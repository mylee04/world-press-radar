import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { canonicalUrl, page, pagination, searchSchema, type Catalog, type Source } from './catalog.js';
import type { HealthStore } from './health.js';
import type { ActivityStore } from './activity.js';
import { describeEndpointStatus } from './endpoint-status.js';

const text = z.string().trim().min(1).max(1024).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'Invalid control character');
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,79}$/);
const publicUrl = z.string().max(2048).refine(value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash; } catch { return false; } }, 'Public HTTP(S) URL required');
const observedDate = z.string().max(40).refine(value => /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)), 'Review date required');
const localized = z.object({ en: text, ko: text });
const evidenceSchema = z.object({ url: publicUrl, claim: text, checked_at: observedDate }).passthrough();
const endpointSchema = z.object({ type: z.enum(['rss', 'sitemap']), url: publicUrl, evidence: z.array(evidenceSchema).min(1).max(8) }).passthrough();
const entrySchema = z.object({ publisher_id: slug, name: text, aliases: z.array(text).max(12), language: z.string().min(2).max(16), topics: z.array(text).min(1).max(12),
  scope: z.enum(['whole_publisher', 'section']), scope_description: text, homepage: publicUrl,
  evidence: z.array(evidenceSchema).min(1).max(12), endpoints: z.array(endpointSchema).min(1).max(6),
  selection_group: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional(), usage_notes: text.optional() }).passthrough();
const gapSchema = z.object({ publisher: text, reason: text, evidence_url: publicUrl.optional() }).passthrough();
const packSchema = z.object({ id: slug, title: localized, description: localized, country: z.string().regex(/^[A-Z]{2}$/), language: z.string().min(2).max(16),
  topics: z.array(text).min(1).max(12), selection_criteria: z.array(text).min(1).max(12), entries: z.array(entrySchema).min(1).max(30), gaps: z.array(gapSchema).max(30) }).passthrough();
export const sourcePackDocumentSchema = z.object({ version: z.literal(1), reviewed_at: observedDate, packs: z.array(packSchema).min(1).max(10) }).passthrough()
  .superRefine((document, context) => {
    if (new Set(document.packs.map(pack => pack.id)).size !== document.packs.length) context.addIssue({ code: 'custom', message: 'Duplicate pack identity' });
    for (const pack of document.packs) if (new Set(pack.entries.map(entry => entry.publisher_id)).size !== pack.entries.length) context.addIssue({ code: 'custom', message: 'Duplicate publisher identity in pack' });
  });
export type SourcePackDocument = z.infer<typeof sourcePackDocumentSchema>;
export const listSourcePacksSchema = z.object({ country: z.string().regex(/^[A-Za-z]{2}$/).optional(), language: z.string().min(2).max(16).optional(), ...pagination }).strict();
export const getSourcePackSchema = z.object({ pack_id: slug, ...pagination }).strict();
export const exportSourcePackSchema = z.object({ pack_id: slug, format: z.enum(['opml', 'csv', 'json']).default('opml'), include: z.enum(['usable', 'all']).default('usable') }).strict();
export const curatedSearchSchema = searchSchema.extend({ pack_id: slug.optional() }).strict();
let cachedDocument: SourcePackDocument | undefined;
export function loadSourcePacks(path = new URL('../curation/source-packs.json', import.meta.url)): SourcePackDocument {
  if (!cachedDocument || path.href !== new URL('../curation/source-packs.json', import.meta.url).href) {
    if (statSync(path).size > 1024 * 1024) throw Error('SOURCE_PACK_DOCUMENT_TOO_LARGE');
    const document = sourcePackDocumentSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (path.href === new URL('../curation/source-packs.json', import.meta.url).href) cachedDocument = document;
    return document;
  }
  return cachedDocument;
}

