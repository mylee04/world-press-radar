import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeMeter, createAggregateSink } from '../dist/metrics.js';

test('CPU uses process counters rather than elapsed network time and projects no request content', async () => {
  const rows = []; let clock = 0, user = 10, system = 20;
  const measure = createRuntimeMeter(async event => { rows.push(event); }, () => ({ user, system }), () => clock);
  const response = await measure(new Request('https://example.com/source-packs/japan-business/export?query=private', {
    headers: { 'x-world-news-traffic': 'inspection', authorization: 'private' },
  }), async () => { clock = 20000; user += 700; system += 200; return new Response('same payload', { headers: { 'x-test': 'kept' } }); });
  assert.deepEqual(rows, [{ revision: 'cpu-optimized-v1', route: 'web_export', traffic: 'inspection', outcome: 'success', overlap: false, cpu_us: 900, wall_ms: 20000 }]);
  assert.equal(await response.text(), 'same payload'); assert.equal(response.headers.get('x-test'), 'kept');
  assert.equal(response.headers.get('x-world-news-runtime-cpu'), 'recorded');
});

test('overlapping requests across meter instances are excluded and telemetry CPU cannot enter a later isolated interval', async () => {
  const rows = []; let releaseFirst, releaseSend, markFirst;
  const firstReady = new Promise(resolve => { markFirst = resolve; });
  const holdFirst = new Promise(resolve => { releaseFirst = resolve; });
  const holdSend = new Promise(resolve => { releaseSend = resolve; });
  const sink = async event => { rows.push(event); if (rows.length === 2) await holdSend; };
  const a = createRuntimeMeter(sink), b = createRuntimeMeter(sink);
  const request = new Request('https://example.com/mcp');
  const first = a(request, async () => { markFirst(); await holdFirst; return new Response('a'); });
  await firstReady;
  await b(request, async () => new Response('b'));
  releaseFirst();
  while (rows.length < 2) await new Promise(resolve => setImmediate(resolve));
  await b(request, async () => new Response('c'));
  releaseSend(); await first;
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.overlap && row.cpu_us === null));
  const last = await a(request, async () => new Response('d'));
  assert.equal(last.status, 200); assert.equal(rows.at(-1).overlap, false);
});

test('measurement and collector failures preserve application responses and thrown errors', async () => {
  let attempts = 0;
  const measure = createRuntimeMeter(async () => { attempts++; throw new Error('private telemetry error'); });
  const response = await measure(new Request('https://example.com/health'), async () => new Response('unchanged', { status: 503 }));
  assert.equal(response.status, 503); assert.equal(await response.text(), 'unchanged');
  assert.equal(response.headers.get('x-world-news-runtime-cpu'), 'unavailable');
  const original = new Error('application failure');
  await assert.rejects(measure(new Request('https://example.com/mcp'), async () => { throw original; }), error => error === original);
  assert.equal(attempts, 2);
  const noCounter = createRuntimeMeter(async () => { throw Error('not reached'); }, () => { throw Error('no counter'); });
  assert.equal((await noCounter(new Request('https://example.com/health'), async () => new Response('ok'))).status, 200);
});

test('runtime sender uses the existing authenticated collector with no retries', async () => {
  const attempts = [];
  const sink = createAggregateSink('https://metrics.example/v1/aggregate', 'test-only-secret', async (url, options) => {
    attempts.push({ url: String(url), options }); return new Response(null, { status: 204 });
  });
  const measure = createRuntimeMeter(sink.runtime);
  const response = await measure(new Request('https://example.com/quality/api/overview'), async () => new Response('ok'));
  assert.equal(response.headers.get('x-world-news-runtime-cpu'), 'recorded');
  assert.equal(attempts.length, 1); assert.equal(attempts[0].url, 'https://metrics.example/v1/runtime-aggregate');
  assert.equal(attempts[0].options.headers.authorization, 'Bearer test-only-secret');
  assert.equal(JSON.parse(attempts[0].options.body).route, 'quality');
  assert.equal(attempts[0].options.redirect, 'error');
});
