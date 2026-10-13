import { McpServer } from '@modelcontextprotocol/server';
import { countrySchema, detailsSchema, healthSchema, page, search, searchSchema, type Catalog } from './catalog.js';
import { HealthStore } from './health.js';
import { ActivityStore, countryActivitySchema, sourceActivitySchema, inventorySchema, countryInventory } from './activity.js';
import { countryQualitySchema, sourceQualitySchema, getCountryQualityOverview, getSourceQualityDetail } from './quality.js';

export function createServer(catalog: Catalog, health: HealthStore, activity = new ActivityStore()) {
  const server = new McpServer({ name: 'world-news-sources-mcp', title: 'World News Sources', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const result = (value: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value });
  const sourcesByEndpoint = new Map<string, Catalog['sources']>();
  const inventoryAt = activity.snapshot?.registry_at ?? new Date().toISOString();
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
  server.registerTool('get_country_source_inventory', { description: 'Current stored registry inventory: active source registrations (not publishers), distinct typed RSS and sitemap endpoint IDs, country totals and snapshot time. Counts are configuration, not health.', inputSchema: inventorySchema, annotations }, async input => result(countryInventory(catalog, input, inventoryAt)));
  for (const kind of ['source', 'country'] as const) {
    server.registerTool(kind === 'source' ? 'get_source_article_activity' : 'get_country_article_activity', {
      description: `Read retained cached ${kind} first-discovered unique article-candidate URL activity, deduplicated in this scope. Every new endpoint/source binding starts with an excluded baseline. Not publication counts or feed item counts. Partial/untracked coverage, UTC check times, timezone calendar days and rolling 24h are explicit. Requests span up to 31 calendar days; older stored dates remain queryable. No live feed fetch.`,
      inputSchema: kind === 'source' ? sourceActivitySchema : countryActivitySchema, annotations,
    }, async (input: unknown) => { try { return result(activity.query(catalog, kind, input)); } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Invalid activity input' }] }; } });
  }
  server.registerTool('get_country_collection_quality', {
    description: 'Read cached country attempt coverage, success among attempted article endpoints, inventory, partial UTC windows and own-country weekday baseline review signals. Unknown cadence freshness stays null. Does not confirm current outages or modify sources.',
    inputSchema: countryQualitySchema, annotations,
  }, async input => {
    try { return result(getCountryQualityOverview(catalog, activity, health, input)); }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Quality lookup failed' }] }; }
  });
  server.registerTool('get_source_collection_quality', {
    description: 'Read cached source endpoint failure/regression/recovery evidence and daily, trailing 7-day and trailing 30-day first-discovered URL counts with explicit deduplication and unavailable endpoint counts. Successful zero discoveries alone is not failure.',
    inputSchema: sourceQualitySchema, annotations,
  }, async input => {
    try { return result(getSourceQualityDetail(catalog, activity, health, input)); }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Quality lookup failed' }] }; }
  });
  return server;
}
