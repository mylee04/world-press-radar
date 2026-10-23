import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../dist/server.js';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { ActivityStore } from '../dist/activity.js';

async function withServer(preferences, run) {
  const catalog = normalizeRegistry({ countries: [{ code: 'US', name: 'United States', feeds: [{ name: 'Example', url: 'https://example.test/feed' }] }] });
  const server = createServer(catalog, new HealthStore(), new ActivityStore(), { version: 1, reviewed_at: '2026-10-23', packs: [] }, preferences);
  const client = new Client({ name: 'usage-preference-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await run(client);
  } finally { await client.close(); await server.close(); }
}

test('usage preference tool has explicit mutation annotations and passes SDK metadata to its callback', async () => {
  const calls = [];
  await withServer(async (meta, enabled) => { calls.push({ meta, enabled }); return { enabled, identity_available: true }; }, async client => {
    const { tools } = await client.listTools();
    const tool = tools.find(item => item.name === 'set_usage_analytics');
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false);
    const rawMeta = { 'test/identity': 'not-a-real-client-identity' };
    const off = await client.callTool({ name: tool.name, arguments: { enabled: false }, _meta: rawMeta });
    assert.notEqual(off.isError, true); assert.equal(off.structuredContent.applied, true); assert.equal(off.structuredContent.enabled, false);
    assert.equal(calls[0].meta['test/identity'], rawMeta['test/identity']); assert.equal(calls[0].enabled, false);
    assert.ok(!JSON.stringify(off).includes(rawMeta['test/identity']));
    const on = await client.callTool({ name: tool.name, arguments: { enabled: true }, _meta: rawMeta });
    assert.equal(on.structuredContent.enabled, true); assert.equal(on.structuredContent.identity_available, true);
    const search = await client.callTool({ name: 'search_sources', arguments: { country: 'US' } });
    assert.notEqual(search.isError, true); assert.equal(search.structuredContent.total, 1);
    for (const args of [{}, { enabled: 'false' }, { enabled: false, subject: 'cannot-select-another-user' }]) {
      assert.equal((await client.callTool({ name: tool.name, arguments: args })).isError, true);
    }
    assert.equal(calls.length, 2);
  });
});

test('unavailable identity or transport and collector errors never claim a preference was applied', async () => {
  for (const [preferences, expected, error] of [
    [undefined, 'unavailable', true],
    [async () => ({ enabled: false, identity_available: false }), 'unavailable', false],
    [async () => { throw new Error('private-upstream-detail'); }, 'error', true],
  ]) {
    await withServer(preferences, async client => {
      const response = await client.callTool({ name: 'set_usage_analytics', arguments: { enabled: false } });
      assert.equal(response.isError === true, error);
      assert.equal(response.structuredContent.status, expected);
      assert.equal(response.structuredContent.applied, false); assert.equal(response.structuredContent.enabled, null);
      assert.ok(!JSON.stringify(response).includes('private-upstream-detail'));
    });
  }
});
