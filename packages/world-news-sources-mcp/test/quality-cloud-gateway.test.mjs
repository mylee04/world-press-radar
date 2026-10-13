import test from 'node:test';
import assert from 'node:assert/strict';
import { createQualityCloudGateway } from '../scripts/quality-cloud-gateway.mjs';
import { CloudQualityAccess } from '../dist/quality-cloud-auth.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = 'https://news.bymyleslee.com';
const secret = 'gateway-test-secret-'.padEnd(43, 'x');
const session = 's'.repeat(43);
const settings = { backendUrl: 'https://bymyleslee.com/_news-quality', gatewayToken: secret, publicOrigins: [origin] };
const request = (path, options = {}) => new Request(`${origin}/quality/api/${path}`, options);
const post = (body = '{}', extra = {}) => ({ method: 'POST', body, headers: { origin, 'content-type': 'application/json', ...extra } });

test('public reads use the fixed HTTPS backend prefix and server-only credential', async () => {
  let captured;
  const gateway = createQualityCloudGateway({ ...settings, fetchImpl: async (url, options) => {
    captured = { url: String(url), ...options }; return Response.json({ items: [{ country: 'US' }] });
  } });
  const response = await gateway(request('overview?date=2026-10-12', { headers: { 'x-wns-public-origin': 'https://attacker.example', 'x-wns-gateway-token': 'client-token', 'x-forwarded-host': 'attacker.example' } }));
  assert.equal(captured.url, 'https://bymyleslee.com/_news-quality/quality/api/overview?date=2026-10-12');
  assert.equal(captured.headers.get('x-wns-gateway-token'), secret);
  assert.equal(captured.headers.get('x-wns-public-origin'), origin);
  assert.equal(captured.headers.get('x-forwarded-host'), null);
  assert.equal(captured.redirect, 'error');
  assert.deepEqual(await response.json(), { items: [{ country: 'US' }] });
  assert.equal(response.headers.get('x-wns-gateway-token'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('invalid targets and missing deployment settings fail closed without making requests', async () => {
  for (const backendUrl of ['http://bymyleslee.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://name.local', 'https://user:pass@bymyleslee.com', 'https://bymyleslee.com/?next=https://attacker.example', 'https://bymyleslee.com/#fragment']) {
    const gateway = createQualityCloudGateway({ ...settings, backendUrl, fetchImpl: () => { throw Error('must not fetch'); } });
    assert.equal((await gateway(request('overview'))).status, 503);
  }
  assert.equal((await createQualityCloudGateway({ ...settings, gatewayToken: null })(request('overview'))).status, 503);
});

test('only documented API routes, methods, queries, and configured public origins are accepted', async () => {
  let calls = 0;
  const gateway = createQualityCloudGateway({ ...settings, fetchImpl: async () => { calls++; return Response.json({}); } });
  assert.equal(await gateway(new Request(`${origin}/quality/styles.css`)), null);
  assert.equal((await gateway(request('proxy?url=https://attacker.example'))).status, 404);
  assert.equal((await gateway(request('overview?url=https://attacker.example'))).status, 400);
  assert.equal((await gateway(request('overview', post()))).status, 405);
  assert.equal((await gateway(new Request('https://attacker.example/quality/api/overview'))).status, 403);
  assert.equal(calls, 0);
});

test('cross-origin mutations are denied before forwarding and anonymous runs remain denied', async () => {
  let calls = 0;
  const gateway = createQualityCloudGateway({ ...settings, fetchImpl: async () => { calls++; return Response.json({}); } });
  for (const extra of [{ origin: 'https://attacker.example' }, { origin: '', 'sec-fetch-site': 'cross-site' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await gateway(request('admin/session', post('{"password":"example"}', extra)))).status, 403);
  }
  assert.equal((await gateway(request('investigations', post('{"engine":"rules","country":"US"}')))).status, 403);
  assert.equal((await gateway(request('investigations', post('{"engine":"openai","country":"US"}')))).status, 403);
  assert.equal(calls, 0);
});

test('admin cookie is scoped and the backend still decides whether a session is valid', async () => {
  let captured;
  const gateway = createQualityCloudGateway({ ...settings, fetchImpl: async (url, options) => { captured = options; return Response.json({ error: 'WORKFLOW_AUTH_REQUIRED' }, { status: 403 }); } });
  const response = await gateway(request('investigations', post('{}', { cookie: `tracking=private; wns_quality_admin=${session}; other=secret` })));
  assert.equal(captured.headers.get('cookie'), `wns_quality_admin=${session}`);
  assert.equal(captured.headers.get('origin'), origin);
  assert.equal(response.status, 403);
  await gateway(request('investigations', { headers: { cookie: `wns_quality_admin=${session}`, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' } }));
  assert.equal(captured.headers.get('cookie'), null);
});

test('login cookie is host-only, HttpOnly, Secure, and bounded; unrelated cookies are not exposed', async () => {
  const gateway = createQualityCloudGateway({ ...settings, fetchImpl: async () => Response.json({ authenticated: true }, { headers: { 'set-cookie': `wns_quality_admin=${session}; Domain=bymyleslee.com; Path=/; Max-Age=28800`, 'x-backend-path': '/private/runtime' } }) });
  const response = await gateway(request('admin/session', post('{"password":"example"}')));
  const cookie = response.headers.get('set-cookie');
  assert.equal(cookie, `wns_quality_admin=${session}; HttpOnly; SameSite=Strict; Secure; Path=/quality/api/; Max-Age=28800`);
  assert.equal(response.headers.get('x-backend-path'), null);
  const publicResponse = await gateway(request('overview'));
  assert.equal(publicResponse.headers.get('set-cookie'), null);
});

test('a signed persistent cloud session is forwarded intact and logout clears it', async () => {
  const signed = `${Buffer.from(JSON.stringify({ origin, id: session, expires: 1791880000000 })).toString('base64url')}.${'h'.repeat(43)}`;
  let captured;
  const gateway = createQualityCloudGateway({ ...settings, fetchImpl: async (_, options) => {
    captured = options;
    return Response.json({ authenticated: options.method !== 'DELETE' }, { headers: { 'set-cookie': `wns_quality_admin=${options.method === 'DELETE' ? '' : signed}; HttpOnly; Secure; SameSite=Strict; Path=/quality/api/; Max-Age=${options.method === 'DELETE' ? 0 : 28800}` } });
  } });
  const login = await gateway(request('admin/session', post('{"password":"example"}')));
  assert.equal(login.headers.get('set-cookie').split(';')[0], `wns_quality_admin=${signed}`);
  await gateway(request('investigations', post('{}', { cookie: `wns_quality_admin=${signed}` })));
  assert.equal(captured.headers.get('cookie'), `wns_quality_admin=${signed}`);
  const logout = await gateway(request('admin/session', { method: 'DELETE', headers: { origin, cookie: `wns_quality_admin=${signed}` } }));
  assert.match(logout.headers.get('set-cookie'), /^wns_quality_admin=;.*Max-Age=0$/);
});

test('request body size and JSON content type are bounded before reaching the backend', async () => {
  let calls = 0;
  const gateway = createQualityCloudGateway({ ...settings, fetchImpl: async () => { calls++; return Response.json({}); } });
  assert.equal((await gateway(request('admin/session', post('x'.repeat(8193))))).status, 413);
  assert.equal((await gateway(request('admin/session', { method: 'POST', body: '{}', headers: { origin } }))).status, 400);
  assert.equal(calls, 0);
});

test('upstream failures, redirects, and non-JSON responses do not disclose private errors', async () => {
  for (const fetchImpl of [async () => { throw Error(`https://private.backend.example ${secret}`); }, async () => new Response('private server details'), async () => new Response('{broken', { headers: { 'content-type': 'application/json' } })]) {
    const response = await createQualityCloudGateway({ ...settings, fetchImpl })(request('overview'));
    const text = await response.text();
    assert.ok(response.status >= 500); assert.ok(!text.includes(secret)); assert.ok(!text.includes('private'));
  }
});

test('upstream deadline aborts the request and reports a safe timeout', async () => {
  const gateway = createQualityCloudGateway({ ...settings, timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('private timeout details')), { once: true })) });
  const response = await gateway(request('overview')); assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: 'QUALITY_CLOUD_TIMEOUT' });
});

test('the real cloud auth contract works through the gateway and remains valid after backend restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wns-gateway-auth-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const password = 'administrator-test-secret-'.padEnd(43, 'z');
  const gatewayFile = join(directory, 'gateway'), adminFile = join(directory, 'admin');
  writeFileSync(gatewayFile, secret, { mode: 0o600 }); writeFileSync(adminFile, password, { mode: 0o600 });
  const env = { WNS_QUALITY_GATEWAY_TOKEN_FILE: gatewayFile, WNS_QUALITY_ADMIN_TOKEN_FILE: adminFile, WNS_QUALITY_PUBLIC_ORIGINS: origin };
  let access = new CloudQualityAccess(env);
  const gateway = createQualityCloudGateway({ ...settings, fetchImpl: async (url, options) => {
    const internal = new URL(url); internal.pathname = internal.pathname.replace(/^\/_news-quality/, ''); // Existing TLS proxy strips the prefix.
    const forwarded = new Request(internal, options), publicUrl = access.publicUrl(forwarded);
    if (publicUrl.pathname === '/quality/api/admin/session') return access.sessionResponse(forwarded, publicUrl);
    return access.authenticate(forwarded, publicUrl) ? Response.json({ status: 'queued' }, { status: 202 }) : Response.json({ error: 'QUALITY_ADMIN_AUTH_REQUIRED' }, { status: 403 });
  } });
  const login = await gateway(request('admin/session', post(JSON.stringify({ password }))));
  assert.equal(login.status, 200); assert.equal((await login.json()).authenticated, true);
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie?.includes('.'));
  assert.equal((await gateway(request('investigations', post('{}', { cookie })))).status, 202);
  assert.equal((await gateway(request('investigations', post('{}', { authorization: `Bearer ${password}` })))).status, 202);
  access = new CloudQualityAccess(env);
  assert.equal((await gateway(request('admin/session', { headers: { cookie } }))).status, 200);
  assert.equal((await gateway(request('investigations', post('{}', { cookie })))).status, 202);
  const bad = await gateway(request('investigations', post('{}', { cookie: `wns_quality_admin=${session}` })));
  assert.equal(bad.status, 403);
});
