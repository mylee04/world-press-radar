import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { normalizeRegistry } from '../dist/catalog.js';
import { ActivityStore } from '../dist/activity.js';
import { HealthStore } from '../dist/health.js';
import { encodeHistory, decodeHistory } from '../dist/activity-history.js';
import { describeEndpointStatus } from '../dist/endpoint-status.js';

const now = Date.parse('2026-10-26T12:00:00.000Z');
const catalog = normalizeRegistry({ countries: [{ code: 'US', name: 'United States', feeds: [{ name: 'Newsroom', url: 'https://publisher.example/feed' }] }] });
const source = catalog.sources[0], endpoint = source.endpoints[0];
const event = (values = {}) => ({ endpoint_id: endpoint.id, checked_at: '2026-10-26T03:00:00.000Z', status: 'working_nonempty', format: 'rss',
  uncertain_urls: 0, baseline_sources: [], source_ids: [source.id], countries: ['US'], source_new: { [source.id]: 2 }, country_new: { US: 1 },
  newest_content_at: '2026-10-26T02:55:00.000Z', date_kind: 'feed_item_date', ...values });
const descriptor = (bytes, records) => {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { month: '2026-10', file: `2026-10-${sha256}.json.gz`, sha256, bytes: bytes.length, records };
};
function store(t, rows, version = 3) {
  const directory = mkdtempSync(join(tmpdir(), 'wns-url-count-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let bytes = encodeHistory(rows);
  if (version !== 3) {
    const data = JSON.parse(gunzipSync(bytes));
    data.version = version; data.rows = data.rows.map(row => row.slice(0, version === 1 ? 8 : 10));
    bytes = gzipSync(JSON.stringify(data));
  }
  const shard = descriptor(bytes, rows.length);
  writeFileSync(join(directory, shard.file), bytes);
  return new ActivityStore({ version: 1, lane: 'production', generated_at: '2026-10-26T04:00:00.000Z', tracking_start: '2026-10-25T00:00:00.000Z',
    available_since: '2026-10-01T00:00:00.000Z', registry_at: null, semantics: 'Test saved records', bindings: [], collections: [],
    scope_starts: { source: { [source.id]: '2026-10-25T03:00:00.000Z' }, country: { US: '2026-10-25T03:00:00.000Z' } }, history: { version: 1, complete: true, shards: [shard] } }, directory);
}
const status = activity => describeEndpointStatus(endpoint, [source], new HealthStore(), activity, now);

test('version 3 preserves actual extracted URL count through archive-backed endpoint status', t => {
  const result = status(store(t, [event({ observed_urls: 17 })]));
  assert.equal(result.status, 'usable');
  assert.equal(result.usability_evidence, 'observed_urls_present');
  assert.equal(result.latest_collection.observed_url_count, 17);
  assert.equal(result.latest_collection.provenance, 'retained_production_collection_archive');
  assert.equal(result.content.newest_content_at, '2026-10-26T02:55:00.000Z');
});

test('an explicit extracted zero is retained separately from absent evidence', t => {
  const zero = status(store(t, [event({ observed_urls: 0 })]));
  assert.equal(zero.status, 'unknown');
  assert.equal(zero.usability_evidence, 'explicit_zero_usable_urls');
  assert.equal(zero.latest_collection.observed_url_count, 0);
  for (const values of [{}, { observed_urls: null }]) {
    const unknown = status(store(t, [event(values)]));
    assert.equal(unknown.latest_collection.observed_url_count, null);
    assert.equal(unknown.usability_evidence, 'recorded_nonempty_xml_count_not_retained');
    assert.notEqual(unknown.usability_evidence, 'observed_urls_present');
  }
});

test('a newer archived failure overrides an older successful structural audit', t => {
  const activity = store(t, [event({ observed_urls: 17 }), event({ checked_at: '2026-10-26T04:00:00.000Z', status: 'blocked', format: null, observed_urls: 0, source_new: {}, country_new: {} })]);
  const health = new HealthStore({ version: 1, observations: [{ endpointId: endpoint.id, type: 'rss', url: endpoint.url, checkedAt: '2026-10-26T02:00:00.000Z', outcome: 'healthy', httpStatus: 200, reason: null, format: 'rss', auditStatus: 'working_nonempty', entryCount: 12, entriesWithUrl: 12 }] });
  const result = describeEndpointStatus(endpoint, [source], health, activity, now);
  assert.equal(result.status, 'failed');
  assert.equal(result.basis, 'collection');
  assert.equal(result.observed_at, '2026-10-26T04:00:00.000Z');
  assert.equal(result.structural_audit.entries_with_url, 12);
});

test('v1 and v2 archives remain readable without inventing extraction counts', t => {
  for (const version of [1, 2]) {
    const result = status(store(t, [event({ observed_urls: 17 })], version));
    assert.equal(result.latest_collection.observed_url_count, null);
    assert.equal(result.usability_evidence, 'recorded_nonempty_xml_count_not_retained');
  }
});

test('adding the extracted count preserves source and country discovery totals and excluded baselines', t => {
  const rows = [event({ checked_at: '2026-10-25T03:00:00.000Z', observed_urls: 100, baseline_sources: [source.id], source_new: { [source.id]: 0 }, country_new: { US: 0 } }), event({ observed_urls: 17 })];
  const latest = store(t, rows), legacy = store(t, rows, 2);
  for (const [kind, scope] of [['source', { source_id: source.id }], ['country', { country: 'US' }]]) {
    const input = { ...scope, start_date: '2026-10-25', end_date: '2026-10-26' };
    assert.deepEqual(latest.query(catalog, kind, input, now), legacy.query(catalog, kind, input, now));
    const result = latest.query(catalog, kind, input, now);
    assert.equal(result.items[0].new_unique_candidate_urls, 0);
    assert.equal(result.items[0].baseline_checks, 1);
    assert.equal(result.items[1].new_unique_candidate_urls, kind === 'source' ? 2 : 1);
  }
});

test('version 3 stores only the integer count, without private URLs or bodies', () => {
  const rows = [event({ observed_urls: 17, urls: ['https://private.example/article'], body: 'private article text' })];
  const bytes = encodeHistory(rows), json = gunzipSync(bytes).toString('utf8'), data = JSON.parse(json);
  assert.equal(data.version, 3); assert.equal(data.rows[0].length, 11); assert.equal(data.rows[0][10], 17);
  assert.ok(!json.includes('https://')); assert.ok(!json.includes('private article'));
  assert.equal(decodeHistory(bytes, descriptor(bytes, 1))[0].observed_urls, 17);
});

test('encoder rejects invalid provided extraction counts and accepts the safe integer boundary', () => {
  for (const observed_urls of [-1, 1.5, '17', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => encodeHistory([event({ observed_urls })]), /ACTIVITY_HISTORY_SCHEMA/);
  const bytes = encodeHistory([event({ observed_urls: Number.MAX_SAFE_INTEGER })]);
  assert.equal(decodeHistory(bytes, descriptor(bytes, 1))[0].observed_urls, Number.MAX_SAFE_INTEGER);
});

test('decoder rejects malformed count fields and row lengths before treating a record as evidence', () => {
  const original = JSON.parse(gunzipSync(encodeHistory([event({ observed_urls: 17 })])));
  for (const value of [-1, 1.5, '17', false, Number.MAX_SAFE_INTEGER + 1]) {
    const changed = structuredClone(original); changed.rows[0][10] = value;
    const bytes = gzipSync(JSON.stringify(changed));
    assert.throws(() => decodeHistory(bytes, descriptor(bytes, 1)), /ACTIVITY_HISTORY_SCHEMA/);
  }
  for (const length of [10, 12]) {
    const changed = structuredClone(original); changed.rows[0].length = length;
    const bytes = gzipSync(JSON.stringify(changed));
    assert.throws(() => decodeHistory(bytes, descriptor(bytes, 1)), /ACTIVITY_HISTORY_SCHEMA/);
  }
});
