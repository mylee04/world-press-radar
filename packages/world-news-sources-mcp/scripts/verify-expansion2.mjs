import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {normalizeRegistry} from '../dist/catalog.js';
import {ActivityStore} from '../dist/activity.js';
import {fileURLToPath} from 'node:url';
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const old=process.argv[2];
const before=json(old+'/data/rss-atlas.json'),after=json('../../data/rss-atlas.json');
for(const c of before.countries){const n=after.countries.find(x=>x.code===c.code);assert.deepEqual(n.feeds.slice(0,c.feeds.length),c.feeds);}
const a=normalizeRegistry(after),b=normalizeRegistry(before),batch=json('expansion/remaining13/applied.json');
assert.equal(a.configuredRows-b.configuredRows,4);
for(const s of b.sources)assert.deepEqual(a.sources.find(x=>x.id===s.id),s);
const oldHealth=json(old+'/packages/world-news-sources-mcp/audits/health-latest.json'),health=json('audits/health-latest.json');
assert.deepEqual(health.audit,oldHealth.audit);assert.deepEqual(health.observations.slice(0,oldHealth.observations.length),oldHealth.observations);
const acks=[];const client=new Client({name:'expansion-production-verification',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL('https://news.bymyleslee.com/mcp'),{fetch:async(i,o)=>{const h=new Headers(o?.headers);h.set('x-world-news-traffic','inspection');const r=await fetch(i,{...o,headers:h});const ack=r.headers.get('x-world-news-metrics');if(ack)acks.push(ack);return r;}}));
const call=async(name,args)=>(await client.callTool({name,arguments:args})).structuredContent;
const inventory=await call('get_country_source_inventory',{limit:1});assert.deepEqual(inventory.global_totals,{active_countries:72,active_source_registrations:5034,unique_active_rss_endpoints:3667,unique_active_sitemap_endpoints:1749});
const snapshot=json('activity/activity-snapshot.json'),store=new ActivityStore(snapshot,fileURLToPath(new URL('../activity/history/',import.meta.url))),sources=[];
for(const s of batch.new_sources){const live=await call('get_source',{source_id:s.id}),expected=a.sources.find(x=>x.id===s.id);assert.equal(live.enabled_changed_at,expected.enabled_changed_at);assert.equal(live.status_transition_count,0);const args={source_id:s.id,start_date:'2026-10-01',end_date:'2026-10-01'};const activity=await call('get_source_article_activity',args);assert.deepEqual(activity.items,store.query(a,'source',args).items);assert.equal(activity.initialization,'initialized');assert.equal(activity.items[0].new_unique_candidate_urls,0);sources.push({id:s.id,name:s.name,initial_enabled_at:live.enabled_changed_at,activity});}
const endpointHealth=await call('get_endpoint_health',{endpoint_ids:batch.endpoint_ids});for(const ep of endpointHealth.endpoints){const e=health.observations.find(x=>x.endpointId===ep.endpoint_id);assert.equal(ep.audit_status,'working_nonempty');assert.equal(ep.checked_at,e.checkedAt);assert.equal(ep.entry_count,e.entryCount);}
await client.close();
const files=[];
for(const [url,file] of [['/','index.html'],['/support','support.html'],['/privacy','privacy.html'],['/terms','terms.html'],['/.well-known/openai-apps-challenge','.well-known/openai-apps-challenge'],['/demo/world-news-sources.mp4','demo/world-news-sources.mp4']]){const expected=readFileSync('site/'+file),previous=readFileSync(old+'/packages/world-news-sources-mcp/site/'+file);assert.deepEqual(expected,previous);const r=await fetch('https://news.bymyleslee.com'+url);assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.deepEqual(bytes,expected);files.push({path:url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),preserved:true});}
assert.ok(acks.length>=10&&acks.every(x=>x==='recorded'));
const result={inventory,sources,endpoint_health:endpointHealth,files,metrics_acknowledgments:acks,old_registry_and_health_preserved:true,history:snapshot.history,snapshot_at:snapshot.generated_at,deployment:json('activity/deployment-expansion2-20261001.json')};writeFileSync('expansion/remaining13/PRODUCTION-VERIFICATION.json',JSON.stringify(result,null,2));console.log(JSON.stringify({inventory:inventory.global_totals,endpoints:endpointHealth.endpoints.map(e=>({id:e.endpoint_id,status:e.audit_status,entries:e.entry_count,freshness:e.content_freshness})),files,metrics_acks:acks.length,history:snapshot.history,deployment:result.deployment}));
