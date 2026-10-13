import { canonicalUrl, stableId, type Catalog, type Endpoint, type Source } from './catalog.js';
import { type HealthStore } from './health.js';
import { estimatePublisherInventory } from './publisher-inventory.js';

type Raw = Record<string, unknown>;
const object = (value: unknown): Raw | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null;
const boundedText = (value: unknown, maximum = 512) => typeof value === 'string' && value.trim() && value.length <= maximum ? value : null;
const timestamp = (value: unknown, now: number) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now ? new Date(at).toISOString() : null;
};
const publicUrl = (value: unknown) => {
  if (typeof value !== 'string') return null;
  try { return canonicalUrl(value); } catch { return null; }
};

// Registry metadata is retained only in memory. Project approved public fields;
// never spread arbitrary raw registry fields into an HTTP response.
function rawRegistrations(rawRegistry: unknown): Map<string, Raw[]> {
  const registrations = new Map<string, Raw[]>(), registry = object(rawRegistry);
  for (const rawCountry of Array.isArray(registry?.countries) ? registry.countries : []) {
    const country = object(rawCountry);
    if (!country || typeof country.code !== 'string' || !Array.isArray(country.feeds)) continue;
    for (const rawFeed of country.feeds) {
      const feed = object(rawFeed);
      if (!feed || typeof feed.name !== 'string') continue;
      const endpointIds: string[] = [];
      let malformed = false;
      for (const [type, value] of [['rss', feed.url], ['sitemap', feed.sitemapUrl]] as const) {
        if (value === undefined || value === null || value === '') continue;
        const url = publicUrl(value);
        if (!url) { malformed = true; break; }
        endpointIds.push(stableId('ep', [type, url]));
      }
      if (malformed) continue;
      const sourceId = stableId('src', [country.code.trim().toUpperCase(), feed.name.trim().normalize('NFKC').toLowerCase(), ...endpointIds.sort()]);
      const matches = registrations.get(sourceId) ?? [];
      matches.push(feed); registrations.set(sourceId, matches);
    }
  }
  return registrations;
}

function initialRegistration(feed: Raw, now: number) {
  const batch = typeof feed.registry_addition_batch === 'string' && /^[a-z0-9-]{1,64}$/.test(feed.registry_addition_batch) ? feed.registry_addition_batch : null;
  // enabled_changed_at normally means a state transition, NOT creation. This
  // exact operator-additions shape is the one exception supported by evidence.
  if (!batch || feed.enabled !== true || feed.status_transition_count !== 0
    || !Array.isArray(feed.status_history) || feed.status_history.length !== 0
    || feed.status_reason !== `Initial registration from verified official declarations (${batch}).`) return null;
  const at = timestamp(feed.enabled_changed_at, now);
  return at ? { recorded_at: at, batch_id: batch } : null;
}

const provenanceKinds = new Set(['official_html_feed_link', 'official_html_feed_anchor', 'official_robots_sitemap',
  'official_sitemap_index_enumerated_child', 'official_sitemap_index_child_ranked']);
function endpointProvenance(feed: Raw, endpoint: Endpoint, now: number) {
  return (Array.isArray(feed.endpoint_provenance) ? feed.endpoint_provenance : []).flatMap(value => {
    const record = object(value);
    if (!record || record.type !== endpoint.type || publicUrl(record.url) !== endpoint.url
      || typeof record.kind !== 'string' || !provenanceKinds.has(record.kind)) return [];
    return [{ kind: record.kind, source_url: publicUrl(record.source_url), found_at: timestamp(record.found_at, now),
      page_sha256: typeof record.page_sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.page_sha256) ? record.page_sha256 : null,
      declaration: boundedText(record.declaration), tag: boundedText(record.tag),
      declared_lastmod: boundedText(record.declared_lastmod, 128),
      validation_checked_at: timestamp(record.checked_at, now), format: boundedText(record.format, 32),
      scope_note: boundedText(record.scope_note) }];
  });
}

