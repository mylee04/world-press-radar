import assert from 'node:assert/strict';
const address=process.argv[2]??'https://news.bymyleslee.com/mcp';
const started_at=new Date().toISOString();
const rpc=async(body)=>{
  const response=await fetch(address,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18','x-world-news-traffic':'inspection'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const text=await response.text();const payload=response.headers.get('content-type')?.includes('text/event-stream')?JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)):JSON.parse(text);
  return {status:response.status,ack:response.headers.get('x-world-news-metrics'),payload};
};
for(const [id,method,params] of [[1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'aggregate-inspection',version:'1'}}],[2,'tools/list',undefined]]) {
  const result=await rpc({jsonrpc:'2.0',id,method,...(params?{params}:{})});assert.equal(result.status,200);assert.equal(result.ack,null);assert.equal(result.payload.error,undefined);
}
const status=await fetch(new URL('/health',address));assert.equal(status.headers.get('x-world-news-metrics'),null);
const calls=Array.from({length:8},(_,i)=> i<4 ? {name:'list_countries',arguments:{limit:1}} : i<6 ? {name:'search_sources',arguments:{limit:0}} : {name:'get_source',arguments:{source_id:'src_'+'0'.repeat(24)}});
const results=await Promise.all(calls.map(async(params,i)=>{
  const result=await rpc({jsonrpc:'2.0',id:100+i,method:'tools/call',params});
  assert.equal(result.ack,'recorded');
  const outcome=result.status>=400||result.payload.error||result.payload.result?.isError?'error':'success';
  assert.equal(outcome,i<4?'success':'error');
  return {tool:params.name,outcome,metrics_ack:result.ack};
}));
const summary={endpoint:address,started_at,finished_at:new Date().toISOString(),concurrent_actual_tool_calls:8,traffic:'inspection',expected_durable_delta:{calls:8,successes:4,errors:4},excluded_control_requests:['initialize','tools/list','health'],results};
console.log(JSON.stringify(summary,null,2));
