import test from 'node:test';
import assert from 'node:assert/strict';
import { SaxesParser } from 'saxes';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { ActivityStore } from '../dist/activity.js';
import { sourcePackDocumentSchema, resolveSourcePacks, listSourcePacks, getSourcePack, exportSourcePack, searchCuratedSources, createSourcePackHandler, loadSourcePacks } from '../dist/source-packs.js';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const FEED = 'https://paper.example/feed?language=en&section=business';
const SITEMAP = 'https://paper.example/news.xml';
const EMPTY = 'https://other.example/feed';
const proof = [{ url: 'https://paper.example/rss', claim: 'Official declaration of this selected stream', checked_at: '2026-10-16' }];
function fixture({ missing = false, old = false, invalidContent = false } = {}) {
  const catalog = normalizeRegistry({ countries: [{ code: 'US', name: 'United States', feeds: [
    { name: 'Paper', url: FEED, sitemapUrl: SITEMAP }, { name: 'Disabled shared feed', url: FEED, enabled: false }, { name: 'Other', url: EMPTY },
  ] }] });
  // The disabled registration must not win deduplication just because it sorts first.
  catalog.sources.sort((a, b) => Number(a.enabled) - Number(b.enabled));
  const paper = catalog.sources.find(source => source.name === 'Paper'), other = catalog.sources.find(source => source.name === 'Other');
  const document = sourcePackDocumentSchema.parse({ version: 1, reviewed_at: '2026-10-16', packs: [{ id: 'test-pack', title: { en: 'Business starter', ko: '비즈니스 시작' },
    description: { en: 'Selected section feeds, not all news', ko: '선정한 섹션 피드' }, country: 'US', language: 'en', topics: ['business'], selection_criteria: ['Official selected addresses'],
    entries: [{ publisher_id: 'paper', name: '=Paper & "Partners"', aliases: ['Paper Alias', '페이퍼'], language: 'en', topics: ['business'], scope: 'section', scope_description: 'Business section', homepage: 'https://paper.example/', evidence: proof,
      endpoints: [{ type: 'rss', url: FEED, evidence: proof }, { type: 'sitemap', url: SITEMAP, evidence: proof }] },
    { publisher_id: 'other', name: 'Other', aliases: [], language: 'en', topics: ['business'], scope: 'whole_publisher', scope_description: 'Whole selected publisher', homepage: 'https://other.example/', evidence: proof,
      endpoints: [{ type: 'rss', url: EMPTY, evidence: proof }] }], gaps: [{ publisher: 'Missing major publisher', reason: 'No verified registered address', evidence_url: 'https://missing.example/' }] }] });
  const observations = catalog.endpoints.values();
  const at = old ? '2026-10-13T10:00:00Z' : '2026-10-16T10:00:00Z';
  const collections = missing ? [] : [...observations].map(endpoint => {
    const sources = catalog.sources.filter(source => source.endpoints.some(value => value.id === endpoint.id));
    return { endpoint_id: endpoint.id, checked_at: at, status: endpoint.url === EMPTY ? 'valid_empty' : 'working_nonempty', format: endpoint.type === 'rss' ? 'rss' : 'urlset',
      observed_urls: endpoint.url === EMPTY ? 0 : 5, source_ids: sources.map(source => source.id), countries: ['US'], source_new: Object.fromEntries(sources.map(source => [source.id, 0])), country_new: { US: 0 }, baseline_sources: [paper.id], uncertain_urls: 0,
      newest_content_at: invalidContent ? '2026-01-01T00:00:00Z' : null, date_kind: 'feed_item_date' };
  });
  const activity = new ActivityStore({ version: 1, lane: 'production', generated_at: '2026-10-16T11:00:00Z', tracking_start: '2026-10-01T00:00:00Z', available_since: '2026-10-01T00:00:00Z', registry_at: null, semantics: 'test fixture', collections, bindings: [] });
  const health = new HealthStore();
  return { catalog, document, activity, health, paper, other, resolved: resolveSourcePacks(catalog, health, activity, document, NOW) };
}

