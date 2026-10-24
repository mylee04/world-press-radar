import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectionFetch, MCP_URL, TOOL_NAMES, parseOptions, runOperator, main } from '../scripts/operator-mcp.mjs';

const toolOptions = { tool: 'search_sources', arguments: { country: 'JP', limit: 1 } };
const resultResponse = (result = { structuredContent: { total: 1, items: [{ id: 'one' }] } }, headers = {}) =>
  Response.json({ jsonrpc: '2.0', id: 1, result }, { headers: { 'x-world-news-metrics': 'recorded', ...headers } });

test('inspection fetch preserves Request and init headers while forcing inspection marking', async () => {
  const request = new Request(MCP_URL, { headers: { 'x-request': 'original', 'x-overlap': 'old', 'x-world-news-traffic': 'unclassified' } });
  const init = { headers: { 'x-init': 'additional', 'x-overlap': 'new', 'x-world-news-traffic': 'external' }, method: 'POST' };
  let calls = 0;
  await inspectionFetch(async (input, actual) => {
    calls++;
    assert.equal(input, request);
    assert.equal(actual.headers.get('x-request'), 'original');
    assert.equal(actual.headers.get('x-init'), 'additional');
    assert.equal(actual.headers.get('x-overlap'), 'new');
    assert.equal(actual.headers.get('x-world-news-traffic'), 'inspection');
    assert.equal(actual.redirect, 'error');
    return resultResponse();
  })(request, init);
  assert.equal(calls, 1);
  assert.equal(request.headers.get('x-world-news-traffic'), 'unclassified');
  assert.equal(init.headers['x-world-news-traffic'], 'external');
});

test('CLI accepts only named tools and fixed public export paths, without an unmarked mode', () => {
  assert.equal(TOOL_NAMES.length, 13);
  assert.deepEqual(parseOptions(['--tool', 'list_countries', '--input', '/tmp/input.json']), { tool: 'list_countries', input: '/tmp/input.json' });
  assert.deepEqual(parseOptions(['--export', 'japan-general', '--format', 'opml', '--include', 'all']), { export: 'japan-general', format: 'opml', include: 'all' });
  for (const args of [[], ['--tool', 'unknown', '--input', 'x'], ['--tool', 'search_sources'],
    ['--tool', 'search_sources', '--tool', 'get_source', '--input', 'x'], ['--url', 'https://example.test/mcp'],
    ['--traffic', 'unclassified'], ['--export', '../other', '--format', 'opml'], ['--export', 'japan-general', '--format', 'xml'],
    ['--tool', 'search_sources', '--input', 'x', '--export', 'japan-general'], ['--export', 'japan-general', '--format', 'opml', '--include', 'unknown']])
    assert.throws(() => parseOptions(args));
});

test('one MCP call always uses the public endpoint, tagged headers and recorded acknowledgment', async () => {
  let calls = 0;
  const result = await runOperator(toolOptions, { fetch: async (input, init) => {
    calls++;
    assert.equal(input, MCP_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('x-world-news-traffic'), 'inspection');
    assert.equal(init.headers.get('mcp-protocol-version'), '2025-06-18');
    assert.deepEqual(JSON.parse(init.body), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_sources', arguments: { country: 'JP', limit: 1 } } });
    return resultResponse();
  } });
  assert.equal(calls, 1);
  assert.equal(result.traffic, 'inspection');
  assert.equal(result.metrics_ack, 'recorded');
  assert.equal(result.outcome, 'success');
  assert.equal('arguments' in result, false);
});

test('RPC and tool errors are acknowledged inspections and never trigger retries', async () => {
  for (const payload of [{ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid arguments' } },
    { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Unknown source' }] } }]) {
    let calls = 0;
    const result = await runOperator(toolOptions, { fetch: async () => { calls++; return Response.json(payload, { headers: { 'x-world-news-metrics': 'recorded' } }); } });
    assert.equal(calls, 1);
    assert.equal(result.outcome, 'error');
    assert.equal(result.metrics_ack, 'recorded');
  }
});

test('missing or unavailable metrics acknowledgment blocks the check without an unmarked fallback', async () => {
  for (const ack of [null, 'unavailable']) {
    let calls = 0;
    await assert.rejects(runOperator(toolOptions, { fetch: async () => {
      calls++;
      return resultResponse(undefined, { 'x-world-news-metrics': ack ?? '' });
    } }), /OPERATOR_INSPECTION_NOT_ACKNOWLEDGED/);
    assert.equal(calls, 1);
  }
});

test('SSE result parsing selects the matching response and rejects oversized or malformed responses', async () => {
  const text = 'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"total":0,"items":[]}}}\r\n\r\n';
  const result = await runOperator(toolOptions, { fetch: async () => new Response(text, { headers: { 'content-type': 'text/event-stream', 'x-world-news-metrics': 'recorded' } }) });
  assert.equal(result.result.structuredContent.total, 0);
  for (const response of [new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'x-world-news-metrics': 'recorded' } }),
    Response.json({ jsonrpc: '2.0', id: 2, result: {} }, { headers: { 'x-world-news-metrics': 'recorded' } })])
    await assert.rejects(runOperator(toolOptions, { fetch: async () => response }), /OPERATOR_(RESPONSE_TOO_LARGE|INVALID_RPC_RESPONSE)/);
});

test('web downloads use tagged GET, exact export route and the same acknowledgment gate', async () => {
  let calls = 0;
  const result = await runOperator({ export: 'japan-general', format: 'opml', include: 'all' }, { fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://news.bymyleslee.com/source-packs/japan-general/export?format=opml&include=all');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('x-world-news-traffic'), 'inspection');
    return new Response('<opml/>', { headers: { 'x-world-news-metrics': 'recorded', 'x-source-pack-exported': '0' } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.channel, 'web_export');
  assert.equal(result.content, '<opml/>');
  assert.equal(result.exported_endpoints, '0');
  await assert.rejects(runOperator({ export: '../escape', format: 'opml' }, { fetch: async () => { throw Error('Must not fetch'); } }), /INVALID_EXPORT_INPUT/);
  await assert.rejects(runOperator({ export: 'japan-general', format: 'opml' }, { fetch: async () => new Response('<opml/>') }), /INSPECTION_NOT_ACKNOWLEDGED/);
});

test('CLI bounds file input and writes a private export only after a recorded response', async () => {
  let fetched = 0, written;
  await assert.rejects(main(['--tool', 'search_sources', '--input', '/tmp/large.json'], {
    stat: async () => ({ isFile: () => true, size: 65537 }), fetch: async () => { fetched++; },
  }), /INVALID_INPUT_FILE/);
  assert.equal(fetched, 0);
  await assert.rejects(main(['--tool', 'search_sources', '--input', '/tmp/invalid.json'], {
    stat: async () => ({ isFile: () => true, size: 20 }), readFile: async () => 'private-invalid-input',
  }), error => error.message === 'OPERATOR_INVALID_INPUT_JSON' && !error.message.includes('private-invalid-input'));
  const status = await main(['--export', 'japan-general', '--format', 'opml', '--output', '/tmp/check.opml'], {
    fetch: async () => new Response('<opml/>', { headers: { 'x-world-news-metrics': 'recorded' } }),
    writeFile: async (...args) => { written = args; },
    print: text => { assert.equal('content' in JSON.parse(text), false); },
  });
  assert.equal(status, 0);
  assert.deepEqual(written, ['/tmp/check.opml', '<opml/>', { flag: 'wx', mode: 0o600 }]);
});
