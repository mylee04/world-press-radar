import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalUrl, normalizeRegistry, stableId } from './catalog.js';
import { observationSchema } from './health.js';
import { safeUrl } from './validate.js';

const text = z.string().trim().min(1).max(512);
const publicUrl = z.string().max(2048).transform(value => safeUrl(value).href);
export const additionsSchema = z.object({
  version: z.literal(1), run_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  prepared_at: z.string().datetime(), registry_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  selected_countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
  additions: z.array(z.object({
    country: z.string().regex(/^[A-Z]{2}$/), name: text, language: z.string().min(2).max(32),
    homepage: publicUrl, publisher_reference: publicUrl, scope_note: text,
    kind: z.enum(['new_domain','existing_publisher_alternative','existing_publisher_additional_language']),
    endpoints: z.array(z.object({
      type: z.enum(['rss','sitemap']), url: publicUrl,
      endpoint_id: z.string().regex(/^ep_[a-f0-9]{24}$/), observation: observationSchema,
      access_review: z.object({
        robots_url: publicUrl, http_status: z.number().int().min(100).max(599), checked_at: z.string().datetime(),
        decision: z.enum(['allowed','allowed_robots_absent']),
        matched_rule: z.object({allow:z.boolean(),pattern:text}).nullable(),
      }).strict(),
      provenance: z.object({
        kind: z.enum(['official_html_feed_link','official_html_feed_anchor','official_robots_sitemap',
          'official_sitemap_index_enumerated_child','official_sitemap_index_child_ranked']),
        source_url: publicUrl, found_at: z.string().datetime(), page_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        declaration: text.optional(), tag: text.optional(), declared_lastmod: z.string().max(128).nullable().optional(),
      }).strict(),
    }).strict()).min(1).max(2),
  }).strict()).min(1).max(50),
}).strict();