test('curation matches exact current country/type/url bindings and retains honest gaps and source IDs', () => {
  const f = fixture(), pack = getSourcePack(f.resolved, { pack_id: 'test-pack' });
  assert.equal(pack.summary.publishers, 2); assert.equal(pack.summary.available_publishers, 1);
  assert.equal(pack.summary.enabled_endpoints, 3); assert.equal(pack.summary.default_export_endpoints, 2);
  assert.equal(pack.summary.excluded_endpoints, 1); assert.equal(pack.gaps[0].publisher, 'Missing major publisher');
  assert.equal(pack.entries[0].sources.find(source => source.name === 'Paper').source_id, f.paper.id);
  assert.equal(pack.entries[0].sources.find(source => source.name === 'Paper').endpoints[0].status_evidence.content.newest_content_at, null);
  assert.ok(pack.download_urls.opml.startsWith('https://news.bymyleslee.com/'));
});
test('RSS-only OPML round trips through a real XML parser with exact feed addresses and escaped names', () => {
  const f = fixture(), exported = exportSourcePack(f.resolved, { pack_id: 'test-pack', format: 'opml' });
  const outlines = [], parser = new SaxesParser();
  parser.on('opentag', tag => { if (tag.name === 'outline') outlines.push(tag.attributes); });
  parser.write(exported.content).close();
  assert.equal(outlines.length, 1); assert.equal(outlines[0].xmlUrl, FEED); assert.equal(outlines[0].type, 'rss');
  assert.equal(outlines[0].text, '=Paper & "Partners"'); assert.equal(exported.sitemap_endpoints_omitted_from_opml, 1);
  assert.equal(exported.excluded_endpoints, 1); assert.ok(!exported.content.includes(SITEMAP));
});
test('typed JSON retains both RSS/sitemap, original observations, provenance and correct enabled shared binding', () => {
  const f = fixture(), all = JSON.parse(exportSourcePack(f.resolved, { pack_id: 'test-pack', format: 'json', include: 'all' }).content);
  assert.equal(all.endpoints.length, 3); assert.deepEqual(new Set(all.endpoints.map(endpoint => endpoint.type)), new Set(['rss', 'sitemap']));
  const feed = all.endpoints.find(endpoint => endpoint.url === FEED);
  assert.equal(feed.enabled, true); assert.equal(feed.default_export_eligible, true); assert.equal(feed.exclusion_reason, null); assert.equal(feed.source_id, f.paper.id);
  assert.equal(feed.status_evidence.latest_collection.source_activity.find(item => item.source_id === f.paper.id).baseline, true);
  assert.equal(feed.status_evidence.latest_collection.source_activity.find(item => item.source_id === f.paper.id).new_unique_candidate_urls, null);
  assert.equal(feed.evidence[0].url, proof[0].url);
});
test('CSV includes type, independent timestamps and formula-safe quoted values', () => {
  const content = exportSourcePack(fixture().resolved, { pack_id: 'test-pack', format: 'csv' }).content;
  assert.ok(content.startsWith('\ufeff')); assert.ok(content.includes('"last_collection_at","last_structural_audit_at"'));
  assert.ok(content.includes('"\'=Paper & ""Partners"""')); assert.ok(content.includes('"sitemap"')); assert.ok(content.includes('"rss"'));
});
test('empty, unobserved, old observation and old content are excluded without being relabelled XML failures', () => {
  for (const options of [{ missing: true }, { old: true }, { invalidContent: true }]) {
    const f = fixture(options), file = exportSourcePack(f.resolved, { pack_id: 'test-pack', format: 'json' });
    assert.equal(file.exported_endpoints, 0);
    const all = JSON.parse(exportSourcePack(f.resolved, { pack_id: 'test-pack', format: 'json', include: 'all' }).content);
    assert.equal(all.endpoints.length, 3); assert.ok(all.endpoints.every(endpoint => endpoint.default_export_eligible === false));
  }
  const f = fixture();
  const empty = f.resolved.packs[0].entries[1].sources[0].endpoints[0];
  assert.equal(empty.status_evidence.status, 'valid_empty'); assert.equal(empty.exclusion_reason, 'endpoint_valid_empty');
});
test('aliases rank exact identities and scoped English/topic metadata never leaks to an unrelated sitemap', () => {
  const f = fixture();
  assert.equal(searchCuratedSources(f.catalog, { query: '페이퍼', language: 'en', category: 'business' }, f.document, f.health, f.activity, NOW).items.some(item => item.id === f.paper.id), true);
  const onlyRss = structuredClone(f.document); onlyRss.packs[0].entries[0].endpoints = onlyRss.packs[0].entries[0].endpoints.filter(endpoint => endpoint.type === 'rss');
  assert.equal(searchCuratedSources(f.catalog, { language: 'en', category: 'business', endpoint_type: 'sitemap' }, onlyRss, f.health, f.activity, NOW).total, 0);
  const rss = searchCuratedSources(f.catalog, { language: 'en', endpoint_type: 'rss', enabled: true }, onlyRss, f.health, f.activity, NOW);
  assert.equal(rss.items.find(item => item.id === f.paper.id).language, null);
  assert.ok(rss.items.find(item => item.id === f.paper.id).curation.matching_endpoint_ids.every(id => f.paper.endpoints.find(endpoint => endpoint.id === id).type === 'rss'));
});
test('unregistered or wrong-country declarations stay explicit and never become downloadable addresses', () => {
  const f = fixture(), document = structuredClone(f.document);
  document.packs[0].entries[0].endpoints.push({ type: 'rss', url: 'https://unregistered.example/feed', evidence: proof });
  const resolved = resolveSourcePacks(f.catalog, f.health, f.activity, document, NOW);
  assert.equal(resolved.packs[0].summary.unregistered_endpoints, 1);
  assert.equal(resolved.packs[0].entries[0].unregistered_endpoints[0].url, 'https://unregistered.example/feed');
  assert.ok(!exportSourcePack(resolved, { pack_id: 'test-pack', format: 'json', include: 'all' }).content.includes('https://unregistered.example/feed'));
  document.packs[0].country = 'JP';
  assert.equal(exportSourcePack(resolveSourcePacks(f.catalog, f.health, f.activity, document, NOW), { pack_id: 'test-pack', format: 'json', include: 'all' }).exported_endpoints, 0);
});
test('tool pagination, invalid pack/format and metadata filtering remain bounded and explicit', () => {
  const f = fixture();
  assert.equal(listSourcePacks(f.resolved, { country: 'jp' }).total, 0);
  const first = getSourcePack(f.resolved, { pack_id: 'test-pack', include: 'all', limit: 1 }); assert.equal(first.next_offset, 1);
  assert.equal(getSourcePack(f.resolved, { pack_id: 'test-pack', include: 'all', offset: first.next_offset, limit: 1 }).entries[0].publisher_id, 'other');
  assert.throws(() => getSourcePack(f.resolved, { pack_id: 'unknown-pack' }), /UNKNOWN_SOURCE_PACK/);
  assert.throws(() => exportSourcePack(f.resolved, { pack_id: 'test-pack', format: 'html' }));
  assert.throws(() => sourcePackDocumentSchema.parse({ ...f.document, packs: [f.document.packs[0], f.document.packs[0]] }));
});
test('public pack handler serves downloads, rejects writes/query/path misuse and makes no publisher calls', async () => {
  const f = fixture(), handler = createSourcePackHandler(f.catalog, f.health, f.activity, f.document);
  const get = path => handler(new Request('https://news.bymyleslee.com' + path));
  const response = await get('/source-packs'); assert.equal(response.status, 200); assert.equal((await response.json()).packs.length, 1);
  const download = await get('/source-packs/test-pack/export?format=opml&include=all'); assert.equal(download.status, 200);
  assert.ok(download.headers.get('content-disposition').includes('world-news-sources-test-pack.opml')); assert.ok((await download.text()).includes(FEED.replaceAll('&', '&amp;')));
  assert.equal((await get('/source-packs/test-pack/export?format=opml&format=json')).status, 400);
  assert.equal((await get('/source-packs?path=../private')).status, 400);
  assert.equal((await get('/source-packs/unknown-pack/export')).status, 404);
  assert.equal((await handler(new Request('https://news.bymyleslee.com/source-packs', { method: 'POST' }))).status, 405);
  const head = await handler(new Request('https://news.bymyleslee.com/source-packs', { method: 'HEAD' })); assert.equal(await head.text(), '');
});
test('three real starter documents preserve official provenance and exact registered typed bindings', () => {
  const document = loadSourcePacks();
  assert.deepEqual(document.packs.map(pack => pack.id), ['us-business', 'japan-general', 'korea-english']);
  assert.ok(document.packs.every(pack => pack.entries.every(entry => entry.evidence.length && entry.endpoints.every(endpoint => endpoint.evidence.length))));
});

