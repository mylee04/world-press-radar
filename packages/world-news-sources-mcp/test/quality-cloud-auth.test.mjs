import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CloudQualityAccess, publicInvestigation } from '../dist/quality-cloud-auth.js';
import { createQualityHandler } from '../dist/quality-http.js';
import { createCloudQualityRuntime } from '../dist/quality-local-runtime.js';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { ActivityStore } from '../dist/activity.js';
import { QualityRunStore } from '../dist/quality-runtime-storage.js';
import { CloudQualityDataCache } from '../dist/quality-cloud-data.js';

const origin = 'https://news.example.com', gateway = 'g'.repeat(43), password = 'p'.repeat(43);
function fixture(t, admin = true, now) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-cloud-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gatewayPath = join(dir, 'gateway'), adminPath = join(dir, 'admin');
  writeFileSync(gatewayPath, `${gateway}\n`, { mode: 0o600 });
  if (admin) writeFileSync(adminPath, `${password}\n`, { mode: 0o600 });
  const env = { WNS_QUALITY_PUBLIC_ORIGINS: origin, WNS_QUALITY_GATEWAY_TOKEN_FILE: gatewayPath,
    ...(admin ? { WNS_QUALITY_ADMIN_TOKEN_FILE: adminPath } : {}), WNS_QUALITY_STATE_DIR: join(dir, 'state') };
  return { dir, env, access: new CloudQualityAccess(env, now) };
}
function request(path = '/overview', options = {}) {
  return new Request(`http://127.0.0.1:3401/quality/api${path}`, { ...options,
    headers: { 'x-wns-gateway-token': gateway, 'x-wns-public-origin': origin, ...options.headers } });
}
const raw = { countries: [{ code: 'US', name: 'United States', feeds: [{ name: 'Example', url: 'https://example.com/feed' }] }] };
const catalog = normalizeRegistry(raw);
const run = { id: '4990ed99-2531-47e1-afd9-9e0cc94d6e75', request_id: '7f3c9963-9761-4074-bf82-317cb8af52c0', country: 'US', date: '2026-10-12',
  status: 'completed', started_at: '2026-10-13T00:00:00.000Z', finished_at: '2026-10-13T00:01:00.000Z',
  events: [{ type: 'tool_completed', status: 'completed', tool: 'get_source_collection_quality', result: { count: 0,
    authorization: 'Bearer secretfixture', error: 'failed /home/opc/.private/key.env', stack: 'private stack', api_key: 'sk-fakefixture0000000000' } }],
  findings: [], summary: 'stored evidence', mode: 'rules_only_cached_mcp', tool_calls: 1, truncated: false,
  limit_reached: false, inspected_sources: 1, available_sources: 1, cost: { provider: 'rules', model_calls: 0, model_cost_usd: 0, server_cost_usd: null },
  limits: { max_tool_calls: 48, max_sources: 12, max_duration_ms: 45000 } };

test('cloud requires exact HTTPS origins and two separate private credential files', t => {
  const { env } = fixture(t);
  assert.throws(() => new CloudQualityAccess({ ...env, WNS_QUALITY_PUBLIC_ORIGINS: 'http://news.example.com' }), /QUALITY_PUBLIC_ORIGIN_INVALID/);
  assert.throws(() => new CloudQualityAccess({ ...env, WNS_QUALITY_PUBLIC_ORIGINS: `${origin}/quality` }), /QUALITY_PUBLIC_ORIGIN_INVALID/);
  assert.throws(() => new CloudQualityAccess({ ...env, WNS_QUALITY_GATEWAY_TOKEN_FILE: undefined }), /QUALITY_GATEWAY_CREDENTIAL_REQUIRED/);
  assert.throws(() => new CloudQualityAccess({ ...env, WNS_QUALITY_ADMIN_TOKEN_FILE: env.WNS_QUALITY_GATEWAY_TOKEN_FILE }), /QUALITY_CLOUD_CREDENTIALS_MUST_DIFFER/);
  chmodSync(env.WNS_QUALITY_ADMIN_TOKEN_FILE, 0o644);
  assert.throws(() => new CloudQualityAccess(env), /QUALITY_CLOUD_CREDENTIAL_UNAVAILABLE/);
});

test('proxy authentication never grants admin and forwarded origin is trusted only after gateway verification', t => {
  const { access } = fixture(t);
  assert.equal(access.publicUrl(request()).origin, origin);
  assert.equal(access.authenticate(request(), access.publicUrl(request())), null);
  assert.throws(() => access.publicUrl(request('/overview', { headers: { 'x-wns-gateway-token': '' } })), /QUALITY_GATEWAY_AUTH_REQUIRED/);
  assert.throws(() => access.publicUrl(request('/overview', { headers: { 'x-wns-public-origin': 'https://evil.example' } })), /QUALITY_PUBLIC_ORIGIN_INVALID/);
});

