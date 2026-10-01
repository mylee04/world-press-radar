import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {ActivityStore} from '../dist/activity.js';
import {fileURLToPath} from 'node:url';
import {normalizeRegistry} from '../dist/catalog.js';
const address=process.argv[2]??'http://127.0.0.1:3000/mcp';
const client=new Client({name:'world-news-sources-live-smoke',version:'0.1.0'});
const verifiedExamples=[];
const metricsAcks=[];
try{
  const status=await fetch(new URL('/health',address),{signal:AbortSignal.timeout(15000)});
  assert.equal(status.status,200);const summary=await status.json();assert.equal(summary.configured_rows,5393);
  await client.connect(new StreamableHTTPClientTransport(new URL(address),{fetch:async(input,init)=>{const headers=new Headers(init?.headers);headers.set('x-world-news-traffic','inspection');const response=await fetch(input,{...init,headers});const ack=response.headers.get('x-world-news-metrics');if(ack)metricsAcks.push(ack);return response;}}));
  const tools=(await client.listTools()).tools;assert.equal(tools.length,7);
  const sources=(await client.callTool({name:'search_sources',arguments:{country:'US',endpoint_type:'sitemap',limit:1}})).structuredContent;
  assert.equal(sources.items.length,1);
  const source=sources.items[0];
  const details=(await client.callTool({name:'get_source',arguments:{source_id:source.id}})).structuredContent;
  assert.equal(details.id,source.id);
  const registryPath=new URL('../../../data/rss-atlas.json',import.meta.url);
  if(existsSync(registryPath)){const expectedSource=normalizeRegistry(JSON.parse(readFileSync(registryPath,'utf8'))).sources.find(s=>s.id===details.id);assert.ok(expectedSource);for(const key of ['enabled','enabled_changed_at','status_reason','status_history','status_transition_count','status_history_consistent'])assert.deepEqual(details[key],expectedSource[key]);}
  const health=(await client.callTool({name:'get_endpoint_health',arguments:{endpoint_ids:[source.endpoints[0].id]}})).structuredContent;
  assert.ok(['unknown','stale','healthy','unhealthy'].includes(health.endpoints[0].status));
  const snapshotPath=new URL('../audits/health-latest.json',import.meta.url);
  if(existsSync(snapshotPath)){
    const expected=JSON.parse(readFileSync(snapshotPath,'utf8'));
    assert.equal(summary.last_completed_full_audit_at,expected.audit.lastCompletedFullAuditAt);
    assert.equal(summary.endpoints_checked,expected.audit.checked);
    const observation=expected.observations.find(o=>o.endpointId===source.endpoints[0].id);
    assert.equal(health.endpoints[0].checked_at,observation.checkedAt);
    assert.equal(health.endpoints[0].entry_count,observation.entryCount??null);
    for(const type of ['rss','sitemap']){
      const working=expected.observations.find(o=>o.type===type&&o.auditStatus==='working_nonempty'&&o.sampleUrls?.length);
      assert.ok(working);
      const actual=(await client.callTool({name:'get_endpoint_health',arguments:{endpoint_ids:[working.endpointId]}})).structuredContent.endpoints[0];
      assert.equal(actual.checked_at,working.checkedAt);assert.equal(actual.entry_count,working.entryCount);
      assert.equal(actual.reason,working.reason);assert.equal(actual.http_status,working.httpStatus);
      assert.equal(actual.audit_status,'working_nonempty');assert.deepEqual(actual.sample_urls,working.sampleUrls);
      verifiedExamples.push({type,endpoint_id:actual.endpoint_id,format:actual.format,checked_at:actual.checked_at,entry_count:actual.entry_count,sample_urls:actual.sample_urls});
    }
  }
  const countries=(await client.callTool({name:'list_countries',arguments:{limit:1}})).structuredContent;
  assert.equal(countries.total,73);
  const inventory=(await client.callTool({name:'get_country_source_inventory',arguments:{country:'US',limit:1}})).structuredContent;
  assert.ok(inventory.items[0].active_source_registrations>0);
  const activityPath=new URL('../activity/activity-snapshot.json',import.meta.url);
  const activitySnapshot=existsSync(activityPath)?JSON.parse(readFileSync(activityPath,'utf8')):null;
  const activitySource=activitySnapshot?.collections[0]?.source_ids[0]??activitySnapshot?.bindings.find(b=>b.baseline_at)?.source_id??source.id;
  const activityDay=(activitySnapshot?.scope_starts?.source[activitySource]??activitySnapshot?.tracking_start)?.slice(0,10)??new Date().toISOString().slice(0,10);
  const activity=(await client.callTool({name:'get_source_article_activity',arguments:{source_id:activitySource,start_date:activityDay,end_date:activityDay}})).structuredContent;
  const countryActivity=(await client.callTool({name:'get_country_article_activity',arguments:{country:'US',start_date:activityDay,end_date:activityDay}})).structuredContent;
  if(activitySnapshot?.history){
    const catalog=normalizeRegistry(JSON.parse(readFileSync(registryPath,'utf8'))),expected=new ActivityStore(activitySnapshot,fileURLToPath(new URL('../activity/history/',import.meta.url))).query(catalog,'source',{source_id:activitySource,start_date:activityDay,end_date:activityDay});
    assert.deepEqual(activity.items,expected.items);assert.deepEqual(activity.snapshot_coverage,activitySnapshot.snapshot_coverage);assert.notEqual(activity.items[0].state,'history_not_in_snapshot');
  }
  if(activitySnapshot){assert.equal(activity.tracking_start,activitySnapshot.tracking_start);assert.equal(activity.snapshot_at,activitySnapshot.generated_at);assert.equal(summary.article_activity.tracking_start,activitySnapshot.tracking_start);assert.ok(activity.initialized_bindings>0);}
  const rpc=async(body,version)=>{
    const response=await fetch(address,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','x-world-news-traffic':'inspection',...(version?{'mcp-protocol-version':version}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const ack=response.headers.get('x-world-news-metrics');if(ack)metricsAcks.push(ack);const text=await response.text();
    const result=response.headers.get('content-type')?.includes('text/event-stream')?JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)):JSON.parse(text);
    assert.equal(result.error,undefined);return result.result;
  };
  const initialized=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'live-legacy-smoke',version:'1'}}});
  assert.equal(initialized.serverInfo.name,'world-news-sources-mcp');
  assert.equal((await rpc({jsonrpc:'2.0',id:2,method:'tools/list'},initialized.protocolVersion)).tools.length,7);
  const called=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_countries',arguments:{limit:1}}},initialized.protocolVersion);
  assert.equal(called.structuredContent.total,73);
  if(summary.usage_statistics?.configured){assert.equal(metricsAcks.length,10);assert.ok(metricsAcks.every(ack=>ack==='recorded'));}
  console.log(JSON.stringify({endpoint:address,service:summary,metrics_acknowledgments:metricsAcks,tools:tools.map(t=>t.name),sample:{source_id:source.id,name:source.name,endpoint_type:source.endpoints[0].type,health:health.endpoints[0].status,checked_at:health.endpoints[0].checked_at,entry_count:health.endpoints[0].entry_count},output_examples:verifiedExamples,inventory,source_activity:activity,country_activity:countryActivity,protocol:initialized.protocolVersion,verified:'HTTPS SDK calls plus legacy initialize, tools/list, tools/call and matching cached audit'},null,2));
}finally{await client.close();}
