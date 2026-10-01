import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Catalog, Endpoint, Source } from './catalog.js';
import { normalizeArticleUrl, NORMALIZATION_VERSION } from './article-url.js';

export type Collection = { id: string; endpoint: Endpoint; checked_at: string; status: string; format: string | null; urls: string[]; reason: string | null; traffic: 'production' | 'inspection' };
export const ACTIVITY_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registry(source_id TEXT NOT NULL,country TEXT NOT NULL,endpoint_id TEXT NOT NULL,type TEXT NOT NULL,url TEXT NOT NULL,enabled INTEGER NOT NULL,registrations INTEGER NOT NULL,PRIMARY KEY(source_id,endpoint_id));
CREATE TABLE IF NOT EXISTS urls(url TEXT PRIMARY KEY,normalization_version TEXT NOT NULL,kind TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scope_urls(scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,url TEXT NOT NULL REFERENCES urls(url),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,baseline INTEGER NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(scope_kind,scope_id,url));
CREATE INDEX IF NOT EXISTS scope_discovery ON scope_urls(scope_kind,scope_id,baseline,kind,first_seen);
CREATE TABLE IF NOT EXISTS endpoint_urls(endpoint_id TEXT NOT NULL,url TEXT NOT NULL REFERENCES urls(url),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(endpoint_id,url));
CREATE TABLE IF NOT EXISTS binding_urls(source_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,country TEXT NOT NULL,url TEXT NOT NULL REFERENCES urls(url),first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(source_id,endpoint_id,url));
CREATE TABLE IF NOT EXISTS bindings(source_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,country TEXT NOT NULL,baseline_at TEXT,last_success_at TEXT,last_attempt_at TEXT,last_status TEXT,failures INTEGER NOT NULL DEFAULT 0,next_due TEXT,PRIMARY KEY(source_id,endpoint_id));
CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL,checked_at TEXT NOT NULL,status TEXT NOT NULL,format TEXT,reason TEXT,details TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS collection_time ON collections(checked_at);
CREATE TABLE IF NOT EXISTS writer_lock(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS request_budget(day TEXT PRIMARY KEY,requests INTEGER NOT NULL);
`;
export function collectionId(endpointId: string, checkedAt: string, urls: string[]) {
  return createHash('sha256').update(JSON.stringify([endpointId, checkedAt, urls])).digest('hex');
}
export class ActivityLedger {
  readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('PRAGMA busy_timeout=5000'); this.db.exec(ACTIVITY_SCHEMA); }
  close() { this.db.close(); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  acquire(owner: string, now: string, seconds = 60) {
    const expiry = new Date(Date.parse(now) + seconds * 1000).toISOString();
    const row = this.db.prepare(`INSERT INTO writer_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE writer_lock.expires_at<=? OR writer_lock.owner=? RETURNING owner`).get(owner, expiry, now, owner);
    if (!row) throw new Error('COLLECTOR_ALREADY_RUNNING');
  }
  release(owner: string) { this.db.prepare('DELETE FROM writer_lock WHERE owner=?').run(owner); }
  reserveRequest(now: string, limit: number) {
    const row = this.db.prepare(`INSERT INTO request_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1 WHERE requests<? RETURNING requests`).get(now.slice(0, 10), limit);
    if (!row) throw new Error('DAILY_REQUEST_BUDGET_EXHAUSTED');
  }
  syncRegistry(catalog: Catalog, at: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM registry').run();
      const insert = this.db.prepare('INSERT INTO registry VALUES(?,?,?,?,?,?,?)');
      const binding = this.db.prepare('INSERT INTO bindings(source_id,endpoint_id,country) VALUES(?,?,?) ON CONFLICT DO NOTHING');
      for (const source of catalog.sources) for (const endpoint of source.endpoints) {
        insert.run(source.id, source.countryCode, endpoint.id, endpoint.type, endpoint.url, +source.enabled, source.registrationCount);
        binding.run(source.id, endpoint.id, source.countryCode);
      }
      this.db.prepare(`INSERT INTO metadata VALUES('registry_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(at);
    });
  }
  // Every URL relationship, scope discovery, initialization and collection checkpoint commits together.
  // Inspection uses a separate ledger file; it is never copied into a production snapshot.
  commit(collection: Collection, sources: Source[], owner: string, now = new Date().toISOString()) {
    if (collection.traffic !== 'production' && this.db.prepare("SELECT value FROM metadata WHERE key='lane'").get()?.value === 'production') throw new Error('TRAFFIC_LANE_MISMATCH');
    if (!Number.isFinite(Date.parse(collection.checked_at))) throw new Error('INVALID_CHECK_TIME');
    return this.transaction(() => {
      const lock = this.db.prepare('SELECT owner,expires_at FROM writer_lock WHERE id=1').get();
      if (!lock || lock.owner !== owner || String(lock.expires_at) <= now) throw new Error('COLLECTOR_LEASE_LOST');
      const previous = this.db.prepare('SELECT details FROM collections WHERE id=?').get(collection.id);
      if (previous) return { ...JSON.parse(String(previous.details)), replayed: true };
      const latest = this.db.prepare('SELECT MAX(checked_at) AS at FROM collections').get();
      if (latest?.at && String(latest.at) > collection.checked_at) throw new Error('OUT_OF_ORDER_COLLECTION');
      this.db.prepare(`INSERT INTO metadata VALUES('lane',?) ON CONFLICT DO NOTHING`).run(collection.traffic);
      const lane = this.db.prepare("SELECT value FROM metadata WHERE key='lane'").get()?.value;
      if (lane !== collection.traffic) throw new Error('TRAFFIC_LANE_MISMATCH');
      const successful = ['working_nonempty', 'valid_empty'].includes(collection.status);
      const index = collection.format === 'sitemapindex';
      // Child sitemap loc values never become observed article URLs.
      const urls = successful && !index ? [...new Map(collection.urls.map(raw => { const value = normalizeArticleUrl(raw); return [value.url, value] as const; })).values()] : [];
      const sourceNew: Record<string, number> = {}, countryNew: Record<string, number> = {}, baselineSources: string[] = [];
      const upsertUrl = this.db.prepare(`INSERT INTO urls VALUES(?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`);
      const endpointUrl = this.db.prepare(`INSERT INTO endpoint_urls VALUES(?,?,?,?) ON CONFLICT(endpoint_id,url) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`);
      const bindingUrl = this.db.prepare(`INSERT INTO binding_urls VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,endpoint_id,url) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`);
      const scope = this.db.prepare(`INSERT INTO scope_urls VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_kind,scope_id,url) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen) RETURNING first_seen,baseline,kind`);
      const bindingStates = sources.map(source => ({ source, initialized: !!this.db.prepare('SELECT baseline_at FROM bindings WHERE source_id=? AND endpoint_id=?').get(source.id, collection.endpoint.id)?.baseline_at }));
      for (const { source, initialized } of bindingStates) {
        sourceNew[source.id] = 0; countryNew[source.countryCode] ??= 0;
        if (!initialized && successful && !index) baselineSources.push(source.id);
      }
      for (const article of urls) {
        upsertUrl.run(article.url, NORMALIZATION_VERSION, article.kind, collection.checked_at, collection.checked_at);
        endpointUrl.run(collection.endpoint.id, article.url, collection.checked_at, collection.checked_at);
        // A newly initialized binding excludes its old archive from BOTH source and country NEW.
        // Country baseline wins when several bindings share the same endpoint on its first visit.
        for (const country of new Set(sources.map(source => source.countryCode))) {
          const baseline = bindingStates.some(b => b.source.countryCode === country && !b.initialized);
          const existed = this.db.prepare('SELECT 1 FROM scope_urls WHERE scope_kind=? AND scope_id=? AND url=?').get('country', country, article.url);
          scope.get('country', country, article.url, collection.checked_at, collection.checked_at, +baseline, article.kind);
          if (!existed && !baseline && article.kind === 'candidate') countryNew[country]++;
        }
        for (const { source, initialized } of bindingStates) {
          bindingUrl.run(source.id, collection.endpoint.id, source.countryCode, article.url, collection.checked_at, collection.checked_at);
          const existed = this.db.prepare('SELECT 1 FROM scope_urls WHERE scope_kind=? AND scope_id=? AND url=?').get('source', source.id, article.url);
          scope.get('source', source.id, article.url, collection.checked_at, collection.checked_at, +!initialized, article.kind);
          if (!existed && initialized && article.kind === 'candidate') sourceNew[source.id]++;
        }
      }
      const details = { source_ids: sources.map(s => s.id), countries: [...new Set(sources.map(s => s.countryCode))], source_new: sourceNew, country_new: countryNew,
        baseline_sources: baselineSources, observed_urls: urls.length, uncertain_urls: urls.filter(u => u.kind === 'uncertain').length, index_children_excluded: index };
      this.db.prepare('INSERT INTO collections VALUES(?,?,?,?,?,?,?)').run(collection.id, collection.endpoint.id, collection.checked_at, collection.status, collection.format, collection.reason, JSON.stringify(details));
      for (const { source } of bindingStates) {
        const row = this.db.prepare('SELECT failures FROM bindings WHERE source_id=? AND endpoint_id=?').get(source.id, collection.endpoint.id);
        const failures = successful ? 0 : Number(row?.failures ?? 0) + 1;
        const next = new Date(successful ? Date.parse(collection.checked_at.slice(0,10)) + (index ? 7 : 1) * 86400000 : Date.parse(collection.checked_at) + Math.min(7 * 86400000, 3600000 * 2 ** Math.min(failures, 8))).toISOString();
        this.db.prepare(`UPDATE bindings SET baseline_at=CASE WHEN ? THEN COALESCE(baseline_at,?) ELSE baseline_at END,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,last_attempt_at=?,last_status=?,failures=?,next_due=? WHERE source_id=? AND endpoint_id=?`).run(+(successful && !index), collection.checked_at, +successful, collection.checked_at, collection.checked_at, collection.status, failures, next, source.id, collection.endpoint.id);
      }
      this.db.prepare(`INSERT INTO metadata VALUES('tracking_start',?) ON CONFLICT DO NOTHING`).run(collection.checked_at);
      return { ...details, replayed: false };
    });
  }
  snapshot(catalog: Catalog, at = new Date().toISOString(), days = 180) {
    const since = new Date(Date.parse(at) - days * 86400000).toISOString();
    const start = this.db.prepare("SELECT value FROM metadata WHERE key='tracking_start'").get()?.value ?? null;
    const lane = this.db.prepare("SELECT value FROM metadata WHERE key='lane'").get()?.value ?? 'production';
    const all = this.db.prepare('SELECT * FROM collections WHERE checked_at>=? ORDER BY checked_at DESC,id DESC LIMIT 25000').all(since).reverse();
    const collections = all.map(row => ({ id: row.id, endpoint_id: row.endpoint_id, checked_at: row.checked_at, status: row.status, format: row.format, reason: row.reason, ...JSON.parse(String(row.details)) }));
    const availableSince = all.length === 25000 ? String(all[0].checked_at) : since;
    const bindings = this.db.prepare('SELECT * FROM bindings').all();
    const starts = (field: string) => Object.fromEntries(this.db.prepare(`SELECT j.value AS scope,MIN(c.checked_at) AS at FROM collections c,json_each(c.details,'$.${field}') j GROUP BY j.value`).all().map(row => [String(row.scope),String(row.at)]));
    return { version: 1, lane, generated_at: at, tracking_start: start, available_since: availableSince, normalization_version: NORMALIZATION_VERSION,
      bindings, collections, scope_starts: { source: starts('source_ids'), country: starts('countries') }, registry_at: this.db.prepare("SELECT value FROM metadata WHERE key='registry_at'").get()?.value ?? null,
      registry_digest: createHash('sha256').update(JSON.stringify(catalog.sources)).digest('hex'),
      semantics: 'First discovered unique candidate URL in each scope after that endpoint/source binding baseline. Not published articles; no semantic content dedup. Index children excluded; homepage/section/forum heuristics reported separately. Full durable URL history remains in the operator SQLite ledger.' };
  }
}
