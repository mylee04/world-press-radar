import { z } from 'zod';
import { page, pagination, type Catalog, type Source, type Endpoint } from './catalog.js';
import { ActivityStore, countryCollectionSchedule } from './activity.js';
import { historyMonths, readHistory } from './activity-history.js';
import { HealthStore } from './health.js';
import { estimatePublisherInventory } from './publisher-inventory.js';
import { completedCycleBaseline, empiricalFreshness, summarizeCollectionCycle } from './quality-history.js';

const DAY = 86400000;
const validDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = Date.parse(value); return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}, 'Invalid UTC calendar date');
const dateFields = { date: validDate.optional(), baseline_days: z.number().int().min(7).max(56).default(28) };
export const countryQualitySchema = z.object({ country: z.string().min(2).max(8).optional(), ...dateFields, ...pagination }).strict();
export const sourceQualitySchema = z.object({ source_id: z.string().regex(/^src_[a-f0-9]{24}$/), ...dateFields }).strict();
type RecordRow = Record<string, any>;
const recordTimes=new WeakMap<RecordRow,{raw:unknown;at:number}>();
function checkedAt(record:RecordRow){const raw=record.checked_at,previous=recordTimes.get(record);if(previous&&previous.raw===raw)return previous.at;const at=Date.parse(raw);recordTimes.set(record,{raw,at});return at;}
function groupBy<T>(values:T[],key:(value:T)=>string){const result=new Map<string,T[]>();for(const value of values){const scope=key(value),rows=result.get(scope)??[];rows.push(value);result.set(scope,rows);}return result;}
type Ratio = { value: number | null; numerator: number | null; denominator: number; unit: 'percent' };
const success = (event: RecordRow) => ['working_nonempty', 'valid_empty'].includes(event.status);
export const successfulArticleCollection = (event: RecordRow) => success(event) && event.format !== 'sitemapindex';
const isoDate = (at: number) => new Date(at).toISOString().slice(0, 10);
const shift = (date: string, days: number) => isoDate(Date.parse(date) + days * DAY);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const ratio = (numerator: number | null, denominator: number): Ratio => ({
  value: numerator === null || denominator === 0 ? null : 100 * numerator / denominator,
  numerator, denominator, unit: 'percent',
});

// Read retained, checksum-verified collection aggregates, never the operator URL ledger.
function recordsInWindow(activity: ActivityStore, from: number, to: number) {
  const snapshot = activity.snapshot;
  if (!snapshot) return [];
  let records = snapshot.collections;
  if (snapshot.history) {
    if (!activity.historyDirectory) throw Error('ACTIVITY_HISTORY_NOT_CONFIGURED');
    const months = new Set(historyMonths(from, to));
    records = snapshot.history.shards.filter(shard => months.has(shard.month)).flatMap(shard => readHistory(activity.historyDirectory!, shard));
  }
  return records.filter(event => checkedAt(event) >= from && checkedAt(event) < to)
    .sort((a, b) => checkedAt(a) - checkedAt(b));
}
function latestCollection(activity: ActivityStore) {
  const snapshot = activity.snapshot;
  const dates = [...(snapshot?.collections ?? []).map(e => String(e.checked_at)), ...Object.values(snapshot?.scope_latest?.country ?? {}),
    ...(snapshot?.bindings ?? []).flatMap(b => typeof b.last_attempt_at === 'string' ? [b.last_attempt_at] : [])];
  return dates.filter(date => Number.isFinite(Date.parse(date))).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}
