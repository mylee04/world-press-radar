import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {prepareRegistryAdditions} from '../dist/operator-additions.js';import {normalizeRegistry} from '../dist/catalog.js';import {countryInventory} from '../dist/activity.js';import {robotsPolicy} from '../expansion/robots-policy.mjs';
import {createHash} from 'node:crypto';import {withoutExpansionBatches} from './fixtures.mjs';
const load=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const first=load('../expansion/registry-additions.json'),live=load('../expansion/second-pass-live-before.json');
const original=withoutExpansionBatches(readFileSync(new URL('../../../data/rss-atlas.json',import.meta.url),'utf8'));
first.registry_sha256=createHash('sha256').update(original).digest('hex'); // isolated fixture only
const current=prepareRegistryAdditions(original,first,new Date(live.first_batch_source.enabled_changed_at)).registry;
const currentText=JSON.stringify(current,null,2)+'\n',batch=load('../expansion/remaining13/registry-additions.json'),now=new Date('2026-10-01T23:00:00Z');
batch.registry_sha256=createHash('sha256').update(currentText).digest('hex'); // isolated fixture only
test('remaining-country batch targets the first live batch state, adds four sources/five endpoints, preserves first activation times and all previous rows',()=>{
 const before=normalizeRegistry(current),r=prepareRegistryAdditions(currentText,batch,now),after=normalizeRegistry(r.registry);
 assert.equal(r.sources.length,4);assert.equal(r.endpoint_ids.length,5);for(const s of before.sources)assert.deepEqual(after.sources.find(x=>x.id===s.id),s);
 const totals=c=>countryInventory(c,{limit:50}).items.concat(countryInventory(c,{offset:50,limit:50}).items);
 const all=totals(after),old=totals(before);assert.equal(all.reduce((n,c)=>n+c.active_source_registrations,0),old.reduce((n,c)=>n+c.active_source_registrations,0)+4);assert.equal(all.filter(c=>c.active_source_registrations).length,old.filter(c=>c.active_source_registrations).length);
 const endpoints=c=>new Map(c.sources.filter(s=>s.enabled).flatMap(s=>s.endpoints.map(e=>[e.id,e])));
 const ep=endpoints(after),previous=endpoints(before);assert.equal([...ep.values()].filter(e=>e.type==='rss').length,[...previous.values()].filter(e=>e.type==='rss').length+3);assert.equal([...ep.values()].filter(e=>e.type==='sitemap').length,[...previous.values()].filter(e=>e.type==='sitemap').length+2);
 assert.throws(()=>prepareRegistryAdditions(original,batch,now),/Registry changed/);assert.equal(prepareRegistryAdditions(JSON.stringify(r.registry),batch,now).changed,false);
});
test('all remaining13 countries receive recorded attention; proven protocol alias and archive/navigation candidates are excluded',()=>{
 const phase=load('../expansion/remaining13/checkpoints.json'),target=load('../expansion/remaining13/targeted.json');
 for(const c of ['CN','IN','BR','AU','KR','MX','ID','TR','RU','SA','ZA','AR','ES'])assert.ok(phase.results.some(r=>r.country===c),c);
 const initial=load('../expansion/first-pass-checkpoints.json');for(const c of batch.selected_countries)assert.ok(initial.results.concat(phase.results).some(r=>r.country===c),c);
 const old=target.results.find(r=>r.kind==='existing_registry_comparison'),alias=phase.results.find(r=>r.name==='Sixth Tone').checked[0];
 assert.equal(old.observation.finalUrl,alias.observation.finalUrl);assert.equal(old.url_set_sha256,alias.url_set_sha256);
 const selected=batch.additions.flatMap(a=>a.endpoints.map(e=>e.url));assert.ok(!selected.includes(alias.url));assert.ok(!selected.includes('https://groundup.org.za/sitemap.xml'));assert.ok(!selected.some(u=>/post-sitemap\d|\?lang=|\/2026\/10\/sitemap/.test(u)));
 for(const a of batch.additions)for(const e of a.endpoints){assert.equal(e.observation.auditStatus,'working_nonempty');assert.ok(['allowed','allowed_robots_absent'].includes(e.access_review.decision));}
});
test('discovery robots matches wildcard/end, explicit bot groups, percent-encoded unreserved chars and longest allow ties',()=>{
 assert.equal(robotsPolicy('User-agent: *\nDisallow: /spip.php?*','https://a.example/spip.php?page=backend').decision,'disallowed');
 assert.equal(robotsPolicy('User-agent: *\nDisallow: /news$','https://a.example/news/1').decision,'allowed');
 assert.equal(robotsPolicy('User-agent: *\nDisallow: /\nUser-agent: WorldNewsSourcesMCP\nAllow: /feed/','https://a.example/feed/').decision,'allowed');
 assert.equal(robotsPolicy('User-agent: *\nDisallow: /foo\nAllow: /foo','https://a.example/%66oo').decision,'allowed');
});
