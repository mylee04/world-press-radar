import test from 'node:test';
import assert from 'node:assert/strict';
import { callMetadata, createAggregateSink, productObservation, requestToolMeta } from '../dist/metrics.js';
import { createHttpHandler } from '../dist/http.js';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { loadSourcePacks } from '../dist/source-packs.js';
import { registry } from './fixtures.mjs';

const event = { tool: 'search_sources', traffic: 'unclassified', outcome: 'success' };
const request = headers => new Request('https://example.com/mcp', { headers });
const result = data => ({ result: { structuredContent: data } });

test('zero matches differ from an empty pagination page, unavailable results and errors', async () => {
  const sink = async () => {};
  for (const [data, expected] of [[{ total: 0, items: [] }, 'zero_matches'], [{ total: 4, items: [] }, 'empty_page'],
    [{ total: 4, items: [{}] }, 'nonempty'], [{ items: [] }, 'unknown'], [{ total: -1, items: [] }, 'unknown']]) {
    assert.equal((await productObservation(event, result(data), request(), undefined, sink)).search, expected);
  }
  assert.equal((await productObservation({ ...event, outcome: 'error' }, result({ total: 0, items: [] }), request(), undefined, sink)).search, undefined);
  for (const [data, expected] of [[{ exported_endpoints: 0 }, 'empty'], [{ exported_endpoints: 2 }, 'nonempty'], [{}, 'unknown']])
    assert.equal((await productObservation({ ...event, tool: 'export_source_pack' }, result(data), request(), undefined, sink)).export, expected);
});

test('only optional subject metadata produces a purpose-specific keyed pseudonym, never raw identifiers', async () => {
  const writes = [];
  const sink = createAggregateSink('https://metrics.example/v1/aggregate', 'test-only-key-material-with-enough-length', async (url, init) => {
    writes.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return new URL(url).pathname === '/v1/preference' ? Response.json({ enabled: writes.at(-1).body.enabled }) : new Response(null, { status: 204 });
  });
  const meta = { 'openai/subject': 'private-subject', 'openai/session': 'private-session', ip: 'private-ip' };
  const key = await sink.actorKey(meta);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(await sink.actorKey(meta), key);
  assert.notEqual(await sink.actorKey({ 'openai/subject': 'different' }), key);
  assert.equal(await sink.actorKey({ 'openai/session': 'private-session' }), undefined);
  assert.equal(await sink.actorKey({ 'openai/subject': ' ' }), undefined);
  const product = await productObservation(event, result({ total: 1, items: [{}] }), request(), meta, sink);
  await sink({ ...event, duration_ms: 1, product });
  assert.deepEqual(await sink.preference(meta, false), { enabled: false, identity_available: true });
  assert.deepEqual(await sink.preference(undefined, true), { enabled: false, identity_available: false });
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(writes[1].body).sort(), ['actor_key', 'enabled']);
  for (const value of ['private-subject', 'private-session', 'private-ip']) assert.ok(!JSON.stringify(writes).includes(value));
  assert.equal(requestToolMeta({ params: { _meta: meta } }), meta);
  for (const tool of ['get_country_collection_quality', 'get_source_collection_quality', 'list_source_packs', 'get_source_pack', 'export_source_pack', 'set_usage_analytics'])
    assert.equal(callMetadata({ method: 'tools/call', params: { name: tool } }, null).tool, tool);
});

test('inspection, web downloads, privacy headers, unknown calls and controls cannot create user-presence observations', async () => {
  let keyReads = 0;
  const sink = Object.assign(async () => {}, { actorKey: async () => { keyReads++; return 'a'.repeat(64); } });
  const excluded = async (patch = {}, headers, channel) => productObservation({ ...event, ...patch }, result({ total: 1, items: [{}] }), request(headers), {}, sink, channel);
  for (const observation of [await excluded({ traffic: 'inspection' }), await excluded({}, {}, 'web_export'),
    await excluded({}, { dnt: '1' }), await excluded({}, { 'sec-gpc': '1' }), await excluded({}, { 'x-world-news-analytics': 'off' }),
    await excluded({ outcome: 'error' }), await excluded({ tool: 'unknown' }), await excluded({ tool: 'set_usage_analytics' })]) {
    assert.equal(observation.identity, 'excluded'); assert.equal(observation.actor_key, undefined);
  }
  assert.equal(keyReads, 0);
  assert.equal((await productObservation(event, result({ total: 1, items: [{}] }), request(), {}, async () => {})).identity, 'missing');
});

test('HTTP instrumentation distinguishes successful empty searches, MCP exports and GET downloads without counting HEAD', async () => {
  const events = [];
  const handler = createHttpHandler(normalizeRegistry(registry), new HealthStore(), ['example.com'], async e => { events.push(e); });
  const rpc = async (name, args) => handler.fetch(new Request('https://example.com/mcp', { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'x-world-news-traffic': 'inspection',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  try {
    await rpc('search_sources', { query: 'no-matching-publisher-for-this-test' });
    assert.equal(events.at(-1).product.search, 'zero_matches');
    const pack = loadSourcePacks().packs[0].id;
    await rpc('export_source_pack', { pack_id: pack });
    assert.equal(events.at(-1).product.channel, 'mcp');
    assert.equal(events.at(-1).product.export, 'empty');
    const url = `https://example.com/source-packs/${pack}/export?format=opml`;
    const response = await handler.fetch(new Request(url));
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-world-news-metrics'), 'recorded');
    assert.equal(events.at(-1).product.channel, 'web_export');
    assert.equal(events.at(-1).product.export, 'empty');
    const size = events.length;
    await handler.fetch(new Request(url, { method: 'HEAD' }));
    await handler.fetch(new Request('https://example.com/source-packs'));
    assert.equal(events.length, size);
  } finally { await handler.close(); }
});