const MAX_DEFAULT_OBSERVATION_AGE = 36 * 3600000;
type StatusEvidence = ReturnType<typeof describeEndpointStatus>;
type ResolvedEndpoint = { endpoint_id: string; type: 'rss' | 'sitemap'; url: string; enabled: boolean; evidence: z.infer<typeof evidenceSchema>[]; status_evidence: StatusEvidence; default_export_eligible: boolean; exclusion_reason: string | null };
function eligible(endpoint: ResolvedEndpoint, now: number) {
  const status = endpoint.status_evidence;
  const time = status.observed_at ? Date.parse(status.observed_at) : NaN;
  if (!endpoint.enabled) return 'registration_disabled';
  if (status.usable !== true) return `endpoint_${status.status}`;
  if (!Number.isFinite(time) || time > now || now - time > MAX_DEFAULT_OBSERVATION_AGE) return 'observation_older_than_36_hours';
  if (['stale', 'unreliable'].includes(status.content.freshness)) return `content_${status.content.freshness}`;
  const contentTime = status.content.newest_content_at ? Date.parse(status.content.newest_content_at) : NaN;
  if (Number.isFinite(contentTime) && now - contentTime > 30 * 86400000) return 'recorded_content_date_older_than_30_days';
  return null;
}

export function resolveSourcePacks(catalog: Catalog, health: HealthStore, activity: ActivityStore, document = loadSourcePacks(), now = Date.now()) {
  const byEndpoint = new Map<string, Source[]>();
  for (const source of catalog.sources) for (const endpoint of source.endpoints) byEndpoint.set(endpoint.id, [...(byEndpoint.get(endpoint.id) ?? []), source]);
  const result = document.packs.map(pack => {
    const unique = new Map<string, ResolvedEndpoint>();
    const entries = pack.entries.map(entry => {
      const sources = catalog.sources.filter(source => source.countryCode === pack.country && source.endpoints.some(endpoint => entry.endpoints.some(selected => selected.type === endpoint.type && canonicalUrl(selected.url) === endpoint.url)))
        .map(source => ({ source_id: source.id, name: source.name, enabled: source.enabled,
          endpoints: source.endpoints.flatMap(endpoint => {
            const selected = entry.endpoints.find(value => value.type === endpoint.type && canonicalUrl(value.url) === endpoint.url);
            if (!selected) return [];
            const value: ResolvedEndpoint = { endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url, enabled: source.enabled,
              evidence: selected.evidence, status_evidence: describeEndpointStatus(endpoint, byEndpoint.get(endpoint.id) ?? [source], health, activity, now), default_export_eligible: false, exclusion_reason: null };
            value.exclusion_reason = eligible(value, now); value.default_export_eligible = value.exclusion_reason === null;
            const prior = unique.get(endpoint.id); if (!prior || !prior.enabled && value.enabled) unique.set(endpoint.id, value);
            return [value];
          }) }));
      const present = new Set(sources.flatMap(source => source.endpoints.map(endpoint => `${endpoint.type}:${endpoint.url}`)));
      const unregistered_endpoints = entry.endpoints.filter(endpoint => !present.has(`${endpoint.type}:${canonicalUrl(endpoint.url)}`));
      return { ...entry, sources, unregistered_endpoints, resolution_state: !sources.length ? 'not_registered' : unregistered_endpoints.length ? 'partial' : sources.every(source => !source.enabled) ? 'disabled_only' : 'registered' };
    });
    const endpoints = [...unique.values()], enabled = endpoints.filter(endpoint => endpoint.enabled);
    const defaultExport = endpoints.filter(endpoint => endpoint.default_export_eligible);
    return { ...pack, entries, reviewed_at: document.reviewed_at,
      summary: { publishers: entries.length, available_publishers: entries.filter(entry => entry.sources.some(source => source.endpoints.some(endpoint => endpoint.default_export_eligible))).length,
        enabled_endpoints: enabled.length, usable_rss: defaultExport.filter(endpoint => endpoint.type === 'rss').length, usable_sitemaps: defaultExport.filter(endpoint => endpoint.type === 'sitemap').length,
        default_export_endpoints: defaultExport.length, excluded_endpoints: endpoints.length - defaultExport.length,
        unknown_or_unusable: enabled.filter(endpoint => !endpoint.default_export_eligible).length, unregistered_endpoints: entries.reduce((sum, entry) => sum + entry.unregistered_endpoints.length, 0) } };
  });
  return { snapshot_at: activity.snapshot?.generated_at ?? null, reviewed_at: document.reviewed_at, evaluated_at: new Date(now).toISOString(),
    export_policy: { default: 'usable', maximum_observation_age_hours: 36, maximum_recorded_content_age_days: 30, excludes: ['disabled', 'failed', 'unknown', 'stale', 'valid_empty', 'index_only', 'stale_or_unreliable_content'], missing_content_dates: 'explicitly_unknown_not_certified_fresh', includes_only_registered_bindings: true },
    semantics: 'Curated starter selections, not exhaustive or editorial reliability ratings. Saved observations are environment-specific; first import in another collector is not guaranteed. No publisher fetch occurs during this request.', packs: result };
}
type ResolvedPacks = ReturnType<typeof resolveSourcePacks>;
export function listSourcePacks(resolved: ResolvedPacks, raw: unknown) {
  const input = listSourcePacksSchema.parse(raw);
  const items = resolved.packs.filter(pack => (!input.country || pack.country === input.country.toUpperCase()) && (!input.language || pack.language === input.language))
    .map(({ entries, ...pack }) => ({ ...pack, download_urls: downloadUrls(pack.id) }));
  return { snapshot_at: resolved.snapshot_at, evaluated_at: resolved.evaluated_at, export_policy: resolved.export_policy, semantics: resolved.semantics, ...page(items, input.offset, input.limit) };
}
export function getSourcePack(resolved: ResolvedPacks, raw: unknown) {
  const input = getSourcePackSchema.parse(raw), pack = resolved.packs.find(value => value.id === input.pack_id);
  if (!pack) throw Error('UNKNOWN_SOURCE_PACK');
  const { entries, ...metadata } = pack;
  const selected = [];
  let size = 0;
  for (const entry of entries.slice(input.offset, input.offset + input.limit)) {
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (size + bytes > 48000) break;
    selected.push(entry); size += bytes;
  }
  const next = input.offset + selected.length;
  return { ...metadata, snapshot_at: resolved.snapshot_at, evaluated_at: resolved.evaluated_at, export_policy: resolved.export_policy, semantics: resolved.semantics,
    entries: selected, total: entries.length, offset: input.offset, next_offset: next < entries.length ? next : null, download_urls: downloadUrls(pack.id) };
}
const downloadUrls = (id: string) => Object.fromEntries(['opml', 'csv', 'json'].map(format => [format, `https://news.bymyleslee.com/source-packs/${id}/export?format=${format}`]));
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;');
const csv = (value: unknown) => { let text = value == null ? '' : String(value); if (/^[\s]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
export function exportSourcePack(resolved: ResolvedPacks, raw: unknown) {
  const input = exportSourcePackSchema.parse(raw), pack = resolved.packs.find(value => value.id === input.pack_id);
  if (!pack) throw Error('UNKNOWN_SOURCE_PACK');
  const candidates = new Map<string, Record<string, unknown>>();
  for (const entry of pack.entries) for (const source of entry.sources) for (const endpoint of source.endpoints) {
    const candidate = { publisher_id: entry.publisher_id, publisher: entry.name, source_id: source.source_id, endpoint_id: endpoint.endpoint_id, country: pack.country, language: entry.language,
      topics: entry.topics, scope: entry.scope, scope_description: entry.scope_description, homepage: entry.homepage,
      selection_group: typeof entry.selection_group === 'string' ? entry.selection_group : null,
      usage_notes: typeof entry.usage_notes === 'string' ? entry.usage_notes : null,
      type: endpoint.type, url: endpoint.url, enabled: endpoint.enabled, default_export_eligible: endpoint.default_export_eligible, exclusion_reason: endpoint.exclusion_reason,
      evidence: [...entry.evidence, ...endpoint.evidence], status_evidence: endpoint.status_evidence };
    const prior = candidates.get(endpoint.endpoint_id);
    if (!prior || !prior.default_export_eligible && candidate.default_export_eligible || !prior.enabled && candidate.enabled) candidates.set(endpoint.endpoint_id, candidate);
  }
  const typed = [...candidates.values()].filter(item => input.format !== 'opml' || item.type === 'rss');
  const nonRss = candidates.size - typed.length;
  const items = typed.filter(item => input.include === 'all' || item.default_export_eligible);
  const excluded = typed.length - items.length;
  const meta = { pack_id: pack.id, title: pack.title, format: input.format, include: input.include, snapshot_at: resolved.snapshot_at, evaluated_at: resolved.evaluated_at,
    exported_endpoints: items.length, excluded_endpoints: excluded, sitemap_endpoints_omitted_from_opml: nonRss, unregistered_endpoints: pack.summary.unregistered_endpoints,
    gaps: pack.gaps, export_policy: resolved.export_policy, semantics: resolved.semantics };
  let content: string;
  if (input.format === 'opml') content = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>${xml(pack.title.en)}: RSS only</title><dateCreated>${xml(resolved.evaluated_at)}</dateCreated></head><body>\n${items.map(item => `<outline type="rss" text="${xml(String(item.publisher))}" title="${xml(String(item.publisher))}" xmlUrl="${xml(String(item.url))}" htmlUrl="${xml(String(item.homepage))}"/>`).join('\n')}\n</body></opml>\n`;
  else if (input.format === 'csv') {
    const columns = ['publisher', 'country', 'language', 'topics', 'scope', 'type', 'url', 'enabled', 'default_export_eligible', 'status', 'observed_at', 'last_collection_at', 'last_structural_audit_at', 'content_date', 'content_date_kind', 'content_freshness', 'exclusion_reason', 'evidence_urls', 'selection_group', 'usage_notes'];
    const values = items.map(item => { const status = item.status_evidence as StatusEvidence; return [item.publisher, item.country, item.language, (item.topics as string[]).join(';'), item.scope, item.type, item.url, item.enabled, item.default_export_eligible,
      status.status, status.observed_at, status.latest_collection?.checked_at, status.structural_audit?.checked_at, status.content.newest_content_at, status.content.date_kind, status.content.freshness, item.exclusion_reason,
      [...new Set((item.evidence as Array<{url:string}>).map(evidence => evidence.url))].join(';'), item.selection_group, item.usage_notes]; });
    content = '\ufeff' + [columns, ...values].map(row => row.map(csv).join(',')).join('\r\n') + '\r\n';
  } else content = JSON.stringify({ ...meta, endpoints: items }, null, 2) + '\n';
  if (Buffer.byteLength(content) > 256 * 1024) throw Error('SOURCE_PACK_EXPORT_TOO_LARGE');
  return { ...meta, filename: `world-news-sources-${pack.id}.${input.format}`, content_type: input.format === 'opml' ? 'text/x-opml; charset=utf-8' : input.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    download_url: downloadUrls(pack.id)[input.format] + (input.include === 'all' ? '&include=all' : ''), content };
}

const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
export function searchCuratedSources(catalog: Catalog, raw: unknown, document = loadSourcePacks()) {
  const input = curatedSearchSchema.parse(raw), query = input.query ? normalized(input.query) : null;
  const wantedLanguage = input.language ? normalized(input.language) : null, wantedCategory = input.category ? normalized(input.category) : null;
  const matches = new Map<string, Array<{ pack_id: string; entry: SourcePackDocument['packs'][number]['entries'][number]; endpoint_ids: string[] }>>();
  for (const pack of document.packs) for (const entry of pack.entries) for (const source of catalog.sources) {
    if (source.countryCode !== pack.country) continue;
    const endpoint_ids = source.endpoints.filter(endpoint => entry.endpoints.some(item => item.type === endpoint.type && canonicalUrl(item.url) === endpoint.url)).map(endpoint => endpoint.id);
    if (endpoint_ids.length) matches.set(source.id, [...(matches.get(source.id) ?? []), { pack_id: pack.id, entry, endpoint_ids }]);
  }
  const ranked = catalog.sources.flatMap(source => {
    const curated = (matches.get(source.id) ?? []).filter(match => !input.pack_id || input.pack_id === match.pack_id);
    if (input.pack_id && !curated.length || input.country && source.countryCode !== input.country.toUpperCase() || input.enabled !== undefined && source.enabled !== input.enabled) return [];
    if (input.endpoint_type && !source.endpoints.some(endpoint => endpoint.type === input.endpoint_type)) return [];
    const typedMatches = curated.filter(match => !input.endpoint_type || source.endpoints.some(endpoint => endpoint.type === input.endpoint_type && match.endpoint_ids.includes(endpoint.id)));
    const metadataMatches = typedMatches.filter(match => (!wantedLanguage || normalized(match.entry.language) === wantedLanguage) && (!wantedCategory || match.entry.topics.some(topic => normalized(topic) === wantedCategory)));
    const originalMetadataMatch = (!input.language || normalized(source.language ?? '') === normalized(input.language)) && (!input.category || normalized(source.category ?? '') === normalized(input.category));
    if ((input.language || input.category) && !originalMetadataMatch && !metadataMatches.length) return [];
    const aliases = [...new Set(curated.flatMap(match => [match.entry.name, ...match.entry.aliases]))];
    const haystack = normalized([source.name, source.countryName, ...source.endpoints.map(endpoint => endpoint.url), ...aliases].join(' '));
    if (query && !haystack.includes(query)) return [];
    const exactName = !!query && [source.name, ...aliases].some(name => normalized(name) === query);
    const exactDomain = !!query && source.endpoints.some(endpoint => new URL(endpoint.url).hostname.replace(/^www\./, '') === query.replace(/^www\./, ''));
    const prefix = !!query && [source.name, ...aliases].some(name => normalized(name).startsWith(query));
    const score = exactName ? 4 : exactDomain ? 3 : prefix ? 2 : curated.length ? 1 : 0;
    return [{ score, value: { ...source, ...(curated.length ? { curation: { pack_ids: [...new Set(curated.map(match => match.pack_id))], aliases,
      languages: [...new Set(typedMatches.map(match => match.entry.language))], topics: [...new Set(typedMatches.flatMap(match => match.entry.topics))],
      matching_endpoint_ids: [...new Set((input.language || input.category ? metadataMatches : typedMatches).flatMap(match => match.endpoint_ids))].filter(id => !input.endpoint_type || source.endpoints.some(endpoint => endpoint.id === id && endpoint.type === input.endpoint_type)),
      metadata_scope: 'declared_curated_endpoint_bindings_only', reviewed_at: document.reviewed_at } } : {}) } }];
  }).sort((a, b) => b.score - a.score || a.value.id.localeCompare(b.value.id));
  if (input.pack_id && !document.packs.some(pack => pack.id === input.pack_id)) throw Error('UNKNOWN_SOURCE_PACK');
  return { ...page(ranked.map(item => item.value), input.offset, input.limit), metadata_semantics: 'Curated language/category matches apply only to curation.matching_endpoint_ids; missing registry metadata remains unknown. Name/domain matches rank before aliases/prefix/other matches. Registrations are not publisher counts.' };
}

export function createSourcePackHandler(catalog: Catalog, health: HealthStore, activity: ActivityStore, document = loadSourcePacks()) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== '/source-packs' && !url.pathname.startsWith('/source-packs/')) return null;
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    try {
      const resolved = resolveSourcePacks(catalog, health, activity, document);
      const match = /^\/source-packs\/([a-z][a-z0-9-]{1,79})\/export$/.exec(url.pathname);
      if (match) {
        if ([...url.searchParams.keys()].some(key => !['format', 'include'].includes(key)) || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw Error('INVALID_SOURCE_PACK_QUERY');
        const result = exportSourcePack(resolved, { pack_id: match[1], ...(url.searchParams.has('format') ? { format: url.searchParams.get('format') } : {}), ...(url.searchParams.has('include') ? { include: url.searchParams.get('include') } : {}) });
        return new Response(request.method === 'HEAD' ? null : result.content, { headers: { 'content-type': result.content_type, 'content-disposition': `attachment; filename="${result.filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'x-source-pack-exported': String(result.exported_endpoints), 'x-source-pack-excluded': String(result.excluded_endpoints), 'x-source-pack-non-rss-omitted': String(result.sitemap_endpoints_omitted_from_opml) } });
      }
      if (url.pathname !== '/source-packs') return Response.json({ error: 'UNKNOWN_SOURCE_PACK_ROUTE' }, { status: 404 });
      if ([...url.searchParams.keys()].length) throw Error('INVALID_SOURCE_PACK_QUERY');
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(resolved), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch (error) {
      const unknown = error instanceof Error && error.message === 'UNKNOWN_SOURCE_PACK';
      return Response.json({ error: unknown ? 'UNKNOWN_SOURCE_PACK' : 'SOURCE_PACK_REQUEST_FAILED' }, { status: unknown ? 404 : 400, headers: { 'cache-control': 'no-store' } });
    }
  };
}
