import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { ActivityStore } from '../dist/activity.js';
import { InvestigationStore } from '../dist/investigation.js';
import { QualityRunStore, PersistentModelBudget } from '../dist/quality-runtime-storage.js';
import { JevClient } from '../dist/jev-runtime.js';
import { qualityChoiceQuestions } from '../dist/jev-investigation.js';

const catalog = normalizeRegistry({ countries: [{ code: 'US', name: 'US', feeds: [{ name: 'Fixture Zero', url: 'https://zero.fixture.example/feed' }] }] });
const source = catalog.sources[0], ep = source.endpoints[0];
function activity() { return new ActivityStore({ version: 1, lane: 'production', generated_at: '2026-10-13T02:00:00.000Z',
  registry_at: '2026-10-13T01:00:00.000Z', tracking_start: '2026-10-01T00:00:00.000Z', available_since: '2026-10-01T00:00:00.000Z',
  semantics: 'Synthetic first-discovered URL fixture',
  scope_starts: { source: { [source.id]: '2026-10-01T00:00:00.000Z' }, country: { US: '2026-10-01T00:00:00.000Z' } },
  scope_latest: { source: { [source.id]: '2026-10-13T01:00:00.000Z' }, country: { US: '2026-10-13T01:00:00.000Z' } },
  bindings: [{ source_id: source.id, endpoint_id: ep.id, baseline_at: '2026-10-01T00:00:00.000Z' }],
  collections: ['2026-10-11', '2026-10-12', '2026-10-13'].map(date => ({ endpoint_id: ep.id,
    checked_at: `${date}T01:00:00.000Z`, status: 'working_nonempty', format: 'rss', source_ids: [source.id],
    countries: ['US'], source_new: { [source.id]: 0 }, country_new: { US: 0 }, baseline_sources: [], uncertain_urls: 0 })) }); }
