import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry, search, page, healthSchema, countrySchema, canonicalUrl } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { loadData } from '../dist/config.js';
import { registry } from './fixtures.mjs';

test('both typed endpoints survive; duplicate registrations merge and IDs survive reorder', () => {
  const catalog = normalizeRegistry(registry);
  assert.equal(catalog.configuredRows, 5);
  assert.equal(catalog.sources.length, 4);
  const source = catalog.sources.find(s => s.name === 'Example News');
  assert.deepEqual(source.endpoints.map(e => e.type), ['rss', 'sitemap']);
  assert.equal(source.registrationCount, 2);
  assert.deepEqual(source.rows, [1, 2]);
  const reordered = structuredClone(registry); reordered.countries.reverse(); reordered.countries[1].feeds.reverse();
  assert.deepEqual(normalizeRegistry(reordered).sources.map(s => s.id), catalog.sources.map(s => s.id));
  const sameUrl = normalizeRegistry({ countries: [{ code: 'US', name: 'US', feeds: [{name:'Same',url:'https://example.com/xml',sitemapUrl:'https://example.com/xml'}] }] });
  assert.notEqual(sameUrl.sources[0].endpoints[0].id, sameUrl.sources[0].endpoints[1].id);
});
test('persistent source identity preserves the legacy ID across an endpoint repair', () => {
  const raw = { countries: [{ code: 'US', name: 'US', feeds: [
    { name: 'Publisher', url: 'https://publisher.example/rss.xml', sitemapUrl: 'https://publisher.example/old-map.xml' },
  ] }] };
  const oldSource = normalizeRegistry(raw).sources[0];
  assert.equal(oldSource.id, 'src_5a079d4a7f67fbf34862a761');
  const repaired = structuredClone(raw);
  repaired.countries[0].feeds[0].persistent_source_id = oldSource.id;
  repaired.countries[0].feeds[0].sitemapUrl = 'https://publisher.example/new-map.xml';
  repaired.countries[0].feeds.push({ ...repaired.countries[0].feeds[0] });
  const source = normalizeRegistry(repaired).sources[0];
  assert.equal(source.id, oldSource.id);
  assert.equal(source.registrationCount, 2);
  assert.equal(source.endpoints[0].id, oldSource.endpoints[0].id);
  assert.notEqual(source.endpoints[1].id, oldSource.endpoints[1].id);
});
test('persistent source IDs reject malformed values and unlike registrations claiming one identity', () => {
  const feed = { name: 'Publisher', url: 'https://publisher.example/rss.xml', persistent_source_id: 'src_' + 'a'.repeat(24) };
  const registryOf = feeds => ({ countries: [{ code: 'US', name: 'US', feeds }] });
  for (const id of ['src_short', 'src_' + 'A'.repeat(24), ' src_' + 'a'.repeat(24), null])
    assert.throws(() => normalizeRegistry(registryOf([{ ...feed, persistent_source_id: id }])));
  for (const patch of [{ name: 'Other Publisher' }, { url: 'https://publisher.example/other.xml' }, { sitemapUrl: 'https://publisher.example/map.xml' }])
    assert.throws(() => normalizeRegistry(registryOf([feed, { ...feed, ...patch }])), /REGISTRY_SOURCE_IDENTITY_CONFLICT/);
  assert.throws(() => normalizeRegistry({ countries: [
    { code: 'US', name: 'US', feeds: [feed] }, { code: 'CA', name: 'Canada', feeds: [feed] },
  ] }), /REGISTRY_SOURCE_IDENTITY_CONFLICT/);
});
test('equivalent registrations cannot be split between different persistent and legacy IDs', () => {
  const legacy = { name: 'Publisher', url: 'https://publisher.example/rss.xml' };
  const explicit = { ...legacy, persistent_source_id: 'src_' + 'a'.repeat(24) };
  for (const feeds of [[legacy, explicit], [explicit, legacy]])
    assert.throws(() => normalizeRegistry({ countries: [{ code: 'US', name: 'US', feeds }] }), /REGISTRY_DUPLICATE_SOURCE_IDENTITY/);
});
test('filtering, pagination, disabled rows and empty sources', () => {
  const catalog = normalizeRegistry(registry);
  const first = search(catalog, {limit:2});
  const second = search(catalog, {offset:first.next_offset,limit:2});
  assert.equal(new Set([...first.items,...second.items].map(s=>s.id)).size, 4);
  assert.equal(second.next_offset, null);
  assert.equal(search(catalog,{country:'gb',endpoint_type:'sitemap'}).items[0].name,'Sitemap Only');
  assert.equal(search(catalog,{query:'example.com',enabled:false}).items[0].name,'RSS Only');
  assert.equal(search(catalog,{offset:100}).items.length,0);
});
test('invalid input and unsafe registry URLs rejected', () => {
  const c = normalizeRegistry(registry);
  for(const input of [{limit:0},{limit:51},{offset:-1},{offset:0.5},{endpoint_type:'html'},{query:'x'.repeat(201)},{unknown:1}]) assert.throws(()=>search(c,input));
  assert.throws(()=>healthSchema.parse({endpoint_ids:[]}));
  assert.throws(()=>healthSchema.parse({endpoint_ids:Array(21).fill('ep_'+'a'.repeat(24))}));
  assert.throws(()=>countrySchema.parse({limit:100}));
  for(const url of ['file:///tmp/a','https://user:secret@example.com/a','javascript:alert(1)']) assert.throws(()=>canonicalUrl(url));
});
test('byte limit paginates without an unbounded response', () => {
  const items = Array.from({length:50},(_,i)=>({id:i,text:'x'.repeat(5000)}));
  const result = page(items,0,50);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<61000);
  assert.ok(result.next_offset>0 && result.next_offset<50);
});
test('health keeps true checked time, stale/unknown and RSS fallback separate', () => {
  const c=normalizeRegistry(registry);const source=c.sources.find(s=>s.name==='Example News');
  const [rss,sitemap]=source.endpoints;const checkedAt='2026-04-03T15:44:36.689Z';
  const now=Date.parse('2026-09-30T12:00:00Z');
  const observation=(e,outcome,time=checkedAt)=>({endpointId:e.id,type:e.type,url:e.url,checkedAt:time,outcome,httpStatus:200,reason:null,format:e.type==='rss'?'rss':'urlset'});
  const h=new HealthStore({version:1,observations:[observation(rss,'unhealthy'),observation(sitemap,'healthy','2026-09-30T11:00:00Z')]});
  assert.equal(h.get(rss,[source],now).status,'stale');
  assert.equal(h.get(rss,[source],now).checked_at,checkedAt);
  assert.equal(h.get(rss,[source],now).last_outcome,'unhealthy');
  assert.equal(h.get(sitemap,[source],now).status,'healthy');
  assert.equal(new HealthStore().get(rss,[source],now).checked_at,null);
  const legacy=new HealthStore(undefined,{results:[{countryCode:'US',outlet:'Example News',url:rss.url,checkedAt,valid:false,httpCode:403}],summary:{sitemapFallback:{recoveredFeeds:[{rssUrl:rss.url,sitemapUrl:sitemap.url}]}}});
  assert.equal(legacy.get(rss,[source],now).last_outcome,'reported_invalid');
  assert.equal(legacy.get(sitemap,[source],now).status,'unknown');
  const recent=new HealthStore(undefined,{results:[{countryCode:'US',outlet:'Example News',url:rss.url,checkedAt:'2026-09-30T11:00:00Z',valid:true,httpCode:200}]});
  assert.equal(recent.get(rss,[source],now).status,'unknown');
  const future=new HealthStore({version:1,observations:[observation(rss,'healthy','2027-01-01T00:00:00Z')]});
  assert.equal(future.get(rss,[source],now).status,'unknown');
  assert.equal(future.get(rss,[source],now).checked_at,null);
  assert.throws(()=>new HealthStore({version:1,observations:[{...observation(rss,'healthy'),type:'sitemap'}]}));
});
test('real registry preserves every current configured row and country independently of a dated fixture count', () => {
  const {catalog,rawRegistry}=loadData();
  const rows=rawRegistry.countries.reduce((count,country)=>count+country.feeds.length,0);
  assert.equal(catalog.configuredRows,rows);
  assert.deepEqual(new Set(catalog.countries.map(country=>country.code)),new Set(rawRegistry.countries.map(country=>country.code.toUpperCase())));
  assert.equal(catalog.sources.reduce((count,source)=>count+source.registrationCount,0),rows);
  assert.equal(catalog.countries.reduce((count,country)=>count+country.configuredRows,0),rows);
  assert.ok(catalog.sources.length<=catalog.configuredRows);
  assert.ok([...catalog.endpoints.values()].some(e=>e.type==='sitemap'));
});
test('fresh audit null fields never inherit historical warning or HTTP code',()=>{
  const c=normalizeRegistry(registry);const source=c.sources.find(s=>s.name==='Example News');const rss=source.endpoints[0];
  const legacy={results:[{countryCode:'US',outlet:'Example News',url:rss.url,checkedAt:'2026-04-03T15:44:36.689Z',valid:true,httpCode:200}]};
  const observation={endpointId:rss.id,type:'rss',url:rss.url,checkedAt:'2026-09-30T11:00:00Z',outcome:'healthy',httpStatus:200,reason:null,format:'rss'};
  const now=Date.parse('2026-09-30T12:00:00Z');
  const fresh=new HealthStore({version:1,observations:[observation]},legacy).get(rss,[source],now);
  assert.equal(fresh.validation,'xml_structure');assert.equal(fresh.reason,null);assert.equal(fresh.http_status,200);
  const failed=new HealthStore({version:1,observations:[{...observation,outcome:'unhealthy',httpStatus:null,reason:'Network timeout',format:null}]},legacy).get(rss,[source],now);
  assert.equal(failed.http_status,null);assert.equal(failed.reason,'Network timeout');assert.equal(failed.format,null);
});