function selection(activity: ActivityStore, date: string | undefined, now: number) {
  const latest = latestCollection(activity), chosen = date ?? (latest ? isoDate(Date.parse(latest)) : isoDate(now));
  if (chosen > isoDate(now)) throw Error('Quality date must be past or present');
  return { date: chosen, latest, now };
}
function temporalState(activity: ActivityStore, date: string, scopeStart: string | null, latest: string | null, now: number) {
  const from = Date.parse(date), to = from + DAY;
  const tracked = !!scopeStart && Date.parse(scopeStart) < to;
  const unavailable = !!activity.snapshot && from < Date.parse(activity.snapshot.available_since);
  const after = !!latest && from > Date.parse(latest);
  const calendarClosed = to <= now;
  const watermarkClosed = !!latest && to <= Date.parse(latest);
  return { date, from: new Date(from).toISOString(), to_exclusive: new Date(to).toISOString(),
    calendar_closed: calendarClosed, observation_window_closed: calendarClosed && watermarkClosed,
    state: !tracked ? 'not_tracked' : unavailable ? 'history_unavailable' : after ? 'after_latest_collection' :
      !calendarClosed || !watermarkClosed ? 'partial_snapshot_window' : 'closed_calendar_window',
    run_completion: 'not_recorded', data_available: tracked && !unavailable && !after };
}
function firstScopeAt(activity: ActivityStore, kind: 'country' | 'source', scope: string, records: RecordRow[]) {
  return activity.snapshot?.scope_starts?.[kind]?.[scope] ?? records.find(e =>
    (kind === 'country' ? e.countries : e.source_ids)?.includes(scope))?.checked_at ?? null;
}
function dayMetrics(activity: ActivityStore, date: string, scopeStart: string | null, latest: string | null,
  expected: Set<string>, records: RecordRow[], now: number) {
  const period = temporalState(activity, date, scopeStart, latest, now), from = Date.parse(date);
  const rows = records.filter(e => expected.has(e.endpoint_id) && checkedAt(e) >= from && checkedAt(e) < from + DAY);
  const attempted = new Set(rows.map(e => e.endpoint_id)), successful = new Set(rows.filter(successfulArticleCollection).map(e => e.endpoint_id));
  const latestByEndpoint = new Map(rows.map(e => [e.endpoint_id, e]));
  return { period: { ...period, last_collection_at: rows.at(-1)?.checked_at ?? null },
    attempt_coverage: ratio(period.data_available ? attempted.size : null, expected.size),
    success_rate: ratio(period.data_available ? successful.size : null, attempted.size),
    successful_registered_coverage: ratio(period.data_available ? successful.size : null, expected.size),
    attempted_endpoints: period.data_available ? attempted.size : null,
    successful_article_endpoints: period.data_available ? successful.size : null,
    failed_checks: period.data_available ? rows.filter(e => !success(e)).length : null,
    failed_latest_endpoints: period.data_available ? [...latestByEndpoint.values()].filter(e => !success(e)).length : null,
    index_only_endpoints: period.data_available ? new Set(rows.filter(e => success(e) && e.format === 'sitemapindex').map(e => e.endpoint_id)).size : null,
    successful_zero_is_not_failure: true };
}
function inventory(catalog: Catalog, country: string) {
  const all = catalog.sources.filter(source => source.countryCode === country), active = all.filter(source => source.enabled);
  const endpoints = (type: 'rss' | 'sitemap') => new Set(active.flatMap(source => source.endpoints.filter(e => e.type === type).map(e => e.id))).size;
  return { active_source_registrations: all.reduce((n, source) => n + source.activeRegistrationCount, 0),
    active_normalized_sources: active.length, disabled_source_registrations: all.reduce((n, source) => n + source.disabledRegistrationCount, 0),
    ...estimatePublisherInventory(active),
    unique_active_rss_endpoints: endpoints('rss'), unique_active_sitemap_endpoints: endpoints('sitemap'),
    count_semantics: 'Current source registrations and distinct typed endpoint IDs. Publisher counts are brand estimates from domains and explicit aliases, not verified legal entities or ownership groups.' };
}
function contentEvidence(endpoint: Endpoint, sources: Source[], health: HealthStore, now: number, records: RecordRow[], evidenceAt: number) {
  const check = health.get(endpoint, sources, now);
  const observations = records.filter(record => record.endpoint_id === endpoint.id).map(record => ({ checked_at: record.checked_at, newest_content_at: record.newest_content_at, date_kind: record.date_kind, status: record.status }));
  if (check.checked_at && check.newest_content_at) observations.push({ checked_at: check.checked_at, newest_content_at: check.newest_content_at, date_kind: check.date_kind, status: check.audit_status });
  return { ...check, evidence_age_seconds: check.checked_at ? Math.max(0, (now - Date.parse(check.checked_at)) / 1000) : null,
    evidence_scope: 'last_saved_health_observation', comparable_update_cadence: empiricalFreshness(observations, evidenceAt) };
}
function classifyEndpoint(endpoint: Endpoint, records: RecordRow[], sources: Source[], health: HealthStore, date: string, now: number,
  bindings: Array<Record<string, unknown>> = []) {
  const end = Date.parse(date) + DAY, relevant = records.filter(e => e.endpoint_id === endpoint.id && checkedAt(e) < end);
  const rows = relevant.filter(e => checkedAt(e) >= Date.parse(date));
  const last = rows.at(-1), previous = last ? relevant.filter(e => e !== last) : relevant;
  const sourceIds = new Set(sources.map(source => source.id));
  // The real binding baseline also proves an earlier non-index success, even when it is outside this bounded history window.
  const oldBaseline = bindings.filter(binding => binding.endpoint_id === endpoint.id && sourceIds.has(String(binding.source_id)) &&
    typeof binding.baseline_at === 'string' && Date.parse(binding.baseline_at) < (last ? checkedAt(last) : end))
    .map(binding => String(binding.baseline_at)).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  const priorSuccess = previous.filter(successfulArticleCollection).at(-1)?.checked_at ?? oldBaseline ?? null;
  const saved = contentEvidence(endpoint, sources, health, now, relevant, Math.min(end - 1, now));
  let state: string;
  if (!last) state = relevant.length ? 'not_attempted_in_period' : 'untracked_or_no_available_checks';
  else if (!success(last)) state = priorSuccess ? 'failure_after_prior_success' : 'access_failure_without_normal_baseline';
  else if (last.format === 'sitemapindex') state = 'index_only';
  else if (previous.at(-1) && !success(previous.at(-1)!)) state = 'recovered_after_failure';
  else if (saved.comparable_update_cadence.value === false || saved.comparable_update_cadence.value === null && saved.content_freshness === 'stale' && saved.checked_at && Date.parse(saved.checked_at) < end) state = 'stale_content_evidence';
  else state = Object.values(last.source_new ?? {}).every(value => value === 0) ? 'successful_no_new_discoveries' : 'successful_collection';
  const recommendations: Record<string, string> = {
    failure_after_prior_success: 'Check a shared collector incident first, then inspect a bounded live validation and the last normal collection. Propose changes only after the cause is verified.',
    access_failure_without_normal_baseline: 'Verify access and initialize tracking; a prior normal collection is not established, so an interruption is not confirmed.',
    recovered_after_failure: 'A later saved successful collection provides recovery evidence. Verify current collection before applying any repair.',
    stale_content_evidence: 'Verify the saved content date and the publisher official feed list. Investigate an obsolete endpoint or publication cadence before suggesting a replacement.',
    successful_no_new_discoveries: 'The collection succeeded. Zero new discoveries alone is not an outage; compare content dates and established cadence if concern remains.',
  };
  return { endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url, classification: state,
    last_collection: last ? { checked_at: last.checked_at, status: last.status, format: last.format,
      reason: last.reason ?? null, attributed_source_new_urls: last.source_new ?? {} } : null,
    prior_success_at: priorSuccess,
    health: saved, requires_live_confirmation: ['failure_after_prior_success', 'access_failure_without_normal_baseline', 'stale_content_evidence'].includes(state),
    content_evidence_is_current_collection: !!last && saved.checked_at === last.checked_at,
    recommendation: recommendations[state] ?? 'Additional dated collection evidence is needed before operational conclusions.',
    evidence: { last_collection_at: last?.checked_at ?? null, last_collection_status: last?.status ?? null,
      prior_success_at: priorSuccess,
      health_checked_at: saved.checked_at, newest_content_at: saved.newest_content_at, health_observation_status: saved.status,
      saved_content_freshness: saved.content_freshness, current_live_state_verified: false } };
}
function baseline(activity: ActivityStore, current: ReturnType<typeof dayMetrics>, expected: Set<string>, records: RecordRow[],
  scopeStart: string | null, latest: string | null, days: number, now: number) {
  const date = current.period.date, weekday = new Date(date).getUTCDay();
  const candidates = Array.from({ length: days }, (_, i) => shift(date, -i - 1)).filter(d => new Date(d).getUTCDay() === weekday);
  const cohortStart = Date.parse(candidates.at(-1) ?? date);
  const historicalEndpoints=new Set(records.filter(e=>checkedAt(e)<cohortStart).map(e=>e.endpoint_id));
  const cohort = new Set([...expected].filter(id => historicalEndpoints.has(id)));
  const samples = candidates.map(d => ({ date: d, metrics: dayMetrics(activity, d, scopeStart, latest, cohort, records, now) }))
    .filter(s => s.metrics.period.observation_window_closed && s.metrics.attempt_coverage.value !== null && s.metrics.attempt_coverage.value >= 80);
  const available = samples.length >= 2 && cohort.size >= Math.min(5, expected.size) && expected.size > 0;
  const metric = (key: 'attempt_coverage' | 'success_rate') => available ? median(samples.map(s => s.metrics[key].value!).filter(v => v !== null)) : null;
  const currentCohort = dayMetrics(activity, date, scopeStart, latest, cohort, records, now);
  return { state: available ? 'comparable_closed_calendar_windows' : 'insufficient_comparable_history',
    weekday_utc: weekday, lookback_days: days, sample_dates: samples.map(s => s.date), samples: samples.length,
    comparable_endpoints: cohort.size, current_active_endpoints: expected.size,
    metrics: { attempt_coverage: metric('attempt_coverage'), success_rate: metric('success_rate') },
    current_cohort_metrics: { attempt_coverage: currentCohort.attempt_coverage, success_rate: currentCohort.success_rate },
    limitations: 'Same country and weekday, stable endpoint cohort, closed saved-data windows, at least 80% prior attempt coverage and two samples. Collector completion and historical registry revisions are not recorded; this is a review signal, not a confirmed cycle failure.' };
}

