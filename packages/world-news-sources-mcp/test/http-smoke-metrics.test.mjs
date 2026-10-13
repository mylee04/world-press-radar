import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSmokeOptions, metricsResult, runHttpSmoke } from './http-smoke.mjs';
import { postDeploySmokeArgs } from '../scripts/refresh-activity.mjs';
import { normalizeRegistry } from '../dist/catalog.js';

const ADDRESS = 'https://news.example.test/mcp';
const CHECKED = '2026-10-12T04:00:00.000Z';
const TOOL_NAMES = ['search_sources', 'get_source', 'list_countries', 'get_endpoint_health',
  'get_country_source_inventory', 'get_source_article_activity', 'get_country_article_activity',
  'get_country_collection_quality', 'get_source_collection_quality'];

function fixture({ ack = 'recorded', functionalFault } = {}) {
  const registry = { countries: [{ code: 'US', name: 'United States', feeds: [
    { name: 'Example News', url: 'https://publisher.example.test/feed', sitemapUrl: 'https://publisher.example.test/sitemap.xml' },
  ] }] };
  const source = normalizeRegistry(registry).sources[0];
  const observations = source.endpoints.map(endpoint => ({ endpointId: endpoint.id, type: endpoint.type,
    auditStatus: 'working_nonempty', format: endpoint.type === 'rss' ? 'rss' : 'sitemap', checkedAt: CHECKED,
    entryCount: 1, reason: null, httpStatus: 200, sampleUrls: ['https://publisher.example.test/news/one'] }));
  const healthSnapshot = { audit: { checked: 2, lastCompletedFullAuditAt: CHECKED }, observations };
  const toolResult = (name, args) => {
    if (name === 'search_sources') return { items: [source], total: 1 };
    if (name === 'get_source') return { ...source, id: functionalFault === 'source' ? 'incorrect_source_id' : source.id };
    if (name === 'get_endpoint_health') return { endpoints: args.endpoint_ids.map(id => {
      const observation = observations.find(row => row.endpointId === id);
      return { endpoint_id: id, status: 'healthy', checked_at: observation.checkedAt,
        entry_count: observation.entryCount, reason: observation.reason, http_status: observation.httpStatus,
        audit_status: observation.auditStatus, sample_urls: observation.sampleUrls, format: observation.format };
    }) };
    if (name === 'list_countries') return { total: functionalFault === 'countries' ? 1 : 73, items: [] };
    if (name === 'get_country_source_inventory') return { items: [{ country: 'US', active_source_registrations: 1 }] };
    if (name === 'get_source_article_activity' || name === 'get_country_article_activity') return { items: [] };
    throw Error('Unexpected fixture tool');
  };
  let toolCalls = 0, closed = false;
  const fetchFixture = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/health') return Response.json({ configured_rows: 5393, endpoints_checked: 2,
      last_completed_full_audit_at: CHECKED, usage_statistics: { configured: true } }, { status: functionalFault === 'http' ? 503 : 200 });
    const request = JSON.parse(init.body);
    let result;
    if (request.method === 'initialize') result = { serverInfo: { name: 'world-news-sources-mcp' }, protocolVersion: '2025-06-18' };
    else if (request.method === 'tools/list') result = { tools: TOOL_NAMES.map(name => ({ name })) };
    else if (request.method === 'tools/call') result = { structuredContent: toolResult(request.params.name, request.params.arguments) };
    else throw Error('Unexpected fixture RPC');
    const headers = {};
    if (request.method === 'tools/call') {
      toolCalls++;
      const value = typeof ack === 'function' ? ack(toolCalls) : ack;
      if (value) headers['x-world-news-metrics'] = value;
      assert.equal(new Headers(init.headers).get('x-world-news-traffic'), 'inspection');
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result }, { headers });
  };
  const client = {
    async connect(transport) { this.transport = transport; },
    async listTools() { return { tools: TOOL_NAMES.map(name => ({ name })) }; },
    async callTool({ name, arguments: args }) {
      const response = await this.transport.fetch(ADDRESS, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: toolCalls + 1,
        method: 'tools/call', params: { name, arguments: args } }) });
      const result=(await response.json()).result;
      if(functionalFault==='tool_error'&&name==='get_source')result.isError=true;
      return result;
    },
    async close() { closed = true; },
  };
  return { dependencies: { fetch: fetchFixture, client, createTransport: (_address, fetcher) => ({ fetch: fetcher }),
    readJson: url => String(url).endsWith('/rss-atlas.json') ? registry : String(url).endsWith('/health-latest.json') ? healthSnapshot : null },
    counts: () => ({ toolCalls, closed }) };
}

