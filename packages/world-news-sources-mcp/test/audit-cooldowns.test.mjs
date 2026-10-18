import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAuditHostGate, loadAuditHostCooldowns, observeAuditHostCooldowns } from '../dist/audit-cooldowns.js';
import { createHostGate } from '../dist/host-gate.js';
import { rss } from './fixtures.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t, rows = [], lane = 'production') {
  const directory = mkdtempSync(join(tmpdir(), 'audit-cooldowns-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'activity.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE host_cooldowns(host TEXT PRIMARY KEY,until_at TEXT NOT NULL,category TEXT NOT NULL)');
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('lane', lane);
  for (const row of rows) db.prepare('INSERT INTO host_cooldowns VALUES(?,?,?)').run(...row);
  db.close();
  return { directory, path };
}

test('configured production cooldowns are read without changing the DB and expired or legacy generic waits are ignored', t => {
  const now = Date.now(), future = new Date(now + 60000).toISOString();
  const f = fixture(t, [['limited.example', future, 'rate_limited'], ['retry.example', future, 'server_retry_after'], ['expired.example', new Date(now).toISOString(), 'rate_limited'], ['legacy.example', future, 'access_restricted']]);
  const before = hash(f.path);
  assert.deepEqual(loadAuditHostCooldowns(f.path, now), [{ host: 'limited.example', until: future, httpStatus: 429 }, { host: 'retry.example', until: future, httpStatus: null }]);
  assert.equal(hash(f.path), before);
  assert.equal(existsSync(`${f.path}-journal`), false);
  assert.equal(existsSync(`${f.path}-wal`), false);
  assert.deepEqual(loadAuditHostCooldowns(undefined), []);
});

test('a configured missing, corrupt, wrong-lane or malformed cooldown DB fails closed and cannot create a missing DB', t => {
  const f = fixture(t), missing = join(f.directory, 'missing.sqlite');
  assert.throws(() => loadAuditHostCooldowns(missing), /AUDIT_COOLDOWN_DB_UNAVAILABLE/);
  assert.equal(existsSync(missing), false);
  const corrupt = join(f.directory, 'corrupt.sqlite'); writeFileSync(corrupt, 'not sqlite');
  assert.throws(() => loadAuditHostCooldowns(corrupt), /AUDIT_COOLDOWN_DB_UNAVAILABLE/);
  assert.throws(() => loadAuditHostCooldowns(fixture(t, [], 'inspection').path), /AUDIT_COOLDOWN_DB_UNAVAILABLE/);
  for (const path of ['', 'relative.sqlite']) assert.throws(() => loadAuditHostCooldowns(path), /AUDIT_COOLDOWN_DB_INVALID/);
  for (const [host, deadline] of [['limited.example/path', new Date(Date.now() + 60000).toISOString()], ['limited.example', 'tomorrow'], ['limited.example', '2027-02-31T00:00:00.000Z']]) {
    assert.throws(() => loadAuditHostCooldowns(fixture(t, [[host, deadline, 'rate_limited']]).path), /AUDIT_COOLDOWN_DB_UNAVAILABLE/);
  }
  const malformed = fixture(t), db = new DatabaseSync(malformed.path); db.exec('DROP TABLE host_cooldowns'); db.close();
  assert.throws(() => loadAuditHostCooldowns(malformed.path), /AUDIT_COOLDOWN_DB_UNAVAILABLE/);
});

test('cooldown loading refuses an unexpectedly large host table instead of silently omitting a protected host', t => {
  const f = fixture(t), db = new DatabaseSync(f.path), insert = db.prepare('INSERT INTO host_cooldowns VALUES(?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < 10001; i++) insert.run(`host${i}.example`, '2099-01-01T00:00:00.000Z', 'rate_limited');
  db.exec('COMMIT'); db.close();
  assert.throws(() => loadAuditHostCooldowns(f.path), /AUDIT_COOLDOWN_DB_UNAVAILABLE/);
});

function runAudit(f, endpoints, mode, configured = true) {
  const dist = join(f.directory, 'dist'); mkdirSync(dist);
  writeFileSync(join(f.directory, 'package.json'), '{"type":"module"}');
  for (const name of ['audit.js', 'audit-cooldowns.js', 'host-gate.js', 'collection-schedule.js']) copyFileSync(new URL(`../dist/${name}`, import.meta.url), join(dist, name));
  writeFileSync(join(dist, 'config.js'), `export function loadData(){ const endpoints=${JSON.stringify(endpoints)}; return {catalog:{endpoints:new Map(endpoints.map(e=>[e.id,e])),sources:[{countryCode:'US',enabled:true,endpoints}]}};}`);
  writeFileSync(join(dist, 'health.js'), 'export const observationSchema={parse:v=>v},snapshotSchema={parse:v=>v};');
  writeFileSync(join(dist, 'audit-check.js'), `import {appendFileSync} from 'node:fs'; export const isTransient=()=>false; export async function auditEndpoint(endpoint,gate){
    if(${JSON.stringify(mode)}==='forbidden')throw Error('UNEXPECTED_PUBLISHER_ATTEMPT');
    if(${JSON.stringify(mode)}==='race'){const until=new Date(Date.now()+60000).toISOString();gate.defer(new URL(endpoint.url).hostname,until,429);try{await gate(new URL(endpoint.url).hostname,Date.now()+1000);}catch(error){return {requestDeferred:{until,httpStatus:429}};}}
    appendFileSync(new URL('../calls.jsonl',import.meta.url),JSON.stringify(endpoint)+'\\n');return {endpointId:endpoint.id,url:endpoint.url,type:endpoint.type,httpStatus:200,auditStatus:'valid_empty',outcome:'healthy',checkedAt:new Date().toISOString(),attempts:1};}`);
  const env = { ...process.env }; delete env.WNS_ACTIVITY_DB;
  if (configured) env.WNS_ACTIVITY_DB = f.path;
  return spawnSync(process.execPath, [join(dist, 'audit.js'), '2026-10-18-test'], { env, encoding: 'utf8', timeout: 10000 });
}
const endpoint = (id, host) => ({ id, type: 'rss', url: `https://${host}/feed` });

test('weekly audit records held direct endpoints as skipped with zero observations and zero publisher attempts', t => {
  const until = new Date(Date.now() + 60000).toISOString(), f = fixture(t, [['limited.example', until, 'rate_limited'], ['retry.example', until, 'server_retry_after'], ['[2606:4700:4700::1111]', until, 'rate_limited']]), before = hash(f.path);
  const run = runAudit(f, [endpoint('a', 'limited.example'), endpoint('b', 'retry.example'), endpoint('c', '[2606:4700:4700::1111]')], 'forbidden');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(readFileSync(join(f.directory, 'audits/2026-10-18-test/report.json'), 'utf8'));
  assert.equal(report.audit.checked, 0); assert.equal(report.audit.skipped, 3); assert.equal(report.audit.lastCompletedFullAuditAt, null);
  assert.deepEqual(report.endpoints.map(e => e.incomplete_reason), ['HOST_RATE_LIMITED', 'HOST_SERVER_RETRY_AFTER', 'HOST_RATE_LIMITED']);
  assert.ok(report.endpoints.every(e => e.observation === null));
  assert.equal(existsSync(join(f.directory, 'calls.jsonl')), false);
  assert.equal(existsSync(join(f.directory, 'audits/2026-10-18-test/observations.jsonl')), false);
  assert.equal(hash(f.path), before);
});

test('a gate hold learned after worker selection cannot become a fake zero-hop audit observation', t => {
  const f = fixture(t), run = runAudit(f, [endpoint('a', 'race.example')], 'race');
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(readFileSync(join(f.directory, 'audits/2026-10-18-test/report.json'), 'utf8'));
  assert.equal(report.audit.checked, 0); assert.equal(report.audit.skipped, 1);
  assert.equal(report.endpoints[0].incomplete_reason, 'HOST_RATE_LIMITED');
  assert.equal(existsSync(join(f.directory, 'calls.jsonl')), false);
  assert.equal(existsSync(join(f.directory, 'audits/2026-10-18-test/observations.jsonl')), false);
});

test('configured DB failure stops audit before artifacts or requests while standalone without env retains prior behavior', t => {
  const invalid = fixture(t), db = new DatabaseSync(invalid.path); db.exec('DROP TABLE host_cooldowns'); db.close();
  const failed = runAudit(invalid, [endpoint('a', 'example.com')], 'forbidden');
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /AUDIT_COOLDOWN_DB_UNAVAILABLE/);
  assert.equal(existsSync(join(invalid.directory, 'audits')), false);
  assert.equal(existsSync(join(invalid.directory, 'calls.jsonl')), false);
  const standalone = fixture(t), succeeded = runAudit(standalone, [endpoint('a', 'example.com')], 'success', false);
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.equal(JSON.parse(readFileSync(join(standalone.directory, 'audits/2026-10-18-test/report.json'), 'utf8')).audit.checked, 1);
});

// Mock transport proves no HTTP request reaches a protected redirect destination.
let requests = [], responses = [];
mock.module('node:dns/promises', { namedExports: { lookup: async () => [{ address: '8.8.8.8', family: 4 }] } });
function fakeRequest(url, options, callback) {
  requests.push(url.href); const request = new EventEmitter(); request.destroy = error => { if (error) request.emit('error', error); request.emit('close'); };
  request.end = () => queueMicrotask(() => { const fixture = responses.shift(), response = new PassThrough(); response.statusCode = fixture.status; response.headers = fixture.headers ?? {}; response.on('close', () => request.emit('close')); callback(response); if (!response.destroyed) response.end(fixture.body ?? Buffer.alloc(0)); });
  return request;
}
mock.module('node:http', { namedExports: { request: fakeRequest } });
mock.module('node:https', { namedExports: { request: fakeRequest } });
const { auditEndpoint } = await import('../dist/audit-check.js');

test('persisted 429 and server Retry-After protect redirect destinations while preserving the actual initial hop', async t => {
  for (const category of ['rate_limited', 'server_retry_after']) for (const heldHost of ['limited.example', '[2606:4700:4700::1111]', '2606:4700:4700::1111']) {
    const f = fixture(t, [[heldHost, new Date(Date.now() + 60000).toISOString(), category]]), gate = createHostGate(0);
    for (const hold of loadAuditHostCooldowns(f.path)) gate.defer(hold.host, hold.until, hold.httpStatus);
    const targetHost = heldHost.includes(':') ? '[2606:4700:4700::1111]' : heldHost;
    requests = []; responses = [{ status: 302, headers: { location: `https://${targetHost}/feed` } }];
    const result = await auditEndpoint(endpoint('a', 'example.com'), gate);
    assert.deepEqual(requests, ['https://example.com/feed']);
    assert.equal(result.requestedHops, 1); assert.equal(result.httpStatus, 302);
    assert.equal(result.auditStatus, 'incomplete'); assert.equal(result.reason, 'REDIRECT_SERVER_RETRY_AFTER_WAIT');
    assert.equal(result.requestDeferred, undefined); assert.equal(result.serverDeferral.hostname, heldHost.replace(/^\[|\]$/g, ''));
    assert.equal(result.serverDeferral.httpStatus, category === 'rate_limited' ? 429 : null);
  }
});

test('an expired persisted wait does not prevent a real redirect fetch', async t => {
  const f = fixture(t, [['limited.example', new Date(Date.now() - 60000).toISOString(), 'rate_limited']]), gate = createHostGate(0);
  for (const hold of loadAuditHostCooldowns(f.path)) gate.defer(hold.host, hold.until, hold.httpStatus);
  requests = []; responses = [{ status: 302, headers: { location: 'https://limited.example/feed' } }, { status: 200, body: Buffer.from(rss) }];
  const result = await auditEndpoint(endpoint('a', 'example.com'), gate);
  assert.deepEqual(requests, ['https://example.com/feed', 'https://limited.example/feed']);
  assert.equal(result.auditStatus, 'working_nonempty'); assert.equal(result.requestedHops, 2);
});

test('a redirected 429 without Retry-After protects origin and destination for the whole audit across UTC midnight', async t => {
  let now = Date.UTC(2026, 9, 18, 23, 59, 59, 999);
  t.mock.method(Date, 'now', () => now);
  const limitedHosts = new Set(), gate = createAuditHostGate(limitedHosts, 0);
  requests = []; responses = [{ status: 302, headers: { location: 'https://limited.example/feed' } }, { status: 429 }];
  const first = await auditEndpoint(endpoint('a', 'origin.example'), gate);
  assert.equal(first.httpStatus, 429); assert.equal(first.retryAfterAt, null); assert.equal(first.retryAfterSource, null);
  observeAuditHostCooldowns(first, gate, limitedHosts);
  assert.deepEqual([...limitedHosts].sort(), ['limited.example', 'origin.example']);
  assert.equal(gate.deferred('limited.example').until, '2026-10-19T00:00:00.000Z');
  for (const [id, host] of [['b', 'other.example'], ['c', 'after-midnight.example']]) {
    if (id === 'c') now += 2;
    responses = [{ status: 302, headers: { location: 'https://limited.example/feed' } }];
    const result = await auditEndpoint(endpoint(id, host), gate);
    assert.equal(result.requestedHops, 1); assert.equal(result.httpStatus, 302);
    observeAuditHostCooldowns(result, gate, limitedHosts);
    assert.equal(result.auditStatus, 'incomplete'); assert.equal(result.reason, 'REDIRECT_HOST_RATE_LIMITED');
    assert.equal(result.serverDeferral, undefined); assert.equal(result.retryAfterAt, null); assert.equal(result.retryAfterSource, null);
  }
  assert.deepEqual(requests, ['https://origin.example/feed', 'https://limited.example/feed', 'https://other.example/feed', 'https://after-midnight.example/feed']);
  const before = requests.length, direct = await auditEndpoint(endpoint('d', 'limited.example'), gate);
  assert.ok(direct.requestDeferred); assert.equal(direct.requestedHops, 0); assert.equal(requests.length, before);
});

test('resuming an actual redirected 429 restores both host restrictions without inventing a Retry-After header', t => {
  const hosts = new Set(), gate = createAuditHostGate(hosts, 0);
  const observation = { url: 'https://origin.example/feed', finalUrl: 'https://limited.example/feed', httpStatus: 429, retryAfterAt: null, retryAfterSource: null };
  observeAuditHostCooldowns(observation, gate, hosts);
  assert.deepEqual([...hosts].sort(), ['limited.example', 'origin.example']);
  assert.equal(observation.retryAfterAt, null); assert.equal(observation.retryAfterSource, null);
});
