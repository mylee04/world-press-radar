import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

test('SDK client initializes real stdio server and exercises all four tools', {timeout:15000}, async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/stdio.js',import.meta.url))],cwd:'/tmp',env:{},stderr:'pipe'});
  const client=new Client({name:'world-news-sources-test',version:'0.1.0'});
  try {
    await client.connect(transport);
    const {tools}=await client.listTools();assert.equal(tools.length,7);
    assert.ok(tools.every(t=>t.annotations.readOnlyHint));
    const countries=await client.callTool({name:'list_countries',arguments:{limit:2}});
    assert.equal(countries.structuredContent.configured_rows,JSON.parse(readFileSync(new URL("../../../data/rss-atlas.json",import.meta.url),"utf8")).countries.reduce((n,c)=>n+c.feeds.length,0));
    assert.equal(countries.structuredContent.items.length,2);
    const found=await client.callTool({name:'search_sources',arguments:{country:'GB',endpoint_type:'rss',limit:1}});
    const source=found.structuredContent.items[0];assert.ok(source);
    const detail=await client.callTool({name:'get_source',arguments:{source_id:source.id}});
    assert.equal(detail.structuredContent.id,source.id);
    const id=source.endpoints[0].id;
    const health=await client.callTool({name:'get_endpoint_health',arguments:{endpoint_ids:[id,id]}});
    assert.equal(health.structuredContent.endpoints.length,1);
    const snapshotPath=new URL('../audits/health-latest.json',import.meta.url);
    if(existsSync(snapshotPath)){
      const snapshot=JSON.parse(readFileSync(snapshotPath,'utf8'));const observation=snapshot.observations.find(o=>o.endpointId===id);
      assert.equal(health.structuredContent.endpoints[0].checked_at,observation.checkedAt);
      assert.equal(health.structuredContent.endpoints[0].entry_count,observation.entryCount??null);
      assert.equal(health.structuredContent.audit.last_completed_full_audit_at,snapshot.audit.lastCompletedFullAuditAt);
    }else assert.ok(['stale','unknown'].includes(health.structuredContent.endpoints[0].status));
    const unknown=await client.callTool({name:'get_source',arguments:{source_id:'src_'+'0'.repeat(24)}});assert.equal(unknown.isError,true);
    const missing=await client.callTool({name:'get_endpoint_health',arguments:{endpoint_ids:['ep_'+'0'.repeat(24)]}});assert.equal(missing.isError,true);
    const invalid=await client.callTool({name:'search_sources',arguments:{limit:51}});assert.equal(invalid.isError,true);
    assert.ok(Buffer.byteLength(JSON.stringify(found))<128000);
  } finally {await client.close();}
});
