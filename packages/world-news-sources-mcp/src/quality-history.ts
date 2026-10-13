import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { canonicalUrl, stableId, type Catalog } from './catalog.js';

const DAY = 86400000;
const iso = z.string().datetime({ offset: true });
const id = z.string().regex(/^ep_[a-f0-9]{24}$/);
export const collectionCycleSchema = z.object({
  id: z.string().min(1).max(128), lane: z.enum(['production', 'inspection']),
  started_at: iso, finished_at: iso.nullable(), status: z.enum(['running', 'completed', 'partial', 'failed']),
  scope: z.enum(['due_endpoints', 'explicit_endpoints']), registry_digest: z.string().regex(/^[a-f0-9]{64}$/),
  country_endpoints: z.record(z.string(), z.array(id).max(10000)),
  eligible_endpoint_ids: z.array(id).max(10000), planned_endpoint_ids: z.array(id).max(10000),
  attempted_endpoint_ids: z.array(id).max(10000), successful_article_endpoint_ids: z.array(id).max(10000),
  failure_reason: z.string().max(128).nullable(),
}).strict();
export type CollectionCycle = z.infer<typeof collectionCycleSchema>;
const cycleSummarySchema = z.object({ summary_version: z.literal(1), id: z.string().min(1).max(128), lane: z.enum(['production', 'inspection']),
  started_at: iso, finished_at: iso.nullable(), status: z.enum(['running', 'completed', 'partial', 'failed']), scope: z.enum(['due_endpoints', 'explicit_endpoints']),
  registry_digest: z.string().regex(/^[a-f0-9]{64}$/), failure_reason: z.string().max(128).nullable(),
  eligible_endpoints: z.number().int().min(0).max(10000), planned_endpoints: z.number().int().min(0).max(10000), attempted_endpoints: z.number().int().min(0).max(10000), successful_article_endpoints: z.number().int().min(0).max(10000),
  country_metrics: z.record(z.string(), z.object({ cohort_sha256: z.string().regex(/^[a-f0-9]{64}$/), eligible_endpoints: z.number().int().min(1).max(10000),
    planned_endpoints: z.number().int().min(0).max(10000), attempted_endpoints: z.number().int().min(0).max(10000), successful_article_endpoints: z.number().int().min(0).max(10000) }).strict()),
}).strict();
export type CollectionCycleSummary = z.infer<typeof cycleSummarySchema>;
export type CollectionCycleEvidence = CollectionCycle | CollectionCycleSummary;

