import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import collector,{UPSERT,parameters,validateAggregate} from '../metrics/worker.mjs';
import { callMetadata,callOutcome,createAggregateSink } from '../dist/metrics.js';
import { createHttpHandler } from '../dist/http.js';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { registry } from './fixtures.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

test('only actual tool calls project fixed aggregate fields; no user data or arbitrary tool names',()=>{
  for(const method of ['initialize','tools/list','ping','notifications/initialized']) assert.equal(callMetadata({method},null),null);
  const event=callMetadata({method:'tools/call',id:'private-id',params:{name:'search_sources',arguments:{query:'private prompt',ip:'1.2.3.4'}}},'inspection');
  assert.deepEqual(event,{tool:'search_sources',traffic:'inspection'});
  assert.deepEqual(callMetadata({method:'tools/call',params:{name:'private arbitrary tool'}},null),{tool:'unknown',traffic:'unclassified'});
  assert.equal(callMetadata([{method:'tools/call'}],null),null);
  assert.equal(callOutcome(200,{result:{isError:true}}),'error');
  assert.equal(callOutcome(200,{error:{message:'secret'}}),'error');
  assert.equal(callOutcome(400,{}),'error');
  assert.equal(callOutcome(200,{structuredContent:{endpoints:[{status:'unhealthy'}]}}),'success');
});

test('real HTTP SDK and legacy calls count errors separately, excluding initialize/list/health',async()=>{
  const events=[];const handler=createHttpHandler(normalizeRegistry(registry),new HealthStore(),['example.com'],async event=>{events.push(event);});
  const client=new Client({name:'metric-test',version:'1'});
  try{
    await handler.fetch(new Request('https://example.com/health'));
    await client.connect(new StreamableHTTPClientTransport(new URL('https://example.com/mcp'),{fetch:(input,init)=>handler.fetch(new Request(input,init))}));
    await client.listTools();assert.equal(events.length,0);
    await client.callTool({name:'list_countries',arguments:{limit:1}});
    await client.callTool({name:'search_sources',arguments:{limit:99}});
    const response=await handler.fetch(new Request('https://example.com/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18','x-world-news-traffic':'inspection'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'missing private name',arguments:{private:'not retained'}}})}));
    assert.equal(response.headers.get('x-world-news-metrics'),'recorded');
    assert.equal(events.length,3);assert.deepEqual(events.map(x=>x.outcome),['success','error','error']);
    assert.deepEqual(events.map(x=>x.tool),['list_countries','search_sources','unknown']);
    assert.equal(events[2].traffic,'inspection');
    assert.ok(events.every(x=>Object.keys(x).sort().join(',')==='duration_ms,outcome,tool,traffic'&&Number.isInteger(x.duration_ms)));
  }finally{await client.close();await handler.close();}
});

test('collector authenticates writes, rejects extra fields/oversize, never exposes owner reads',async()=>{
  const secret='test-only-not-a-live-secret-value';const rows=[];
  const env={METRICS_WRITE_SECRET:secret,DB:{prepare(sql){assert.equal(sql,UPSERT);return{bind(...args){return{async run(){rows.push(args);}}}};}}};
  const request=(body,auth=secret)=>new Request('https://metrics.example/v1/aggregate',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify(body)});
  const event={tool:'get_source',traffic:'inspection',outcome:'error',duration_ms:550};
  assert.equal((await collector.fetch(request(event,'wrong'),env)).status,401);
  assert.equal((await collector.fetch(request({...event,query:'must reject'}),env)).status,400);
  assert.equal((await collector.fetch(request({...event,padding:'x'.repeat(1024)}),env)).status,400);
  assert.equal((await collector.fetch(new Request('https://metrics.example/dashboard'),env)).status,404);
  assert.equal((await collector.fetch(request(event),env)).status,204);assert.equal(rows.length,1);
  const broken={...env,DB:{prepare(){throw new Error('private DB error');}}};
  assert.equal(await(await collector.fetch(request(event),broken)).text(),'Collector unavailable');
  assert.throws(()=>validateAggregate({...event,duration_ms:-1}));
});

test('atomic SQLite increments survive concurrent writers and reopen; no event history table',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'news-metrics-'));const path=join(dir,'aggregate.sqlite');
  try{
    const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL;');db.exec(readFileSync(new URL('../metrics/schema.sql',import.meta.url),'utf8'));db.close();
    const args=parameters({tool:'search_sources',traffic:'inspection',outcome:'success',duration_ms:120},new Date('2026-09-30T00:00:00Z'));
    await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{
      const worker=new Worker(`const {workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=10000;');const stmt=db.prepare(workerData.sql);for(let i=0;i<100;i++)stmt.run(...workerData.args);db.close();`,{eval:true,workerData:{path,sql:UPSERT,args}});
      worker.on('error',reject);worker.on('exit',code=>code?reject(new Error(`Writer ${code}`)):resolve());
    })));
    const reopened=new DatabaseSync(path);const row=reopened.prepare('SELECT * FROM daily_tool_usage').get();
    assert.equal(row.calls,400);assert.equal(row.successes,400);assert.equal(row.errors,0);assert.equal(row.duration_sum_ms,48000);assert.equal(row.duration_max_ms,120);assert.equal(row.latency_101_500,400);
    assert.deepEqual(reopened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name),['daily_tool_usage']);reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('collector outages do not change MCP result; sender never blindly retries',async()=>{
  let writes=0;const sink=createAggregateSink('https://metrics.example/v1/aggregate','test-secret',async()=>{writes++;throw new Error('network failed');});
  const handler=createHttpHandler(normalizeRegistry(registry),new HealthStore(),['example.com'],sink);
  try{
    const response=await handler.fetch(new Request('https://example.com/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_countries',arguments:{limit:1}}})}));
    assert.equal(response.status,200);assert.equal(response.headers.get('x-world-news-metrics'),'unavailable');assert.equal(writes,1);
  }finally{await handler.close();}
});
