import { z } from 'zod';
import { page, pagination, type Catalog } from './catalog.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const at = Date.parse(value); return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value; }, 'Invalid date');
const timezone = z.string().max(100).default('UTC').refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Invalid IANA timezone');
const activityFields = { mode: z.enum(['calendar_days', 'rolling_24h']).default('calendar_days'), start_date: day.optional(), end_date: day.optional(), timezone, ...pagination };
export const sourceActivitySchema = z.object({ source_id: z.string().regex(/^src_[a-f0-9]{24}$/), ...activityFields }).strict();
export const countryActivitySchema = z.object({ country: z.string().min(2).max(8), ...activityFields }).strict();
export const inventorySchema = z.object({ country: z.string().min(2).max(8).optional(), include_disabled: z.boolean().default(false), ...pagination }).strict();
export type ActivitySnapshot = { version: number; lane: string; generated_at: string; tracking_start: string | null; available_since: string; registry_at: string | null; semantics: string; bindings: Array<Record<string, unknown>>; collections: Array<Record<string, any>>; scope_starts?: { source: Record<string,string>; country: Record<string,string> } };
export function localDate(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
// Locate a local calendar boundary rather than assuming every day has 24 hours.
export function dayBoundary(date: string, zone: string) {
  const nominal = Date.parse(date); let low = nominal - 36 * 3600000, high = nominal + 36 * 3600000;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (localDate(mid, zone) < date) low = mid + 1; else high = mid; }
  return low;
}
const nextDay = (value: string) => new Date(Date.parse(value) + 86400000).toISOString().slice(0, 10);
export class ActivityStore {
  constructor(readonly snapshot?: ActivitySnapshot) {
    if (snapshot && (snapshot.version !== 1 || snapshot.lane !== 'production' || !Array.isArray(snapshot.bindings) || !Array.isArray(snapshot.collections))) throw new Error('Invalid production activity snapshot');
  }
  query(catalog: Catalog, kind: 'source' | 'country', raw: unknown, now = Date.now()) {
    const input = kind === 'source' ? sourceActivitySchema.parse(raw) : countryActivitySchema.parse(raw);
    const scope = 'source_id' in input ? input.source_id : input.country.toUpperCase();
    const sources = catalog.sources.filter(s => kind === 'source' ? s.id === scope : s.enabled && s.countryCode === scope);
    if (kind === 'source' && !catalog.sources.some(s => s.id === scope) || kind === 'country' && !catalog.countries.some(c => c.code === scope)) throw new Error('Unknown activity scope');
    const expected = new Set(sources.flatMap(s => s.endpoints.map(e => e.id)));
    const sourceIds = new Set(sources.map(s => s.id));
    const snapshot = this.snapshot;
    const events = (snapshot?.collections ?? []).filter(e => kind === 'source' ? e.source_ids.includes(scope) : e.countries.includes(scope));
    const scopeStart = snapshot?.scope_starts?.[kind][scope] ?? events[0]?.checked_at ?? null;
    const binding = (snapshot?.bindings ?? []).filter(b => sourceIds.has(String(b.source_id)) && expected.has(String(b.endpoint_id)));
    const initializedBindings = binding.filter(b => b.baseline_at);
    let ranges: Array<{ label: string; from: number; to: number }> = [];
    if (input.mode === 'rolling_24h') {
      if (input.start_date || input.end_date) throw new Error('rolling_24h does not accept calendar dates');
      ranges = [{ label: 'rolling_24h', from: now - 86400000, to: now }];
    } else {
      const end = input.end_date ?? localDate(now, input.timezone), start = input.start_date ?? end;
      if (start > end || Date.parse(end) - Date.parse(start) > 30 * 86400000 || end > localDate(now, input.timezone)) throw new Error('Date range must be past/present and at most 31 days');
      for (let date = start; date <= end; date = nextDay(date)) ranges.push({ label: date, from: dayBoundary(date, input.timezone), to: dayBoundary(nextDay(date), input.timezone) });
    }
    const periods = ranges.map(range => {
      const records = events.filter(e => Date.parse(e.checked_at) >= range.from && Date.parse(e.checked_at) < range.to);
      const successful = records.filter(e => ['working_nonempty', 'valid_empty'].includes(e.status) && e.format !== 'sitemapindex');
      const targeted = new Set(records.map(e => e.endpoint_id));
      const successIds = new Set(successful.map(e => e.endpoint_id));
      const beforeTracking = !scopeStart || range.to <= Date.parse(scopeStart);
      const unavailable = !!snapshot && range.from < Date.parse(snapshot.available_since);
      const state = beforeTracking ? 'not_tracked' : unavailable ? 'history_not_in_snapshot' : !records.length ? 'not_collected' : !successful.length ? 'failed_or_index_only' : successIds.size < expected.size ? 'partial' : 'complete';
      return { period: range.label, from: new Date(range.from).toISOString(), to_exclusive: new Date(range.to).toISOString(),
        new_unique_candidate_urls: beforeTracking || unavailable || !successful.length ? null : successful.reduce((total, e) => total + Number((kind === 'source' ? e.source_new : e.country_new)[scope] ?? 0), 0),
        state, expected_endpoints: expected.size, targeted_endpoints: targeted.size, successful_article_endpoints: successIds.size,
        failed_checks: records.filter(e => !['working_nonempty', 'valid_empty'].includes(e.status)).length,
        index_only_checks: records.filter(e => e.format === 'sitemapindex').length,
        uncertain_url_observations: successful.reduce((total, e) => total + e.uncertain_urls, 0),
        baseline_checks: successful.filter(e => e.baseline_sources.some((id: string) => sourceIds.has(id))).length };
    });
    return { scope_kind: kind, scope_id: scope, metric: 'first_discovered_unique_candidate_url_after_binding_baseline', timezone: input.timezone, mode: input.mode,
      tracking_start: snapshot?.tracking_start ?? null, scope_tracking_start: scopeStart,
      latest_collection: events.at(-1)?.checked_at ?? null, snapshot_at: snapshot?.generated_at ?? null, coverage_registry_at: snapshot?.registry_at ?? null,
      coverage_semantics: 'Complete means every currently configured endpoint had at least one successful non-index check in the interval. It does not prove every article was seen; the interval may still be open.',
      initialized_bindings: initializedBindings.length, expected_bindings: sources.reduce((n, s) => n + s.endpoints.length, 0),
      initialization: !initializedBindings.length ? 'not_initialized' : initializedBindings.length < sources.reduce((n, s) => n + s.endpoints.length, 0) ? 'partial' : 'initialized',
      semantics: snapshot?.semantics ?? 'Article URL history has not been collected. Counts are not publication or entry counts.',
      ...page(periods, input.offset, input.limit) };
  }
}
export function countryInventory(catalog: Catalog, raw: unknown, at = new Date().toISOString()) {
  const input = inventorySchema.parse(raw);
  if (input.country && !catalog.countries.some(c => c.code === input.country!.toUpperCase())) throw new Error('Unknown country');
  const items = catalog.countries.filter(c => !input.country || c.code === input.country.toUpperCase()).map(country => {
    const all = catalog.sources.filter(s => s.countryCode === country.code), active = all.filter(s => s.enabled);
    const ids = (type: 'rss' | 'sitemap', sources = active) => new Set(sources.flatMap(s => s.endpoints.filter(e => e.type === type).map(e => e.id))).size;
    return { country: country.code, name: country.name, active_source_registrations: all.reduce((n, s) => n + s.activeRegistrationCount, 0), active_normalized_sources: active.length,
      unique_active_rss_endpoints: ids('rss'), unique_active_sitemap_endpoints: ids('sitemap'),
      ...(input.include_disabled ? { disabled_source_registrations: all.reduce((n, s) => n + s.disabledRegistrationCount, 0), unique_configured_rss_endpoints: ids('rss', all), unique_configured_sitemap_endpoints: ids('sitemap', all) } : {}) };
  });
  const active = catalog.sources.filter(source => source.enabled);
  return { registry_snapshot_at: at, global_totals: { active_countries: new Set(active.map(s => s.countryCode)).size, active_source_registrations: catalog.sources.reduce((n, s) => n + s.activeRegistrationCount, 0),
    unique_active_rss_endpoints: new Set(active.flatMap(s => s.endpoints.filter(e => e.type === 'rss').map(e => e.id))).size,
    unique_active_sitemap_endpoints: new Set(active.flatMap(s => s.endpoints.filter(e => e.type === 'sitemap').map(e => e.id))).size },
    semantics: 'Source registrations, not unique publishers; unique endpoint IDs preserve RSS and sitemap type. Configuration counts, not health or article coverage.', ...page(items, input.offset, input.limit) };
}