export function validateCollectionCycle(value: unknown): CollectionCycle {
  const parsed = collectionCycleSchema.parse(value), row = { ...parsed, started_at: new Date(Date.parse(parsed.started_at)).toISOString(), finished_at: parsed.finished_at ? new Date(Date.parse(parsed.finished_at)).toISOString() : null }, eligible = new Set(row.eligible_endpoint_ids), planned = new Set(row.planned_endpoint_ids), attempted = new Set(row.attempted_endpoint_ids);
  const unique = (values: string[]) => values.length === new Set(values).size;
  if (![row.eligible_endpoint_ids, row.planned_endpoint_ids, row.attempted_endpoint_ids, row.successful_article_endpoint_ids, ...Object.values(row.country_endpoints)].every(unique)
    || row.planned_endpoint_ids.some(value => !eligible.has(value)) || row.attempted_endpoint_ids.some(value => !planned.has(value))
    || row.successful_article_endpoint_ids.some(value => !attempted.has(value))
    || Object.values(row.country_endpoints).flat().some(value => !eligible.has(value))
    || row.eligible_endpoint_ids.some(value => !Object.values(row.country_endpoints).some(ids => ids.includes(value)))
    || row.finished_at && Date.parse(row.finished_at) < Date.parse(row.started_at)
    || row.status === 'running' && row.finished_at !== null || row.status !== 'running' && row.finished_at === null
    || row.status === 'completed' && (planned.size !== eligible.size || attempted.size !== planned.size)) throw Error('INVALID_COLLECTION_CYCLE');
  return row;
}
/** Public export retains cohort identity and measured counts without repeating thousands of endpoint IDs. */
export function summarizeCollectionCycle(input: CollectionCycleEvidence): CollectionCycleSummary {
  if ('summary_version' in input) {
    const parsed = cycleSummarySchema.parse(input), row = { ...parsed, started_at: new Date(Date.parse(parsed.started_at)).toISOString(), finished_at: parsed.finished_at ? new Date(Date.parse(parsed.finished_at)).toISOString() : null };
    const ordered = (value: { eligible_endpoints: number; planned_endpoints: number; attempted_endpoints: number; successful_article_endpoints: number }) => value.successful_article_endpoints <= value.attempted_endpoints && value.attempted_endpoints <= value.planned_endpoints && value.planned_endpoints <= value.eligible_endpoints;
    const complete = (value: { eligible_endpoints: number; planned_endpoints: number; attempted_endpoints: number }) => value.eligible_endpoints === value.planned_endpoints && value.planned_endpoints === value.attempted_endpoints;
    if (!ordered(row) || Object.values(row.country_metrics).some(country => !ordered(country) || country.eligible_endpoints > row.eligible_endpoints || country.attempted_endpoints > row.attempted_endpoints)
      || row.status === 'completed' && (!complete(row) || Object.values(row.country_metrics).some(country => !complete(country)))
      || row.status === 'running' && row.finished_at !== null || row.status !== 'running' && row.finished_at === null
      || row.finished_at && Date.parse(row.finished_at) < Date.parse(row.started_at)) throw Error('INVALID_COLLECTION_CYCLE_SUMMARY');
    return row;
  }
  const row = validateCollectionCycle(input), count = (eligible: string[], values: string[]) => eligible.filter(id => values.includes(id)).length;
  return { summary_version: 1, id: row.id, lane: row.lane, started_at: row.started_at, finished_at: row.finished_at, status: row.status, scope: row.scope,
    registry_digest: row.registry_digest, failure_reason: row.failure_reason, eligible_endpoints: row.eligible_endpoint_ids.length, planned_endpoints: row.planned_endpoint_ids.length,
    attempted_endpoints: row.attempted_endpoint_ids.length, successful_article_endpoints: row.successful_article_endpoint_ids.length,
    country_metrics: Object.fromEntries(Object.entries(row.country_endpoints).map(([country, ids]) => [country, {
      cohort_sha256: createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex'), eligible_endpoints: ids.length,
      planned_endpoints: count(ids, row.planned_endpoint_ids), attempted_endpoints: count(ids, row.attempted_endpoint_ids), successful_article_endpoints: count(ids, row.successful_article_endpoint_ids) }])) };
}

const median = (values: number[]) => { const a = [...values].sort((x, y) => x - y), i = Math.floor(a.length / 2); return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
type DatedContent = { checked_at: string; newest_content_at?: string | null; date_kind?: string | null; status?: string };
/** Empirical cadence needs multiple dated content advances, not a successful HTTP response. */
export function empiricalFreshness(input: DatedContent[], at: number) {
  const valid = input.filter(row => Number.isFinite(Date.parse(row.checked_at)) && Date.parse(row.checked_at) <= at
    && typeof row.newest_content_at === 'string' && Number.isFinite(Date.parse(row.newest_content_at))
    && Date.parse(row.newest_content_at) <= Date.parse(row.checked_at) + 300000
    && ['feed_item_date', 'sitemap_lastmod'].includes(row.date_kind ?? '')
    && (!row.status || ['working_nonempty', 'valid_empty'].includes(row.status)))
    .sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));
  const latest = valid.at(-1), kind = latest?.date_kind;
  const comparable = valid.filter(row => row.date_kind === kind), advances: number[] = [], checks: number[] = [];
  let previousContent: number | null = null, previousCheck: number | null = null;
  for (const row of comparable) {
    const content = Date.parse(row.newest_content_at!), checked = Date.parse(row.checked_at);
    if (previousContent !== null && content > previousContent) advances.push(content - previousContent);
    if (previousCheck !== null && checked > previousCheck) checks.push(checked - previousCheck);
    previousContent = previousContent === null ? content : Math.max(previousContent, content); previousCheck = checked;
  }
  if (!latest || advances.length < 3) return { state: 'insufficient_content_date_history', value: null, newest_content_at: latest?.newest_content_at ?? null,
    date_kind: kind ?? null, advance_samples: advances.length, typical_update_seconds: null, freshness_threshold_seconds: null, content_age_seconds: null };
  const cadence = median(advances), inspection = median(checks), threshold = Math.max(3600000, cadence * 3, inspection * 2);
  const age = Math.max(0, at - Date.parse(latest.newest_content_at!));
  // An old observation cannot certify present freshness, even for an established feed.
  const observationAge = at - Date.parse(latest.checked_at), current = observationAge <= Math.max(DAY, inspection * 2);
  return { state: current ? age <= threshold ? 'within_observed_cadence' : 'outside_observed_cadence' : 'content_observation_too_old',
    value: current ? age <= threshold : null, newest_content_at: latest.newest_content_at!, date_kind: kind!, advance_samples: advances.length,
    typical_update_seconds: cadence / 1000, freshness_threshold_seconds: threshold / 1000, content_age_seconds: age / 1000 };
}