async function finished(run) {
  const end = Date.now() + 5000;
  while (run.status === 'running' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(run.status, 'completed', run.summary);
  return run;
}
function durable(t) {
  const dir = mkdtempSync(join(tmpdir(), 'investigation-durable-'));
  const path = join(dir, 'runtime.sqlite'), storage = new QualityRunStore(path), budget = new PersistentModelBudget(path, 1, 'fixture');
  t.after(() => { storage.close(); budget.close(); rmSync(dir, { recursive: true, force: true }); });
  return { storage, budget };
}
test('Actual MCP run events and final findings persist and request IDs recover without duplicate execution', async t => {
  const { storage, budget } = durable(t);
  const store = new InvestigationStore(catalog, new HealthStore(), activity(), false, { store: storage, budget });
  const requestId = randomUUID(), run = store.start({ country: 'US', date: '2026-10-12', request_id: requestId });
  assert.equal(storage.get(run.id).status, 'running');
  await finished(run);
  const saved = storage.get(run.id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.finished_at, run.finished_at);
  assert.equal(saved.tool_calls, saved.events.filter(event => event.tool).length);
  assert.ok(saved.events.filter(event => event.tool).every(event => event.status === 'completed' && event.result && event.duration_ms >= 0));
  assert.equal(saved.findings[0].classification, 'successful_no_new_discoveries');
  const restarted = new InvestigationStore(catalog, new HealthStore(), activity(), false, { store: storage, budget });
  assert.equal(restarted.get(run.id).id, run.id); assert.equal(restarted.getByRequestId(requestId).id, run.id);
  const same = restarted.start({ country: 'US', date: '2026-10-12', request_id: requestId });
  assert.equal(same.id, run.id); assert.equal(same.events.length, run.events.length); assert.equal(restarted.runs.size, 0);
  assert.equal(restarted.list().length, 1);
  assert.throws(() => restarted.start({ country: 'US', date: '2026-10-11', request_id: requestId }), /REQUEST_ID_CONFLICT/);
});
test('Durable runs remain retrievable beyond memory retention and startup reconciliation is explicit', async t => {
  const { storage, budget } = durable(t), store = new InvestigationStore(catalog, new HealthStore(), activity(), false, { store: storage, budget });
  const run = await finished(store.start({ country: 'US', date: '2026-10-12' }));
  run.started_at = new Date(Date.now() - 7200000).toISOString(); storage.save(run);
  assert.equal(store.get(run.id).id, run.id); assert.equal(store.runs.has(run.id), false);
  const pending = { ...run, id: randomUUID(), started_at: new Date().toISOString(), status: 'running', finished_at: null, request_id: randomUUID() };
  storage.save(pending);
  const restarted = new InvestigationStore(catalog, new HealthStore(), activity(), false, { store: storage, budget });
  assert.equal(restarted.get(pending.id).status, 'running');
  assert.equal(storage.reconcileInterrupted(), 1); assert.equal(restarted.get(pending.id).status, 'failed');
  assert.match(restarted.get(pending.id).summary, /재시작/); assert.equal(restarted.runs.size, 0);
});
test('Jev investigation uses actual MCP reads, logs fixture provider usage, and preserves code zero classification', async t => {
  const { storage, budget } = durable(t); let requests = 0, passedBudget;
  const policy = { authorized: true, model: 'jev-1.13.0', keyFile: null, totalBudgetUsd: 1, perRunBudgetUsd: .1,
    inputUsdPerMillion: .042, maxModelCalls: 12, maxInputBytes: 24000, timeoutMs: 1000 };
  const answer = (question, choice) => ({ type: 'choice', choice, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) });
  const store = new InvestigationStore(catalog, new HealthStore(), activity(), false, { store: storage, budget, jevPolicy: policy,
    createJevClient: shared => { passedBudget = shared; return new JevClient(policy, 'DUMMY_FIXTURE_NEVER_SENT', shared, async () => {
      requests++; return new Response(JSON.stringify({ model: policy.model, answers: {
        classification: answer(qualityChoiceQuestions.classification, 'successful_collection'),
        confirmation: answer(qualityChoiceQuestions.confirmation, 'no') }, usage: { input_tokens: 500, output_tokens: 40 } }), { status: 200 });
    }); } });
  const run = await finished(store.start({ country: 'US', date: '2026-10-12', engine: 'jev' }));
  assert.equal(run.mode, 'jev_cached_mcp'); assert.equal(passedBudget, budget); assert.equal(requests, 1);
  assert.equal(run.findings[0].classification, 'successful_no_new_discoveries');
  assert.equal(run.model_assessment.decisions[0].classification, 'successful_collection');
  assert.equal(run.model_assessment.decisions[0].requires_review, true);
  assert.equal(run.cost.model_calls, 1); assert.equal(run.cost.model_cost_usd, null); assert.equal(run.cost.billing_cost_usd, null);
  assert.equal(run.cost.input_tokens, 500); assert.equal(run.cost.output_tokens, 40);
  assert.ok(run.cost.estimated_model_cost_usd > 0); assert.equal(run.events.filter(event => event.type === 'model_completed').length, 1);
  assert.ok(run.events.some(event => event.tool === 'get_source_collection_quality' && event.status === 'completed'));
  assert.equal(storage.get(run.id).model_assessment.kind, 'structured_evidence_classifier');
  assert.equal(storage.get(run.id).cost.model_calls, 1); assert.ok(!JSON.stringify(run).includes('DUMMY_FIXTURE_NEVER_SENT'));
});
test('Jev stays locked before starting or persisting a run when credentials/budget are unavailable', t => {
  const { storage, budget } = durable(t), store = new InvestigationStore(catalog, new HealthStore(), activity(), false, { store: storage, budget });
  assert.equal(store.jevReadiness().available, false);
  assert.throws(() => store.start({ country: 'US', date: '2026-10-12', engine: 'jev' }), /JEV_EXECUTION_NOT_AUTHORIZED/);
  assert.equal(storage.list().length, 0); assert.equal(store.runs.size, 0);
});
test('A failed durable start stops before model construction or any MCP/model execution', () => {
  let constructed = 0;
  const store = new InvestigationStore(catalog, new HealthStore(), activity(), false, {
    createJevClient: () => { constructed++; throw Error('must not run'); },
    store: { save() { throw Error('private disk error'); }, list() { return []; }, get() {}, getByRequestId() {} } });
  assert.throws(() => store.start({ country: 'US', date: '2026-10-12', engine: 'jev' }), /QUALITY_RUN_PERSISTENCE_FAILED/);
  assert.equal(constructed, 0); assert.equal(store.runs.size, 0);
});