const searchFixture = (f, input = {}) => searchCuratedSources(f.catalog, input, f.document, f.health, f.activity, NOW);
function newerObservation(f, url, overrides) {
  const old = f.activity.snapshot.collections.find(row => f.catalog.endpoints.get(row.endpoint_id).url === url);
  const next = { ...structuredClone(old), checked_at: '2026-10-16T11:30:00Z', ...overrides };
  f.activity.snapshot.collections.push(next);
  return next;
}

test('default search and starter details keep a healthy sibling and omit failed endpoint URLs everywhere', () => {
  const f = fixture();
  newerObservation(f, SITEMAP, { status: 'blocked', format: null, observed_urls: 0, reason: 'HTTP_403' });
  const resolved = resolveSourcePacks(f.catalog, f.health, f.activity, f.document, NOW);
  const search = searchFixture(f, { query: 'Paper', enabled: true });
  assert.equal(search.total, 1);
  assert.deepEqual(search.items[0].endpoints.map(endpoint => endpoint.url), [FEED]);
  assert.equal(search.items[0].endpoints[0].status_evidence.observed_at, '2026-10-16T10:00:00Z');
  assert.deepEqual(search.items[0].curation.matching_endpoint_ids, [f.paper.endpoints.find(endpoint => endpoint.url === FEED).id]);
  assert.equal(search.selection.excluded_endpoints, 1);
  assert.equal(search.selection.excluded_endpoint_reasons.endpoint_failed, 1);
  assert.ok(!JSON.stringify(search).includes(SITEMAP));
  const pack = getSourcePack(resolved, { pack_id: 'test-pack' });
  assert.equal(pack.total, 1);
  assert.deepEqual(pack.entries[0].endpoints.map(endpoint => endpoint.url), [FEED]);
  assert.ok(pack.entries[0].sources.every(source => source.enabled && source.endpoints.every(endpoint => endpoint.url === FEED)));
  assert.equal(pack.selection.matched_publishers, 2);
  assert.equal(pack.selection.excluded_publishers, 1);
  assert.ok(!JSON.stringify(pack).includes(SITEMAP));
  assert.ok(!exportSourcePack(resolved, { pack_id: 'test-pack', format: 'json' }).content.includes(SITEMAP));
  const diagnostic = getSourcePack(resolved, { pack_id: 'test-pack', include: 'all' });
  assert.ok(JSON.stringify(diagnostic).includes(SITEMAP));
  assert.ok(diagnostic.download_urls.json.endsWith('&include=all'));
  assert.equal(f.activity.snapshot.collections.length, 4);
  assert.equal(f.document.packs[0].entries[0].endpoints.length, 2);
});