/** Compare the same country's fully recorded due cycles, UTC weekday and unchanged planned cohort. */
export function completedCycleBaseline(input: CollectionCycleEvidence[], country: string, date: string, days = 56) {
  // Stores validate summaries on ingestion; do not revalidate every country field once per country during comparisons.
  const cycles = input.map(row => 'summary_version' in row ? row : summarizeCollectionCycle(row));
  const selected = cycles.filter(row => row.lane === 'production' && row.started_at.slice(0, 10) === date && row.country_metrics[country]?.eligible_endpoints)
    .sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
  const empty = { state: 'completion_not_recorded', cycle_id: selected?.id ?? null, samples: 0, sample_dates: [] as string[], comparable_endpoints: 0,
    metrics: { attempt_coverage: null as number | null, success_rate: null as number | null }, current: null as null | { attempt_coverage: number; success_rate: number | null }, reasons: [] as Array<{ metric: string; current: number; baseline: number; delta_percentage_points: number }> };
  if (!selected || selected.status !== 'completed' || selected.scope !== 'due_endpoints') return { ...empty, state: selected ? 'incomplete_or_explicit_cycle' : empty.state };
  const cohort = selected.country_metrics[country], signature = cohort.cohort_sha256, start = Date.parse(date) - days * DAY, weekday = new Date(date).getUTCDay();
  const previous = cycles.filter(row => row.lane === 'production' && row.status === 'completed' && row.scope === 'due_endpoints'
    && Date.parse(row.started_at) >= start && row.started_at < selected.started_at && row.started_at.slice(0, 10) < date
    && new Date(row.started_at).getUTCDay() === weekday && row.country_metrics[country]?.cohort_sha256 === signature);
  // Several runs on one day do not multiply the number of independent weekday samples.
  const samples = [...new Map(previous.sort((a, b) => a.started_at.localeCompare(b.started_at)).map(row => [row.started_at.slice(0, 10), row])).values()];
  const metrics = (row: CollectionCycleSummary) => { const value = row.country_metrics[country], attempted = value.attempted_endpoints, succeeded = value.successful_article_endpoints;
    return { attempt_coverage: 100 * attempted / cohort.eligible_endpoints, success_rate: attempted ? 100 * succeeded / attempted : null }; };
  const current = metrics(selected), eligible = samples.filter(row => metrics(row).attempt_coverage >= 80 && metrics(row).success_rate !== null);
  if (eligible.length < 2) return { ...empty, state: 'insufficient_completed_cycle_history', cycle_id: selected.id, comparable_endpoints: cohort.eligible_endpoints, samples: eligible.length, sample_dates: eligible.map(row => row.started_at.slice(0, 10)), current };
  const normal = { attempt_coverage: median(eligible.map(row => metrics(row).attempt_coverage)), success_rate: median(eligible.map(row => metrics(row).success_rate!)) };
  const reasons = (['attempt_coverage', 'success_rate'] as const).flatMap(metric => { const value = current[metric], baseline = normal[metric];
    return value !== null && baseline - value >= 15 && value < baseline * .8 ? [{ metric, current: value, baseline, delta_percentage_points: value - baseline }] : []; });
  return { state: 'comparable_completed_cycles', cycle_id: selected.id, samples: eligible.length, sample_dates: eligible.map(row => row.started_at.slice(0, 10)),
    comparable_endpoints: cohort.eligible_endpoints, metrics: normal, current, reasons };
}

