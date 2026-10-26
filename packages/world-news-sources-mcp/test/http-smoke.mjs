import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {ActivityStore} from '../dist/activity.js';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {normalizeRegistry} from '../dist/catalog.js';

export function parseSmokeOptions(args) {
  let address, allowMetricsDegraded=false;
  for(const argument of args){
    if(argument==='--allow-metrics-degraded'){
      if(allowMetricsDegraded)throw Error('Duplicate --allow-metrics-degraded');
      allowMetricsDegraded=true;
    }else if(argument.startsWith('--')||address!==undefined)throw Error('Usage: http-smoke.mjs [MCP_URL] [--allow-metrics-degraded]');
    else address=argument;
  }
  const url=new URL(address??'http://127.0.0.1:3000/mcp');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw Error('MCP_URL must be HTTP(S), without credentials or a fragment');
  return {address:url.href,allowMetricsDegraded};
}

export function metricsResult(configured,acknowledgments,allowMetricsDegraded=false,expected=10){
  const missing=Math.max(0,expected-acknowledgments.length);
  const complete=acknowledgments.length===expected&&acknowledgments.every(ack=>ack==='recorded');
  if(configured&&!allowMetricsDegraded){
    // Strict mode retains the original acknowledgment requirements.
    assert.equal(acknowledgments.length,expected,'Configured usage statistics must acknowledge every checked tool call');
    assert.ok(acknowledgments.every(ack=>ack==='recorded'),'Configured usage statistics acknowledgments must be recorded');
  }
  const degraded=configured&&!complete;
  return {status:!configured?'not_configured':degraded?'degraded':'recorded',
    expected_acknowledgments:configured?expected:0,received_acknowledgments:acknowledgments.length,
    recorded_acknowledgments:acknowledgments.filter(ack=>ack==='recorded').length,
    missing_acknowledgments:configured?missing:0,
    warning:degraded?'Usage statistics acknowledgments are unavailable or incomplete; MCP functional checks passed.':null};
}