test('newer failed collection excludes an address despite an earlier successful structural audit', () => {
  const f = fixture();
  const endpoint = f.paper.endpoints.find(endpoint => endpoint.url === FEED);
  const health = new HealthStore({ version: 1, observations: [{ endpointId: endpoint.id, type: 'rss', url: FEED, checkedAt: '2026-10-16T11:00:00Z',
    outcome: 'healthy', httpStatus: 200, reason: null, format: 'rss', auditStatus: 'working_nonempty', entryCount: 5, entriesWithUrl: 5 }] });
  newerObservation(f, FEED, { status: 'http_error', format: null, observed_urls: 0, reason: 'HTTP_404' });
  const result = searchCuratedSources(f.catalog, { query: 'Paper', enabled: true, endpoint_type: 'rss' }, f.document, health, f.activity, NOW);
  assert.equal(result.total, 0);
  assert.equal(result.selection.matched_registrations, 1);
  assert.equal(result.selection.excluded_endpoint_reasons.endpoint_failed, 1);
  const diagnostic = searchCuratedSources(f.catalog, { query: 'Paper', enabled: true, endpoint_type: 'rss', include: 'all' }, f.document, health, f.activity, NOW);
  assert.equal(diagnostic.items[0].endpoints[0].status_evidence.status, 'failed');
  assert.equal(diagnostic.items[0].endpoints[0].status_evidence.conflict.present, true);
  const shared = searchCuratedSources(f.catalog, { endpoint_type: 'rss' }, f.document, health, f.activity, NOW);
  assert.equal(shared.selection.excluded_endpoint_reasons.endpoint_failed, 1);
  assert.equal(shared.selection.excluded_endpoint_reasons.registration_disabled, undefined);
});

test('default search filters before pagination and keeps exclusion totals independent of the current page', () => {
  const f = fixture();
  newerObservation(f, EMPTY, { status: 'working_nonempty', observed_urls: 3 });
  const first = searchFixture(f, { limit: 1 });
  const second = searchFixture(f, { limit: 1, offset: first.next_offset });
  assert.equal(first.total, 2); assert.equal(first.items.length, 1); assert.equal(first.next_offset, 1);
  assert.equal(second.items.length, 1); assert.equal(second.next_offset, null);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(first.selection.matched_registrations, 3);
  assert.equal(first.selection.returned_registrations, 2);
  assert.equal(first.selection.excluded_registrations, 1);
  assert.deepEqual(first.selection, second.selection);
});

