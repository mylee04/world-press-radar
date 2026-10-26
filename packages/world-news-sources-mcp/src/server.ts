import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { countrySchema, detailsSchema, healthSchema, page, type Catalog } from './catalog.js';
import { HealthStore } from './health.js';
import { ActivityStore, countryActivitySchema, sourceActivitySchema, inventorySchema, countryInventory } from './activity.js';
import { countryQualitySchema, sourceQualitySchema, getCountryQualityOverview, getSourceQualityDetail } from './quality.js';
import { describeEndpointStatus } from './endpoint-status.js';
import { curatedSearchSchema, searchCuratedSources, loadSourcePacks, resolveSourcePacks, listSourcePacks, getSourcePack, exportSourcePack,
  listSourcePacksSchema, getSourcePackSchema, exportSourcePackSchema, type SourcePackDocument } from './source-packs.js';

export function createServer(catalog: Catalog, health: HealthStore, activity = new ActivityStore(), sourcePacks: SourcePackDocument = loadSourcePacks(), usagePreferences?: (rawMeta: unknown, enabled: boolean) => Promise<{ enabled: boolean; identity_available: boolean }>) {
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
    description: 'Find RSS/sitemap registrations by publisher/name/domain, country, category, language, enabled flag or curated pack_id. Default include=usable returns only selected enabled addresses with recent saved positive article-URL evidence. Failed, empty, index-only, old and unverified addresses are excluded with counts. Use include=all explicitly to research configured exceptions. Endpoint status includes actual observation time, not a live check. Curated metadata applies only to curation.matching_endpoint_ids. Pagination follows filtering; registration totals are not publisher counts.',
    inputSchema: curatedSearchSchema, annotations,
  }, async input => { try { return result(searchCuratedSources(catalog, input, sourcePacks, health, activity)); } catch { return { isError: true, content: [{ type: 'text' as const, text: 'Invalid source search, unknown source pack or unavailable saved evidence' }] }; } });
  server.registerTool('get_source', {
    description: 'Get a source by stable source_id, separate typed RSS/sitemap endpoints, original cached health and additive status_evidence comparing the latest actual collection with the dated structural audit. Inspect conflicts, content date meaning, empty/index-only/stale/unknown states. Includes activation history; sitemap success never makes RSS healthy.',
    inputSchema: detailsSchema, annotations,
  }, async input => {
    const source = catalog.sources.find(s => s.id === input.source_id);
    if (!source) return { isError: true, content: [{ type: 'text' as const, text: 'Unknown source_id' }] };
    return result({ ...source, endpoints: source.endpoints.map(e => ({ ...e, health: health.get(e, sourcesByEndpoint.get(e.id) ?? []), status_evidence: describeEndpointStatus(e, sourcesByEndpoint.get(e.id) ?? [], health, activity) })) });
  });
  server.registerTool('list_countries', {
    description: 'List supported country sections with configured row counts and normalized source counts. Counts are not unique publishers or verified live feeds.',
    inputSchema: countrySchema, annotations,
  }, async input => result({ ...page(catalog.countries, input.offset, input.limit), configured_rows: catalog.configuredRows, normalized_sources: catalog.sources.length }));
  server.registerTool('get_endpoint_health', {
    description: 'Read original cached health for 1–20 endpoint IDs plus status_evidence separating the latest actual collection, structural audit and content dates. Top-level health fields preserve audit provenance; use status_evidence for the combined dated view. Empty/index-only/unknown are distinct from failure. No publisher fetch.',
    inputSchema: healthSchema, annotations,
  }, async input => {
    const ids = [...new Set(input.endpoint_ids)];
    if (ids.some(id => !catalog.endpoints.has(id))) return { isError: true, content: [{ type: 'text' as const, text: 'Unknown endpoint_id' }] };
    const responses = ids.map(id => ({ ...health.get(catalog.endpoints.get(id)!, sourcesByEndpoint.get(id) ?? []),
      status_evidence: describeEndpointStatus(catalog.endpoints.get(id)!, sourcesByEndpoint.get(id) ?? [], health, activity) }));
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
  const resolvedPacks = () => resolveSourcePacks(catalog, health, activity, sourcePacks);
  server.registerTool('list_source_packs', { description: 'List curated starter source packs by country/language, selection criteria, explicit major-publisher gaps, saved evidence time and export availability. Selections are not exhaustive media coverage or editorial trust ratings. No live check.', inputSchema: listSourcePacksSchema, annotations }, async input => {
    try { return result(listSourcePacks(resolvedPacks(), input)); } catch { return { isError: true, content: [{ type: 'text' as const, text: 'Source pack evidence unavailable' }] }; }
  });
  server.registerTool('get_source_pack', { description: 'Get a paginated curated starter pack. Default include=usable returns only publishers and exact registered addresses with recent positive saved article-URL evidence, plus exclusion counts and known gaps. Use include=all for configured failures, empty/index-only, old, unknown or inactive addresses. Separate observation times and content dates; no live fetch.', inputSchema: getSourcePackSchema, annotations }, async input => {
    try { return result(getSourcePack(resolvedPacks(), input)); } catch { return { isError: true, content: [{ type: 'text' as const, text: 'Unknown source pack or unavailable evidence' }] }; }
  });
  server.registerTool('export_source_pack', { description: 'Export a curated pack as RSS-only OPML or typed CSV/JSON. Default include=usable excludes disabled, failed, empty, index-only, old/unknown evidence; include=all explicitly includes configured exceptions. No registration changes or publisher requests. Returns a public download URL and bounded file content.', inputSchema: exportSourcePackSchema, annotations }, async input => {
    try {
      const exported = exportSourcePack(resolvedPacks(), input);
      if (Buffer.byteLength(exported.content) > 40000) { const { content, ...metadata } = exported; return result({ ...metadata, inline_content_omitted: true, inline_content_bytes: Buffer.byteLength(content), note: 'Use download_url for the complete export; no export rows were truncated.' }); }
      return result(exported);
    } catch { return { isError: true, content: [{ type: 'text' as const, text: 'Unknown source pack or invalid export request' }] }; }
  });
  server.registerTool('set_usage_analytics', {
    description: 'Enable or disable pseudonymous repeat-use measurement for the optional client identity on this call. Disabling deletes its last 30 days of presence and keeps a suppression key until enabled again. Source access and results stay available; aggregate counters continue. A preference cannot be stored when no supported identity is provided.',
    inputSchema: z.object({ enabled: z.boolean() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input, context) => {
    if (!usagePreferences) return { ...result({ status: 'unavailable', applied: false, enabled: null, identity_available: false, message: 'Usage preferences are unavailable on this connection. No preference was changed.' }), isError: true };
    try {
      const preference = await usagePreferences(context.mcpReq._meta, input.enabled);
      if (typeof preference.enabled !== 'boolean' || typeof preference.identity_available !== 'boolean') throw new Error('Invalid usage preference response');
      if (!preference.identity_available) return result({ status: 'unavailable', applied: false, enabled: null, identity_available: false, message: 'No supported client identity was provided. Repeat-use measurement is unavailable for this call; aggregate counters continue. No stored preference was changed.' });
      return result({ status: 'applied', applied: true, enabled: preference.enabled, identity_available: true, message: preference.enabled ? 'The preference to allow repeat-use measurement was saved for this client identity. Measurement also depends on service activation. Source access and results are unchanged.' : 'Repeat-use measurement is disabled for this client identity. Its recent presence was deleted and a suppression key is retained until enabled again. Source access, results and aggregate counters are unchanged.' });
    } catch { return { ...result({ status: 'error', applied: false, enabled: null, identity_available: null, message: 'The usage preference could not be confirmed. No successful change is claimed; retry this request.' }), isError: true }; }
  });
  return server;
}
