import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { ActivityStore } from '../dist/activity.js';
import { loadSourcePacks, resolveSourcePacks, exportSourcePack, searchCuratedSources } from '../dist/source-packs.js';

const NHK = 'https://news.web.nhk/n-data/conf/na/rss/cat0.xml';
const ASAHI = 'http://rss.asahi.com/rss/asahi/newsheadlines.rdf';
const YOMIURI = 'https://www.yomiuri.co.jp/sitemap-news-latest.xml';
const document = loadSourcePacks();
const japan = document.packs.find(pack => pack.id === 'japan-general');

function fixture() {
  const catalog = normalizeRegistry({ countries: [{ code: 'JP', name: 'Japan', feeds: [
    { name: 'NHK News Headlines', url: NHK, persistent_source_id: 'src_a4257f72f8574d8a74f20140' },
    { name: 'NHK World English', url: 'https://example.org/nhk-world-english.xml', language: 'en' },
    { name: 'Asahi Shimbun', url: ASAHI, sitemapUrl: 'https://www.asahi.com/sitemap.xml', persistent_source_id: 'src_ecbd91598fa0498c81261924' },
    { name: 'Yomiuri Latest', sitemapUrl: YOMIURI },
  ] }] });
  const observations = [...catalog.endpoints.values()].map(endpoint => {
    const blocked = endpoint.url === YOMIURI;
    return { endpointId: endpoint.id, type: endpoint.type, url: endpoint.url, checkedAt: '2026-10-26T02:16:00Z',
      outcome: blocked ? 'unhealthy' : 'healthy', httpStatus: blocked ? 403 : 200, reason: blocked ? 'HTTP_403' : null,
      format: endpoint.type === 'rss' ? endpoint.url === ASAHI ? 'rdf' : 'rss' : endpoint.url === YOMIURI ? null : 'sitemapindex',
      auditStatus: blocked ? 'blocked' : 'working_nonempty', ...(blocked ? {} : { entryCount: 7, entriesWithUrl: 7, newestContentAt: '2026-10-26T02:00:00Z', contentFreshness: 'recent', dateKind: 'feed_item_date' }) };
  });
  return { catalog, resolved: resolveSourcePacks(catalog, new HealthStore({ version: 1, observations }), new ActivityStore(), document, Date.parse('2026-10-26T02:20:00Z')) };
}

test('Japan starter puts five explicitly scoped major selections before the preserved regional and digital supplements', () => {
  assert.deepEqual(japan.entries.slice(0, 5).map(entry => entry.publisher_id), ['nhk', 'asahi-shimbun', 'mainichi', 'yomiuri-shimbun', 'kyodo-news']);
  assert.ok(japan.entries.slice(0, 5).every(entry => entry.selection_group === 'national_major' && entry.language === 'ja'));
  assert.deepEqual(japan.entries.slice(5).map(entry => entry.publisher_id), ['j-cast', 'hokkaido-shimbun', 'kyoto-shimbun', 'okinawa-times', 'nippon-com']);
  assert.ok(japan.entries.slice(5).every(entry => entry.selection_group.endsWith('_supplement')));
  assert.equal(japan.entries[0].endpoints[0].url, NHK);
  assert.match(japan.entries[0].usage_notes, /personal use/);
  assert.ok(japan.entries[0].endpoints[0].evidence.some(item => item.fields.includes('usage_terms') && item.claim.includes('does not grant redistribution rights')));
  assert.equal(japan.entries[1].endpoints[0].url, ASAHI);
  assert.equal(japan.entries[3].endpoints[0].url, YOMIURI);
  const kyodo = japan.entries[4];
  assert.equal(kyodo.distribution.direct_publisher_host, false);
  assert.equal(kyodo.distribution.platform, 'Yahoo Japan');
  assert.match(kyodo.name, /Yahoo Japan/);
  assert.match(kyodo.scope_description, /not a direct Kyodo/);
  assert.deepEqual(japan.gaps.map(gap => gap.publisher), ['Nikkei']);
  assert.match(japan.gaps[0].reason, /remains an explicit gap/);
});

test('Japanese NHK and Asahi searches resolve new exact bindings without borrowing English or sitemap language metadata', () => {
  const { catalog } = fixture();
  const nhk = searchCuratedSources(catalog, { country: 'JP', query: 'NHK', language: 'ja' }, document);
  assert.equal(nhk.total, 1);
  assert.equal(nhk.items[0].id, 'src_a4257f72f8574d8a74f20140');
  assert.equal(nhk.items[0].endpoints[0].url, NHK);
  assert.equal(searchCuratedSources(catalog, { country: 'JP', query: '朝日新聞', language: 'ja', endpoint_type: 'rss' }, document).total, 1);
  assert.equal(searchCuratedSources(catalog, { country: 'JP', query: '朝日新聞', language: 'ja', endpoint_type: 'sitemap' }, document).total, 0);
  assert.equal(searchCuratedSources(catalog, { country: 'JP', query: 'NHK', language: 'en' }, document).items[0].name, 'NHK World English');
});

test('consumer success evidence never converts a saved blocked Yomiuri observation into an eligible export', () => {
  const { resolved } = fixture();
  const json = JSON.parse(exportSourcePack(resolved, { pack_id: 'japan-general', format: 'json', include: 'all' }).content);
  const yomiuri = json.endpoints.find(endpoint => endpoint.url === YOMIURI);
  assert.equal(yomiuri.selection_group, 'national_major');
  assert.match(json.endpoints.find(endpoint => endpoint.url === NHK).usage_notes, /personal use/);
  assert.equal(yomiuri.status_evidence.status, 'failed');
  assert.equal(yomiuri.default_export_eligible, false);
  assert.ok(yomiuri.evidence.some(item => item.kind === 'bounded_consumer_xml_observation' && item.claim.includes('263')));
  const usable = JSON.parse(exportSourcePack(resolved, { pack_id: 'japan-general', format: 'json' }).content);
  assert.deepEqual(new Set(usable.endpoints.map(endpoint => endpoint.url)), new Set([NHK, ASAHI]));
  const opml = exportSourcePack(resolved, { pack_id: 'japan-general', format: 'opml' });
  assert.equal(opml.exported_endpoints, 2);
  assert.equal(opml.sitemap_endpoints_omitted_from_opml, 1);
  assert.ok(!opml.content.includes(YOMIURI));
});
