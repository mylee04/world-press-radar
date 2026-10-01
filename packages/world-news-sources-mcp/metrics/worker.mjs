export const UPSERT = `INSERT INTO daily_tool_usage
 (day,tool,traffic,calls,successes,errors,duration_sum_ms,duration_max_ms,latency_le_100,latency_101_500,latency_501_2000,latency_gt_2000)
 VALUES (?,?,?,1,?,?,?,?,?,?,?,?)
 ON CONFLICT(day,tool,traffic) DO UPDATE SET
 calls=calls+1, successes=successes+excluded.successes, errors=errors+excluded.errors,
 duration_sum_ms=duration_sum_ms+excluded.duration_sum_ms,
 duration_max_ms=MAX(duration_max_ms,excluded.duration_max_ms),
 latency_le_100=latency_le_100+excluded.latency_le_100,
 latency_101_500=latency_101_500+excluded.latency_101_500,
 latency_501_2000=latency_501_2000+excluded.latency_501_2000,
 latency_gt_2000=latency_gt_2000+excluded.latency_gt_2000`;
export const ACTIVITY_UPSERT = UPSERT.replace('daily_tool_usage', 'daily_activity_tool_usage');
const toolNames = new Set(['search_sources','get_source','list_countries','get_endpoint_health','get_source_article_activity','get_country_article_activity','get_country_source_inventory','unknown']);
export function validateAggregate(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid aggregate');
  if (Object.keys(value).sort().join(',') !== 'duration_ms,outcome,tool,traffic') throw new Error('Unexpected fields');
  if (!toolNames.has(value.tool) || !['inspection','unclassified'].includes(value.traffic)
    || !['success','error'].includes(value.outcome) || !Number.isInteger(value.duration_ms)
    || value.duration_ms < 0 || value.duration_ms > 120000) throw new Error('Invalid aggregate');
  return value;
}
export function parameters(value, now = new Date()) {
  validateAggregate(value);
  const ms=value.duration_ms;
  return [now.toISOString().slice(0,10),value.tool,value.traffic,
    +(value.outcome==='success'),+(value.outcome==='error'),ms,ms,
    +(ms<=100),+(ms>100&&ms<=500),+(ms>500&&ms<=2000),+(ms>2000)];
}
async function authorized(request, secret) {
  if (!secret || secret.length < 32) return false;
  const input=request.headers.get('authorization') ?? '';
  if (input.length > 256) return false;
  const digest=async text => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  const [actual,expected]=await Promise.all([digest(input),digest(`Bearer ${secret}`)]);
  let difference=0;for(let i=0;i<expected.length;i++) difference|=actual[i]^expected[i];
  return difference===0;
}
async function boundedJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) throw new Error('Invalid body');
  const reader=request.body.getReader(); const parts=[];let size=0;
  try {while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>1024)throw new Error('Too large');parts.push(chunk.value);}}
  finally {await reader.cancel();}
  const data=new Uint8Array(size);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}
  return JSON.parse(new TextDecoder().decode(data));
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path!=='/v1/aggregate')return new Response('Not found',{status:404});
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    if(!await authorized(request,env.METRICS_WRITE_SECRET))return new Response('Unauthorized',{status:401});
    let value;try{value=validateAggregate(await boundedJson(request));}catch{return new Response('Invalid aggregate',{status:400});}
    try{await env.DB.prepare(value.tool.includes('article_activity') || value.tool === 'get_country_source_inventory' ? ACTIVITY_UPSERT : UPSERT).bind(...parameters(value)).run();}
    catch{return new Response('Collector unavailable',{status:503});}
    return new Response(null,{status:204,headers:{'cache-control':'no-store'}});
  }
};
