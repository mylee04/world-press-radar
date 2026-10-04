import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRegistry,search} from '../dist/catalog.js';
import {updateRegistryStatus} from '../dist/operator-status.js';
import {HealthStore} from '../dist/health.js';

const input=()=>({countries:[{code:'US',name:'United States',feeds:[
  {name:'Example',url:'https://example.com/rss',sitemapUrl:'https://example.com/sitemap.xml',enabled:true,row:1},
  {name:'Example',url:'https://example.com/rss',sitemapUrl:'https://example.com/sitemap.xml',enabled:true,row:2},
]}]});
test('existing activation history remains unknown; health checks do not change registry state',()=>{
  const raw=input(),source=normalizeRegistry(raw).sources[0];
  assert.equal(source.enabled_changed_at,null);assert.equal(source.status_reason,null);
  assert.equal(source.status_transition_count,null);assert.deepEqual(source.status_history,[]);
  const ep=source.endpoints[0];
  new HealthStore({version:1,observations:[{endpointId:ep.id,type:ep.type,url:ep.url,checkedAt:'2026-09-30T20:00:00Z',outcome:'unhealthy',httpStatus:503,reason:'HTTP error',format:null}]}).get(ep,[source]);
  assert.deepEqual(raw,input());assert.equal(normalizeRegistry(raw).sources[0].enabled,true);
});
test('operator records actual transition separately and updates duplicate registrations consistently',()=>{
  const raw=input(),id=normalizeRegistry(raw).sources[0].id;
  const changed=updateRegistryStatus(raw,id,false,'Publisher discontinued feed',new Date('2026-09-30T23:00:00Z'));
  const source=normalizeRegistry(changed).sources[0];
  assert.equal(source.id,id);assert.equal(source.enabled,false);assert.equal(source.enabled_changed_at,'2026-09-30T23:00:00.000Z');
  assert.equal(source.status_reason,'Publisher discontinued feed');assert.equal(source.status_transition_count,1);
  assert.deepEqual(source.status_history,[{old_enabled:true,new_enabled:false,changed_at:source.enabled_changed_at,reason:source.status_reason}]);
  assert.equal(source.registrationCount,2);assert.equal(source.status_history_consistent,true);
  assert.equal(search(normalizeRegistry(changed),{enabled:false}).items.length,1);
  assert.deepEqual(raw,input());
  assert.throws(()=>updateRegistryStatus(changed,id,false,'unchanged'));
  assert.throws(()=>updateRegistryStatus(changed,id,true,'earlier',new Date('2026-09-30T22:00:00Z')));
  assert.throws(()=>updateRegistryStatus(changed,id,true,''));
});
test('history is bounded to twenty genuine transitions while total count survives',()=>{
  let raw=input();const id=normalizeRegistry(raw).sources[0].id;
  for(let i=0;i<25;i++) raw=updateRegistryStatus(raw,id,i%2!==0,'Operator review '+i,new Date(Date.UTC(2026,8,30,23,0,i)));
  const source=normalizeRegistry(raw).sources[0];
  assert.equal(source.status_history.length,20);assert.equal(source.status_transition_count,25);
  assert.equal(source.status_history[0].reason,'Operator review 5');assert.equal(source.status_history.at(-1).reason,'Operator review 24');
});
test('invalid UTC dates/chains/state metadata fail and conflicting duplicates never invent a date',()=>{
  const raw=input(),id=normalizeRegistry(raw).sources[0].id;
  const changed=updateRegistryStatus(raw,id,false,'reviewed',new Date('2026-09-30T23:00:00Z'));
  const bad=structuredClone(changed);bad.countries[0].feeds[0].enabled_changed_at='2026-09-30T23:00:00+02:00';assert.throws(()=>normalizeRegistry(bad));
  const mismatch=structuredClone(changed);mismatch.countries[0].feeds[0].enabled=true;assert.throws(()=>normalizeRegistry(mismatch));
  const conflict=structuredClone(changed);conflict.countries[0].feeds[1]=raw.countries[0].feeds[1];
  const source=normalizeRegistry(conflict).sources[0];
  assert.equal(source.enabled,true);assert.equal(source.enabled_changed_at,null);assert.equal(source.status_history_consistent,false);
  assert.throws(()=>updateRegistryStatus(conflict,id,false,'reconcile first'));
});
