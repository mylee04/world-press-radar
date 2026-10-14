import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { koreanUiContext } from './dashboard-test-runtime.mjs';

const app = readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
const code = app.slice(app.indexOf('function canRunInvestigation()'), app.indexOf('function renderEngineStatus()'));
function access(runtime, { authenticated = false, status } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, open: false, textContent: '', querySelector: () => ({ textContent: '' }) });
    return elements.get(id);
  };
  const context = koreanUiContext({ state: { overview: { runtime }, adminSession: { authenticated }, run: status ? { status } : null }, $: element });
  vm.runInContext(`${code}\nrenderExecutionAccess(); this.allowed=canRunInvestigation();`, context);
  return { elements, allowed: context.allowed };
}
test('public cloud users can view records while all run controls remain unavailable', () => {
  const { elements, allowed } = access({ admin_auth_required: true, admin_login_enabled: true, investigations_enabled: false });
  assert.equal(allowed, false);
  assert.equal(elements.get('investigation-form').hidden, true);
  assert.equal(elements.get('investigate-selected').hidden, true);
  assert.equal(elements.get('start-investigation').disabled, true);
  assert.equal(elements.get('admin-access').hidden, false);
  assert.equal(elements.get('run-history').open, true);
});
test('cloud mutation controls require an authenticated session even if runtime is stale', () => {
  assert.equal(access({ admin_auth_required: true, admin_login_enabled: true, investigations_enabled: true }).allowed, false);
  const { elements, allowed } = access({ admin_auth_required: true, admin_login_enabled: true, investigations_enabled: true }, { authenticated: true });
  assert.equal(allowed, true);
  assert.equal(elements.get('investigation-form').hidden, false);
  assert.equal(elements.get('admin-access').textContent, '로그아웃');
  assert.equal(elements.get('start-investigation').disabled, false);
});
test('authenticated running or queued investigations cannot be submitted twice', () => {
  for (const status of ['running', 'queued']) {
    const { elements } = access({ admin_auth_required: true, investigations_enabled: true }, { authenticated: true, status });
    assert.equal(elements.get('start-investigation').disabled, true);
  }
});
test('existing local owner workflow does not show a cloud login or hide local rules controls', () => {
  const { elements, allowed } = access({ investigations_enabled: true });
  assert.equal(allowed, true); assert.equal(elements.get('admin-access').hidden, true);
  assert.equal(elements.get('investigation-form').hidden, false);
});
