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
export const EXTENDED_UPSERT = UPSERT.replace('daily_tool_usage', 'daily_extended_tool_usage');
const activityTools = new Set(['get_source_article_activity', 'get_country_article_activity', 'get_country_source_inventory']);
const extendedTools = new Set(['get_country_collection_quality', 'get_source_collection_quality', 'list_source_packs', 'get_source_pack', 'export_source_pack', 'set_usage_analytics']);
const toolNames = new Set(['search_sources','get_source','list_countries','get_endpoint_health', ...activityTools, ...extendedTools, 'unknown']);
const actorKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = value => Object.keys(value).sort().join(',');
export function validateAggregate(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid aggregate');
  if (!['duration_ms,outcome,tool,traffic', 'duration_ms,outcome,product,tool,traffic'].includes(fields(value))) throw new Error('Unexpected fields');
  if (!toolNames.has(value.tool) || !['inspection','unclassified'].includes(value.traffic)
    || !['success','error'].includes(value.outcome) || !Number.isInteger(value.duration_ms)
    || value.duration_ms < 0 || value.duration_ms > 120000) throw new Error('Invalid aggregate');
  if (value.product !== undefined) {
    const product = value.product;
    if (!product || Array.isArray(product) || typeof product !== 'object'
      || Object.keys(product).some(key => !['channel', 'identity', 'actor_key', 'search', 'export'].includes(key))
      || !['mcp', 'web_export'].includes(product.channel) || !['provided', 'missing', 'excluded'].includes(product.identity)) throw new Error('Invalid product aggregate');
    if (product.identity === 'provided') {
      if (!actorKey(product.actor_key) || product.channel !== 'mcp' || value.traffic !== 'unclassified'
        || value.outcome !== 'success' || ['unknown', 'set_usage_analytics'].includes(value.tool)) throw new Error('Invalid identity projection');
    } else if (Object.hasOwn(product, 'actor_key')) throw new Error('Unexpected identity');
    if (Object.hasOwn(product, 'search') && (value.outcome !== 'success' || value.tool !== 'search_sources' || product.channel !== 'mcp'
      || !['nonempty', 'zero_matches', 'empty_page', 'unknown'].includes(product.search))) throw new Error('Invalid search projection');
    if (Object.hasOwn(product, 'export') && (value.outcome !== 'success' || value.tool !== 'export_source_pack'
      || !['nonempty', 'empty', 'unknown'].includes(product.export))) throw new Error('Invalid export projection');
    if (product.channel === 'web_export' && (value.tool !== 'export_source_pack' || product.identity !== 'excluded'
      || (value.outcome === 'success' && !Object.hasOwn(product, 'export')))) throw new Error('Invalid web export');
  }
  return value;
}
export function parameters(value, now = new Date()) {
  validateAggregate(value);
  const ms=value.duration_ms;
  return [now.toISOString().slice(0,10),value.tool,value.traffic,
    +(value.outcome==='success'),+(value.outcome==='error'),ms,ms,
    +(ms<=100),+(ms>100&&ms<=500),+(ms>500&&ms<=2000),+(ms>2000)];
}
const productColumns = ['events', 'identity_provided', 'identity_missing', 'identity_excluded', 'identity_suppressed', 'identity_disabled',
  'search_nonempty', 'search_zero_matches', 'search_empty_page', 'search_unknown', 'export_nonempty', 'export_empty', 'export_unknown'];
export const PRODUCT_UPSERT = `INSERT INTO daily_product_usage (day,traffic,channel,${productColumns.join(',')})
 SELECT ?,?,?,1,
 CASE WHEN ? = 'provided' AND NOT EXISTS (SELECT 1 FROM usage_opt_out WHERE actor_key = ?) THEN 1 ELSE 0 END,
 ?,?,CASE WHEN ? = 'provided' AND EXISTS (SELECT 1 FROM usage_opt_out WHERE actor_key = ?) THEN 1 ELSE 0 END,
 ?,?,?,?,?,?,?,?
 ON CONFLICT(day,traffic,channel) DO UPDATE SET ${productColumns.map(name => `${name}=${name}+excluded.${name}`).join(',')}`;
