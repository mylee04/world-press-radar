import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { ActivityStore } from '../dist/activity.js';
import { encodeHistory } from '../dist/activity-history.js';
import { describeEndpointStatus } from '../dist/endpoint-status.js';
import { inspectXml } from '../dist/inspect.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const catalog = normalizeRegistry({ countries: [{ code: 'US', name: 'United States', feeds: [
  { name: 'Primary newsroom', url: 'https://publisher.example/rss', sitemapUrl: 'https://publisher.example/sitemap.xml' },
  { name: 'Sibling binding', url: 'https://publisher.example/rss' }
] }] });
const primary = catalog.sources.find(source => source.name === 'Primary newsroom');
const sibling = catalog.sources.find(source => source.name === 'Sibling binding');
const endpoint = primary.endpoints.find(value => value.type === 'rss');
const sitemap = primary.endpoints.find(value => value.type === 'sitemap');
function observation({ at = '2026-10-13T04:00:00.000Z', status = 'blocked', format = null, ep = endpoint, ...rest } = {}) {
  return { endpointId: ep.id, type: ep.type, url: ep.url, checkedAt: at, auditStatus: status,
    outcome: ['working_nonempty', 'valid_empty'].includes(status) ? 'healthy' : 'unhealthy', httpStatus: status === 'blocked' ? 403 : 200,
    reason: status === 'blocked' ? 'HTTP_403' : null, format, ...rest };
}
function event({ ep = endpoint, at = '2026-10-15T04:00:00.000Z', status = 'working_nonempty', format = 'rss', ...rest } = {}) {
  return { endpoint_id: ep.id, checked_at: at, status, format, uncertain_urls: 0,
    source_ids: [primary.id, sibling.id], countries: ['US'], baseline_sources: [],
    source_new: { [primary.id]: 0, [sibling.id]: 4 }, country_new: { US: 4 }, ...rest };
}
function snapshot(collections = [], extra = {}) {
  return { version: 1, lane: 'production', generated_at: '2026-10-16T04:00:00.000Z', tracking_start: '2026-10-13T00:00:00.000Z',
    available_since: '2026-10-01T00:00:00.000Z', registry_at: null, semantics: 'Fixture retained evidence', bindings: [], collections, ...extra };
}
function describe(rows, audits = [observation()], ep = endpoint, sources = catalog.sources, extra = {}) {
  return describeEndpointStatus(ep, sources, new HealthStore({ version: 1, observations: audits }), new ActivityStore(snapshot(rows, extra)), NOW);
}
function archive(directory, month, rows) {
  const bytes = encodeHistory(rows), sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = `${month}-${sha256}.json.gz`; writeFileSync(join(directory, file), bytes);
  return { month, file, sha256, bytes: bytes.length, records: rows.length };
}
function withDirectory(t) { const directory = mkdtempSync(join(tmpdir(), 'wns-endpoint-status-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
async function countVerifiedReads(t, moduleTag) {
  const historyModule = await import('../dist/activity-history.js');
  let reads = 0;
  t.mock.module(new URL('../dist/activity-history.js', import.meta.url).href, { namedExports: {
    readHistory: (...args) => { reads++; return historyModule.readHistory(...args); }
  } });
  const { describeEndpointStatus: checkedDescribe } = await import(`../dist/endpoint-status.js?${moduleTag}`);
  return { checkedDescribe, reads: () => reads };
}

test('later production recovery overrides an old failed structural audit without mutating it', () => {
  const health = new HealthStore({ version: 1, observations: [observation()] });
  const before = health.get(endpoint, catalog.sources, NOW);
  const result = describeEndpointStatus(endpoint, catalog.sources, health, new ActivityStore(snapshot([event()])), NOW);
  assert.equal(result.status, 'usable'); assert.equal(result.usable, true); assert.equal(result.basis, 'collection');
  assert.equal(result.observed_at, '2026-10-15T04:00:00.000Z');
  assert.equal(result.structural_audit.http_status, 403); assert.equal(result.latest_collection.http_status, null);
  assert.equal(result.latest_collection.reason, null); assert.equal(result.conflict.present, true);
  assert.match(result.conflict.explanation, /later dated observation/);
  assert.deepEqual(health.get(endpoint, catalog.sources, NOW), before);
});

test('a newer real collection failure wins over a still healthy structural cache', () => {
  const result = describe([event({ status: 'timeout', format: null, http_status: null, reason: 'TIMEOUT' })], [observation({ status: 'working_nonempty', format: 'rss', entriesWithUrl: 20 })]);
  assert.equal(result.status, 'failed'); assert.equal(result.usable, false); assert.equal(result.conflict.present, true);
  assert.equal(result.latest_collection.source_activity[0].new_unique_candidate_urls, null);
  assert.equal(result.latest_collection.reason, 'TIMEOUT');
});

test('a structurally valid RSS item without any entry URL cannot certify an article list', () => {
  const summary = inspectXml(Buffer.from('<rss version="2.0"><channel><title>News</title><link>https://publisher.example/</link><description>News</description><item><title>Text only</title><description>No entry link</description></item></channel></rss>'), 'rss', NOW);
  assert.equal(summary.entryCount, 1); assert.equal(summary.entriesWithUrl, 0);
  const result = describe([], [observation({ status: 'working_nonempty', ...summary })]);
  assert.equal(result.structural_audit.last_outcome, 'healthy');
  assert.equal(result.status, 'unknown'); assert.equal(result.usable, null);
  assert.equal(result.usability_evidence, 'explicit_zero_usable_urls');
  assert.match(result.reason, /zero usable HTTP\(S\) entry URLs/);
});

test('inline known zero URL collection is distinct from missing or positive URL counts', () => {
  const zero = describe([event({ observed_urls: 0 })]);
  assert.equal(zero.status, 'unknown'); assert.equal(zero.usable, null);
  assert.equal(zero.latest_collection.status, 'working_nonempty');
  assert.equal(zero.usability_evidence, 'explicit_zero_usable_urls');
  assert.match(zero.reason, /article-list usability was not established/);
  for (const missing of [undefined, null]) {
    const unknownCount = describe([event({ observed_urls: missing })]);
    assert.equal(unknownCount.status, 'usable'); assert.equal(unknownCount.usable, true);
    assert.equal(unknownCount.usability_evidence, 'recorded_nonempty_xml_count_not_retained');
    assert.match(unknownCount.reason, /first-import success is not certified/);
  }
  assert.equal(describe([event({ observed_urls: 4 })]).usability_evidence, 'observed_urls_present');
  const empty = describe([event({ observed_urls: 0, status: 'valid_empty' })]);
  assert.equal(empty.status, 'valid_empty'); assert.equal(empty.usability_evidence, 'not_established');
});

test('a newer audit can report failure after an older successful collection, and ties prefer production', () => {
  const audits = [observation({ at: '2026-10-15T06:00:00.000Z' })];
  assert.equal(describe([event()], audits).basis, 'structural_audit');
  assert.equal(describe([event()], audits).status, 'failed');
  const tied = describe([event({ at: '2026-10-15T06:00:00.000Z' })], audits);
  assert.equal(tied.basis, 'collection'); assert.equal(tied.status, 'usable');
});

test('valid empty and sitemap index documents stay distinct from failures and article usability', () => {
  const empty = describe([event({ status: 'valid_empty' })]);
  assert.equal(empty.status, 'valid_empty'); assert.equal(empty.usable, false);
  assert.equal(empty.latest_collection.source_activity.find(row => row.source_id === primary.id).new_unique_candidate_urls, 0);
  const index = describe([event({ ep: sitemap, format: 'sitemapindex' })], [], sitemap);
  assert.equal(index.status, 'index_only'); assert.equal(index.usable, false);
  assert.equal(index.latest_collection.source_activity[0].new_unique_candidate_urls, null);
});

test('shared endpoint evidence keeps binding baseline null separate from measured zero', () => {
  const result = describe([event({ baseline_sources: [primary.id], source_new: { [primary.id]: 0, [sibling.id]: 0 } })]);
  const primaryActivity = result.latest_collection.source_activity.find(row => row.source_id === primary.id);
  const siblingActivity = result.latest_collection.source_activity.find(row => row.source_id === sibling.id);
  assert.deepEqual(primaryActivity, { source_id: primary.id, bound: true, baseline: true, new_unique_candidate_urls: null });
  assert.deepEqual(siblingActivity, { source_id: sibling.id, bound: true, baseline: false, new_unique_candidate_urls: 0 });
  assert.equal(result.latest_collection.source_activity.length, 2);
});

test('a shared endpoint can inform another binding without fabricating its source discoveries', () => {
  const result = describe([event({ source_ids: [primary.id], source_new: { [primary.id]: 2 } })]);
  assert.equal(result.usable, true);
  assert.deepEqual(result.latest_collection.source_activity.find(row => row.source_id === sibling.id), {
    source_id: sibling.id, bound: false, baseline: false, new_unique_candidate_urls: null
  });
});

test('unrecorded evidence stays unknown; a baseline marker alone is not a new check', () => {
  const result = describe([], [], endpoint, catalog.sources, { bindings: [{ source_id: primary.id, endpoint_id: endpoint.id, baseline_at: '2026-10-01T00:00:00.000Z' }] });
  assert.equal(result.status, 'unknown'); assert.equal(result.usable, null); assert.equal(result.observed_at, null);
  assert.equal(result.latest_collection, null); assert.equal(result.structural_audit, null);
  assert.equal(result.collection_history.state, 'not_recorded');
});

test('old success and old failure become stale without pretending their outcomes changed', () => {
  for (const status of ['working_nonempty', 'timeout']) {
    const result = describe([event({ at: '2026-10-01T04:00:00.000Z', status, format: status === 'timeout' ? null : 'rss' })], []);
    assert.equal(result.status, 'stale'); assert.equal(result.usable, null); assert.equal(result.latest_collection.status, status);
  }
});

test('future and invalid collection timestamps cannot hide the newest valid dated collection', () => {
  const result = describe([
    event({ at: '2026-10-15T04:00:00.000Z' }),
    event({ at: '2026-10-17T04:00:00.000Z', status: 'timeout', format: null }),
    event({ at: '2026-02-30T04:00:00.000Z', status: 'blocked' }),
    event({ at: 'invalid-time', status: 'blocked' }),
  ], [observation({ at: '2026-10-17T05:00:00.000Z' })]);
  assert.equal(result.status, 'usable'); assert.equal(result.observed_at, '2026-10-15T04:00:00.000Z');
  assert.equal(result.structural_audit, null); assert.equal(result.collection_history.ignored_future_records, 1);
  assert.equal(result.collection_history.ignored_invalid_time_records, 2);
});

test('unknown newer retained status blocks an older success rather than inventing validity', () => {
  const result = describe([event(), event({ at: '2026-10-15T06:00:00.000Z', status: 'unexpected_status' })], []);
  assert.equal(result.status, 'unknown'); assert.equal(result.usable, null);
  assert.equal(result.observed_at, '2026-10-15T06:00:00.000Z');
});

test('content-date age uses an explicit 30-day rule without claiming publisher cadence', () => {
  const dated = describe([event({ newest_content_at: '2026-10-14T20:00:00.000Z', date_kind: 'feed_item_date' })]);
  assert.equal(dated.content.newest_content_at, '2026-10-14T20:00:00.000Z');
  assert.equal(dated.content.freshness, 'recent'); assert.match(dated.content.meaning, /feed-item date/);
  assert.equal(dated.content.freshness_basis, 'retained_content_date_age');
  assert.equal(dated.content.age_seconds, (NOW - Date.parse(dated.content.newest_content_at)) / 1000);
  assert.equal(dated.content.stale_after_seconds, 30 * 24 * 60 * 60);
  assert.equal(dated.content.recorded_audit_freshness, null);
  const old = describe([event({ newest_content_at: '2026-09-01T20:00:00.000Z', date_kind: 'feed_item_date' })]);
  assert.equal(old.content.freshness, 'stale'); assert.equal(old.status, 'usable');
  assert.match(old.content.meaning, /does not estimate publisher update cadence/);
  const boundary = describe([event({ newest_content_at: '2026-09-16T12:00:00.000Z', date_kind: 'feed_item_date' })]);
  assert.equal(boundary.content.freshness, 'recent');
  for (const date of ['2026-10-17T00:00:00.000Z', '2026-02-30T00:00:00.000Z']) {
    const unreliable = describe([event({ newest_content_at: date, date_kind: 'sitemap_lastmod' })]);
    assert.equal(unreliable.content.newest_content_at, null); assert.equal(unreliable.content.freshness, 'unreliable');
    assert.match(unreliable.content.meaning, /modification hint/); assert.equal(unreliable.usable, true);
  }
});

test('audit freshness labels remain separate from current content-date age, including unreliable dates', () => {
  const healthy = { status: 'working_nonempty', format: 'rss', entriesWithUrl: 20, newestContentAt: '2026-09-01T00:00:00.000Z', dateKind: 'feed_item_date' };
  const old = describe([], [observation({ ...healthy, contentFreshness: 'recent' })]);
  assert.equal(old.content.freshness, 'stale'); assert.equal(old.content.recorded_audit_freshness, 'recent');
  const unreliable = describe([], [observation({ ...healthy, contentFreshness: 'unreliable' })]);
  assert.equal(unreliable.content.freshness, 'unreliable'); assert.equal(unreliable.content.freshness_basis, 'recorded_unreliable_date');
});

test('archived collection evidence wins over the old audit and missing inline history', t => {
  const directory = withDirectory(t);
  const shard = archive(directory, '2026-10', [event({ newest_content_at: '2026-10-15T03:00:00.000Z', date_kind: 'feed_item_date', http_status: 200, reason: 'Not retained in compressed archive', observed_urls: 25 })]);
  const activity = new ActivityStore(snapshot([], { history: { version: 1, complete: true, shards: [shard] } }), directory);
  const result = describeEndpointStatus(endpoint, catalog.sources, new HealthStore({ version: 1, observations: [observation()] }), activity, NOW);
  assert.equal(result.status, 'usable'); assert.equal(result.latest_collection.provenance, 'retained_production_collection_archive');
  assert.equal(result.usability_evidence, 'observed_urls_present');
  assert.match(result.reason, /valid nonempty article-list/);
  assert.equal(result.latest_collection.http_status, null); assert.equal(result.latest_collection.reason, null); assert.equal(result.latest_collection.observed_url_count, 25);
  assert.equal(result.content.newest_content_at, '2026-10-15T03:00:00.000Z');
  assert.equal(result.latest_collection.source_activity.find(row => row.source_id === sibling.id).new_unique_candidate_urls, 4);
});

test('newest archive wins regardless of inline sorting; older absent endpoints can use earlier archives', t => {
  const directory = withDirectory(t);
  const old = archive(directory, '2026-09', [event({ ep: sitemap, at: '2026-09-30T04:00:00.000Z', format: 'urlset' })]);
  const current = archive(directory, '2026-10', [event(), event({ at: '2026-10-15T07:00:00.000Z', status: 'timeout', format: null }), event({ at: '2026-10-18T07:00:00.000Z' })]);
  const activity = new ActivityStore(snapshot([event({ at: '2026-10-14T04:00:00.000Z' })], { history: { version: 1, complete: true, shards: [old, current] } }), directory);
  const healthyAudit = new HealthStore({ version: 1, observations: [observation({ status: 'working_nonempty', format: 'rss', entriesWithUrl: 3 })] });
  const latest = describeEndpointStatus(endpoint, catalog.sources, healthyAudit, activity, NOW);
  assert.equal(latest.status, 'failed'); assert.equal(latest.observed_at, '2026-10-15T07:00:00.000Z');
  const earlier = describeEndpointStatus(sitemap, catalog.sources, new HealthStore(), activity, NOW);
  assert.equal(earlier.latest_collection.checked_at, '2026-09-30T04:00:00.000Z'); assert.equal(earlier.status, 'stale');
});

test('cached archive indexes invalidate on corruption or deletion instead of falling back to a stale audit', t => {
  const directory = withDirectory(t), shard = archive(directory, '2026-10', [event()]);
  const activity = new ActivityStore(snapshot([], { history: { version: 1, complete: true, shards: [shard] } }), directory);
  const health = new HealthStore({ version: 1, observations: [observation({ status: 'working_nonempty', format: 'rss', entriesWithUrl: 5 })] });
  assert.equal(describeEndpointStatus(endpoint, catalog.sources, health, activity, NOW).status, 'usable');
  const path = join(directory, shard.file), bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes);
  const corrupt = describeEndpointStatus(endpoint, catalog.sources, health, activity, NOW);
  assert.equal(corrupt.status, 'evidence_unavailable'); assert.equal(corrupt.usable, null); assert.equal(corrupt.latest_collection, null);
  assert.equal(corrupt.structural_audit.last_outcome, 'healthy'); assert.equal(corrupt.collection_history.error, 'ACTIVITY_HISTORY_INTEGRITY');
  unlinkSync(path);
  assert.equal(describeEndpointStatus(endpoint, catalog.sources, health, activity, NOW).collection_history.error, 'ACTIVITY_HISTORY_READ_FAILURE');
});

test('archive-backed snapshot without configured history is explicitly unavailable', () => {
  const result = describe([], [], endpoint, catalog.sources, { history: { version: 1, complete: true, shards: [] } });
  assert.equal(result.status, 'evidence_unavailable'); assert.equal(result.collection_history.error, 'ACTIVITY_HISTORY_NOT_CONFIGURED');
});

test('already newer inline evidence does not require an unrelated older archive to be readable', t => {
  const directory = withDirectory(t), shard = archive(directory, '2026-09', [event({ at: '2026-09-30T04:00:00.000Z' })]);
  unlinkSync(join(directory, shard.file));
  const activity = new ActivityStore(snapshot([event()], { history: { version: 1, complete: true, shards: [shard] } }), directory);
  assert.equal(describeEndpointStatus(endpoint, catalog.sources, new HealthStore(), activity, NOW).status, 'usable');
});

test('legacy XML markers cannot establish full structural article-list usability', () => {
  const health = new HealthStore(undefined, { results: [{ countryCode: primary.countryCode, outlet: primary.name, url: endpoint.url,
    checkedAt: '2026-10-15T04:00:00.000Z', valid: true, httpCode: 200 }] });
  const result = describeEndpointStatus(endpoint, [primary], health, new ActivityStore(), NOW);
  assert.equal(result.status, 'unknown'); assert.equal(result.usable, null); assert.equal(result.structural_audit.validation, 'legacy_xml_markers');
});

test('a maximum-size 500,000-row archive is verified once for a 15-endpoint batch', async t => {
  const directory = withDirectory(t);
  const many = normalizeRegistry({ countries: [{ code: 'US', name: 'United States', feeds: Array.from({ length: 15 }, (_, i) => ({ name: `Newsroom ${i}`, url: `https://publisher-${i}.example/rss` })) }] });
  const endpoints = many.sources.map(source => source.endpoints[0]);
  const first = Date.parse('2026-10-01T00:00:00.000Z');
  // This is the actual supported 500,000-row envelope, beyond the underlying
  // all-row cache's 200,000-row limit. Compact tuples keep the fixture small.
  const rows = Array.from({ length: 500000 }, (_, i) => [first + i * 1000, i % 15, 0, 0, 0, [], [[i % 15, 0]], [[0, 0]], null, null]);
  const bytes = gzipSync(JSON.stringify({ version: 2, dictionaries: {
    endpoint: endpoints.map(value => value.id), source: many.sources.map(source => source.id), country: ['US'], status: ['working_nonempty'], format: ['rss']
  }, rows }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const shard = { month: '2026-10', file: `2026-10-${sha256}.json.gz`, sha256, bytes: bytes.length, records: rows.length };
  writeFileSync(join(directory, shard.file), bytes);
  const { checkedDescribe, reads } = await countVerifiedReads(t, 'compact-archive-proof');
  const activity = new ActivityStore(snapshot([], { history: { version: 1, complete: true, shards: [shard] } }), directory);
  const health = new HealthStore();
  const batchAsOf = first + 500000 * 1000 + 3600000;
  for (const value of endpoints) assert.equal(checkedDescribe(value, many.sources, health, activity, batchAsOf).status, 'usable');
  assert.equal(reads(), 1, 'the 500k-row shard must not be decoded again for each endpoint');
});

test('compact archive cache respects historical as_of and exact future eligibility boundaries', async t => {
  const directory = withDirectory(t);
  const first = Date.parse('2026-10-15T04:00:00.000Z');
  const shard = archive(directory, '2026-10', [event(), event({ at: new Date(first + 1000).toISOString(), status: 'timeout', format: null }),
    event({ at: new Date(first + 2000).toISOString() })]);
  const { checkedDescribe, reads } = await countVerifiedReads(t, 'asof-archive-proof');
  const activity = new ActivityStore(snapshot([], { history: { version: 1, complete: true, shards: [shard] } }), directory);
  const health = new HealthStore();
  assert.equal(checkedDescribe(endpoint, catalog.sources, health, activity, NOW).status, 'usable');
  assert.equal(reads(), 1);
  const historical = checkedDescribe(endpoint, catalog.sources, health, activity, first);
  assert.equal(reads(), 2); assert.equal(historical.observed_at, new Date(first).toISOString());
  assert.ok(historical.collection_history.ignored_future_records > 0);
  checkedDescribe(endpoint, catalog.sources, health, activity, first + 999);
  assert.equal(reads(), 2, 'the same eligibility interval reuses its index');
  const next = checkedDescribe(endpoint, catalog.sources, health, activity, first + 1000);
  assert.equal(reads(), 3, 'the next observation crossing the upper boundary rebuilds the index');
  assert.equal(next.status, 'failed'); assert.equal(next.observed_at, new Date(first + 1000).toISOString());
});
