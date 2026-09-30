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
test('real registry loads independently with expected configuration counts', () => {
  const {catalog}=loadData();assert.equal(catalog.configuredRows,5393);assert.equal(catalog.countries.length,73);
  assert.ok(catalog.sources.length<=catalog.configuredRows);
  assert.ok([...catalog.endpoints.values()].some(e=>e.type==='sitemap'));
});
