import { readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const MCP_URL = 'https://news.bymyleslee.com/mcp';
export const TOOL_NAMES = Object.freeze(['search_sources', 'get_source', 'list_countries', 'get_endpoint_health',
  'get_source_article_activity', 'get_country_article_activity', 'get_country_source_inventory',
  'get_country_collection_quality', 'get_source_collection_quality', 'list_source_packs', 'get_source_pack',
  'export_source_pack', 'set_usage_analytics']);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const usage = 'operator-mcp.mjs --tool NAME --input FILE [--output FILE] | --export PACK_ID --format opml|csv|json [--include usable|all] [--output FILE]';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Request and init headers both survive, but callers cannot turn off inspection marking.
export function inspectionFetch(fetcher = fetch) {
  return (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set('x-world-news-traffic', 'inspection');
    return fetcher(input, { ...init, headers, redirect: 'error' });
  };
}

export function parseOptions(args) {
  const options = {};
  const accepted = new Set(['--tool', '--input', '--output', '--export', '--format', '--include']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!accepted.has(flag) || typeof value !== 'string' || !value || value.startsWith('--') || flag.slice(2) in options)
      throw Error(usage);
    options[flag.slice(2)] = value;
  }
  if (options.tool) {
    if (!TOOL_NAMES.includes(options.tool) || !options.input || options.export || options.format || options.include) throw Error(usage);
  } else if (!options.export || options.input || !/^[a-z][a-z0-9-]{1,79}$/.test(options.export)
    || !['opml', 'csv', 'json'].includes(options.format) || options.include && !['usable', 'all'].includes(options.include)) throw Error(usage);
  return options;
}

async function boundedText(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw Error('OPERATOR_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw Error('OPERATOR_RESPONSE_TOO_LARGE');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function rpcPayload(text, contentType) {
  if (!contentType?.includes('text/event-stream')) return JSON.parse(text);
  const payloads = text.replaceAll('\r\n', '\n').split('\n\n').flatMap(event => {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data ? [JSON.parse(data)] : [];
  });
  const matching = payloads.filter(payload => object(payload) && payload.id === 1);
  if (matching.length !== 1) throw Error('OPERATOR_INVALID_RPC_RESPONSE');
  return matching[0];
}

export async function runOperator(options, { fetch: fetcher = fetch } = {}) {
  const request = inspectionFetch(fetcher);
  let url, init;
  if (options.tool) {
    if (!TOOL_NAMES.includes(options.tool) || !object(options.arguments)) throw Error('OPERATOR_INVALID_TOOL_INPUT');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: options.tool, arguments: options.arguments } });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw Error('OPERATOR_REQUEST_TOO_LARGE');
    url = MCP_URL;
    init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18' }, body };
  } else {
    if (!/^[a-z][a-z0-9-]{1,79}$/.test(options.export ?? '') || !['opml', 'csv', 'json'].includes(options.format)
      || options.include && !['usable', 'all'].includes(options.include)) throw Error('OPERATOR_INVALID_EXPORT_INPUT');
    const target = new URL(`/source-packs/${options.export}/export`, MCP_URL);
    target.searchParams.set('format', options.format);
    if (options.include) target.searchParams.set('include', options.include);
    url = target.href;
    init = { method: 'GET', headers: { accept: '*/*' } };
  }
  const response = await request(url, { ...init, signal: AbortSignal.timeout(20000) });
  const ack = response.headers.get('x-world-news-metrics');
  if (ack !== 'recorded') {
    await response.body?.cancel();
    throw Error('OPERATOR_INSPECTION_NOT_ACKNOWLEDGED: check stopped; do not retry through an unmarked connector');
  }
  const text = await boundedText(response);
  const receipt = { traffic: 'inspection', metrics_ack: ack, http_status: response.status };
  if (!options.tool) return { ...receipt, channel: 'web_export', pack_id: options.export, format: options.format,
    outcome: response.ok ? 'success' : 'error', exported_endpoints: response.headers.get('x-source-pack-exported'), content: text };
  let payload;
  try { payload = rpcPayload(text, response.headers.get('content-type')); }
  catch { throw Error('OPERATOR_INVALID_RPC_RESPONSE'); }
  if (!object(payload) || payload.jsonrpc !== '2.0' || payload.id !== 1 || !object(payload.result) && !object(payload.error))
    throw Error('OPERATOR_INVALID_RPC_RESPONSE');
  if (!payload.error && !['content', 'structuredContent', 'isError'].some(key => key in payload.result))
    throw Error('OPERATOR_INVALID_RPC_RESPONSE');
  return { ...receipt, channel: 'mcp', tool: options.tool,
    outcome: response.ok && !payload.error && payload.result?.isError !== true ? 'success' : 'error',
    ...(payload.error ? { error: payload.error } : { result: payload.result }) };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(args);
  if (options.tool) {
    const info = await (dependencies.stat ?? stat)(options.input);
    if (!info.isFile() || info.size > MAX_REQUEST_BYTES) throw Error('OPERATOR_INVALID_INPUT_FILE');
    const text = await (dependencies.readFile ?? readFile)(options.input, 'utf8');
    try { options.arguments = JSON.parse(text); }
    catch { throw Error('OPERATOR_INVALID_INPUT_JSON'); }
  }
  const result = await runOperator(options, dependencies);
  if (options.output) {
    const content = options.export ? result.content : `${JSON.stringify(result, null, 2)}\n`;
    await (dependencies.writeFile ?? writeFile)(options.output, content, { flag: 'wx', mode: 0o600 });
  }
  const printed = options.output && options.export ? { ...result, content: undefined } : result;
  (dependencies.print ?? console.log)(JSON.stringify(printed, null, 2));
  return result.outcome === 'success' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : 'OPERATOR_CHECK_FAILED');
    process.exitCode = 1;
  });
}