/** Saved-data quality overview. No live network checks, registry changes, or model calls. */
export function getCountryQualityOverview(catalog: Catalog, activity: ActivityStore, health: HealthStore, raw: unknown = {}, now = Date.now()) {
  const input = countryQualitySchema.parse(raw), selected = selection(activity, input.date, now);
  const countryCode = input.country?.toUpperCase();
  if (countryCode && !catalog.countries.some(c => c.code === countryCode)) throw Error('Unknown country');
  const from = Date.parse(shift(selected.date, -input.baseline_days - 7));
  const records = recordsInWindow(activity, from, Date.parse(selected.date) + DAY);
  const countryRecords=new Map<string,RecordRow[]>();
  for(const record of records)for(const country of new Set<string>(record.countries??[])){const rows=countryRecords.get(country)??[];rows.push(record);countryRecords.set(country,rows);}
  const countrySources=groupBy(catalog.sources.filter(source=>source.enabled),source=>source.countryCode);
  const endpointBindings=groupBy(activity.snapshot?.bindings??[],binding=>String(binding.endpoint_id));
  const cycles = (activity.snapshot?.collection_cycles ?? []).map(summarizeCollectionCycle);
  const rows = catalog.countries.map(country => {
    const sources = countrySources.get(country.code)??[];
    const endpoints = new Map(sources.flatMap(s => s.endpoints.map(e => [e.id, e] as const))), expected = new Set(endpoints.keys());
    const relevant = (countryRecords.get(country.code)??[]).filter(e => expected.has(e.endpoint_id));
    const endpointRecords=groupBy(relevant,record=>String(record.endpoint_id)),endpointSources=new Map<string,Source[]>();
    for(const source of sources)for(const endpoint of source.endpoints){const bound=endpointSources.get(endpoint.id)??[];bound.push(source);endpointSources.set(endpoint.id,bound);}
    const scopeStart = firstScopeAt(activity, 'country', country.code, relevant);
    const current = dayMetrics(activity, selected.date, scopeStart, selected.latest, expected, relevant, now);
    const history = baseline(activity, current, expected, relevant, scopeStart, selected.latest, input.baseline_days, now);
    const completedHistory = completedCycleBaseline(cycles, country.code, selected.date, input.baseline_days);
    const selectedCycles = cycles.filter(cycle => cycle.lane === 'production' && cycle.started_at.slice(0, 10) === selected.date && cycle.country_metrics[country.code]?.eligible_endpoints).sort((a, b) => a.started_at.localeCompare(b.started_at));
    if (selectedCycles.length) current.period.run_completion = selectedCycles.at(-1)!.status;
    const reasons: Array<{ metric: string; current: number; baseline: number; delta_percentage_points: number }> = [];
    if (history.state === 'comparable_closed_calendar_windows' && current.period.observation_window_closed) {
      for (const key of ['attempt_coverage', 'success_rate'] as const) {
        const value = history.current_cohort_metrics[key].value, normal = history.metrics[key];
        if (value !== null && normal !== null && normal - value >= 15 && value < normal * .8)
          reasons.push({ metric: key, current: value, baseline: normal, delta_percentage_points: value - normal });
      }
    }
    const findings = [...endpoints.values()].map(e => classifyEndpoint(e, endpointRecords.get(e.id)??[], endpointSources.get(e.id)??[], health, selected.date, now, endpointBindings.get(e.id)??[]));
    const evidenceCounts = { recent: 0, stale: 0, missing: 0, unreliable: 0 };
    for (const finding of findings) evidenceCounts[finding.health.content_freshness]++;
    const freshnessEligible = findings.filter(finding => finding.health.comparable_update_cadence.value !== null);
    const investigationCandidates = findings.flatMap(finding => {
      const boundSources = endpointSources.get(finding.endpoint_id)??[];
      const candidate = (source: Source, reason: string, priority: number) => ({ source_id: source.id, endpoint_id: finding.endpoint_id, reason, priority });
      if (finding.classification === 'failure_after_prior_success') return boundSources.map(source => candidate(source, finding.classification, 1));
      if (finding.health.content_freshness === 'stale' && finding.health.checked_at) return boundSources.map(source => candidate(source, 'saved_stale_content_evidence_requires_confirmation', 2));
      if (finding.classification === 'access_failure_without_normal_baseline') return boundSources.map(source => candidate(source, finding.classification, 3));
      if (finding.classification === 'recovered_after_failure') return boundSources.map(source => candidate(source, finding.classification, 4));
      return boundSources.filter(source => !(endpointBindings.get(finding.endpoint_id)??[]).some(binding => binding.source_id === source.id && binding.baseline_at))
        .map(source => candidate(source, 'uninitialized_binding', 5));
    }).sort((a, b) => a.priority - b.priority || a.source_id.localeCompare(b.source_id));
    return { country: country.code, name: country.name, inventory: inventory(catalog, country.code), period: current.period,
      collection_schedule: countryCollectionSchedule(cycles, country.code, Date.parse(selected.date), Date.parse(selected.date) + DAY, now, expected.size),
      metrics: { attempt_coverage: current.attempt_coverage, success_rate: current.success_rate,
        successful_registered_coverage: current.successful_registered_coverage,
        freshness: { ...ratio(freshnessEligible.length ? freshnessEligible.filter(finding => finding.health.comparable_update_cadence.value).length : null, freshnessEligible.length),
          reason: freshnessEligible.length ? 'At least three dated content advances establish each eligible endpoint cadence; stale observations and insufficient histories are excluded.' : 'Empirical content update cadence and historical content-date observations are insufficient.',
          evaluated_endpoints: freshnessEligible.length, total_endpoints: findings.length,
          evidence_counts: evidenceCounts, evidence_semantics: 'Cadence freshness uses each endpoint dated history. Saved health freshness labels remain separate evidence, never substituted for cadence percentages.' } },
      collection: { attempted_endpoints: current.attempted_endpoints, successful_article_endpoints: current.successful_article_endpoints,
        failed_checks: current.failed_checks, failed_latest_endpoints: current.failed_latest_endpoints, index_only_endpoints: current.index_only_endpoints },
      daily: Array.from({ length: 7 }, (_, i) => {
        const d = dayMetrics(activity, shift(selected.date, i - 6), scopeStart, selected.latest, expected, relevant, now);
        return { date: d.period.date, period: d.period, attempt_coverage: d.attempt_coverage, success_rate: d.success_rate };
      }),
      baseline: history, completed_cycle_baseline: completedHistory,
      operational_anomaly: { state: completedHistory.state === 'comparable_completed_cycles' ? completedHistory.reasons.length ? 'review_needed' : 'no_drop_signal' : completedHistory.state,
        reasons: completedHistory.reasons, operational_failure_confirmed: false },
      anomaly: { state: reasons.length ? 'review_needed' : !current.period.observation_window_closed ? 'partial_window' :
        history.state === 'insufficient_comparable_history' ? 'insufficient_baseline' : 'no_drop_signal', reasons,
        operational_failure_confirmed: false, threshold: { minimum_drop_percentage_points: 15, maximum_relative_to_baseline: .8 } },
      endpoint_findings: findings.filter(f => f.requires_live_confirmation || f.classification === 'recovered_after_failure').map(f => ({ endpoint_id: f.endpoint_id,
        type: f.type, url: f.url, classification: f.classification, checked_at: f.last_collection?.checked_at ?? f.health.checked_at,
        prior_success_at: f.prior_success_at, requires_live_confirmation: f.requires_live_confirmation })).slice(0, 100),
      endpoint_findings_total: findings.filter(f => f.requires_live_confirmation || f.classification === 'recovered_after_failure').length,
      investigation_candidates: investigationCandidates.slice(0, 20), investigation_candidates_total: investigationCandidates.length,
      source_activity_dedup_scope: 'Use country activity counts for country totals; source totals cannot be added without cross-source duplicates.' };
  });
  const failed = rows.filter(r => r.anomaly.reasons.some(reason => reason.metric === 'success_rate'));
  const eligible = rows.filter(r => r.baseline.state === 'comparable_closed_calendar_windows').length;
  const widespread = eligible >= 3 && failed.length >= 3 && failed.length / eligible >= .5;
  const cycleEligible = rows.filter(row => row.completed_cycle_baseline.state === 'comparable_completed_cycles'), cycleFailed = cycleEligible.filter(row => row.completed_cycle_baseline.reasons.some(reason => reason.metric === 'success_rate'));
  return { date: selected.date, timezone: 'UTC', evaluated_at: new Date(now).toISOString(), snapshot_at: activity.snapshot?.generated_at ?? null,
    latest_collection: selected.latest, registry_snapshot_at: activity.snapshot?.registry_at ?? null,
    history_available_since: activity.snapshot?.available_since ?? null,
    snapshot_age_seconds: activity.snapshot ? Math.max(0, (now - Date.parse(activity.snapshot.generated_at)) / 1000) : null,
    source: 'saved_production_observations', live_state_verified: false,
    collection_cycles: cycles,
    completed_cycle_common_signal: { state: cycleEligible.length >= 3 && cycleFailed.length >= 3 && cycleFailed.length / cycleEligible.length >= .3 ? 'investigate_common_collector_first' : 'not_established',
      eligible_countries: cycleEligible.length, affected_countries: cycleFailed.map(row => row.country), assessment_scope: 'all_catalog_countries', cause_confirmed: false },
    common_collector_signal: { state: widespread ? 'investigate_common_collector_first' : 'not_established', affected_countries: failed.map(r => r.country),
      eligible_baseline_countries: eligible, total_catalog_countries: rows.length, assessment_scope: 'all_catalog_countries',
      reason: 'Shared country success declines are a triage signal. Collector/network cause requires separate evidence; no cause is inferred from a zero count.' },
    metric_semantics: 'Attempt coverage = attempted/current active typed endpoints. Success = successful non-index article endpoints/attempted endpoints. At least one successful check qualifies; latest failed outcomes are separately retained. Current registry denominators are not historical inventory.',
    ...page(rows.filter(row => !countryCode || row.country === countryCode), input.offset, input.limit) };
}