export const ACTOR_INSERT = `INSERT INTO usage_actor_days(day,actor_key)
 SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM usage_opt_out WHERE actor_key=?)
 ON CONFLICT(day,actor_key) DO NOTHING`;
export const PRUNE_ACTORS = 'DELETE FROM usage_actor_days WHERE day < ?';
export function actorCutoff(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29)).toISOString().slice(0, 10);
}
export function productParameters(value, now = new Date(), repeatEnabled = false) {
  validateAggregate(value);
  const p = value.product;
  if (!p) throw new Error('Product aggregate required');
  const success = value.outcome === 'success';
  const identity = p.identity === 'provided' && !repeatEnabled ? 'disabled' : p.identity;
  const key = identity === 'provided' ? p.actor_key : '';
  return [now.toISOString().slice(0, 10), value.traffic, p.channel, identity, key,
    +(identity === 'missing'), +(identity === 'excluded'), identity, key, +(identity === 'disabled'),
    ...['nonempty', 'zero_matches', 'empty_page', 'unknown'].map(kind => +(success && p.search === kind)),
    ...['nonempty', 'empty', 'unknown'].map(kind => +(success && p.export === kind))];
}
export function aggregateStatements(db, value, now = new Date(), repeatEnabled = false) {
  validateAggregate(value);
  const statements = [];
  if (value.product?.channel !== 'web_export') {
    const sql = activityTools.has(value.tool) ? ACTIVITY_UPSERT : extendedTools.has(value.tool) ? EXTENDED_UPSERT : UPSERT;
    statements.push(db.prepare(sql).bind(...parameters(value, now)));
  }
  if (value.product) {
    statements.push(db.prepare(PRODUCT_UPSERT).bind(...productParameters(value, now, repeatEnabled)));
    if (repeatEnabled && value.product.identity === 'provided') statements.push(db.prepare(ACTOR_INSERT).bind(now.toISOString().slice(0, 10), value.product.actor_key, value.product.actor_key));
    statements.push(db.prepare(PRUNE_ACTORS).bind(actorCutoff(now)));
  }
  return statements;
}
export function validatePreference(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || fields(value) !== 'actor_key,enabled'
    || !actorKey(value.actor_key) || typeof value.enabled !== 'boolean') throw new Error('Invalid preference');
  return value;
}
export function preferenceStatements(db, value) {
  validatePreference(value);
  return value.enabled
    ? [db.prepare('DELETE FROM usage_opt_out WHERE actor_key=?').bind(value.actor_key)]
    : [db.prepare('INSERT INTO usage_opt_out(actor_key) VALUES (?) ON CONFLICT(actor_key) DO NOTHING').bind(value.actor_key),
      db.prepare('DELETE FROM usage_actor_days WHERE actor_key=?').bind(value.actor_key)];
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
    if (!['/v1/aggregate', '/v1/preference'].includes(path)) return new Response('Not found',{status:404});
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    if(!await authorized(request,env.METRICS_WRITE_SECRET))return new Response('Unauthorized',{status:401});
    let value;
    try { value = (path === '/v1/preference' ? validatePreference : validateAggregate)(await boundedJson(request)); }
    catch { return new Response('Invalid aggregate or preference',{status:400}); }
    try {
      if (path === '/v1/preference') {
        await env.DB.batch(preferenceStatements(env.DB, value));
        return Response.json({enabled: value.enabled}, {headers: {'cache-control':'no-store'}});
      }
      const statements = aggregateStatements(env.DB, value, new Date(), env.REPEAT_USAGE_ENABLED === '1');
      if (value.product) await env.DB.batch(statements);
      else await statements[0].run();
    } catch { return new Response('Collector unavailable',{status:503}); }
    return new Response(null,{status:204,headers:{'cache-control':'no-store'}});
  },
  async scheduled(_event, env) {
    await env.DB.prepare(PRUNE_ACTORS).bind(actorCutoff()).run();
  }
};