const registrySourceSchema = z.object({ source_id: z.string().regex(/^src_[a-f0-9]{24}$/), country: z.string().min(2).max(8), name: z.string().min(1).max(512),
  enabled: z.boolean(), registration_count: z.number().int().min(1).max(10000),
  endpoints: z.array(z.object({ endpoint_id: id, type: z.enum(['rss', 'sitemap']), url: z.string().max(2048) }).strict()).max(2),
}).strict();
type RegistrySource = z.infer<typeof registrySourceSchema>;
type RegistryObservation = { observed_at: string; registry_snapshot_at: string | null; complete: boolean; sources: RegistrySource[] };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const qualitySchema = `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS quality_observations(id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,snapshot_at TEXT,country TEXT NOT NULL,date TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS quality_country_date ON quality_observations(country,date,observed_at);
CREATE TABLE IF NOT EXISTS quality_registry(id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,registry_snapshot_at TEXT,sources TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quality_registry_events(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,country TEXT NOT NULL,kind TEXT NOT NULL,observed_at TEXT NOT NULL,previous_observed_at TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quality_seen_sources(source_id TEXT PRIMARY KEY,first_observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quality_cycles(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
`;

/** Local immutable observations; no raw MCP output, credentials, article bodies or fabricated registration dates. */
export class QualityHistoryStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') { if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('QUALITY_HISTORY_SYMLINK'); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.db = new DatabaseSync(path); if (path !== ':memory:') chmodSync(path, 0o600); this.db.exec(qualitySchema);
  }
  close() { this.db.close(); }
  private transaction<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  observeOverview(payload: Record<string, any>, observedAt = new Date().toISOString()) {
    observedAt = new Date(Date.parse(iso.parse(observedAt))).toISOString(); const rows = Array.isArray(payload.items) ? payload.items : [];
    return this.transaction(() => {
      for (const row of rows) {
        if (typeof row.country !== 'string' || !/^[A-Z0-9-]{2,8}$/.test(row.country) || !/^\d{4}-\d{2}-\d{2}$/.test(row.period?.date ?? payload.date ?? '')) throw Error('INVALID_QUALITY_OBSERVATION');
        const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        const metric = (value: any) => ({ value: numeric(value?.value), numerator: numeric(value?.numerator), denominator: numeric(value?.denominator) });
        const saved = { country: row.country, date: row.period?.date ?? payload.date, snapshot_at: typeof payload.snapshot_at === 'string' ? payload.snapshot_at : null,
          period_state: row.period?.state ?? null, completion: row.period?.run_completion ?? 'not_recorded',
          attempt_coverage: metric(row.metrics?.attempt_coverage), success_rate: metric(row.metrics?.success_rate), freshness: metric(row.metrics?.freshness),
          inventory: Object.fromEntries(['active_source_registrations', 'disabled_source_registrations', 'active_normalized_sources', 'unique_active_rss_endpoints', 'unique_active_sitemap_endpoints'].map(key => [key, numeric(row.inventory?.[key])])) };
        const observationId = digest(saved); this.db.prepare('INSERT INTO quality_observations VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(observationId, observedAt, saved.snapshot_at, saved.country, saved.date, JSON.stringify(saved));
      }
      for (const candidate of payload.collection_cycles ?? []) this.observeCycle(candidate);
    });
  }
  observeCycle(input: unknown) { const row = summarizeCollectionCycle(input as CollectionCycleEvidence); if (row.status === 'running') return;
    const previous = this.db.prepare('SELECT payload FROM quality_cycles WHERE id=?').get(row.id);
    if (previous && String(previous.payload) !== JSON.stringify(row)) throw Error('QUALITY_COMPLETED_CYCLE_IMMUTABLE');
    this.db.prepare('INSERT INTO quality_cycles VALUES(?,?) ON CONFLICT DO NOTHING').run(row.id, JSON.stringify(row)); }
  observeCatalog(catalog: Catalog, observedAt = new Date().toISOString(), registryAt: string | null = null) {
    return this.observeRegistry({ observed_at: observedAt, registry_snapshot_at: registryAt, complete: true,
      sources: catalog.sources.map(source => ({ source_id: source.id, country: source.countryCode, name: source.name, enabled: source.enabled,
        registration_count: source.registrationCount, endpoints: source.endpoints.map(endpoint => ({ endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url })) })) });
  }
  observeRegistry(input: RegistryObservation) {
    iso.parse(input.observed_at); if (input.registry_snapshot_at !== null) iso.parse(input.registry_snapshot_at);
    input = { ...input, observed_at: new Date(Date.parse(input.observed_at)).toISOString(), registry_snapshot_at: input.registry_snapshot_at ? new Date(Date.parse(input.registry_snapshot_at)).toISOString() : null };
    if (!input.complete) return { state: 'partial_registry_ignored', added: 0, removed: 0, reactivated: 0, deactivated: 0, reappeared: 0 };
    if (input.sources.length > 10000) throw Error('QUALITY_REGISTRY_LIMIT');
    const sources = input.sources.map(value => registrySourceSchema.parse(value)).sort((a, b) => a.source_id.localeCompare(b.source_id));
    if (sources.length !== new Set(sources.map(value => value.source_id)).size) throw Error('QUALITY_REGISTRY_DUPLICATE_SOURCE');
    for (const source of sources) for (const endpoint of source.endpoints) if (canonicalUrl(endpoint.url) !== endpoint.url || stableId('ep', [endpoint.type, endpoint.url]) !== endpoint.endpoint_id) throw Error('QUALITY_REGISTRY_ENDPOINT_IDENTITY');
    return this.transaction(() => {
      const latest = this.db.prepare('SELECT * FROM quality_registry ORDER BY observed_at DESC,id DESC LIMIT 1').get();
      if (latest && String(latest.observed_at) > input.observed_at) throw Error('QUALITY_REGISTRY_OBSERVATION_OUT_OF_ORDER');
      if (latest?.registry_snapshot_at && (!input.registry_snapshot_at || String(latest.registry_snapshot_at) > input.registry_snapshot_at)) throw Error('QUALITY_REGISTRY_SNAPSHOT_OUT_OF_ORDER');
      const observationId = digest([input.observed_at, input.registry_snapshot_at, sources]);
      if (latest?.id === observationId) return { state: 'unchanged_registry', added: 0, removed: 0, reactivated: 0, deactivated: 0, reappeared: 0 };
      const previous: RegistrySource[] = latest ? JSON.parse(String(latest.sources)) : [], old = new Map(previous.map(source => [source.source_id, source])), current = new Map(sources.map(source => [source.source_id, source]));
      const events = latest ? [...sources.flatMap(source => !old.has(source.source_id) ? [{ source, kind: this.db.prepare('SELECT 1 FROM quality_seen_sources WHERE source_id=?').get(source.source_id) ? 'registration_reappearance_observed' : 'registration_observed' }] : source.enabled !== old.get(source.source_id)!.enabled ? [{ source, kind: source.enabled ? 'reactivation_observed' : 'deactivation_observed' }] : []),
        ...previous.filter(source => !current.has(source.source_id)).map(source => ({ source, kind: 'registry_removal_observed' }))] : [];
      this.db.prepare('INSERT INTO quality_registry VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(observationId, input.observed_at, input.registry_snapshot_at, JSON.stringify(sources));
      for (const source of sources) this.db.prepare('INSERT INTO quality_seen_sources VALUES(?,?) ON CONFLICT DO NOTHING').run(source.source_id, input.observed_at);
      for (const event of events) { const row = { ...event.source, kind: event.kind, observed_at: input.observed_at, previous_observed_at: String(latest!.observed_at),
        occurred_at: null, registration_created_at: null, evidence: 'difference_between_complete_registry_observations' };
        this.db.prepare('INSERT INTO quality_registry_events VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(digest([observationId, event.source.source_id, event.kind]), event.source.source_id, event.source.country, event.kind, input.observed_at, String(latest!.observed_at), JSON.stringify(row)); }
      return { state: latest ? events.length ? 'registry_changes_observed' : 'unchanged_registry' : 'initial_observation_baseline', added: events.filter(row => row.kind === 'registration_observed').length,
        removed: events.filter(row => row.kind === 'registry_removal_observed').length, reactivated: events.filter(row => row.kind === 'reactivation_observed').length, deactivated: events.filter(row => row.kind === 'deactivation_observed').length,
        reappeared: events.filter(row => row.kind === 'registration_reappearance_observed').length };
    });
  }
  summary(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(Date.parse(date)).toISOString().slice(0, 10) !== date) throw Error('INVALID_QUALITY_HISTORY_DATE');
    const first = this.db.prepare('SELECT observed_at FROM quality_registry ORDER BY observed_at,id LIMIT 1').get(), latest = this.db.prepare('SELECT observed_at,registry_snapshot_at FROM quality_registry ORDER BY observed_at DESC,id DESC LIMIT 1').get();
    const events = this.db.prepare('SELECT payload FROM quality_registry_events WHERE observed_at>=? AND observed_at<? ORDER BY observed_at,id').all(`${date}T00:00:00.000Z`, new Date(Date.parse(date) + DAY).toISOString()).map(row => JSON.parse(String(row.payload)));
    const countries = [...new Set(events.map(row => row.country))].sort().map(country => {
      const selected = events.filter(row => row.country === country), count = (kind: string) => selected.filter(row => row.kind === kind).length;
      return { country, observed_additions: count('registration_observed'), observed_registry_removals: count('registry_removal_observed'), observed_reappearances: count('registration_reappearance_observed'),
        observed_reactivations: count('reactivation_observed'), observed_deactivations: count('deactivation_observed'),
        observed_net_normalized_sources: count('registration_observed') + count('registration_reappearance_observed') - count('registry_removal_observed'),
        actual_deletions: null, actual_net_change: null };
    });
    return { baseline_observed_at: first?.observed_at ?? null, latest_registry_observed_at: latest?.observed_at ?? null, registry_snapshot_at: latest?.registry_snapshot_at ?? null,
      actual_registration_dates_known: false, changes_are_observation_intervals: true, date, per_country: countries, observed_registry_changes: events,
      observations_saved: Number(this.db.prepare('SELECT count(*) AS n FROM quality_observations').get()?.n ?? 0) };
  }
  decorateOverview(payload: Record<string, any>) {
    const date = String(payload.date ?? payload.items?.[0]?.period?.date ?? ''), cycles = this.db.prepare('SELECT payload FROM quality_cycles').all().map(row => summarizeCollectionCycle(JSON.parse(String(row.payload))));
    const rows = (payload.items ?? []).map((row: any) => ({ ...row, completed_cycle_baseline: completedCycleBaseline(cycles, row.country, row.period?.date ?? date) }));
    const all = [...new Set(cycles.flatMap(cycle => Object.keys(cycle.country_metrics)))].map(country => ({ country, baseline: completedCycleBaseline(cycles, country, date) }));
    const eligible = all.filter(row => row.baseline.state === 'comparable_completed_cycles'), failed = eligible.filter(row => row.baseline.reasons.some(reason => reason.metric === 'success_rate'));
    return { ...payload, items: rows, history: this.summary(date), completed_cycle_common_signal: {
      state: eligible.length >= 3 && failed.length >= 3 && failed.length / eligible.length >= .3 ? 'investigate_common_collector_first' : 'not_established',
      eligible_countries: eligible.length, affected_countries: failed.map(row => row.country), assessment_scope: 'all_recorded_cycle_countries', cause_confirmed: false } };
  }
}