test('admin session uses HTTPS HttpOnly cookies, survives runtime replacement, expires, and forbids cross-origin requests', async t => {
  let clock = Date.now();
  const { access, env } = fixture(t, true, () => clock);
  const login = request('/admin/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const response = await access.sessionResponse(login, access.publicUrl(login));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, true);
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly; Secure; SameSite=Strict; Path=\/quality\/api\/; Max-Age=28800/);
  assert.ok(!header.includes(password));
  const cookie = header.split(';')[0];
  const current = request('/overview', { headers: { cookie } });
  const principal = access.authenticate(current, access.publicUrl(current));
  assert.equal(principal.actor_id, 'cloud_admin');
  assert.match(principal.session_id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new CloudQualityAccess(env, () => clock).authenticate(current, access.publicUrl(current)).session_id, principal.session_id);
  const crossOrigin = request('/overview', { headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(access.authenticate(crossOrigin, access.publicUrl(crossOrigin)), null);
  const forged = request('/overview', { headers: { cookie: `${cookie.slice(0, -1)}X` } });
  assert.equal(access.authenticate(forged, access.publicUrl(forged)), null);
  clock += 8 * 3600000 + 1;
  assert.equal(access.authenticate(current, access.publicUrl(current)), null);
});

test('public reads work with no model credentials but every run or proposal access requires admin before execution', async t => {
  const { access, dir } = fixture(t);
  const store = new QualityRunStore(join(dir, 'runs.sqlite')); t.after(() => store.close());
  store.save(run); store.save({ ...run, id: '4990ed99-2531-47e1-afd9-9e0cc94d6e76', request_id: undefined, status: 'running' });
  const handler = createQualityHandler(catalog, new HealthStore(), new ActivityStore(), raw, true, false,
    { cloudAccess: access, investigations: { store } });
  const overview = await (await handler(request('/overview'))).json();
  assert.equal(overview.runtime.admin_auth_required, true);
  assert.equal(overview.runtime.investigations_enabled, false);
  assert.deepEqual(overview.runtime.openai, { available: false, reason: 'administrator_access_required' });
  const listed = await (await handler(request('/investigations'))).json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, run.id);
  assert.equal(listed.items[0].request_id, undefined);
  assert.equal(listed.items[0].events[0].result.count, 0);
  assert.ok(!JSON.stringify(listed).includes('/home/opc'));
  assert.ok(!JSON.stringify(listed).includes('private stack'));
  assert.ok(!JSON.stringify(listed).includes('sk-fakefixture'));
  for (const engine of ['rules', 'openai', 'jev']) {
    const denied = await handler(request('/investigations', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ country: 'US', engine }) }));
    assert.equal(denied.status, 403);
  }
  assert.equal(store.list().length, 2);
  assert.equal((await handler(request('/proposals'))).status, 403);
  assert.equal((await handler(request(`/investigations/requests/${run.request_id}`))).status, 403);
  assert.equal((await handler(request('/overview', { headers: { 'x-wns-gateway-token': 'bad' } }))).status, 403);
  assert.equal((await handler(request('/admin/session'))).status, 200);
  assert.equal((await (await handler(request('/admin/session'))).json()).authenticated, false);
});

test('cloud reads default to the preceding UTC date while explicit dates and local latest-snapshot defaults remain intact', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-13T00:30:00.000Z'));
  const { access } = fixture(t);
  const activity = new ActivityStore({ version: 1, lane: 'production', generated_at: '2026-10-13T00:20:00.000Z',
    tracking_start: null, available_since: '2026-10-01T00:00:00.000Z', registry_at: null, semantics: 'Fixture counts', bindings: [], collections: [] });
  const cloud = createQualityHandler(catalog, new HealthStore(), activity, raw, true, false, { cloudAccess: access });
  const local = createQualityHandler(catalog, new HealthStore(), activity, raw, true);
  for (const route of ['/overview', '/country?country=US', `/source?source_id=${catalog.sources[0].id}`]) {
    assert.equal((await (await cloud(request(route))).json()).date, '2026-10-12');
    const separator = route.includes('?') ? '&' : '?';
    assert.equal((await (await cloud(request(`${route}${separator}date=2026-10-11`))).json()).date, '2026-10-11');
    assert.equal((await (await local(new Request(`http://127.0.0.1:3400/quality/api${route}`))).json()).date, '2026-10-13');
  }
});

test('cloud durable state requires an absolute private directory and remains usable without paid providers', async t => {
  const { env } = fixture(t, false);
  assert.throws(() => createCloudQualityRuntime({ ...env, WNS_QUALITY_STATE_DIR: 'relative' }), /QUALITY_CLOUD_STATE_DIRECTORY_REQUIRED/);
  const runtime = createCloudQualityRuntime(env);
  assert.equal(runtime.options.localOwner, false);
  assert.equal(runtime.options.repair, undefined);
  assert.equal(runtime.options.investigations.policy.authorized, false);
  runtime.store.save(run);
  await runtime.close();
  const restored = createCloudQualityRuntime(env);
  assert.equal(restored.store.get(run.id).summary, run.summary);
  await restored.close();
});

