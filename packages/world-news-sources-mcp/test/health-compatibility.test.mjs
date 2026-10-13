import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore, snapshotSchema } from '../dist/health.js';

const catalog = normalizeRegistry({ countries: [{ code: 'US', name: 'USA', feeds: [{ name: 'Fixture newsroom', url: 'https://example.com/feed' }] }] });
const endpoint = catalog.sources[0].endpoints[0];
const observation = { endpointId: endpoint.id, type: endpoint.type, url: endpoint.url, checkedAt: '2026-10-13T03:00:00.000Z',
  outcome: 'unhealthy', httpStatus: 429, reason: 'HTTP_429', format: null, auditStatus: 'blocked', validatorVersion: '3', attempts: 1,
  diagnostics: { phase: 'fetch', contentType: 'text/html', bodyKind: 'html', requestHost: 'example.com',
    retryAfterAt: '2026-10-14T06:00:00.000Z', cooldownUntil: '2026-10-14T06:00:00.000Z' } };

test('existing Oracle v3 health diagnostics load intact with the new daily collector', () => {
  const input = { version: 1, observations: [observation] };
  const parsed = snapshotSchema.parse(input);
  assert.deepEqual(parsed.observations[0].diagnostics, observation.diagnostics);
  const health = new HealthStore(input).get(endpoint, catalog.sources, Date.parse('2026-10-13T04:00:00.000Z'));
  assert.equal(health.http_status, 429);
  assert.equal(health.audit_status, 'blocked');
});

test('compatibility accepts only the reviewed diagnostic fields, not arbitrary snapshot additions', () => {
  assert.throws(() => snapshotSchema.parse({ version: 1, observations: [{ ...observation,
    diagnostics: { ...observation.diagnostics, unreviewed_field: 'fixture' } }] }));
  assert.throws(() => snapshotSchema.parse({ version: 1, observations: [{ ...observation, diagnostics: { phase: 'fetch' } }] }));
});
