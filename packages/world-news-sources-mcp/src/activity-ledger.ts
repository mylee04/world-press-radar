import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {encodeHistory,type HistoryShard} from './activity-history.js';
import type { Catalog, Endpoint, Source } from './catalog.js';
import { normalizeArticleUrl, NORMALIZATION_VERSION } from './article-url.js';
import { validateCollectionCycle, summarizeCollectionCycle, type CollectionCycle } from './quality-history.js';
import { collectionNextDue, endpointDue, type CollectionScheduling, type DeferredEndpoint, type RetryAfterSource, type SchedulingState } from './collection-schedule.js';
import { COMPACT_URL_SCHEMA, LEGACY_URL_SCHEMA, urlStorageVersion } from './activity-url-storage.js';

export type CollectionBinding = Pick<Source, 'id' | 'countryCode'>;
export type Collection = { id: string; endpoint: Endpoint; checked_at: string; status: string; format: string | null; urls: string[]; reason: string | null; traffic: 'production' | 'inspection'; source_bindings?: CollectionBinding[];
  cycle_id?: string; newest_content_at?: string | null; date_kind?: 'feed_item_date' | 'sitemap_lastmod';
  http_status?: number | null; retry_after_at?: string | null; retry_after_source?: RetryAfterSource | null; request_host?: string; response_host?: string; attempts?: number;
  requested_hops?: number; server_deferral?: { until: string; http_status: number | null; hostname?: string } };
