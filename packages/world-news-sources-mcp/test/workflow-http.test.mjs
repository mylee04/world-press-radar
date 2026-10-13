import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry } from '../dist/catalog.js';
import { ActivityStore } from '../dist/activity.js';
import { HealthStore } from '../dist/health.js';
import { createQualityHandler } from '../dist/quality-http.js';

const raw = { countries: [{ code: 'US', name: 'United States', feeds: [{ name: 'Publisher', url: 'https://publisher.example/rss' }] }] };
const catalog = normalizeRegistry(raw), proposalId = 'ae93cdb3-1ccc-4e60-b745-101f3907bcc7';
const approvalId = '66ce9b24-17d0-4d68-a697-0bca0fb5de9d';
const before = 'a'.repeat(64), proposalDigest = 'b'.repeat(64);
const source = catalog.sources[0];
function fixture(options = {}) {
  const calls = [];
  const repair = {
    list() { return { items: [], total: 0, registry_hash: before }; },
    get(id) { return id === proposalId ? { content: { proposal_id: id } } : null; },
    async discover(input) { calls.push({ operation: 'discover', input }); return { proposal: { content: { proposal_id: proposalId } } }; },
    approve(input, principal) { calls.push({ operation: 'approve', input, principal }); return { proposal: { state: 'approved' }, approval: { approval_id: approvalId } }; },
    apply(input, principal) { calls.push({ operation: 'apply', input, principal }); return { proposal: { state: 'applied' }, registry_reload_required: true, deployed: false }; },
    rollback(input, principal) { calls.push({ operation: 'rollback', input, principal }); return { proposal: { state: 'rolled_back' }, registry_reload_required: true, deployed: false }; },
    async verify(id) { calls.push({ operation: 'verify', id }); return { state: 'applied', recovery: { status: 'validation_passed_waiting_for_collector' } }; },
  };
  return { calls, handler: createQualityHandler(catalog, new HealthStore(), new ActivityStore(), raw, true, false,
    { repair, localOwner: true, ...options }) };
}
const request = (path, method = 'GET', body = undefined, headers = {}, origin = 'http://127.0.0.1:3400') => new Request(`${origin}/quality/api/${path}`,
  { method, headers: { ...(method === 'POST' ? { 'content-type': 'application/json', origin } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function adminCookie(handler) {
  const response = await handler(request('admin/session'));
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.authenticated, true);
  assert.ok(!('session_id' in body));
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/quality\/api\//);
  return cookie.split(';')[0];
}

test('admin session is loopback owner only and same-origin, with HttpOnly session bound to its port', async () => {
  const { handler } = fixture();
  assert.equal((await handler(request('admin/session', 'GET', undefined, {}, 'https://public.example'))).status, 403);
  assert.equal((await handler(request('admin/session', 'GET', undefined, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await handler(request('admin/session', 'GET', undefined, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  const cookie = await adminCookie(handler);
  const repeated = await handler(request('admin/session', 'GET', undefined, { cookie }));
  assert.equal(repeated.headers.get('set-cookie'), null);
  const otherPort = await handler(request('proposals', 'POST', {}, { cookie }, 'http://127.0.0.1:3401'));
  assert.equal(otherPort.status, 403);
  assert.equal((await fixture({ localOwner: false }).handler(request('admin/session'))).status, 403);
});

test('all publisher validation and registry mutations require server-authenticated cookie', async () => {
  const { handler, calls } = fixture();
  for (const path of ['proposals', `proposals/${proposalId}/approve`, `proposals/${proposalId}/apply`, `proposals/${proposalId}/verify`, `proposals/${proposalId}/rollback`]) {
    assert.equal((await handler(request(path, 'POST', {}))).status, 403);
    assert.equal((await handler(request(path, 'POST', {}, { cookie: 'wns_quality_admin=' + 'a'.repeat(43) }))).status, 403);
  }
  assert.equal(calls.length, 0);
  const cookie = await adminCookie(handler);
  assert.equal((await handler(request('proposals', 'POST', {}, { cookie, origin: 'https://evil.example' }))).status, 403);
  assert.equal(calls.length, 0);
});

test('approval and application bind URL proposal identity and server principal, rejecting injected identity', async () => {
  const { handler, calls } = fixture(), cookie = await adminCookie(handler);
  const consent = { proposal_digest: proposalDigest, expected_registry_hash: before };
  assert.equal((await handler(request(`proposals/${proposalId}/approve`, 'POST', consent, { cookie }))).status, 200);
  assert.equal(calls.at(-1).input.proposal_id, proposalId);
  assert.equal(calls.at(-1).principal.actor_id, 'local_owner');
  assert.match(calls.at(-1).principal.session_id, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(calls.at(-1).principal.session_id, cookie.split('=')[1], 'Audit principal must never expose the bearer cookie');
  assert.equal((await handler(request(`proposals/${proposalId}/approve`, 'POST', { ...consent, actor_id: 'spoofed' }, { cookie }))).status, 400);
  assert.equal((await handler(request(`proposals/${proposalId}/approve`, 'POST', { ...consent, proposal_id: proposalId }, { cookie }))).status, 400);
  const apply = await handler(request(`proposals/${proposalId}/apply`, 'POST', { approval_id: approvalId, expected_registry_hash: before }, { cookie }));
  assert.equal(apply.status, 200);
  const body = await apply.json(); assert.equal(body.deployed, false); assert.equal(body.registry_reload_required, true);
  assert.equal((await handler(request(`proposals/${proposalId}/verify`, 'POST', { instruction: 'force_recovered' }, { cookie }))).status, 400);
  const verify = await (await handler(request(`proposals/${proposalId}/verify`, 'POST', {}, { cookie }))).json();
  assert.equal(verify.proposal.recovery.status, 'validation_passed_waiting_for_collector');
});

test('hosted repair is unavailable and overview retains read-only collection plus explicit local repair scope', async () => {
  const hosted = fixture({ localOwner: false });
  assert.equal((await hosted.handler(request('proposals'))).status, 503);
  assert.equal((await hosted.handler(request(`proposals/${proposalId}/verify`, 'POST', {}))).status, 503);
  const local = fixture();
  const overview = await (await local.handler(request('overview'))).json();
  assert.equal(overview.runtime.sources_read_only, true);
  assert.equal(overview.runtime.repair_workflow.enabled, true);
  assert.equal(overview.runtime.repair_workflow.scope, 'local_registry');
  assert.equal(overview.runtime.repair_workflow.publisher_fetches, 'explicit_review_only');
  assert.equal((await local.handler(request(`proposals/${proposalId}`))).status, 200);
});

test('history is optional and decorates measured overview without inventing registry history', async () => {
  const observed = [], history = { observeOverview: payload => observed.push(payload), decorateOverview: payload => ({ ...payload, history: { observations_saved: observed.length } }) };
  const { handler } = fixture({ history });
  const overview = await (await handler(request('overview'))).json();
  assert.equal(overview.history.observations_saved, 1);
  assert.equal(observed[0].items[0].country, 'US');
  assert.equal(overview.items[0].metrics.freshness.value, null);
});

test('investigation list preserves real requests and paid starts require local admin session', async () => {
  const { handler } = fixture();
  assert.equal((await handler(request('investigations', 'POST', { country: 'US', engine: 'openai' }))).status, 403);
  const started = await (await handler(request('investigations', 'POST', { country: 'US', engine: 'rules' }))).json();
  assert.ok(started.id);
  const runs = await (await handler(request('investigations'))).json();
  assert.equal(runs.items[0].id, started.id);
});
