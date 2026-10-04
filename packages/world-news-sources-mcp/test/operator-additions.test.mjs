import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareRegistryAdditions} from '../dist/operator-additions.js';
import {normalizeRegistry} from '../dist/catalog.js';
import {ActivityLedger} from '../dist/activity-ledger.js';
import {countryInventory,ActivityStore} from '../dist/activity.js';
import {HealthStore} from '../dist/health.js';
import {updateRegistryStatus} from '../dist/operator-status.js';
import {createHash} from 'node:crypto';
import {withoutExpansionBatches} from './fixtures.mjs';

const at='2026-10-01T21:00:00.000Z',registry=withoutExpansionBatches(readFileSync(new URL('../../../data/rss-atlas.json',import.meta.url),'utf8'));
const batch=JSON.parse(readFileSync(new URL('../expansion/registry-additions.json',import.meta.url),'utf8'));
batch.registry_sha256=createHash('sha256').update(registry).digest('hex'); // isolated fixture only
const proposal=()=>prepareRegistryAdditions(registry,batch,new Date(at));
test('verified batch adds seven registrations / eight typed endpoints in existing countries; original rows and IDs unchanged',()=>{
  const result=proposal(),before=JSON.parse(registry),old=normalizeRegistry(before),after=normalizeRegistry(result.registry);
  assert.equal(result.sources.length,7);assert.equal(result.endpoint_ids.length,8);assert.equal(after.configuredRows,old.configuredRows+7);
  assert.deepEqual(after.countries.map(c=>c.code),old.countries.map(c=>c.code));
  for(let i=0;i<before.countries.length;i++)assert.deepEqual(result.registry.countries[i].feeds.slice(0,before.countries[i].feeds.length),before.countries[i].feeds);
  for(const s of old.sources)assert.deepEqual(after.sources.find(x=>x.id===s.id),s);
  for(const s of result.sources){assert.equal(s.enabled_changed_at,at);assert.equal(s.status_transition_count,0);assert.deepEqual(s.status_history,[]);}
  const sum=c=>countryInventory(c,{limit:50}).items.concat(countryInventory(c,{offset:50,limit:50}).items).reduce((n,r)=>n+r.active_source_registrations,0);
  assert.equal(sum(after),sum(old)+7);assert.equal(new Set(after.sources.filter(s=>s.enabled).flatMap(s=>s.endpoints.map(e=>e.id))).size,new Set(old.sources.filter(s=>s.enabled).flatMap(s=>s.endpoints.map(e=>e.id))).size+8);
});
test('batch replay preserves state/history, including later operator deactivation',()=>{
  const result=proposal(),disabled=updateRegistryStatus(result.registry,result.sources[0].id,false,'Operator review',new Date('2026-10-01T22:00:00Z'));
  const replay=prepareRegistryAdditions(JSON.stringify(disabled),batch,new Date('2026-10-02T00:00:00Z'));
  assert.equal(replay.changed,false);assert.deepEqual(replay.registry,disabled);
});
test('changed registry, out-of-scope country, duplicate/disabled endpoints and observation mismatches reject without edits',()=>{
  assert.throws(()=>prepareRegistryAdditions(registry+' ',batch,new Date(at)),/Registry changed/);
  const check=mutate=>{const bad=structuredClone(batch);mutate(bad);assert.throws(()=>prepareRegistryAdditions(registry,bad,new Date(at)));};
  check(b=>b.additions[0].country='NZ');
  check(b=>b.additions.push(structuredClone(b.additions[0])));
  check(b=>b.additions[0].endpoints[0].observation.type='sitemap');
  check(b=>b.additions[0].endpoints[0].access_review.matched_rule={allow:false,pattern:'/'});
  check(b=>b.additions[0].endpoints[0].access_review.checked_at='2026-09-25T00:00:00.000Z');
  const old=normalizeRegistry(JSON.parse(registry)).sources.find(s=>!s.enabled&&s.endpoints.length),ep=old.endpoints[0];
  const bad=structuredClone(batch),e=bad.additions[0].endpoints[0];Object.assign(e,{type:ep.type,url:ep.url,endpoint_id:ep.id});Object.assign(e.observation,{type:ep.type,url:ep.url,endpointId:ep.id,format:ep.type==='rss'?'rss':'urlset',finalUrl:ep.url});e.access_review.robots_url=new URL('/robots.txt',ep.url).href;bad.additions[0].endpoints=[e];
  assert.throws(()=>prepareRegistryAdditions(registry,bad,new Date(at)),/Already configured/);
});
test('invalid XML, index-only, empty, stale check and future timestamps are not accepted as verified additions',()=>{
  for(const mutate of [o=>o.auditStatus='malformed',o=>o.format='sitemapindex',o=>o.entriesWithUrl=0,
    o=>o.checkedAt='2026-09-01T00:00:00.000Z',o=>o.checkedAt='2026-10-02T00:00:00.000Z']){
    const bad=structuredClone(batch);mutate(bad.additions[0].endpoints[0].observation);assert.throws(()=>prepareRegistryAdditions(registry,bad,new Date(at)));
  }
});
test('new RSS+sitemap binding baselines exclude archives and country deduplicates later overlap',()=>{
  const result=proposal(),catalog=normalizeRegistry(result.registry),source=result.sources.find(s=>s.name==='The Maple');
  const dir=mkdtempSync(join(tmpdir(),'source-additions-')),ledger=new ActivityLedger(join(dir,'inspection.sqlite'));
  try{
    ledger.acquire('test',at,3600);ledger.syncRegistry(normalizeRegistry(JSON.parse(registry)),at);ledger.syncRegistry(catalog,at);
    let i=0;const visit=(ep,urls)=>ledger.commit({id:'check-'+i,endpoint:ep,checked_at:new Date(Date.parse(at)+i++*1000).toISOString(),status:'working_nonempty',format:ep.type==='rss'?'rss':'urlset',reason:null,urls,traffic:'inspection'},[source],'test',at);
    const old='https://www.readthemaple.com/example-archive/',fresh='https://www.readthemaple.com/example-new/';
    assert.equal(visit(source.endpoints[0],[old]).country_new.CA,0);assert.equal(visit(source.endpoints[1],[old,'https://www.readthemaple.com/older/']).source_new[source.id],0);
    assert.equal(visit(source.endpoints[0],[old,fresh]).country_new.CA,1);assert.equal(visit(source.endpoints[1],[fresh]).country_new.CA,0);
    const snapshot=ledger.snapshot(catalog,'2026-10-02T00:00:00Z');
    assert.equal(snapshot.lane,'inspection');
    assert.equal(snapshot.bindings.filter(b=>b.source_id===source.id&&b.baseline_at).length,2);
    assert.throws(()=>new ActivityStore(snapshot),/Invalid production activity snapshot/);
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
test('actual checked time stays separate from registration time and publication/lastmod freshness; fallback failure is not overwritten',()=>{
  const result=proposal(),catalog=normalizeRegistry(result.registry),snapshot=JSON.parse(readFileSync(new URL('../expansion/verified-health-additions.json',import.meta.url),'utf8'));
  const health=new HealthStore(snapshot);
  for(const source of result.sources)for(const ep of source.endpoints){const got=health.get(ep,catalog.sources,Date.parse(at));assert.equal(got.status,'healthy');assert.notEqual(got.checked_at,source.enabled_changed_at);}
  const capital=result.sources.find(s=>s.name==='Capital (Official RSS)');assert.equal(health.get(capital.endpoints[0],catalog.sources,Date.parse(at)).date_kind,'feed_item_date');
  const nippon=result.sources.find(s=>s.name.startsWith('Nippon.com ('));assert.equal(health.get(nippon.endpoints[0],catalog.sources,Date.parse(at)).content_freshness,'unreliable');
  const old=normalizeRegistry(JSON.parse(registry)).sources.find(s=>s.endpoints.some(e=>e.url==='https://www.capital.fr/rss'));
  assert.ok(old);
  const prior=JSON.parse(readFileSync(new URL('../audits/health-latest.json',import.meta.url),'utf8'));
  const oldEp=old.endpoints.find(e=>e.url==='https://www.capital.fr/rss');
  const before=new HealthStore(prior).get(oldEp,catalog.sources,Date.parse(at));
  const combined=new HealthStore({version:1,observations:prior.observations.concat(snapshot.observations)});
  assert.equal(before.last_outcome,'unhealthy');assert.deepEqual(combined.get(oldEp,catalog.sources,Date.parse(at)),before);
});