export async function runHttpSmoke(options,dependencies={}){
const {address,allowMetricsDegraded=false}=options;
const fetchImpl=dependencies.fetch??fetch;
const readJson=dependencies.readJson??(path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null);
const client=dependencies.client??new Client({name:'world-news-sources-live-smoke',version:'0.1.0'});
const callStructured=async input=>{
  const result=await client.callTool(input);
  assert.notEqual(result.isError,true,'MCP tool reported a functional error');
  assert.ok(result.structuredContent&&typeof result.structuredContent==='object'&&!Array.isArray(result.structuredContent),'MCP tool requires structured output');
  return result.structuredContent;
};
const verifiedExamples=[];
const metricsAcks=[];
try{
  const registry=readJson(new URL('../../../data/rss-atlas.json',import.meta.url));
  const catalog=registry?normalizeRegistry(registry):null;
  const status=await fetchImpl(new URL('/health',address),{signal:AbortSignal.timeout(15000)});
  assert.equal(status.status,200);const summary=await status.json();
  for(const key of ['configured_rows','countries'])assert.ok(Number.isSafeInteger(summary[key])&&summary[key]>0,`Health ${key} must be a positive safe integer`);
  if(catalog){
    assert.equal(summary.configured_rows,catalog.configuredRows,'Health registration count must match the local registry');
    assert.equal(summary.countries,catalog.countries.length,'Health country count must match the local registry');
  }
  const inspectionFetch=async(input,init)=>{const headers=new Headers(init?.headers);headers.set('x-world-news-traffic','inspection');const response=await fetchImpl(input,{...init,headers});const ack=response.headers.get('x-world-news-metrics');if(ack)metricsAcks.push(ack);return response;};
  await client.connect(dependencies.createTransport?dependencies.createTransport(address,inspectionFetch):new StreamableHTTPClientTransport(new URL(address),{fetch:inspectionFetch}));
  const tools=(await client.listTools()).tools;
  const toolNames=new Set(tools.map(tool=>tool.name));
  for(const name of ['search_sources','get_source','list_countries','get_endpoint_health','get_country_source_inventory','get_source_article_activity','get_country_article_activity','get_country_collection_quality','get_source_collection_quality'])assert.ok(toolNames.has(name),`Missing required tool ${name}`);
  const packToolNames=['list_source_packs','get_source_pack','export_source_pack'];
  const hasPacks=packToolNames.some(name=>toolNames.has(name));
  if(hasPacks)for(const name of packToolNames)assert.ok(toolNames.has(name),`Incomplete source pack tool set: ${name}`);
  const sources=await callStructured({name:'search_sources',arguments:{country:'US',endpoint_type:'sitemap',include:'all',limit:1}});
  assert.equal(sources.items.length,1);
  const source=sources.items[0];
  const details=await callStructured({name:'get_source',arguments:{source_id:source.id}});
  assert.equal(details.id,source.id);
  if(catalog){const expectedSource=catalog.sources.find(s=>s.id===details.id);assert.ok(expectedSource);for(const key of ['enabled','enabled_changed_at','status_reason','status_history','status_transition_count','status_history_consistent'])assert.deepEqual(details[key],expectedSource[key]);}
  const health=await callStructured({name:'get_endpoint_health',arguments:{endpoint_ids:[source.endpoints[0].id]}});
  assert.ok(['unknown','stale','healthy','unhealthy'].includes(health.endpoints[0].status));
  const snapshotPath=new URL('../audits/health-latest.json',import.meta.url);
  const expected=readJson(snapshotPath);
  if(expected){
    assert.equal(summary.last_completed_full_audit_at,expected.audit.lastCompletedFullAuditAt);
    assert.equal(summary.endpoints_checked,expected.audit.checked);
    const observation=expected.observations.find(o=>o.endpointId===source.endpoints[0].id);
    assert.equal(health.endpoints[0].checked_at,observation.checkedAt);
    assert.equal(health.endpoints[0].entry_count,observation.entryCount??null);
    for(const type of ['rss','sitemap']){
      const working=expected.observations.find(o=>o.type===type&&o.auditStatus==='working_nonempty'&&o.sampleUrls?.length);
      assert.ok(working);
      const actual=(await callStructured({name:'get_endpoint_health',arguments:{endpoint_ids:[working.endpointId]}})).endpoints[0];
      assert.equal(actual.checked_at,working.checkedAt);assert.equal(actual.entry_count,working.entryCount);
      assert.equal(actual.reason,working.reason);assert.equal(actual.http_status,working.httpStatus);
      assert.equal(actual.audit_status,'working_nonempty');assert.deepEqual(actual.sample_urls,working.sampleUrls);
      verifiedExamples.push({type,endpoint_id:actual.endpoint_id,format:actual.format,checked_at:actual.checked_at,entry_count:actual.entry_count,sample_urls:actual.sample_urls});
    }
  }
  const countries=await callStructured({name:'list_countries',arguments:{limit:1}});
  assert.equal(countries.total,summary.countries,'SDK country count must match health');
  assert.equal(countries.configured_rows,summary.configured_rows,'SDK registration count must match health');
  const inventory=await callStructured({name:'get_country_source_inventory',arguments:{country:'US',limit:1}});
  assert.ok(inventory.items[0].active_source_registrations>0);
  const activityPath=new URL('../activity/activity-snapshot.json',import.meta.url);
  const activitySnapshot=readJson(activityPath);
  const activitySource=activitySnapshot?.collections[0]?.source_ids[0]??activitySnapshot?.bindings.find(b=>b.baseline_at)?.source_id??source.id;
  const activityDay=(activitySnapshot?.scope_starts?.source[activitySource]??activitySnapshot?.tracking_start)?.slice(0,10)??new Date().toISOString().slice(0,10);
  const activity=await callStructured({name:'get_source_article_activity',arguments:{source_id:activitySource,start_date:activityDay,end_date:activityDay}});
  const countryActivity=await callStructured({name:'get_country_article_activity',arguments:{country:'US',start_date:activityDay,end_date:activityDay}});
  if(activitySnapshot?.history){
    assert.ok(catalog,'Local registry is required to verify exported activity history');
    const expected=new ActivityStore(activitySnapshot,fileURLToPath(new URL('../activity/history/',import.meta.url))).query(catalog,'source',{source_id:activitySource,start_date:activityDay,end_date:activityDay});
    assert.deepEqual(activity.items,expected.items);assert.deepEqual(activity.snapshot_coverage,activitySnapshot.snapshot_coverage);assert.notEqual(activity.items[0].state,'history_not_in_snapshot');
  }
  if(activitySnapshot){assert.equal(activity.tracking_start,activitySnapshot.tracking_start);assert.equal(activity.snapshot_at,activitySnapshot.generated_at);assert.equal(summary.article_activity.tracking_start,activitySnapshot.tracking_start);assert.ok(activity.initialized_bindings>0);}
  let sourcePackVerification={available:false};
  if(hasPacks){
    const packs=await callStructured({name:'list_source_packs',arguments:{limit:1}});assert.ok(packs.total>=3);assert.equal(packs.items.length,1);
    const pack=await callStructured({name:'get_source_pack',arguments:{pack_id:packs.items[0].id,limit:1}});assert.equal(pack.id,packs.items[0].id);assert.ok(pack.entries.length);
    const exported=await callStructured({name:'export_source_pack',arguments:{pack_id:pack.id,format:'opml'}});assert.equal(exported.format,'opml');assert.equal(new URL(exported.download_url).hostname,'news.bymyleslee.com');
    assert.ok(typeof exported.content==='string'&&exported.content.includes('<opml'));assert.ok(!exported.content.includes('type="sitemap"'));
    sourcePackVerification={available:true,pack_id:pack.id,pack_count:packs.total,exported_endpoints:exported.exported_endpoints,download_url:exported.download_url};
  }
  const rpc=async(body,version)=>{
    const response=await fetchImpl(address,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','x-world-news-traffic':'inspection',...(version?{'mcp-protocol-version':version}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const ack=response.headers.get('x-world-news-metrics');if(ack)metricsAcks.push(ack);const text=await response.text();
    const result=response.headers.get('content-type')?.includes('text/event-stream')?JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)):JSON.parse(text);
    assert.equal(result.error,undefined);return result.result;
  };
  const initialized=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'live-legacy-smoke',version:'1'}}});
  assert.equal(initialized.serverInfo.name,'world-news-sources-mcp');
  assert.deepEqual(new Set((await rpc({jsonrpc:'2.0',id:2,method:'tools/list'},initialized.protocolVersion)).tools.map(tool=>tool.name)),toolNames);
  const called=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_countries',arguments:{limit:1}}},initialized.protocolVersion);
  assert.notEqual(called.isError,true,'Legacy MCP tool reported a functional error');
  assert.equal(called.structuredContent.total,summary.countries,'Legacy country count must match health');
  assert.equal(called.structuredContent.configured_rows,summary.configured_rows,'Legacy registration count must match health');
  const metrics=metricsResult(Boolean(summary.usage_statistics?.configured),metricsAcks,allowMetricsDegraded,hasPacks?13:10);
  return {status:metrics.status==='degraded'?'degraded':'passed',functional_status:'passed',endpoint:address,service:summary,
    metrics,metrics_acknowledgments:metricsAcks,tools:tools.map(t=>t.name),source_pack_verification:sourcePackVerification,sample:{source_id:source.id,name:source.name,endpoint_type:source.endpoints[0].type,health:health.endpoints[0].status,checked_at:health.endpoints[0].checked_at,entry_count:health.endpoints[0].entry_count},output_examples:verifiedExamples,inventory,source_activity:activity,country_activity:countryActivity,protocol:initialized.protocolVersion,verified:'HTTPS SDK calls plus legacy initialize, tools/list, tools/call and matching cached audit; source pack reads/OPML where available'};
}finally{await client.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const result=await runHttpSmoke(parseSmokeOptions(process.argv.slice(2)));if(result.metrics.warning)console.warn(result.metrics.warning);console.log(JSON.stringify(result,null,2));}
  catch(error){console.error(`MCP smoke failed: ${error.message}`);process.exitCode=1;}
}