function sourceAddition(source: Source, feeds: Raw[], health: HealthStore, catalog: Catalog, now: number) {
  if (feeds.length !== source.registrationCount || !source.status_history_consistent) return null;
  const initial = feeds.map(feed => initialRegistration(feed, now));
  const first = initial[0];
  if (!first || initial.some(value => !value || value.recorded_at !== first.recorded_at || value.batch_id !== first.batch_id)) return null;
  return { source_id: source.id, country: source.countryCode, name: source.name,
    endpoint_types: source.endpoints.map(endpoint => endpoint.type), ...first,
    recorded_at_basis: 'operator_initial_registration' as const,
    registration_count: source.registrationCount, source_homepage: publicUrl(feeds[0].source_homepage),
    endpoints: source.endpoints.map(endpoint => ({ endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url,
      provenance: endpointProvenance(feeds[0], endpoint, now), latest_validation: health.get(endpoint, catalog.sources, now) })) };
}

/** Recorded changes on one UTC day; holdings always describe the current catalog. */
export function getInventoryChanges(catalog: Catalog, rawRegistry: unknown, date: string, health: HealthStore, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Invalid inventory observation time');
  const from = Date.parse(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(from) || new Date(from).toISOString().slice(0, 10) !== date
    || date > new Date(now).toISOString().slice(0, 10)) throw new Error('Inventory date must be a valid past/present UTC date');
  const onDate = (value: string) => Date.parse(value) >= from && Date.parse(value) < from + 86400000 && Date.parse(value) <= now;
  const raw = rawRegistrations(rawRegistry);
  const knownAdditions = catalog.sources.flatMap(source => {
    const addition = sourceAddition(source, raw.get(source.id) ?? [], health, catalog, now);
    return addition ? [addition] : [];
  });
  const knownIds = new Set(knownAdditions.map(addition => addition.source_id));
  const additions = knownAdditions.filter(addition => onDate(addition.recorded_at))
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.source_id.localeCompare(b.source_id));
  const sourceTransitions = catalog.sources.flatMap(source => source.status_history_consistent ? source.status_history
    .flatMap(transition => {
      const at = timestamp(transition.changed_at, now);
      return at && onDate(at) ? [{ source_id: source.id, country: source.countryCode, name: source.name,
        kind: transition.new_enabled ? 'reactivation' as const : 'deactivation' as const,
        recorded_at: at, reason: transition.reason, old_enabled: transition.old_enabled, new_enabled: transition.new_enabled,
        registration_count: source.registrationCount }] : [];
    }) : []).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.source_id.localeCompare(b.source_id));
  const perCountry = catalog.countries.map(country => {
    const sources = catalog.sources.filter(source => source.countryCode === country.code), active = sources.filter(source => source.enabled);
    const endpoints = (type: 'rss' | 'sitemap') => new Set(active.flatMap(source => source.endpoints.filter(endpoint => endpoint.type === type).map(endpoint => endpoint.id))).size;
    return { country: country.code, name: country.name,
      additions: additions.filter(addition => addition.country === country.code).length,
      deactivations: sourceTransitions.filter(transition => transition.country === country.code && transition.kind === 'deactivation').length,
      reactivations: sourceTransitions.filter(transition => transition.country === country.code && transition.kind === 'reactivation').length,
      deletions: null, net_change: null, history_complete: false as const,
      unknown_addition_timestamps: sources.filter(source => !knownIds.has(source.id)).length,
      current_holdings: { active_source_registrations: sources.reduce((count, source) => count + source.activeRegistrationCount, 0),
        disabled_source_registrations: sources.reduce((count, source) => count + source.disabledRegistrationCount, 0),
        configured_source_registrations: sources.reduce((count, source) => count + source.registrationCount, 0),
        active_normalized_sources: active.length, configured_normalized_sources: sources.length,
        unique_active_rss_endpoints: endpoints('rss'), unique_active_sitemap_endpoints: endpoints('sitemap'), ...estimatePublisherInventory(active) } };
  });
  return { date, timezone: 'UTC' as const, as_of: new Date(now).toISOString(), history_complete: false as const,
    recorded_events_only: true as const, per_country: perCountry, additions, source_transitions: sourceTransitions,
    unknown_addition_timestamp_count: catalog.sources.length - knownIds.size,
    known_addition_timestamp_count: knownIds.size,
    semantics: 'Changes count recorded normalized-source events on the selected UTC date among sources still present in the current registry. Zero recorded events does not establish zero actual changes. Current holdings are configuration counts at as_of, not historical holdings. Missing creation dates remain unknown; first observation and endpoint validation are not registration dates. Deactivation is not deletion. No deletion ledger exists, so deletions and net change are unknown. Publisher counts are brand estimates from domains and explicit aliases, not verified legal entities or ownership groups. Endpoint deduplication uses type plus canonical URL within each country; registration rows and normalized sources are distinct.' };
}
