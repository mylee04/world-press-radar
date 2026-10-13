import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type Row = Record<string, any>;
export type RemoteQualityCall = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Row>;
export const REMOTE_NEWS_MCP_URL = 'https://news.bymyleslee.com/mcp';
const DAY = 86400000;
const originalTools = new Set(['search_sources', 'get_source', 'list_countries', 'get_endpoint_health',
  'get_source_article_activity', 'get_country_article_activity', 'get_country_source_inventory']);

function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error('REMOTE_QUALITY_ABORTED'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
type NewsReaderClient = Pick<Client, 'connect' | 'callTool' | 'close'>;
type RemoteNewsReader = RemoteQualityCall & { close: () => Promise<void> };

/** Lazy shared MCP session. Every operation remains a real read; only transport negotiation is reused. */
export function createRemoteNewsReader(createClient: () => NewsReaderClient = () => new Client({ name: 'news-quality-dashboard-reader', version: '0.1.0' })): RemoteNewsReader {
  let session: { client: NewsReaderClient; promise: Promise<NewsReaderClient> } | null = null;
  const discard = (value: NonNullable<typeof session>) => { if (session === value) session = null; void value.client.close().catch(() => {}); };
  const connected = () => {
    if (session) return session;
    const client = createClient(), value = { client, promise: null as unknown as Promise<NewsReaderClient> }; session = value;
    value.promise = client.connect(new StreamableHTTPClientTransport(new URL(REMOTE_NEWS_MCP_URL), {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers); headers.set('x-world-news-traffic', 'inspection');
        const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
        return fetch(input, { ...init, headers, signal });
      },
    }), { timeout: 15000, signal: AbortSignal.timeout(15000) }).then(() => client).catch(error => { discard(value); throw error; });
    return value;
  };
  const call: RemoteNewsReader = Object.assign(async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Row> => {
    if (!originalTools.has(name)) throw Error('Unsupported remote read-only MCP tool');
    if (signal?.aborted) throw signal.reason ?? Error('REMOTE_QUALITY_ABORTED');
    const current = connected();
    try {
      const client = await untilAborted(current.promise, signal);
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const result = await untilAborted(client.callTool({ name, arguments: args }, { timeout: 15000, signal: requestSignal }), requestSignal);
      if (result.isError) throw Error(result.content.filter(value => value.type === 'text').map(value => value.text).join(' ').slice(0, 512) || 'Remote MCP tool failed');
      if (!result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) throw Error('Remote MCP result has no structured content');
      return result.structuredContent;
    } catch (error) { discard(current); throw error; }
  }, { close: async () => { const current = session; session = null; if (current) await current.client.close(); } });
  return call;
}
/** Shared real, read-only public MCP operations, with no credentials or publisher fetch. */
export const readRemoteNewsTool = createRemoteNewsReader();

