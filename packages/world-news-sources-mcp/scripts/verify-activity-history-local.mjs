// Actual generated hosted module + actual stored aggregate metadata. No external fetch or usage writes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {normalizeRegistry} from '../dist/catalog.js';
import {ActivityStore} from '../dist/activity.js';
import {fileURLToPath} from 'node:url';
delete process.env.METRICS_COLLECTOR_URL;delete process.env.METRICS_WRITE_SECRET;
const {handler}=await import('../.deploy-vercel/dist/hosted.mjs');
const snapshot=JSON.parse(readFileSync(new URL('../activity/activity-snapshot.json',import.meta.url),'utf8'));
assert.ok(snapshot.history?.complete);const catalog=normalizeRegistry(JSON.parse(readFileSync(new URL('../../../data/rss-atlas.json',import.meta.url),'utf8')));
const source_id=snapshot.bindings.find(b=>b.baseline_at)?.source_id;assert.ok(source_id,'Needs a genuinely initialized source in stored ledger');const source=catalog.sources.find(s=>s.id===source_id);assert.ok(source);
const country=source.countryCode,day=snapshot.scope_starts.source[source_id].slice(0,10),prior=new Date(Date.parse(snapshot.tracking_start.slice(0,10))-86400000).toISOString().slice(0,10);
const untracked=catalog.countries.find(c=>!snapshot.scope_starts.country[c.code]);
const calls=[['search_sources',{country,limit:1}],['get_source',{source_id}],['list_countries',{limit:1}],['get_endpoint_health',{endpoint_ids:source.endpoints.map(e=>e.id)}],['get_country_source_inventory',{country}],['get_source_article_activity',{source_id,start_date:day,end_date:day}],['get_country_article_activity',{country,start_date:day,end_date:day}],['get_country_article_activity',{country,start_date:prior,end_date:prior}]];
if(untracked)calls.push(['get_country_article_activity',{country:untracked.code,start_date:day,end_date:day}]);
const client=new Client({name:'world-news-sources-local-archive-inspection',version:'1'}),results=[];
try{
  await client.connect(new StreamableHTTPClientTransport(new URL('https://news.bymyleslee.com/mcp'),{fetch:(input,init)=>handler.fetch(new Request(input,init))}));
  const tools=(await client.listTools()).tools.map(t=>t.name);assert.equal(tools.length,7);
  for(const [name,args]of calls){const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result.content));results.push({tool:name,input:args,result:result.structuredContent});
    if(name.endsWith('_article_activity')){const expected=new ActivityStore(snapshot,fileURLToPath(new URL('../activity/history/',import.meta.url))).query(catalog,name==='get_source_article_activity'?'source':'country',args);assert.deepEqual(result.structuredContent.items,expected.items);}}
  const evidence={kind:'local_generated_hosted_bundle_real_ledger_archive_inspection',live_deployment:false,external_metrics_sent:false,tools,results};
  writeFileSync(new URL('../activity/HISTORY-LOCAL-MCP-VERIFICATION.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({tools:tools.length,calls:results.length,tracking_start:snapshot.tracking_start,scope_states:results.filter(r=>r.tool.endsWith('_article_activity')).map(r=>({tool:r.tool,scope:r.result.scope_id,state:r.result.items[0].state,new:r.result.items[0].new_unique_candidate_urls}))}));
}finally{await client.close();await handler.close();}
