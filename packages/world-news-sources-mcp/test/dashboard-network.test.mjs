import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped browser request helper, with controlled transport failures.
const app=readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8');
const code=app.slice(app.indexOf('class DashboardConnectionError'),app.indexOf('function dateQuery('));
function client(fetchImpl){
  const status={textContent:''};
  const context=vm.createContext({fetch:fetchImpl,TypeError,AbortController,window:{setTimeout,clearTimeout},$:()=>status});
  vm.runInContext(code+'\nthis.request=api;',context);
  return {request:context.request,status};
}

test('read transport recovers transient disconnects and clears request timers',async()=>{
  let calls=0; const {request,status}=client(async()=>{
    if(++calls<3)throw new TypeError('Failed to fetch');
    return Response.json({status:'completed',tool_calls:34});
  });
  const result=await request('investigations/fixture');
  assert.equal(calls,3); assert.equal(result.status,'completed');assert.equal(result.tool_calls,34);
  assert.match(status.textContent,/서버 연결 복구 중/);
});

test('lost POST response is never automatically replayed',async()=>{
  let calls=0;const {request}=client(async()=>{calls++;throw new TypeError('Failed to fetch');});
  await assert.rejects(()=>request('investigations',{method:'POST',body:'{}'}),error=>error.name==='DashboardConnectionError'&&/서버/.test(error.message));
  assert.equal(calls,1);
});

test('HTTP authorization failures and expired IDs are not treated as reconnectable failures',async()=>{
  for(const status of [403,404]){
    let calls=0;const {request}=client(async()=>{calls++;return Response.json({error:'Unavailable'},{status});});
    await assert.rejects(()=>request('investigations/fixture'),error=>error.status===status);
    assert.equal(calls,1);
  }
});

test('interrupted GET response body is retried, invalid JSON is reported without retry',async()=>{
  let calls=0;const {request}=client(async()=>++calls===1?{status:200,ok:true,json:async()=>{throw new TypeError('Connection interrupted');}}:Response.json({id:'retained-run'}));
  assert.equal((await request('investigations/fixture')).id,'retained-run');assert.equal(calls,2);
  let invalidCalls=0;const invalid=client(async()=>{invalidCalls++;return new Response('not-json');});
  await assert.rejects(()=>invalid.request('investigations/fixture'),error=>error.status===200&&/JSON/.test(error.message));
  assert.equal(invalidCalls,1);
});
