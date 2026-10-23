const tools = new Set(['search_sources', 'get_source', 'list_countries', 'get_endpoint_health', 'get_source_article_activity', 'get_country_article_activity', 'get_country_source_inventory', 'get_country_collection_quality', 'get_source_collection_quality', 'list_source_packs', 'get_source_pack', 'export_source_pack', 'set_usage_analytics']);
export interface ProductObservation {
  channel: 'mcp' | 'web_export';
  identity: 'provided' | 'missing' | 'excluded';
  actor_key?: string;
  search?: 'nonempty' | 'zero_matches' | 'empty_page' | 'unknown';
  export?: 'nonempty' | 'empty' | 'unknown';
}
export interface CallAggregate {
  tool: string;
  traffic: 'unclassified' | 'inspection';
  outcome: 'success' | 'error';
  duration_ms: number;
  product?: ProductObservation;
}
type Rpc = { method?: unknown; params?: { name?: unknown }; jsonrpc?: unknown; id?: unknown };
// Only this bounded projection can leave the MCP process. Neither RPC parameters
// nor result content are retained or sent to the collector.
export function callMetadata(body: unknown, inspectionHint: string | null): Pick<CallAggregate, 'tool' | 'traffic'> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rpc = body as Rpc;
  if (rpc.method !== 'tools/call') return null;
  const name = rpc.params?.name;
  return { tool: typeof name === 'string' && tools.has(name) ? name : 'unknown',
    traffic: inspectionHint === 'inspection' ? 'inspection' : 'unclassified' };
}
export function callOutcome(status: number, payload: unknown): CallAggregate['outcome'] {
  if (status < 200 || status >= 300 || !payload || typeof payload !== 'object') return 'error';
  const rpc = payload as { error?: unknown; result?: unknown; isError?: unknown };
  if (rpc.error !== undefined) return 'error';
  const result = rpc.result === undefined ? rpc : rpc.result;
  if (!result || typeof result !== 'object') return 'error';
  if (!('content' in result) && !('structuredContent' in result) && !('isError' in result)) return 'error';
  return (result as {isError?:unknown}).isError === true ? 'error' : 'success';
}
export async function readRpcResponse(response: Response): Promise<unknown> {
  const text = await response.clone().text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    return JSON.parse(data);
  }
  return JSON.parse(text);
}
export type UsagePreference = { enabled: boolean; identity_available: boolean };
export type AggregateSink = ((event: CallAggregate) => Promise<void>) & {
  actorKey?: (meta: unknown) => Promise<string | undefined>;
  preference?: (meta: unknown, enabled: boolean) => Promise<UsagePreference>;
};
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function requestToolMeta(body: unknown): unknown {
  return record(record(body)?.params)?._meta;
}
function resultData(payload: unknown): Record<string, unknown> | undefined {
  const rpc = record(payload), result = record(rpc?.result) ?? rpc;
  return record(result?.structuredContent);
}
export async function productObservation(event: Pick<CallAggregate, 'tool' | 'traffic' | 'outcome'>,
  payload: unknown, request: Request, meta: unknown, sink: AggregateSink,
  channel: ProductObservation['channel'] = 'mcp'): Promise<ProductObservation> {
  const product: ProductObservation = { channel, identity: 'excluded' };
  const data = resultData(payload);
  if (event.outcome === 'success' && event.tool === 'search_sources') {
    const total = data?.total, items = data?.items;
    product.search = Number.isSafeInteger(total) && (total as number) >= 0 && Array.isArray(items)
      ? total === 0 && items.length === 0 ? 'zero_matches'
      : (total as number) > 0 ? items.length ? 'nonempty' : 'empty_page' : 'unknown' : 'unknown';
  }
  if (event.outcome === 'success' && event.tool === 'export_source_pack') {
    const count = data?.exported_endpoints;
    product.export = Number.isSafeInteger(count) && (count as number) >= 0
      ? count === 0 ? 'empty' : 'nonempty' : 'unknown';
  }
  const optedOut = request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1'
    || request.headers.get('x-world-news-analytics') === 'off';
  if (channel === 'mcp' && event.traffic === 'unclassified' && event.outcome === 'success'
    && event.tool !== 'unknown' && event.tool !== 'set_usage_analytics' && !optedOut) {
    const key = await sink.actorKey?.(meta);
    product.identity = key ? 'provided' : 'missing';
    if (key) product.actor_key = key;
  }
  return product;
}
export function createAggregateSink(address: string | undefined, secret: string | undefined,
  fetcher: typeof fetch = fetch): AggregateSink | undefined {
  if (!address || !secret) return undefined;
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/v1/aggregate') throw new Error('Invalid metrics collector URL');
  let hmacKey: Promise<CryptoKey> | undefined;
  const actorKey = async (meta: unknown): Promise<string | undefined> => {
    const subject = record(meta)?.['openai/subject'];
    if (typeof subject !== 'string' || subject.length < 1 || subject.length > 512 || !subject.trim() || /[\u0000-\u001f\u007f]/.test(subject)) return undefined;
    hmacKey ??= crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const hash = await crypto.subtle.sign('HMAC', await hmacKey, new TextEncoder().encode('world-news-usage-v1\0' + subject));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const sink: AggregateSink = async event => {
    // No retries: an ambiguous response could already have committed the increment.
    // No request IDs or per-event history are stored for deduplication.
    const response = await fetcher(url, {method:'POST', redirect:'error',
      headers:{'content-type':'application/json', authorization:`Bearer ${secret}`},
      body:JSON.stringify(event), signal:AbortSignal.timeout(1500)});
    if (response.status !== 204) throw new Error('Aggregate collector unavailable');
  };
  sink.actorKey = actorKey;
  sink.preference = async (meta, enabled) => {
    const actor_key = await actorKey(meta);
    if (!actor_key) return { enabled: false, identity_available: false };
    const target = new URL('/v1/preference', url);
    const response = await fetcher(target, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ actor_key, enabled }), signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Usage preference unavailable');
    const value = await response.json() as { enabled?: unknown };
    if (value.enabled !== enabled) throw new Error('Usage preference not confirmed');
    return { enabled, identity_available: true };
  };
  return sink;
}