test('missing URL-count evidence, empty documents and sitemap indexes are withheld without inventing failures', () => {
  const f = fixture();
  for (const row of f.activity.snapshot.collections) delete row.observed_urls;
  const result = searchFixture(f, { enabled: true });
  assert.equal(result.total, 0);
  assert.equal(result.selection.excluded_endpoint_reasons.article_url_count_not_recorded, 2);
  const diagnostic = searchFixture(f, { include: 'all', enabled: true });
  assert.equal(diagnostic.items.find(source => source.id === f.paper.id).endpoints[0].status_evidence.status, 'usable');
  const resolved = resolveSourcePacks(f.catalog, f.health, f.activity, f.document, NOW);
  assert.equal(exportSourcePack(resolved, { pack_id: 'test-pack', format: 'json' }).exported_endpoints, 0);
  const index = fixture();
  newerObservation(index, SITEMAP, { format: 'sitemapindex', status: 'working_nonempty', observed_urls: 8 });
  assert.equal(searchFixture(index, { endpoint_type: 'sitemap' }).total, 0);
  assert.equal(searchFixture(index, { endpoint_type: 'sitemap', include: 'all' }).items[0].endpoints[0].status_evidence.status, 'index_only');
});

test('curated selection and endpoint type restrict usable siblings before searching and exporting diagnostics', () => {
  const f = fixture(), onlyRss = structuredClone(f.document);
  onlyRss.packs[0].entries[0].endpoints = onlyRss.packs[0].entries[0].endpoints.filter(endpoint => endpoint.type === 'rss');
  newerObservation(f, FEED, { status: 'blocked', format: null, observed_urls: 0 });
  const scoped = raw => searchCuratedSources(f.catalog, raw, onlyRss, f.health, f.activity, NOW);
  assert.equal(scoped({ pack_id: 'test-pack', query: 'Paper', enabled: true }).total, 0);
  assert.equal(scoped({ language: 'en', category: 'business', query: 'Paper', enabled: true }).total, 0);
  const all = scoped({ pack_id: 'test-pack', query: 'Paper', enabled: true, include: 'all' });
  assert.deepEqual(all.items[0].endpoints.map(endpoint => endpoint.url), [FEED]);
  assert.ok(!JSON.stringify(all).includes(SITEMAP));
  assert.deepEqual(all.items[0].curation.matching_endpoint_ids, [f.paper.endpoints.find(endpoint => endpoint.url === FEED).id]);
  assert.equal(searchFixture(f, { query: FEED, enabled: true }).total, 0);
  assert.deepEqual(searchFixture(f, { query: 'Paper', enabled: true, endpoint_type: 'sitemap' }).items[0].endpoints.map(endpoint => endpoint.url), [SITEMAP]);
});

test('public starter list hides excluded and unregistered addresses while explicit diagnostics retain them', async () => {
  const f = fixture();
  newerObservation(f, SITEMAP, { status: 'blocked', format: null, observed_urls: 0 });
  const unregistered = 'https://unregistered.example/feed';
  f.document.packs[0].entries[0].endpoints.push({ type: 'rss', url: unregistered, evidence: proof });
  const handler = createSourcePackHandler(f.catalog, f.health, f.activity, f.document);
  const invoke = path => handler(new Request('https://news.bymyleslee.com' + path));
  // Use a matching current wall-clock observation for the HTTP handler's default clock.
  for (const row of f.activity.snapshot.collections) row.checked_at = new Date(Date.now() - (row.status === 'blocked' ? 1000 : 2000)).toISOString();
  const response = await invoke('/source-packs');
  const body = await response.text();
  assert.equal(response.status, 200); assert.ok(body.includes(FEED));
  assert.ok(!body.includes(SITEMAP)); assert.ok(!body.includes(unregistered));
  const all = await (await invoke('/source-packs?include=all')).json();
  assert.ok(JSON.stringify(all).includes(SITEMAP)); assert.ok(JSON.stringify(all).includes(unregistered));
  assert.equal(all.packs[0].selection.excluded_endpoints, 0);
  assert.equal((await invoke('/source-packs?include=all&include=usable')).status, 400);
  assert.equal((await invoke('/source-packs?include=failed')).status, 400);
});