function aggregateActivity(result: ReturnType<ActivityStore['query']>, label: string, latest: string | null, now: number) {
  const known = result.items.filter(item => item.new_unique_candidate_urls !== null), missing = result.items.filter(item => item.new_unique_candidate_urls === null);
  const end = result.items.at(-1)?.to_exclusive;
  const closed = !!end && !!latest && Date.parse(end) <= Date.parse(latest) && Date.parse(end) <= now;
  return { label, from: result.items[0]?.from ?? null, to_exclusive: result.items.at(-1)?.to_exclusive ?? null,
    new_unique_candidate_urls: known.length ? known.reduce((n, item) => n + item.new_unique_candidate_urls!, 0) : null,
    known_days: known.length, unknown_days: missing.length, state: missing.length ? known.length ? 'partial' : 'unavailable' : 'observed',
    baseline_checks: result.items.reduce((n, item) => n + item.baseline_checks, 0), metric: result.metric,
    dedup_scope: 'source across RSS/sitemap endpoints, baseline excluded; first discovered candidate URLs, not publications',
    observation_window_closed: closed, interval_may_be_open_or_incomplete: !closed || missing.length > 0 };
}

/** Drilldown retains per-address evidence without inventing endpoint-unique counts from scope allocations. */
export function getSourceQualityDetail(catalog: Catalog, activity: ActivityStore, health: HealthStore, raw: unknown, now = Date.now()) {
  const input = sourceQualitySchema.parse(raw), source = catalog.sources.find(s => s.id === input.source_id);
  if (!source) throw Error('Unknown source');
  const selected = selection(activity, input.date, now), begin = shift(selected.date, -Math.max(30, input.baseline_days + 7));
  const records = recordsInWindow(activity, Date.parse(begin), Date.parse(selected.date) + DAY).filter(e => e.source_ids?.includes(source.id));
  const scopeStart = firstScopeAt(activity, 'source', source.id, records);
  const query = (days: number) => activity.query(catalog, 'source', { source_id: source.id, start_date: shift(selected.date, 1 - days), end_date: selected.date, limit: 50 }, now);
  const monthly = query(30), weekly = query(7), daily = query(1);
  const attributed = (endpoint: Endpoint, days: number) => {
    const first = shift(selected.date, 1 - days), rows = records.filter(e => e.endpoint_id === endpoint.id && Date.parse(e.checked_at) >= Date.parse(first));
    const usable = rows.filter(successfulArticleCollection), initialized = activity.snapshot?.bindings.some(b => b.source_id === source.id && b.endpoint_id === endpoint.id && b.baseline_at);
    return { from: `${first}T00:00:00.000Z`, to_exclusive: `${shift(selected.date, 1)}T00:00:00.000Z`,
      new_unique_candidate_urls: null,
      unique_count_state: 'independent_endpoint_discovery_counts_not_exported',
      attributed_source_new_urls: initialized && usable.length ? usable.reduce((n, event) => n + Number(event.source_new?.[source.id] ?? 0), 0) : null,
      successful_checks: usable.length, failed_checks: rows.filter(e => !success(e)).length,
      baseline_checks: usable.filter(e => e.baseline_sources?.includes(source.id)).length,
      count_semantics: 'Attributed source-wide first discoveries at this endpoint, baseline excluded. A URL seen first on a different feed is absent here; this is not an independent endpoint article count.' };
  };
  return { source: { id: source.id, name: source.name, country: source.countryCode, country_name: source.countryName, enabled: source.enabled,
      active_registration_count: source.activeRegistrationCount, language: source.language, category: source.category },
    date: selected.date, timezone: 'UTC', snapshot_at: activity.snapshot?.generated_at ?? null, latest_collection: selected.latest,
    period: temporalState(activity, selected.date, scopeStart, selected.latest, now), initialization: monthly.initialization,
    article_activity: { daily: aggregateActivity(daily, 'selected_calendar_day', selected.latest, now), weekly: aggregateActivity(weekly, 'trailing_7_calendar_days', selected.latest, now),
      monthly: aggregateActivity(monthly, 'trailing_30_calendar_days', selected.latest, now), days: monthly.items },
    endpoints: source.endpoints.map(endpoint => ({ id: endpoint.id, ...classifyEndpoint(endpoint, records, [source], health, selected.date, now, activity.snapshot?.bindings),
      daily: attributed(endpoint, 1), weekly: attributed(endpoint, 7), monthly: attributed(endpoint, 30),
      days: Array.from({ length: 7 }, (_, i) => {
        const date = shift(selected.date, i - 6), events = records.filter(e => e.endpoint_id === endpoint.id && isoDate(Date.parse(e.checked_at)) === date);
        const good = events.filter(successfulArticleCollection), period = temporalState(activity, date, scopeStart, selected.latest, now);
        return { date, period, checks: period.data_available ? events.length : null, successful_checks: period.data_available ? good.length : null,
          attributed_source_new_urls: period.data_available && good.length ? good.reduce((n, e) => n + Number(e.source_new?.[source.id] ?? 0), 0) : null,
          new_unique_candidate_urls: null };
      }) })),
    semantics: monthly.semantics, dedup_scope: 'Use source article_activity for source totals and country activity for country totals. Endpoint attributed values are allocations of source-deduplicated discoveries.' };
}