const iso = (at: number) => new Date(at).toISOString().slice(0, 10);
const shift = (date: string, days: number) => iso(Date.parse(date) + days * DAY);
function selection(date?: string) {
  const now = Date.now(), chosen = date ?? iso(now - DAY);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chosen) || !Number.isFinite(Date.parse(chosen)) || iso(Date.parse(chosen)) !== chosen || chosen > iso(now)) throw Error('Invalid past/present UTC quality date');
  return { date: chosen, now };
}
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const dated = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const ratio = (numerator: number | null, denominator: number | null) => ({
  value: numerator === null || denominator === null || denominator === 0 ? null : 100 * numerator / denominator,
  numerator, denominator, unit: 'percent' as const,
});
function period(activity: Row, date: string, now: number) {
  const from = Date.parse(date), end = from + DAY, latest = dated(activity.latest_collection), scopeStart = dated(activity.scope_tracking_start);
  if (activity.lookup_error) return { date, from: new Date(from).toISOString(), to_exclusive: new Date(end).toISOString(),
    calendar_closed: end <= now, observation_window_closed: false, state: 'lookup_failed',
    run_completion: 'unknown', data_available: false, last_collection_at: null, lookup_error: activity.lookup_error };
  const item = (Array.isArray(activity.items) ? activity.items : []).find((value: Row) => value.period === date);
  const unavailable = !item || ['not_tracked', 'history_not_in_snapshot'].includes(item.state)
    || !!latest && from > Date.parse(latest);
  const closed = end <= now && !!latest && end <= Date.parse(latest);
  return { date, from: new Date(from).toISOString(), to_exclusive: new Date(end).toISOString(),
    calendar_closed: end <= now, observation_window_closed: closed,
    state: !scopeStart || item?.state === 'not_tracked' ? 'not_tracked' : item?.state === 'history_not_in_snapshot' ? 'history_unavailable'
      : latest && from > Date.parse(latest) ? 'after_latest_collection' : !closed ? 'partial_snapshot_window' : 'closed_calendar_window',
    run_completion: 'not_exported', data_available: !unavailable, last_collection_at: null };
}
function metrics(activity: Row, date: string, now: number) {
  const item = (activity.items ?? []).find((value: Row) => value.period === date), window = period(activity, date, now);
  const expected = finite(item?.expected_endpoints), attempted = window.data_available ? finite(item?.targeted_endpoints) : null;
  const successful = window.data_available ? finite(item?.successful_article_endpoints) : null;
  return { period: window, attempt_coverage: ratio(attempted, expected), success_rate: ratio(successful, attempted),
    successful_registered_coverage: ratio(successful, expected),
    collection: { attempted_endpoints: attempted, successful_article_endpoints: successful,
      failed_checks: window.data_available ? finite(item?.failed_checks) : null,
      failed_latest_endpoints: null, index_only_endpoints: null,
      index_only_checks: window.data_available ? finite(item?.index_only_checks) : null,
      endpoint_outcome_order: 'not_exported' } };
}
function inventory(value: Row) {
  return { active_source_registrations: finite(value.active_source_registrations), active_normalized_sources: finite(value.active_normalized_sources),
    disabled_source_registrations: finite(value.disabled_source_registrations), unique_publishers: null,
    publisher_count_state: 'publisher_entity_identity_not_recorded', unique_active_rss_endpoints: finite(value.unique_active_rss_endpoints),
    unique_active_sitemap_endpoints: finite(value.unique_active_sitemap_endpoints),
    count_semantics: 'Current remote configuration: registration rows, normalized sources, and distinct typed endpoint IDs. Publisher entities are not exported.' };
}
function countryRow(info: Row, activity: Row, date: string, now: number) {
  const current = metrics(activity, date, now), expected = finite((activity.items ?? []).at(-1)?.expected_endpoints);
  return { country: info.country, name: info.name, inventory: inventory(info), period: current.period,
    metrics: { attempt_coverage: current.attempt_coverage, success_rate: current.success_rate,
      successful_registered_coverage: current.successful_registered_coverage,
      freshness: { ...ratio(null, 0), reason: 'Remote MCP does not export empirical update cadence or comparable content-date history.',
        evidence_counts: { recent: 0, stale: 0, missing: 0, unreliable: 0 }, evidence_state: 'not_queried',
        evidence_semantics: 'No endpoint content-health census was requested for this overview.' } },
    collection: current.collection,
    daily: Array.from({ length: 7 }, (_, index) => {
      const value = metrics(activity, shift(date, index - 6), now);
      return { date: value.period.date, period: value.period, attempt_coverage: value.attempt_coverage, success_rate: value.success_rate };
    }),
    baseline: { state: 'insufficient_comparable_history', weekday_utc: new Date(date).getUTCDay(), lookback_days: 28,
      sample_dates: [], samples: 0, comparable_endpoints: null, current_active_endpoints: expected,
      metrics: { attempt_coverage: null, success_rate: null },
      current_cohort_metrics: { attempt_coverage: ratio(null, null), success_rate: ratio(null, null) },
      limitations: 'Remote daily aggregates do not export a stable historical endpoint cohort or completed collection cycles; a comparable own-country baseline cannot be established.' },
    anomaly: { state: current.period.observation_window_closed ? 'insufficient_baseline' : 'partial_window', reasons: [],
      operational_failure_confirmed: false, threshold: { minimum_drop_percentage_points: 15, maximum_relative_to_baseline: .8 } },
    endpoint_findings: [], endpoint_findings_total: null, investigation_candidates: [], investigation_candidates_total: null,
    source_activity_dedup_scope: 'Country activity is deduplicated within country. Source counts cannot be added without cross-source duplicates.',
    activity_snapshot_at: dated(activity.snapshot_at), latest_collection: dated(activity.latest_collection),
    history_available_since: dated(activity.history_available_since), lookup_error: activity.lookup_error ?? null };
}
function unknownChanges(rows: Row[], date: string, registryAt: string | null) {
  return { date, timezone: 'UTC', as_of: registryAt, history_complete: false, recorded_events_only: false,
    additions: [], source_transitions: [], unknown_addition_timestamp_count: null, known_addition_timestamp_count: null,
    per_country: rows.map(row => ({ country: row.country, name: row.name, additions: null, deactivations: null, reactivations: null,
      deletions: null, net_change: null, history_complete: false, unknown_addition_timestamps: null, current_holdings: row.inventory })),
    state: 'addition_and_deletion_ledgers_not_exported',
    semantics: 'Remote tools export configuration and activation/deactivation metadata, not a registry addition/deletion ledger. Change totals and creation dates remain unknown. First observation and validation dates are not registration dates.' };
}
async function mapFour<T, U>(items: T[], action: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await action(items[index]); }
  }));
  return results;
}
function aggregate(activity: Row, date: string, days: number, label: string, now: number) {
  const start = shift(date, 1 - days), rows = (activity.items ?? []).filter((item: Row) => item.period >= start && item.period <= date);
  const known = rows.filter((item: Row) => finite(item.new_unique_candidate_urls) !== null), missing = days - known.length;
  const end = Date.parse(shift(date, 1)), latest = dated(activity.latest_collection), closed = end <= now && !!latest && end <= Date.parse(latest);
  return { label, from: `${start}T00:00:00.000Z`, to_exclusive: `${shift(date, 1)}T00:00:00.000Z`,
    new_unique_candidate_urls: known.length ? known.reduce((count: number, item: Row) => count + item.new_unique_candidate_urls, 0) : null,
    known_days: known.length, unknown_days: missing, state: missing ? known.length ? 'partial' : 'unavailable' : 'observed',
    baseline_checks: rows.reduce((count: number, item: Row) => count + (finite(item.baseline_checks) ?? 0), 0), metric: activity.metric,
    dedup_scope: 'Source across RSS/sitemap endpoints, baseline excluded. First-discovered candidate URLs, not publications.',
    observation_window_closed: closed, interval_may_be_open_or_incomplete: !closed || missing > 0 };
}
function endpointDetail(endpoint: Row, source: Row, activity: Row, date: string, now: number) {
  const rawHealth = endpoint.health ?? {}, checked = dated(rawHealth.checked_at), future = !!checked && Date.parse(checked) > now;
  const content = dated(rawHealth.newest_content_at), contentFuture = !!content && (Date.parse(content) > now || !!checked && Date.parse(content) > Date.parse(checked));
  const health = { ...rawHealth, checked_at: future ? null : checked,
    evidence_scope: 'last_saved_remote_health_observation', evidence_age_seconds: checked && !future ? Math.max(0, (now - Date.parse(checked)) / 1000) : null,
    evidence_is_old: checked && !future ? now - Date.parse(checked) > 7 * DAY : null,
    evidence_is_future: future, content_date_is_future_or_after_check: contentFuture, comparable_update_cadence: null };
  const day = (activity.items ?? []).find((item: Row) => item.period === date), window = period(activity, date, now);
  const prior = (activity.items ?? []).filter((item: Row) => item.period < date && finite(item.successful_article_endpoints)! > 0);
  const priorSuccess = source.endpoints?.length === 1 ? prior.at(-1)?.period ?? null : null;
  let classification = 'insufficient_endpoint_history', requires = false;
  const single = source.endpoints?.length === 1, attempted = finite(day?.targeted_endpoints), successful = finite(day?.successful_article_endpoints), failed = finite(day?.failed_checks);
  if (single && window.data_available && attempted !== null && successful !== null && failed !== null) {
    if (attempted === 0) classification = activity.initialization === 'not_initialized' ? 'untracked_or_no_available_checks' : 'not_attempted_in_period';
    else if (successful === 0 && failed > 0 && (finite(day.index_only_checks) ?? 0) === 0) {
      classification = priorSuccess ? 'failure_after_prior_success' : 'access_failure_without_normal_baseline'; requires = true;
    } else if (successful > 0 && failed === 0) {
      const previous = (activity.items ?? []).filter((item: Row) => item.period < date && finite(item.targeted_endpoints)! > 0).at(-1);
      classification = previous && previous.successful_article_endpoints === 0 && previous.failed_checks > 0 ? 'recovered_after_failure'
        : day.new_unique_candidate_urls === 0 ? 'successful_no_new_discoveries' : 'successful_collection';
    } else if (successful === 0 && failed === 0 && day.index_only_checks > 0) classification = 'index_only';
    // Daily aggregates with both successes and failures do not export ordering.
  }
  const usableHealth = !!checked && !future && Date.parse(checked) < Date.parse(shift(date, 1));
  if (usableHealth && !contentFuture && health.content_freshness === 'stale' && content
    && !['failure_after_prior_success', 'recovered_after_failure', 'access_failure_without_normal_baseline'].includes(classification)) {
    classification = 'stale_content_evidence'; requires = true;
  } else if (!single && usableHealth && health.last_outcome === 'unhealthy') {
    classification = 'access_failure_without_normal_baseline'; requires = true;
  }
  const attributed = (days: number) => ({ from: `${shift(date, 1 - days)}T00:00:00.000Z`, to_exclusive: `${shift(date, 1)}T00:00:00.000Z`,
    new_unique_candidate_urls: null, unique_count_state: 'independent_endpoint_discovery_counts_not_exported',
    attributed_source_new_urls: null, successful_checks: null, failed_checks: null, baseline_checks: null,
    count_semantics: 'Remote source totals do not export independent endpoint discoveries, endpoint allocations, or individual checks.' });
  return { id: endpoint.id, endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url, classification,
    last_collection: single && window.data_available && attempted ? { checked_at: null, period_date: date, status: 'source_daily_aggregate',
      format: null, reason: 'Individual collection timestamps and outcome order are not exported.', attributed_source_new_urls: null } : null,
    prior_success_at: null, prior_success_date: priorSuccess, health, requires_live_confirmation: requires,
    content_evidence_is_current_collection: false,
    recommendation: classification === 'successful_no_new_discoveries' ? 'The dated collection succeeded. Zero discoveries alone is not an outage.'
      : 'Confirm dated endpoint evidence and official publisher declarations before proposing any operational change.',
    evidence: { last_collection_at: null, last_collection_status: null, prior_success_at: null, prior_success_date: priorSuccess,
      selected_collection_date: single && attempted !== null && attempted > 0 ? date : null,
      selected_attempted_endpoints: single ? attempted : null, selected_successful_article_endpoints: single ? successful : null,
      health_checked_at: health.checked_at, newest_content_at: health.newest_content_at ?? null,
      saved_content_freshness: health.content_freshness ?? 'missing', current_live_state_verified: false,
      source_daily_attribution_available: single, outcome_order_exported: false,
      health_evidence_after_selected_period: !!checked && Date.parse(checked) >= Date.parse(shift(date, 1)) },
    daily: attributed(1), weekly: attributed(7), monthly: attributed(30),
    days: Array.from({ length: 7 }, (_, index) => { const d = shift(date, index - 6); return { date: d, period: period(activity, d, now),
      checks: null, successful_checks: null, attributed_source_new_urls: null, new_unique_candidate_urls: null }; }) };
}