test('an explicitly approved current-release root alias is resolved once while nested symlinks stay forbidden', async t => {
  const { env, dir } = fixture(t);
  const physicalRoot = join(dir, 'owned-release'), alias = join(dir, 'current');
  mkdirSync(join(physicalRoot, 'data'), { recursive: true });
  writeFileSync(join(physicalRoot, 'data/registry.json'), JSON.stringify(raw));
  symlinkSync(physicalRoot, alias, 'dir');
  const runtime = createCloudQualityRuntime({ ...env, WNS_QUALITY_REPAIR_ENABLED: '1', WNS_QUALITY_REGISTRY_ROOT: alias,
    WNS_REGISTRY_PATH: join(alias, 'data/registry.json') });
  assert.ok(runtime.options.repair);
  assert.match(runtime.options.repair.registryHash(), /^[a-f0-9]{64}$/);
  await runtime.close();
  const outside = join(dir, 'unapproved'); mkdirSync(outside);
  writeFileSync(join(outside, 'registry.json'), JSON.stringify(raw));
  symlinkSync(outside, join(physicalRoot, 'nested'), 'dir');
  assert.throws(() => createCloudQualityRuntime({ ...env, WNS_QUALITY_STATE_DIR: join(dir, 'blocked-state'),
    WNS_QUALITY_REPAIR_ENABLED: '1', WNS_QUALITY_REGISTRY_ROOT: alias, WNS_REGISTRY_PATH: join(alias, 'nested/registry.json') }),
  /WORKFLOW_SYMLINK_NOT_ALLOWED/);
  const recovered = createCloudQualityRuntime({ ...env, WNS_QUALITY_STATE_DIR: join(dir, 'blocked-state') });
  assert.equal(recovered.options.repair, undefined);
  await recovered.close();
  assert.throws(() => createCloudQualityRuntime({ ...env, WNS_QUALITY_STATE_DIR: join(dir, 'blocked-outside-state'),
    WNS_QUALITY_REPAIR_ENABLED: '1', WNS_QUALITY_REGISTRY_ROOT: alias, WNS_REGISTRY_PATH: join(outside, 'registry.json') }),
  /QUALITY_CLOUD_REPAIR_ROOT_REQUIRED/);
  const readonly = createCloudQualityRuntime({ ...env, WNS_REGISTRY_PATH: join(outside, 'registry.json') });
  assert.equal(readonly.options.repair, undefined);
  await readonly.close();
});

test('a real authenticated administrator can start a bounded rules run and read its durable evidence', async t => {
  const { access, dir } = fixture(t);
  const store = new QualityRunStore(join(dir, 'runs.sqlite')); t.after(() => store.close());
  const handler = createQualityHandler(catalog, new HealthStore(), new ActivityStore(), raw, true, false,
    { cloudAccess: access, investigations: { store } });
  const login = request('/admin/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = (await handler(login)).headers.get('set-cookie').split(';')[0];
  const accepted = await handler(request('/investigations', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ country: 'US', date: '2026-10-12', engine: 'rules' }) }));
  assert.equal(accepted.status, 202);
  const started = await accepted.json();
  assert.equal(started.status, 'running');
  const until = Date.now() + 5000;
  while (store.get(started.id)?.status === 'running' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.get(started.id).status, 'completed');
  assert.ok(store.get(started.id).events.some(event => event.tool && event.status === 'completed'));
  const overview = await (await handler(request('/overview', { headers: { cookie } }))).json();
  assert.equal(overview.runtime.investigations_enabled, true);
  assert.equal(overview.runtime.model_api_configured, false);
  assert.equal((await handler(request(`/investigations/${started.id}`))).status, 200);
});

test('metadata refresh waits for active investigations and keeps last valid snapshot on malformed publication', t => {
  const { dir } = fixture(t);
  const path = join(dir, 'snapshot.json'); writeFileSync(path, '{"count":1}');
  let clock = 1000, busy = false;
  const cache = new CloudQualityDataCache([path], () => JSON.parse(readFileSync(path, 'utf8')), () => busy, () => clock, 100);
  assert.equal(cache.get().count, 1);
  busy = true; writeFileSync(path, '{"count":22}'); clock += 200;
  assert.equal(cache.get().count, 1);
  busy = false;
  assert.equal(cache.get().count, 22);
  writeFileSync(path, 'malformed'); clock += 200;
  assert.equal(cache.get().count, 22);
  assert.equal(cache.reloadFailed(), true);
  writeFileSync(path, '{"count":333}'); clock += 200;
  assert.equal(cache.get().count, 333);
  assert.equal(cache.reloadFailed(), false);
});

test('public investigation sanitization preserves real counts and bounds unsafe stored strings', () => {
  const safe = publicInvestigation({ ...run, summary: 'Bearer test-secret-abcdef /Users/name/project/private.key sk-faketoken000000000000' });
  assert.equal(safe.events[0].result.count, 0);
  assert.ok(!safe.summary.includes('test-secret'));
  assert.ok(!safe.summary.includes('/Users/'));
  assert.ok(!safe.summary.includes('sk-fake'));
});
