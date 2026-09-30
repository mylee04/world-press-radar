import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHttpHandler } from '../dist/http.js';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { registry } from './fixtures.mjs';

const create = () => createHttpHandler(normalizeRegistry(registry),new HealthStore(),['example.com']);
const post = (handler,body,headers={})=>handler.fetch(new Request('https://example.com/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...headers},body:JSON.stringify(body)}));
const payload = async response => {
  const text=await response.text();
  return response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)) : JSON.parse(text);
};
test('HTTP SDK client discovers/lists/calls all tools with stateless transport',async()=>{
  const handler=create();const client=new Client({name:'http-test',version:'1.0.0'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL('https://example.com/mcp'),{fetch:(input,init)=>handler.fetch(new Request(input,init))}));
    assert.equal((await client.listTools()).tools.length,4);
    const result=await client.callTool({name:'search_sources',arguments:{country:'US',limit:1}});
    assert.equal(result.structuredContent.items.length,1);
    assert.equal((await client.callTool({name:'list_countries',arguments:{}})).structuredContent.total,2);
    const source=result.structuredContent.items[0];
    assert.equal((await client.callTool({name:'get_source',arguments:{source_id:source.id}})).structuredContent.id,source.id);
    if(source.endpoints.length) assert.equal((await client.callTool({name:'get_endpoint_health',arguments:{endpoint_ids:[source.endpoints[0].id]}})).structuredContent.endpoints[0].status,'unknown');
  }finally{await client.close();await handler.close();}
});
test('legacy initialize and tools calls succeed without a persistent session',async()=>{
  const handler=create();
  try{
    const response=await post(handler,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'legacy-test',version:'1'}}});
    assert.equal(response.status,200);assert.equal(response.headers.get('mcp-session-id'),null);
    assert.equal((await payload(response)).result.serverInfo.name,'world-news-sources-mcp');
    const tools=await post(handler,{jsonrpc:'2.0',id:2,method:'tools/list'}, {'mcp-protocol-version':'2025-06-18'});
    assert.equal((await payload(tools)).result.tools.length,4);
  }finally{await handler.close();}
});
test('HTTP boundary rejects invalid hosts, origins, paths, methods and oversized requests',async()=>{
  const handler=create();
  try{
    assert.equal((await handler.fetch(new Request('https://evil.example/mcp'))).status,403);
    assert.equal((await post(handler,{},{host:'evil.example'})).status,403);
    assert.equal((await post(handler,{},{origin:'https://evil.example'})).status,403);
    assert.equal((await post(handler,{},{origin:'null'})).status,403);
    assert.equal((await handler.fetch(new Request('https://example.com/mcp'))).status,405);
    assert.equal((await handler.fetch(new Request('https://example.com/other'))).status,404);
    assert.equal((await post(handler,{query:'x'.repeat(65536)})).status,413);
    assert.equal((await handler.fetch(new Request('https://example.com/health'))).status,200);
  }finally{await handler.close();}
});
test('health output samples respect the byte budget and return remaining IDs',async()=>{
  const catalog=normalizeRegistry({countries:[{code:'US',name:'US',feeds:Array.from({length:20},(_,i)=>({name:`Publisher ${i}`,url:`https://example.com/${i}?q=${'a'.repeat(1800)}`}))}]});
  const observations=[...catalog.endpoints.values()].map(e=>({endpointId:e.id,type:e.type,url:e.url,checkedAt:new Date().toISOString(),outcome:'healthy',httpStatus:200,reason:null,format:'rss',sampleUrls:Array(3).fill(`https://example.com/?q=${'b'.repeat(1800)}`)}));
  const handler=createHttpHandler(catalog,new HealthStore({version:1,observations}),['example.com']);
  try{
    const response=await post(handler,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_endpoint_health',arguments:{endpoint_ids:[...catalog.endpoints.keys()]}}},{'mcp-protocol-version':'2025-06-18'});
    const result=(await payload(response)).result;
    assert.ok(result.structuredContent.remaining_endpoint_ids.length>0);
    assert.ok(Buffer.byteLength(JSON.stringify(result))<128000);
  }finally{await handler.close();}
});
