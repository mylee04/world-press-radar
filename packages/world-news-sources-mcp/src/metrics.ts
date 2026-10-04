const tools = new Set(['search_sources', 'get_source', 'list_countries', 'get_endpoint_health', 'get_source_article_activity', 'get_country_article_activity', 'get_country_source_inventory']);
export interface CallAggregate {
  tool: string;
  traffic: 'unclassified' | 'inspection';
  outcome: 'success' | 'error';
  duration_ms: number;
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
export type AggregateSink = (event: CallAggregate) => Promise<void>;
export function createAggregateSink(address: string | undefined, secret: string | undefined,
  fetcher: typeof fetch = fetch): AggregateSink | undefined {
  if (!address || !secret) return undefined;
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/v1/aggregate') throw new Error('Invalid metrics collector URL');
  return async event => {
    // No retries: an ambiguous response could already have committed the increment.
    // No request IDs or per-event history are stored for deduplication.
    const response = await fetcher(url, {method:'POST', redirect:'error',
      headers:{'content-type':'application/json', authorization:`Bearer ${secret}`},
      body:JSON.stringify(event), signal:AbortSignal.timeout(1500)});
    if (response.status !== 204) throw new Error('Aggregate collector unavailable');
  };
}