test('HTTP smoke option parsing keeps strict default and accepts only the explicit degraded flag', () => {
  assert.equal(parseSmokeOptions([]).allowMetricsDegraded, false);
  assert.deepEqual(parseSmokeOptions([ADDRESS, '--allow-metrics-degraded']), { address: ADDRESS, allowMetricsDegraded: true });
  assert.deepEqual(parseSmokeOptions(['--allow-metrics-degraded', ADDRESS]), { address: ADDRESS, allowMetricsDegraded: true });
  for (const args of [['--allow-metrics-degraded=true'], ['--unknown'], [ADDRESS, ADDRESS],
    ['--allow-metrics-degraded', '--allow-metrics-degraded'], ['https://secret@example.test/mcp'], ['file:///tmp/mcp']])
    assert.throws(() => parseSmokeOptions(args));
  assert.deepEqual(postDeploySmokeArgs(), ['run', 'smoke:http', '--', 'https://news.bymyleslee.com/mcp', '--allow-metrics-degraded']);
});

test('metrics strict default rejects unavailable or missing ACKs, opt-in produces explicit degradation', () => {
  const recorded = Array(10).fill('recorded');
  assert.equal(metricsResult(true, recorded).status, 'recorded');
  for (const acknowledgments of [Array(10).fill('unavailable'), recorded.slice(1), []]) {
    assert.throws(() => metricsResult(true, acknowledgments));
    const result = metricsResult(true, acknowledgments, true);
    assert.equal(result.status, 'degraded'); assert.ok(result.warning.includes('MCP functional checks passed'));
  }
  assert.equal(metricsResult(false, []).status, 'not_configured');
});

test('complete mocked SDK and legacy functional smoke remains passed with ten recorded ACKs', async () => {
  const mocked = fixture();
  const result = await runHttpSmoke(parseSmokeOptions([ADDRESS]), mocked.dependencies);
  assert.equal(result.status, 'passed'); assert.equal(result.functional_status, 'passed');
  assert.equal(result.metrics.status, 'recorded'); assert.equal(result.metrics.warning, null);
  assert.deepEqual(mocked.counts(), { toolCalls: 10, closed: true });
});

test('post-deploy opt-in retains successful MCP results while clearly reporting unavailable or missing usage ACKs', async () => {
  for (const ack of ['unavailable', count => count === 10 ? null : 'recorded']) {
    const mocked = fixture({ ack });
    const result = await runHttpSmoke(parseSmokeOptions([ADDRESS, '--allow-metrics-degraded']), mocked.dependencies);
    assert.equal(result.status, 'degraded'); assert.equal(result.functional_status, 'passed');
    assert.equal(result.output_examples.length, 2); assert.equal(result.tools.length, 9); assert.ok(result.metrics.warning);
    assert.equal(mocked.counts().closed, true);
  }
  const strict = fixture({ ack: 'unavailable' });
  await assert.rejects(runHttpSmoke(parseSmokeOptions([ADDRESS]), strict.dependencies));
  assert.equal(strict.counts().closed, true);
});

test('degraded metrics flag never masks HTTP, source identity or country functional failures', async () => {
  for (const functionalFault of ['http', 'source', 'countries', 'tool_error']) {
    const mocked = fixture({ ack: 'unavailable', functionalFault });
    await assert.rejects(runHttpSmoke(parseSmokeOptions([ADDRESS, '--allow-metrics-degraded']), mocked.dependencies));
    assert.equal(mocked.counts().closed, true);
  }
});