export class RemoteQualityStore {
  private readonly call: RemoteQualityCall;
  private readonly injected: boolean;
  private cached: { at: number; value: Row } | null = null;
  private pending: Promise<Row> | null = null;
  private readonly overviewTimeoutMs: number;
  constructor(call?: RemoteQualityCall, options: { overviewTimeoutMs?: number } = {}) {
    this.call = call ?? readRemoteNewsTool; this.injected = !!call; this.overviewTimeoutMs = options.overviewTimeoutMs ?? 20000;
    if (!Number.isInteger(this.overviewTimeoutMs) || this.overviewTimeoutMs < 1 || this.overviewTimeoutMs > 20000) throw Error('Invalid remote overview deadline');
  }

  async overview(date?: string, country?: string): Promise<Row> {
    const selected = selection(date), code = country?.toUpperCase();
    if (code && !/^[A-Z]{2,8}$/.test(code)) throw Error('Invalid country');
    const cacheable = !this.injected && date === undefined && country === undefined;
    if (cacheable && this.cached && this.cached.value.date === selected.date && selected.now - this.cached.at < 60000) return this.cached.value;
    if (cacheable && this.pending) return this.pending;
    const build = async () => {
      const started = Date.now(), signal = AbortSignal.timeout(this.overviewTimeoutMs);
      const bounded = (name: string, args: Record<string, unknown>) => untilAborted(this.call(name, args, signal), signal);
      const infos: Row[] = []; let offset: number | null = 0, meta: Row = {}, pages = 0;
      while (offset !== null && infos.length < 73 && pages++ < 20) {
        if (signal.aborted) { if (!infos.length) throw Error('REMOTE_QUALITY_OVERVIEW_DEADLINE'); break; }
        let response: Row;
        try { response = await bounded('get_country_source_inventory', { include_disabled: true, offset, limit: 50 }); }
        catch (error) { if (!infos.length || !signal.aborted) throw error; break; }
        meta = response; infos.push(...(response.items ?? []).slice(0, 73 - infos.length));
        const next = response.next_offset;
        if (next !== null && next !== undefined && (typeof next !== 'number' || next <= offset)) throw Error('Invalid remote inventory pagination');
        offset = next ?? null;
      }
      const chosen = code ? infos.filter(info => info.country === code) : infos;
      if (code && !chosen.length) throw Error(signal.aborted ? 'REMOTE_QUALITY_OVERVIEW_DEADLINE' : 'Unknown country');
      const activities = await mapFour(chosen, async info => {
        if (signal.aborted) return { items: [], lookup_error: 'REMOTE_QUALITY_OVERVIEW_DEADLINE', lookup_attempted: false };
        // The overview renders seven daily points; longer aggregates cannot establish an endpoint-cohort baseline.
        try { return await bounded('get_country_article_activity', { country: info.country, start_date: shift(selected.date, -6),
          end_date: selected.date, timezone: 'UTC', limit: 50 }); }
        catch (error) { return { items: [], lookup_error: signal.aborted ? 'REMOTE_QUALITY_OVERVIEW_DEADLINE' : error instanceof Error ? error.message.slice(0, 512) : 'Remote activity lookup failed', lookup_attempted: true }; }
      });
      const rows = chosen.map((info, index) => countryRow(info, activities[index], selected.date, selected.now));
      const latest = activities.map(activity => dated(activity.latest_collection)).filter(Boolean).sort().at(-1) ?? null;
      const snapshots = activities.map(activity => dated(activity.snapshot_at)).filter(Boolean).sort();
      const inventoryPartial = offset !== null || (finite(meta.total) ?? infos.length) > infos.length;
      const checkedCountries = activities.filter(activity => !activity.lookup_error).length;
      const value = { date: selected.date, timezone: 'UTC', evaluated_at: new Date(selected.now).toISOString(),
        snapshot_at: snapshots.at(-1) ?? null, snapshot_times: [...new Set(snapshots)], latest_collection: latest,
        registry_snapshot_at: dated(meta.registry_snapshot_at), history_available_since: activities.map(activity => dated(activity.history_available_since)).filter(Boolean).sort().at(0) ?? null,
        snapshot_age_seconds: snapshots.length ? Math.max(0, (selected.now - Date.parse(snapshots.at(-1)!)) / 1000) : null,
        source: 'remote_cached_mcp', live_state_verified: false,
        common_collector_signal: { state: 'not_established', affected_countries: [], eligible_baseline_countries: 0,
          total_catalog_countries: finite(meta.total) ?? infos.length, checked_country_count: checkedCountries,
          requested_country_count: chosen.length,
          assessment_scope: code ? 'selected_country_only' : inventoryPartial || checkedCountries < chosen.length ? 'bounded_country_sample' : 'all_catalog_countries',
          reason: 'Remote aggregates do not export comparable historical endpoint cohorts or completed cycles; shared collector failure is not established.' },
        metric_semantics: 'Attempts/current registered typed endpoints and successful article endpoints/attempts, read from saved remote daily aggregates. These are not live publisher checks or publication counts. Current configuration denominators are not historical inventory.',
        items: rows, total: rows.length, offset: 0, next_offset: null, inventory_changes: unknownChanges(rows, selected.date, dated(meta.registry_snapshot_at)),
        global_inventory: { active_countries: finite(meta.global_totals?.active_countries),
          active_source_registrations: finite(meta.global_totals?.active_source_registrations),
          unique_active_rss_endpoints: finite(meta.global_totals?.unique_active_rss_endpoints),
          unique_active_sitemap_endpoints: finite(meta.global_totals?.unique_active_sitemap_endpoints), unique_publishers: null,
          count_semantics: 'Remote global totals preserve cross-country endpoint deduplication. Country endpoint counts must not be summed into global unique totals.' },
        runtime: { data_source: 'remote_cached_mcp', mcp_endpoint: REMOTE_NEWS_MCP_URL, model_provider: 'rules', model_api_configured: false,
          sources_read_only: true, publisher_fetches: false, country_limit: 73, inventory_partial: inventoryPartial,
          overview_duration_ms: Date.now() - started, overview_deadline_ms: this.overviewTimeoutMs, overview_timed_out: signal.aborted,
          unqueried_country_count: activities.filter(activity => activity.lookup_attempted === false).length,
          failed_country_lookups: activities.filter(activity => activity.lookup_error).length } };
      if (cacheable) this.cached = { at: Date.now(), value }; return value;
    };
    if (!cacheable) return build();
    this.pending = build();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async country(country: string, date?: string): Promise<Row> {
    const code = country.toUpperCase(); if (!/^[A-Z]{2,8}$/.test(code)) throw Error('Invalid country');
    const overview = await this.overview(date, code), sources: Row[] = [];
    let offset: number | null = 0, total: number | null = null, pages = 0;
    while (offset !== null && sources.length < 500 && pages++ < 30) {
      const response = await this.call('search_sources', { country: code, enabled: true, offset, limit: 50 });
      sources.push(...(response.items ?? []).slice(0, 500 - sources.length)); total = finite(response.total);
      const next = response.next_offset;
      if (next !== null && next !== undefined && (typeof next !== 'number' || next <= offset)) throw Error('Invalid remote source pagination');
      offset = next ?? null;
    }
    return { country: overview.items[0], date: overview.date, snapshot_at: overview.snapshot_at, latest_collection: overview.latest_collection,
      sources, source_list_state: offset !== null || total !== null && total > sources.length ? 'partial' : 'complete',
      source_list_limit: 500, source_count: sources.length, source_total: total,
      inventory_changes: overview.inventory_changes, source: 'remote_cached_mcp', runtime: overview.runtime };
  }

  async source(sourceId: string, date?: string): Promise<Row> {
    if (!/^src_[a-f0-9]{24}$/.test(sourceId)) throw Error('Invalid source_id');
    const selected = selection(date), source = await this.call('get_source', { source_id: sourceId });
    const activity = await this.call('get_source_article_activity', { source_id: sourceId, start_date: shift(selected.date, -29),
      end_date: selected.date, timezone: 'UTC', limit: 50 });
    return { source: { id: source.id, name: source.name, country: source.countryCode, country_name: source.countryName,
        enabled: source.enabled, active_registration_count: source.activeRegistrationCount, language: source.language ?? null,
        category: source.category ?? null, enabled_changed_at: source.enabled_changed_at ?? null, status_reason: source.status_reason ?? null,
        status_history: source.status_history ?? [], status_transition_count: source.status_transition_count ?? null,
        status_history_consistent: source.status_history_consistent ?? null, recorded_addition_at: null },
      date: selected.date, timezone: 'UTC', snapshot_at: dated(activity.snapshot_at), latest_collection: dated(activity.latest_collection),
      period: period(activity, selected.date, selected.now), initialization: activity.initialization ?? 'unknown',
      article_activity: { daily: aggregate(activity, selected.date, 1, 'selected_calendar_day', selected.now),
        weekly: aggregate(activity, selected.date, 7, 'trailing_7_calendar_days', selected.now),
        monthly: aggregate(activity, selected.date, 30, 'trailing_30_calendar_days', selected.now), days: activity.items ?? [] },
      endpoints: (source.endpoints ?? []).map((endpoint: Row) => endpointDetail(endpoint, source, activity, selected.date, selected.now)),
      semantics: activity.semantics ?? 'First-discovered candidate URLs after excluded binding baselines, not publication counts.',
      dedup_scope: 'Use source totals or country totals in their respective deduplication scopes. Endpoint allocations and independent endpoint counts are not exported.',
      data_source: 'remote_cached_mcp', live_state_verified: false };
  }
}
