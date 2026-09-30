import { McpServer } from '@modelcontextprotocol/server';
import { countrySchema, detailsSchema, healthSchema, page, search, searchSchema, type Catalog } from './catalog.js';
import { HealthStore } from './health.js';

export function createServer(catalog: Catalog, health: HealthStore) {
  const server = new McpServer({ name: 'world-news-sources-mcp', title: 'World News Sources', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const result = (value: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value });
  const sourcesByEndpoint = new Map<string, Catalog['sources']>();
  for (const source of catalog.sources) for (const endpoint of source.endpoints) {
    const list = sourcesByEndpoint.get(endpoint.id) ?? [];
    list.push(source); sourcesByEndpoint.set(endpoint.id, list);
  }
  server.registerTool('search_sources', {
    description: 'Search configured news source registrations by name/domain, country, RSS or sitemap type, category, language and enabled flag. Results describe configuration, not live coverage. Stable pagination with a response byte limit.',
    inputSchema: searchSchema, annotations,
  }, async input => result(search(catalog, input)));
  server.registerTool('get_source', {
    description: 'Get a source by stable source_id, separate typed RSS/sitemap endpoints and cached health. Includes recorded activation/deactivation time, reason and up to 20 transitions; historical dates can be unknown. Sitemap success never makes RSS healthy.',
    inputSchema: detailsSchema, annotations,
  }, async input => {
    const source = catalog.sources.find(s => s.id === input.source_id);
    if (!source) return { isError: true, content: [{ type: 'text' as const, text: 'Unknown source_id' }] };
    return result({ ...source, endpoints: source.endpoints.map(e => ({ ...e, health: health.get(e, sourcesByEndpoint.get(e.id) ?? []) })) });
  });
  server.registerTool('list_countries', {
    description: 'List supported country sections with configured row counts and normalized source counts. Counts are not unique publishers or verified live feeds.',
    inputSchema: countrySchema, annotations,
  }, async input => result({ ...page(catalog.countries, input.offset, input.limit), configured_rows: catalog.configuredRows, normalized_sources: catalog.sources.length }));
  server.registerTool('get_endpoint_health', {
    description: 'Read cached health for 1–20 configured endpoint IDs. Includes actual checked_at, unknown/stale states and historical validation provenance. Does not fetch endpoints.',
    inputSchema: healthSchema, annotations,
  }, async input => {
    const ids = [...new Set(input.endpoint_ids)];
    if (ids.some(id => !catalog.endpoints.has(id))) return { isError: true, content: [{ type: 'text' as const, text: 'Unknown endpoint_id' }] };
    const responses = ids.map(id => health.get(catalog.endpoints.get(id)!, sourcesByEndpoint.get(id) ?? []));
    const bounded = page(responses, 0, ids.length);
    return result({ endpoints: bounded.items, remaining_endpoint_ids: ids.slice(bounded.items.length), audit: health.summary() });
  });
  return server;
}
