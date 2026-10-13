import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseRetryAfter, nextDailyCheck, collectionNextDue, endpointDue, collectionConcurrency } from '../dist/collection-schedule.js';
import { ActivityLedger } from '../dist/activity-ledger.js';
import { normalizeRegistry } from '../dist/catalog.js';
import { createHostGate } from '../dist/host-gate.js';

const at = '2026-10-13T12:00:00.000Z';
test('Retry-After validates finite delta seconds and HTTP date, invalid/past values cannot invent waits', () => {
  const now = Date.parse(at);
  assert.deepEqual(parseRetryAfter('60', now), { at: '2026-10-13T12:01:00.000Z', source: 'delta_seconds' });
  assert.deepEqual(parseRetryAfter('0', now), { at, source: 'delta_seconds' });
  assert.deepEqual(parseRetryAfter('Wed, 14 Oct 2026 12:00:00 GMT', now), { at: '2026-10-14T12:00:00.000Z', source: 'http_date' });
  assert.equal(parseRetryAfter('Wednesday, 14-Oct-26 12:00:00 GMT', now).at, '2026-10-14T12:00:00.000Z');
  assert.equal(parseRetryAfter('Wed Oct 14 12:00:00 2026', now).at, '2026-10-14T12:00:00.000Z');
  for (const value of ['', '-1', '1.5', '1e9', '999999999999', '999999999999999999999999999', '2026-10-14', 'Tue, 31 Feb 2026 12:00:00 GMT', 'Tue, 13 Oct 2026 11:00:00 GMT']) assert.equal(parseRetryAfter(value, now), null, value);
});
test('success, index and non-429 failure share next UTC day; server deadlines can extend it', () => {
  assert.equal(nextDailyCheck(at), '2026-10-14T00:00:00.000Z');
  assert.equal(nextDailyCheck('2026-10-13T23:59:59.999Z'), '2026-10-14T00:00:00.000Z');
  assert.equal(collectionNextDue(at, 404), '2026-10-14T00:00:00.000Z');
  assert.equal(collectionNextDue(at, 429, '2026-10-15T00:00:00.000Z'), '2026-10-15T00:00:00.000Z');
  assert.equal(collectionNextDue(at, 503, '2026-10-13T13:00:00.000Z'), '2026-10-14T00:00:00.000Z');
  assert.throws(() => nextDailyCheck('bad'), /INVALID_CHECK_TIME/);
});
test('legacy week-long generic waits are ignored; 429 and explicit server waits survive force', () => {
  const base = { endpoint_id: 'ep_' + 'a'.repeat(24), last_attempt_at: '2026-10-12T12:00:00.000Z', next_due: '2026-10-19T12:00:00.000Z' };
  assert.equal(endpointDue(base, at).eligible, true);
  assert.equal(endpointDue({ ...base, reason: 'HTTP_404' }, at).eligible, true);
  const limited = endpointDue({ ...base, reason: 'HTTP_429' }, at, true);
  assert.equal(limited.eligible, false); assert.equal(limited.deferred.reason, 'rate_limited');
  assert.equal(endpointDue({ ...base, http_status: 503, retry_after_at: '2026-10-13T14:00:00.000Z' }, at, true).eligible, false);
  assert.equal(endpointDue({ ...base, last_attempt_at: at }, at).eligible, false);
  assert.equal(endpointDue({ ...base, last_attempt_at: at }, at, true).eligible, true);
  assert.equal(endpointDue(undefined, at).eligible, true);
});
test('parallel host governor spaces one host while allowing another and rejects real cooldowns immediately', async () => {
  const gate = createHostGate(25), first = await gate('a.example', Date.now() + 200);
  const other = await gate('b.example', Date.now() + 200); other(); first();
  const started = Date.now(); (await gate('a.example', Date.now() + 200))(); assert.ok(Date.now() - started >= 20);
  gate.defer('a.example', new Date(Date.now() + 60000).toISOString(), 429);
  await assert.rejects(gate('a.example', Date.now() + 8000), error => error.message === 'SERVER_RETRY_AFTER_WAIT' && error.httpStatus === 429);
  (await gate('c.example', Date.now() + 200))();
  assert.equal(collectionConcurrency(), 6); assert.equal(collectionConcurrency('16'), 16);
  for (const value of [0, 17, 1.5, 'bad', Infinity]) assert.throws(() => collectionConcurrency(value));
});
test('a waiting host worker rechecks newly learned Retry-After immediately before slot acquisition', async () => {
  const gate = createHostGate(0), release = await gate('a.example', Date.now() + 500);
  const pending = gate('a.example', Date.now() + 500);
  gate.defer('a.example', new Date(Date.now() + 60000).toISOString(), 429); release();
  await assert.rejects(pending, /SERVER_RETRY_AFTER_WAIT/);
});
test('ledger keeps production recovery compatibility and persists daily schedule, historical 429 waits and actual cycle exceptions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-policy-')), ledger = new ActivityLedger(join(dir, 'ledger.sqlite'));
  const catalog = normalizeRegistry({ countries: [{ code: 'US', name: 'US', feeds: [{ name: 'A', url: 'https://a.example/rss', sitemapUrl: 'https://a.example/map.xml' }, { name: 'B', url: 'https://b.example/rss' }] }] });
  const source = catalog.sources.find(s => s.name === 'A'), rss = source.endpoints.find(e => e.type === 'rss'), index = source.endpoints.find(e => e.type === 'sitemap');
  try {
    ledger.acquire('owner', at, 3600); ledger.syncRegistry(catalog, at);
    const commit = (endpoint, time, extra = {}) => ledger.commit({ id: time + endpoint.id, endpoint, checked_at: time, traffic: 'production', status: 'working_nonempty', format: endpoint.type === 'sitemap' ? 'sitemapindex' : 'rss', reason: null, urls: [], ...extra }, [source], 'owner', at);
    commit(rss, '2026-10-12T10:00:00.000Z', { status: 'http_error', reason: 'HTTP_404', http_status: 404 });
    commit(index, '2026-10-12T11:00:00.000Z');
    assert.equal(ledger.db.prepare('SELECT MIN(next_due) due FROM bindings WHERE source_id=?').get(source.id).due, '2026-10-13T00:00:00.000Z');
    const schedule = ledger.scheduling(catalog, at); assert.equal(schedule.eligible.length, 3);
    ledger.beginCycle(catalog, { id: 'cycle', lane: 'production', at, scope: 'due_endpoints', eligible_endpoint_ids: schedule.eligible, planned_endpoint_ids: schedule.eligible, scheduling: schedule.scheduling });
    ledger.db.prepare('INSERT INTO host_cooldowns VALUES(?,?,?)').run('a.example', '2026-11-01T00:00:00.000Z', 'access_restricted');
    commit(rss, '2026-10-13T12:01:00.000Z', { status: 'blocked', reason: 'HTTP_429', http_status: 429, retry_after_at: '2026-10-15T12:00:00.000Z', retry_after_source: 'http_date', cycle_id: 'cycle' });
    assert.equal(ledger.hostCooldowns('2026-10-13T12:02:00.000Z').find(row => row.host === 'a.example').until, '2026-10-15T12:00:00.000Z');
    const state = ledger.scheduling(catalog, '2026-10-13T12:02:00.000Z', true);
    assert.equal(state.eligible.length, 1); assert.equal(state.scheduling.deferred_endpoints.length, 2);
    const recovery = ledger.db.prepare('SELECT * FROM endpoint_recovery WHERE endpoint_id=?').get(rss.id);
    assert.equal(recovery.category, 'rate_limited'); assert.equal(recovery.next_eligible_at, '2026-10-15T12:00:00.000Z');
    assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM recovery_events').get().n, 3);
    assert.equal(JSON.parse(ledger.db.prepare('SELECT details FROM collections WHERE endpoint_id=? ORDER BY checked_at DESC LIMIT 1').get(rss.id).details).recovery.category, 'rate_limited');
    ledger.deferCycleEndpoint('cycle', state.scheduling.deferred_endpoints.find(row => row.endpoint_id === index.id));
    const finished = ledger.finishCycle('cycle', 'partial', '2026-10-13T12:03:00.000Z', 'SERVER_RETRY_AFTER_DEFERRED');
    assert.equal(finished.attempted_endpoint_ids.length, 1); assert.equal(finished.scheduling.deferred_endpoints.length, 2);
    assert.equal(finished.scheduling.as_of, '2026-10-13T12:03:00.000Z');
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('healthy sibling feeds cannot cancel an unexpired 503 Retry-After host instruction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-cooldown-')), ledger = new ActivityLedger(join(dir, 'ledger.sqlite'));
  const catalog = normalizeRegistry({ countries: [{ code: 'US', name: 'US', feeds: [{ name: 'A', url: 'https://a.example/rss' }] }] }), source = catalog.sources[0], endpoint = source.endpoints[0];
  try {
    ledger.acquire('owner', at, 3600); ledger.syncRegistry(catalog, at);
    ledger.db.prepare('INSERT INTO host_cooldowns VALUES(?,?,?)').run('a.example', '2026-10-14T14:00:00.000Z', 'server_retry_after');
    ledger.commit({ id: 'healthy-spool-replay', endpoint, checked_at: at, traffic: 'production', status: 'valid_empty', format: 'rss', reason: null, urls: [] }, [source], 'owner', at);
    assert.equal(ledger.hostCooldowns(at)[0].until, '2026-10-14T14:00:00.000Z');
    assert.equal(ledger.scheduling(catalog, '2026-10-14T12:00:00.000Z', true).eligible.length, 0);
    assert.equal(ledger.scheduling(catalog, '2026-10-14T14:00:00.000Z').eligible.length, 1);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Mock network: prove header propagation, retry suppression and redirect-host reservation without publisher access.
let responses = [], requests = [];
mock.module('node:dns/promises', { namedExports: { lookup: async () => [{ address: '8.8.8.8', family: 4 }] } });
function fakeRequest(url, options, callback) {
  requests.push(url.href); const req = new EventEmitter(); req.destroy = error => { if (error) req.emit('error', error); req.emit('close'); };
  req.end = () => queueMicrotask(() => { const fixture = responses.shift(), response = new PassThrough(); response.statusCode = fixture.status; response.headers = fixture.headers ?? {}; response.on('close', () => req.emit('close')); callback(response); if (!response.destroyed) response.end(fixture.body ?? Buffer.alloc(0)); }); return req;
}
mock.module('node:http', { namedExports: { request: fakeRequest } }); mock.module('node:https', { namedExports: { request: fakeRequest } });
const { auditEndpoint, isTransient } = await import('../dist/audit-check.js');
test('429/503 Retry-After reaches observations and prevents immediate retries; host-deferred work is not a check', async () => {
  const endpoint = { id: 'ep_' + 'b'.repeat(24), type: 'rss', url: 'https://example.com/feed' };
  for (const status of [429, 503]) {
    requests = []; responses = [{ status, headers: { 'retry-after': '3600' } }];
    const observation = await auditEndpoint(endpoint); assert.equal(observation.httpStatus, status); assert.equal(observation.requestedHops, 1); assert.equal(observation.retryAfterSource, 'delta_seconds'); assert.ok(Date.parse(observation.retryAfterAt) > Date.now()); assert.equal(isTransient(observation), false); assert.equal(requests.length, 1);
  }
  requests = []; const gate = createHostGate(0); gate.defer('example.com', new Date(Date.now() + 60000).toISOString(), 429);
  const deferred = await auditEndpoint(endpoint, gate); assert.ok(deferred.requestDeferred); assert.equal(deferred.httpStatus, null); assert.equal(requests.length, 0);
});
test('durable budget errors remain stop signals instead of false publisher failures', async () => {
  requests = []; const endpoint = { id: 'ep_' + 'c'.repeat(24), type: 'rss', url: 'https://example.com/feed' };
  await assert.rejects(auditEndpoint(endpoint, async () => { throw Error('DAILY_REQUEST_BUDGET_EXHAUSTED'); }), /DAILY_REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(requests.length, 0);
});
test('redirect blocked by a saved host cooldown preserves the real initial HTTP request', async () => {
  requests = []; responses = [{ status: 302, headers: { location: 'https://limited.example/feed' } }];
  const gate = createHostGate(0); gate.defer('limited.example', new Date(Date.now() + 60000).toISOString(), 429);
  const result = await auditEndpoint({ id: 'ep_' + 'd'.repeat(24), type: 'rss', url: 'https://example.com/feed' }, gate);
  assert.equal(result.requestDeferred, undefined); assert.equal(result.requestedHops, 1); assert.equal(result.httpStatus, 302);
  assert.equal(result.auditStatus, 'incomplete'); assert.equal(result.serverDeferral.httpStatus, 429); assert.deepEqual(requests, ['https://example.com/feed']);
});
test('budget exhaustion during a redirect retains the preceding actual response before stopping', async () => {
  requests = []; responses = [{ status: 302, headers: { location: 'https://other.example/feed' } }]; let gates = 0;
  const result = await auditEndpoint({ id: 'ep_' + 'e'.repeat(24), type: 'rss', url: 'https://example.com/feed' }, async () => { if (++gates > 1) throw Error('DAILY_REQUEST_BUDGET_EXHAUSTED'); return () => {}; });
  assert.equal(result.stopReason, 'DAILY_REQUEST_BUDGET_EXHAUSTED'); assert.equal(result.requestedHops, 1); assert.equal(result.httpStatus, 302);
  assert.equal(result.auditStatus, 'incomplete'); assert.deepEqual(requests, ['https://example.com/feed']);
});