// Local operator function only. Never exposed as a writable MCP tool, fetcher or deployer.
export function prepareRegistryAdditions(registryText: string, rawBatch: unknown, now = new Date()) {
  const batch = additionsSchema.parse(rawBatch);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid operator time');
  const before = JSON.parse(registryText);
  const catalog = normalizeRegistry(before);
  const existingCountries = new Set(catalog.countries.map(c => c.code));
  if (new Set(batch.selected_countries).size !== batch.selected_countries.length
    || batch.selected_countries.some(c => !existingCountries.has(c))) throw new Error('Only distinct existing countries may be selected');
  const selected = new Set(batch.selected_countries), ids = new Set<string>();
  let alreadyApplied = 0;
  for (const addition of batch.additions) {
    if (!selected.has(addition.country)) throw new Error('Addition outside selected existing countries');
    const types = new Set<string>();
    for (const endpoint of addition.endpoints) {
      if (types.has(endpoint.type)) throw new Error('Only one endpoint per type per new source');
      types.add(endpoint.type);
      if (ids.has(endpoint.endpoint_id)) throw new Error('Duplicate typed endpoint in additions');
      ids.add(endpoint.endpoint_id);
      if (endpoint.endpoint_id !== stableId('ep',[endpoint.type,canonicalUrl(endpoint.url)])) throw new Error('Endpoint identity mismatch');
      const access=endpoint.access_review;
      if (new URL(access.robots_url).origin !== new URL(endpoint.url).origin
        || new URL(access.robots_url).pathname !== '/robots.txt'
        || access.decision === 'allowed_robots_absent' && ![404,410].includes(access.http_status)
        || access.decision === 'allowed' && (access.http_status !== 200 || access.matched_rule?.allow === false)) throw new Error('Robots review does not allow endpoint collection');
      const observation = endpoint.observation;
      if (observation.endpointId !== endpoint.endpoint_id || observation.type !== endpoint.type || canonicalUrl(observation.url) !== endpoint.url) throw new Error('Observation identity mismatch');
      if (observation.outcome !== 'healthy' || observation.auditStatus !== 'working_nonempty'
        || !(observation.entriesWithUrl! > 0)
        || !(['rss','atom','rdf'].includes(observation.format ?? '') && endpoint.type === 'rss'
          || observation.format === 'urlset' && endpoint.type === 'sitemap')) throw new Error('Addition requires nonempty feed or URL-set XML; indexes are not article endpoints');
      if (Date.parse(endpoint.provenance.found_at) > Date.parse(observation.checkedAt)) throw new Error('Declaration must precede XML validation');
      if (observation.finalUrl && canonicalUrl(observation.finalUrl) !== endpoint.url
        && [...catalog.endpoints.values()].some(e => e.type === endpoint.type && e.url === canonicalUrl(observation.finalUrl!))) throw new Error('Redirect resolves to an already configured typed endpoint');
    }
    const matching = before.countries.filter((c: {code:string}) => c.code.toUpperCase() === addition.country)
      .flatMap((c: {feeds:Record<string,unknown>[]}) => c.feeds).filter((feed: Record<string,unknown>) => feed.registry_addition_batch === batch.run_id
        && feed.name === addition.name
        && (feed.url ?? null) === (addition.endpoints.find(e => e.type === 'rss')?.url ?? null)
        && (feed.sitemapUrl ?? null) === (addition.endpoints.find(e => e.type === 'sitemap')?.url ?? null));
    if (matching.length === 1) { alreadyApplied++; continue; }
    if (matching.length > 1 || addition.endpoints.some(e => catalog.endpoints.has(e.endpoint_id))) throw new Error('Already configured typed endpoint, including disabled registrations; original state preserved');
    if (addition.endpoints.some(e => Date.parse(e.observation.checkedAt) > now.getTime()
      || now.getTime() - Date.parse(e.observation.checkedAt) > 7*86400000)) throw new Error('Current actual XML check required within seven days');
    if (addition.endpoints.some(e=>Date.parse(e.access_review.checked_at)>now.getTime()
      || now.getTime()-Date.parse(e.access_review.checked_at)>86400000)) throw new Error('Current robots review required within one day');
  }
  if (alreadyApplied) {
    if (alreadyApplied !== batch.additions.length) throw new Error('Partially applied batch requires operator reconciliation');
    return { registry: before, changed: false, sources: [], endpoint_ids: [...ids], batch_id: batch.run_id };
  }
  if (createHash('sha256').update(registryText).digest('hex') !== batch.registry_sha256) throw new Error('Registry changed since review; reconcile the batch against the authoritative registry');
  const output = structuredClone(before), at = now.toISOString();
  for (const addition of batch.additions) {
    const country = output.countries.find((c: {code:string}) => c.code.toUpperCase() === addition.country);
    country.feeds.push({name:addition.name, language:addition.language,
      url:addition.endpoints.find(e => e.type === 'rss')?.url ?? null,
      sitemapUrl:addition.endpoints.find(e => e.type === 'sitemap')?.url ?? null,
      enabled:true, enabled_changed_at:at,
      status_reason:`Initial registration from verified official declarations (${batch.run_id}).`,
      status_history:[], status_transition_count:0, registry_addition_batch:batch.run_id,
      source_homepage:addition.homepage, endpoint_provenance:addition.endpoints.map(e => ({type:e.type,url:e.url,
        ...e.provenance, checked_at:e.observation.checkedAt, format:e.observation.format, scope_note:addition.scope_note})),
    });
  }
  const after = normalizeRegistry(output);
  if (after.configuredRows !== catalog.configuredRows + batch.additions.length) throw new Error('Unexpected registry row count');
  // Existing source IDs and every existing row/status field stay untouched.
  if (catalog.sources.some(source => JSON.stringify(source) !== JSON.stringify(after.sources.find(s => s.id === source.id)))) throw new Error('Existing source metadata changed');
  return {registry:output,changed:true,sources:after.sources.filter(s => !catalog.sources.some(old => old.id === s.id)),endpoint_ids:[...ids],batch_id:batch.run_id};
}