export const COMMON_ACTIVITY_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registry(source_id TEXT NOT NULL,country TEXT NOT NULL,endpoint_id TEXT NOT NULL,type TEXT NOT NULL,url TEXT NOT NULL,enabled INTEGER NOT NULL,registrations INTEGER NOT NULL,PRIMARY KEY(source_id,endpoint_id));
CREATE TABLE IF NOT EXISTS bindings(source_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,country TEXT NOT NULL,baseline_at TEXT,last_success_at TEXT,last_attempt_at TEXT,last_status TEXT,failures INTEGER NOT NULL DEFAULT 0,next_due TEXT,PRIMARY KEY(source_id,endpoint_id));
CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL,checked_at TEXT NOT NULL,status TEXT NOT NULL,format TEXT,reason TEXT,details TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS collection_time ON collections(checked_at);
CREATE INDEX IF NOT EXISTS collection_endpoint_time ON collections(endpoint_id,checked_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS writer_lock(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS request_budget(day TEXT PRIMARY KEY,requests INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collection_cycles(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS endpoint_recovery(endpoint_id TEXT PRIMARY KEY,request_host TEXT NOT NULL,response_host TEXT,failed_checks INTEGER,last_checked_at TEXT,category TEXT,action TEXT,next_eligible_at TEXT,review_required INTEGER,record TEXT);
CREATE TABLE IF NOT EXISTS recovery_events(event_key TEXT PRIMARY KEY,endpoint_id TEXT,checked_at TEXT,record TEXT);
CREATE TABLE IF NOT EXISTS host_cooldowns(host TEXT PRIMARY KEY,until_at TEXT,category TEXT);
`;
export const ACTIVITY_SCHEMA = COMMON_ACTIVITY_SCHEMA + COMPACT_URL_SCHEMA;
export function collectionId(endpointId: string, checkedAt: string, urls: string[]) {
  return createHash('sha256').update(JSON.stringify([endpointId, checkedAt, urls])).digest('hex');
}
export class ActivityLedger {
  readonly db: DatabaseSync;
  readonly urlStorageVersion: 1 | 2;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000');
      this.urlStorageVersion = urlStorageVersion(this.db) ?? 2;
      this.db.exec(COMMON_ACTIVITY_SCHEMA + (this.urlStorageVersion === 1 ? LEGACY_URL_SCHEMA : COMPACT_URL_SCHEMA));
    } catch (error) { this.db.close(); throw error; }
  }
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
  beginCycle(catalog: Catalog, input: { id: string; lane: 'production' | 'inspection'; at: string; eligible_endpoint_ids: string[]; planned_endpoint_ids: string[]; scope: 'due_endpoints' | 'explicit_endpoints'; scheduling?: CollectionScheduling }) {
    const eligible = new Set(input.eligible_endpoint_ids), active = catalog.sources.filter(source => source.enabled);
    if ([...eligible].some(id => !active.some(source => source.endpoints.some(endpoint => endpoint.id === id)))) throw Error('UNREGISTERED_CYCLE_ENDPOINT');
    const countries = Object.fromEntries(catalog.countries.map(country => [country.code, [...new Set(active.filter(source => source.countryCode === country.code).flatMap(source => source.endpoints.map(endpoint => endpoint.id)))].filter(id => eligible.has(id))]).filter(([, ids]) => ids.length));
    const row = validateCollectionCycle({ id: input.id, lane: input.lane, started_at: input.at, finished_at: null, status: 'running', scope: input.scope,
      registry_digest: createHash('sha256').update(JSON.stringify(catalog.sources)).digest('hex'), country_endpoints: countries,
      eligible_endpoint_ids: input.eligible_endpoint_ids, planned_endpoint_ids: input.planned_endpoint_ids, attempted_endpoint_ids: [], successful_article_endpoint_ids: [], failure_reason: null, ...(input.scheduling ? { scheduling: input.scheduling } : {}) });
    this.db.prepare('INSERT INTO collection_cycles VALUES(?,?)').run(row.id, JSON.stringify(row)); return row;
  }
  deferCycleEndpoint(id: string, deferred: DeferredEndpoint) {
    const value = this.db.prepare('SELECT payload FROM collection_cycles WHERE id=?').get(id); if (!value) throw Error('UNKNOWN_COLLECTION_CYCLE');
    const prior = JSON.parse(String(value.payload)); if (prior.status !== 'running' || !prior.scheduling || !prior.scheduling.active_endpoint_ids.includes(deferred.endpoint_id)) throw Error('COLLECTION_CYCLE_MISMATCH');
    const rows = new Map<string, DeferredEndpoint>(prior.scheduling.deferred_endpoints.map((row: DeferredEndpoint) => [row.endpoint_id, row])); rows.set(deferred.endpoint_id, deferred);
    prior.scheduling.deferred_endpoints = [...rows.values()];
    this.db.prepare('UPDATE collection_cycles SET payload=? WHERE id=?').run(JSON.stringify(validateCollectionCycle(prior)), id);
  }
  hostCooldowns(at: string) {
    return this.db.prepare("SELECT host,until_at,category FROM host_cooldowns WHERE category IN ('rate_limited','server_retry_after') AND until_at>?").all(at)
      .map(row => ({ host: String(row.host), until: String(row.until_at), reason: String(row.category) as DeferredEndpoint['reason'], http_status: row.category === 'rate_limited' ? 429 : null }));
  }
  scheduling(catalog: Catalog, at: string, force = false, explicit: string[] = []) {
    const sources = catalog.sources.filter(source => source.enabled);
    const active = [...new Set(sources.flatMap(source => source.endpoints.map(endpoint => endpoint.id)))].filter(id => !explicit.length || explicit.includes(id));
    const countries = Object.fromEntries(catalog.countries.map(country => [country.code, [...new Set(sources.filter(source => source.countryCode === country.code).flatMap(source => source.endpoints.map(endpoint => endpoint.id)))].filter(id => active.includes(id))]).filter(([, ids]) => ids.length));
    const bindingRows = this.db.prepare('SELECT endpoint_id,MAX(next_due) next_due,MAX(last_attempt_at) last_attempt_at FROM bindings GROUP BY endpoint_id').all();
    const states = new Map<string, SchedulingState>(bindingRows.map(row => [String(row.endpoint_id), { endpoint_id: String(row.endpoint_id), next_due: row.next_due as string | null, last_attempt_at: row.last_attempt_at as string | null }]));
    const latest = this.db.prepare('SELECT c.endpoint_id,c.checked_at,c.reason,c.details FROM (SELECT DISTINCT endpoint_id FROM bindings) b JOIN collections c ON c.id=(SELECT id FROM collections p WHERE p.endpoint_id=b.endpoint_id ORDER BY checked_at DESC,id DESC LIMIT 1)').all();
    for (const row of latest) {
      const details = JSON.parse(String(row.details)), state = states.get(String(row.endpoint_id)); if (!state) continue;
      const recovery = details.recovery;
      Object.assign(state, { reason: row.reason, http_status: details.http_status ?? recovery?.http_status ?? null,
        retry_after_at: details.retry_after_at ?? (recovery?.category === 'rate_limited' || recovery?.cause === 'rate_limited' ? recovery.nextEligibleAt : null),
        defer_reason: details.defer_reason ?? (recovery?.category === 'rate_limited' || recovery?.cause === 'rate_limited' ? 'rate_limited' : null) });
    }
    const cooldowns = new Map(this.hostCooldowns(at).map(row => [row.host, row]));
    const eligible: string[] = [], checked: string[] = [], deferred: DeferredEndpoint[] = [];
    for (const id of active) {
      const state = states.get(id), due = endpointDue(state, at, force), host = new URL(catalog.endpoints.get(id)!.url).hostname;
      if (due.checked_today) checked.push(id);
      const hostUntil = cooldowns.get(host);
      if (hostUntil && (!due.deferred || hostUntil.until > due.deferred.next_due)) deferred.push({ endpoint_id: id, next_due: hostUntil.until, reason: hostUntil.reason, http_status: hostUntil.reason === 'rate_limited' ? 429 : null });
      else if (due.deferred) deferred.push(due.deferred);
      else if (due.eligible) eligible.push(id);
    }
    eligible.sort((a, b) => String(states.get(a)?.last_attempt_at ?? '').localeCompare(String(states.get(b)?.last_attempt_at ?? '')) || a.localeCompare(b));
    const scheduling: CollectionScheduling = { policy: 'daily_all_active', as_of: at, active_endpoint_ids: active, already_checked_today_endpoint_ids: checked, deferred_endpoints: deferred, country_active_endpoints: countries, ...(force ? { force_recheck: true } : {}) };
    return { eligible, scheduling };
  }
  finishCycle(id: string, status: 'completed' | 'partial' | 'failed', at: string, reason: string | null = null) {
    const value = this.db.prepare('SELECT payload FROM collection_cycles WHERE id=?').get(id); if (!value) throw Error('UNKNOWN_COLLECTION_CYCLE');
    const prior = validateCollectionCycle(JSON.parse(String(value.payload))); if (prior.status !== 'running') throw Error('COLLECTION_CYCLE_ALREADY_FINISHED');
    const records = this.db.prepare("SELECT endpoint_id,status,format FROM collections WHERE json_extract(details,'$.cycle_id')=?").all(id);
    const row = validateCollectionCycle({ ...prior, status, finished_at: at, failure_reason: reason,
      ...(prior.scheduling ? { scheduling: { ...prior.scheduling, as_of: at, deferred_endpoints: prior.scheduling.deferred_endpoints.filter(value => Date.parse(value.next_due) > Date.parse(at)) } } : {}),
      attempted_endpoint_ids: [...new Set(records.map(record => String(record.endpoint_id)))],
      successful_article_endpoint_ids: [...new Set(records.filter(record => ['working_nonempty', 'valid_empty'].includes(String(record.status)) && record.format !== 'sitemapindex').map(record => String(record.endpoint_id)))] });
    this.db.prepare('UPDATE collection_cycles SET payload=? WHERE id=?').run(JSON.stringify(row), id); return row;
  }
  // Every URL relationship, scope discovery, initialization and collection checkpoint commits together.
  // Inspection uses a separate ledger file; it is never copied into a production snapshot.
  commit(collection: Collection, sources: CollectionBinding[], owner: string, now = new Date().toISOString()) {
    if (collection.traffic !== 'production' && this.db.prepare("SELECT value FROM metadata WHERE key='lane'").get()?.value === 'production') throw new Error('TRAFFIC_LANE_MISMATCH');
    if (!Number.isFinite(Date.parse(collection.checked_at))) throw new Error('INVALID_CHECK_TIME');
    return this.transaction(() => {
      const lock = this.db.prepare('SELECT owner,expires_at FROM writer_lock WHERE id=1').get();
      if (!lock || lock.owner !== owner || String(lock.expires_at) <= now) throw new Error('COLLECTOR_LEASE_LOST');
      const previous = this.db.prepare('SELECT details FROM collections WHERE id=?').get(collection.id);
      if (previous) return { ...JSON.parse(String(previous.details)), replayed: true };
      if (collection.cycle_id) {
        const value = this.db.prepare('SELECT payload FROM collection_cycles WHERE id=?').get(collection.cycle_id);
        const cycle: CollectionCycle | null = value ? validateCollectionCycle(JSON.parse(String(value.payload))) : null;
        if (!cycle || cycle.status === 'completed' || cycle.lane !== collection.traffic || !cycle.planned_endpoint_ids.includes(collection.endpoint.id)
          || Date.parse(collection.checked_at) < Date.parse(cycle.started_at) || cycle.finished_at && Date.parse(collection.checked_at) > Date.parse(cycle.finished_at)) throw Error('COLLECTION_CYCLE_MISMATCH');
      }
      if (collection.newest_content_at != null && !Number.isFinite(Date.parse(collection.newest_content_at)) || collection.date_kind && !['feed_item_date', 'sitemap_lastmod'].includes(collection.date_kind)) throw Error('INVALID_COLLECTION_CONTENT_DATE');
      if (!sources.length || new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('UNREGISTERED_COLLECTION_BINDING');
      for (const source of sources) {
        const binding = this.db.prepare('SELECT country FROM bindings WHERE source_id=? AND endpoint_id=?').get(source.id, collection.endpoint.id);
        if (!binding || binding.country !== source.countryCode) throw new Error('UNREGISTERED_COLLECTION_BINDING');
      }
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
      const urlKey = this.urlStorageVersion === 2 ? 'url_id' : 'url';
      const upsertUrl = this.db.prepare(`INSERT INTO urls(url,normalization_version,kind,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen) RETURNING ${this.urlStorageVersion === 2 ? 'id' : 'url'} AS url_key`);
      const endpointUrl = this.db.prepare(`INSERT INTO endpoint_urls VALUES(?,?,?,?) ON CONFLICT(endpoint_id,${urlKey}) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`);
      const bindingUrl = this.db.prepare(`INSERT INTO binding_urls VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,endpoint_id,${urlKey}) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`);
      const scope = this.db.prepare(`INSERT INTO scope_urls VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_kind,scope_id,${urlKey}) DO UPDATE SET last_seen=MAX(last_seen,excluded.last_seen)`);
      const scopeExists = this.db.prepare(`SELECT 1 FROM scope_urls WHERE scope_kind=? AND scope_id=? AND ${urlKey}=?`);
      const bindingStates = sources.map(source => ({ source, initialized: !!this.db.prepare('SELECT baseline_at FROM bindings WHERE source_id=? AND endpoint_id=?').get(source.id, collection.endpoint.id)?.baseline_at }));
      for (const { source, initialized } of bindingStates) {
        sourceNew[source.id] = 0; countryNew[source.countryCode] ??= 0;
        if (!initialized && successful && !index) baselineSources.push(source.id);
      }
      const countryBaselines = [...new Set(sources.map(source => source.countryCode))]
        .map(country => ({ country, baseline: bindingStates.some(binding => binding.source.countryCode === country && !binding.initialized) }));
      for (const article of urls) {
        const storedUrl = upsertUrl.get(article.url, NORMALIZATION_VERSION, article.kind, collection.checked_at, collection.checked_at)!.url_key;
        endpointUrl.run(collection.endpoint.id, storedUrl, collection.checked_at, collection.checked_at);
        // A newly initialized binding excludes its old archive from BOTH source and country NEW.
        // Country baseline wins when several bindings share the same endpoint on its first visit.
        for (const { country, baseline } of countryBaselines) {
          const existed = scopeExists.get('country', country, storedUrl);
          scope.run('country', country, storedUrl, collection.checked_at, collection.checked_at, +baseline, article.kind);
          if (!existed && !baseline && article.kind === 'candidate') countryNew[country]++;
        }
        for (const { source, initialized } of bindingStates) {
          bindingUrl.run(source.id, collection.endpoint.id, source.countryCode, storedUrl, collection.checked_at, collection.checked_at);
          const existed = scopeExists.get('source', source.id, storedUrl);
          scope.run('source', source.id, storedUrl, collection.checked_at, collection.checked_at, +!initialized, article.kind);
          if (!existed && initialized && article.kind === 'candidate') sourceNew[source.id]++;
        }
      }
      const retryDeadline = collection.server_deferral?.until ?? collection.retry_after_at;
      const serverDeadline = retryDeadline && Date.parse(retryDeadline) > Date.parse(collection.checked_at) ? retryDeadline : null;
      const limitingStatus = collection.server_deferral?.http_status ?? collection.http_status ?? null;
      const nextDue = collectionNextDue(collection.checked_at, limitingStatus, retryDeadline);
      const deferReason = limitingStatus === 429 ? 'rate_limited' : serverDeadline ? 'server_retry_after' : null;
      const requestHost = collection.request_host ?? new URL(collection.endpoint.url).hostname;
      const responseHost = collection.response_host ?? requestHost;
      const oldRecovery = this.db.prepare('SELECT failed_checks FROM endpoint_recovery WHERE endpoint_id=?').get(collection.endpoint.id);
      const category = successful ? 'healthy' : limitingStatus === 429 ? 'rate_limited' : [401, 402, 403, 451].includes(collection.http_status ?? 0) ? 'access_restricted' : [404, 410].includes(collection.http_status ?? 0) ? 'missing_endpoint' : [500, 502, 503, 504].includes(collection.http_status ?? 0) ? 'server_error_retry_candidate' : collection.status === 'timeout' ? 'transient_transport' : collection.status === 'malformed' ? 'document_validation' : 'unresolved';
      const recovery = { endpoint_id: collection.endpoint.id, checked_at: collection.checked_at, http_status: collection.http_status ?? null, reason: collection.reason, status: collection.status,
        diagnostics: { requestHost, retryAfterAt: retryDeadline ?? null, ...(collection.server_deferral?.hostname ? { deferredHost: collection.server_deferral.hostname } : {}) }, attempts: collection.attempts ?? 1, category,
        action: successful ? 'normal_cadence' : category === 'rate_limited' ? 'wait_retry_after' : category === 'missing_endpoint' ? 'review_relocation_or_removal' : category === 'access_restricted' ? 'review_official_alternative' : category === 'document_validation' ? 'review_document_or_parser_fixture' : ['transient_transport', 'server_error_retry_candidate'].includes(category) ? 'bounded_backoff' : 'retain_diagnostics_and_review',
        review: !successful && !['rate_limited', 'transient_transport', 'server_error_retry_candidate'].includes(category), nextEligibleAt: nextDue,
        failedChecks: successful ? 0 : Number(oldRecovery?.failed_checks ?? 0) + 1, policyVersion: 'daily-all-active-1' };
      const details = { source_ids: sources.map(s => s.id), countries: [...new Set(sources.map(s => s.countryCode))], source_new: sourceNew, country_new: countryNew,
        baseline_sources: baselineSources, observed_urls: urls.length, uncertain_urls: urls.filter(u => u.kind === 'uncertain').length, index_children_excluded: index,
        http_status: collection.http_status ?? null, retry_after_at: retryDeadline ?? null, retry_after_source: collection.retry_after_source ?? null, defer_reason: deferReason,
        requested_hops: collection.requested_hops ?? null, ...(collection.server_deferral ? { server_deferral: collection.server_deferral } : {}),
        recovery,
        ...(collection.cycle_id ? { cycle_id: collection.cycle_id } : {}), ...(collection.newest_content_at !== undefined ? { newest_content_at: collection.newest_content_at, date_kind: collection.date_kind ?? null } : {}) };
      this.db.prepare('INSERT INTO collections VALUES(?,?,?,?,?,?,?)').run(collection.id, collection.endpoint.id, collection.checked_at, collection.status, collection.format, collection.reason, JSON.stringify(details));
      for (const { source } of bindingStates) {
        const row = this.db.prepare('SELECT failures FROM bindings WHERE source_id=? AND endpoint_id=?').get(source.id, collection.endpoint.id);
        const failures = successful ? 0 : Number(row?.failures ?? 0) + 1;
        this.db.prepare(`UPDATE bindings SET baseline_at=CASE WHEN ? THEN COALESCE(baseline_at,?) ELSE baseline_at END,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,last_attempt_at=?,last_status=?,failures=?,next_due=? WHERE source_id=? AND endpoint_id=?`).run(+(successful && !index), collection.checked_at, +successful, collection.checked_at, collection.checked_at, collection.status, failures, nextDue, source.id, collection.endpoint.id);
      }
      this.db.prepare('INSERT INTO endpoint_recovery VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(endpoint_id) DO UPDATE SET request_host=excluded.request_host,response_host=excluded.response_host,failed_checks=excluded.failed_checks,last_checked_at=excluded.last_checked_at,category=excluded.category,action=excluded.action,next_eligible_at=excluded.next_eligible_at,review_required=excluded.review_required,record=excluded.record').run(collection.endpoint.id, requestHost, responseHost, recovery.failedChecks, collection.checked_at, recovery.category, recovery.action, nextDue, +recovery.review, JSON.stringify(recovery));
      this.db.prepare('INSERT INTO recovery_events VALUES(?,?,?,?) ON CONFLICT(event_key) DO NOTHING').run(collection.id, collection.endpoint.id, collection.checked_at, JSON.stringify(recovery));
      for (const host of new Set([requestHost, responseHost, ...(collection.server_deferral?.hostname ? [collection.server_deferral.hostname] : [])])) {
        if (deferReason) this.db.prepare("INSERT INTO host_cooldowns VALUES(?,?,?) ON CONFLICT(host) DO UPDATE SET until_at=CASE WHEN host_cooldowns.category IN ('rate_limited','server_retry_after') THEN MAX(host_cooldowns.until_at,excluded.until_at) ELSE excluded.until_at END,category=CASE WHEN host_cooldowns.category IN ('rate_limited','server_retry_after') AND host_cooldowns.until_at>excluded.until_at THEN host_cooldowns.category ELSE excluded.category END").run(host, serverDeadline ?? nextDue, deferReason);
        else this.db.prepare("DELETE FROM host_cooldowns WHERE host=? AND (category NOT IN ('rate_limited','server_retry_after') OR until_at<=?)").run(host, collection.checked_at);
      }
      if (collection.cycle_id && deferReason && this.db.prepare("SELECT 1 FROM collection_cycles WHERE id=? AND json_extract(payload,'$.status')='running'").get(collection.cycle_id)) this.deferCycleEndpoint(collection.cycle_id, { endpoint_id: collection.endpoint.id, next_due: serverDeadline ?? nextDue, reason: deferReason, http_status: limitingStatus });
      this.db.prepare(`INSERT INTO metadata VALUES('tracking_start',?) ON CONFLICT DO NOTHING`).run(collection.checked_at);
      return { ...details, replayed: false };
    });
  }
  archive(catalog:Catalog,directory:string,at=new Date().toISOString()) {
    mkdirSync(directory,{recursive:true,mode:0o700});
    const shards:HistoryShard[]=[];
    const months=this.db.prepare('SELECT DISTINCT substr(checked_at,1,7) AS month FROM collections ORDER BY month').all();
    for(const {month} of months){
      if(!/^\d{4}-\d{2}$/.test(String(month)))throw Error('INVALID_HISTORY_MONTH');
      const rows=this.db.prepare('SELECT * FROM collections WHERE checked_at>=? AND checked_at<? ORDER BY checked_at,id LIMIT 500001').all(`${month}-01`,`${month}-32`);
      const records=rows.map(r=>({endpoint_id:r.endpoint_id,checked_at:r.checked_at,status:r.status,format:r.format,...JSON.parse(String(r.details))}));
      const bytes=encodeHistory(records),sha256=createHash('sha256').update(bytes).digest('hex'),file=`${month}-${sha256}.json.gz`,path=join(directory,file);
      writeFileSync(`${path}.tmp`,bytes,{mode:0o600});renameSync(`${path}.tmp`,path);
      shards.push({month:String(month),file,sha256,bytes:bytes.length,records:records.length});
    }
    const snapshot=this.snapshot(catalog,at,180,{maxRecords:1}),latest=(field:string)=>Object.fromEntries(this.db.prepare(`SELECT j.value AS scope,MAX(c.checked_at) AS at FROM collections c,json_each(c.details,'$.${field}') j GROUP BY j.value`).all().map(r=>[String(r.scope),String(r.at)]));
    return {...snapshot,collections:[],available_since:shards[0]?`${shards[0].month}-01T00:00:00.000Z`:at,
      scope_latest:{source:latest('source_ids'),country:latest('countries')},history:{version:1 as const,complete:true as const,shards},
      snapshot_coverage:{complete_stored_window:true,durable_history_retained:true,exported_collections:shards.reduce((n,s)=>n+s.records,0),format:'monthly_gzip_scope_counts',compressed_bytes:shards.reduce((n,s)=>n+s.bytes,0)}};
  }
  snapshot(catalog: Catalog, at = new Date().toISOString(), days = 180, options: { maxRecords?: number; maxBytes?: number } = {}) {
    const maxRecords = options.maxRecords ?? 25000, maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 25000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 10 * 1024 * 1024) throw new Error('INVALID_SNAPSHOT_BUDGET');
    const since = new Date(Date.parse(at) - days * 86400000).toISOString();
    const start = this.db.prepare("SELECT value FROM metadata WHERE key='tracking_start'").get()?.value ?? null;
    const lane = this.db.prepare("SELECT value FROM metadata WHERE key='lane'").get()?.value ?? 'production';
    const all = this.db.prepare('SELECT * FROM collections WHERE checked_at>=? ORDER BY checked_at DESC,id DESC LIMIT ?').all(since, maxRecords + 1).reverse();
    const records = all.map(row => ({ id: row.id, endpoint_id: row.endpoint_id, checked_at: String(row.checked_at), status: row.status, format: row.format, reason: row.reason, ...JSON.parse(String(row.details)) }));
    const bindings = this.db.prepare('SELECT * FROM bindings').all();
    const starts = (field: string) => Object.fromEntries(this.db.prepare(`SELECT j.value AS scope,MIN(c.checked_at) AS at FROM collections c,json_each(c.details,'$.${field}') j GROUP BY j.value`).all().map(row => [String(row.scope),String(row.at)]));
    const base = { version: 1, lane, generated_at: at, tracking_start: start, normalization_version: NORMALIZATION_VERSION,
      scheduling: this.scheduling(catalog, at).scheduling,
      collection_cycles: this.db.prepare('SELECT payload FROM collection_cycles ORDER BY json_extract(payload,\'$.started_at\') DESC LIMIT 256').all().map(row => summarizeCollectionCycle(JSON.parse(String(row.payload)))),
      bindings, scope_starts: { source: starts('source_ids'), country: starts('countries') }, registry_at: this.db.prepare("SELECT value FROM metadata WHERE key='registry_at'").get()?.value ?? null,
      registry_digest: createHash('sha256').update(JSON.stringify(catalog.sources)).digest('hex'),
      semantics: 'First discovered unique candidate URL in each scope after that endpoint/source binding baseline. Not published articles; no semantic content dedup. Index children excluded; homepage/section/forum heuristics reported separately. Full durable URL history remains in the operator SQLite ledger.' };
    const make = (count: number) => {
      let offset = records.length - count;
      // Never export half of a timestamp cohort and then call that boundary complete.
      if (offset > 0) while (offset < records.length && records[offset].checked_at === records[offset - 1].checked_at) offset++;
      const collections = records.slice(offset), truncated = offset > 0;
      return { ...base, collections, available_since: truncated ? collections[0]?.checked_at ?? at : since,
        snapshot_coverage: { requested_since: since, exported_collections: collections.length, record_limit: maxRecords, byte_limit: maxBytes, complete_stored_window: !truncated, durable_history_retained: true } };
    };
    if (Buffer.byteLength(JSON.stringify(make(0))) > maxBytes) throw new Error('SNAPSHOT_METADATA_SIZE_LIMIT');
    let low = 0, high = Math.min(maxRecords, records.length);
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(make(mid))) <= maxBytes) low = mid; else high = mid - 1; }
    return make(low);
  }
}
