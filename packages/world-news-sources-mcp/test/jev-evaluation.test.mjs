import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Usage } from '@openai/agents';
import { JevClient, JevSessionBudget, JEV_API_URL, jevPolicy, jevReadiness, readJevKey } from '../dist/jev-runtime.js';
import { classifyWithJev, qualityChoiceQuestions, runJevInvestigation } from '../dist/jev-investigation.js';
import { OpenAIQualityEvaluator } from '../dist/openai-quality-evaluation.js';
import { OpenAISessionBudget } from '../dist/openai-runtime.js';
import { PersistentModelBudget } from '../dist/quality-runtime-storage.js';
import { fixedCaseModelEvidence, compareQualityProviders, loadQualityCases } from '../scripts/evaluate-quality.mjs';

const policy = { authorized: true, model: 'jev-1.13.0', keyFile: null, totalBudgetUsd: 1, perRunBudgetUsd: .1,
  inputUsdPerMillion: .042, maxModelCalls: 12, maxInputBytes: 24000, timeoutMs: 1000 };
const answer = (question, choice) => ({ type: 'choice', choice, confidence: 1,
  probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) });
const body = (classification = 'successful_no_new_discoveries') => ({ model: 'jev-1.13.0',
  answers: { classification: answer(qualityChoiceQuestions.classification, classification),
    confirmation: answer(qualityChoiceQuestions.confirmation, 'no') }, usage: { input_tokens: 400, output_tokens: 20 } });
function fixture(result = body(), overrides = {}) {
  const requests = [], events = [], budget = new JevSessionBudget(1);
  const client = new JevClient({ ...policy, ...overrides }, 'DUMMY_FIXTURE_NEVER_SENT', budget, async (url, request) => {
    requests.push({ url, request }); return new Response(JSON.stringify(result), { status: 200 });
  });
  return { client, requests, events, budget, options: { onModel: event => events.push(event) } };
}
test('Jev posts the documented typed-question contract and reports usage as an estimate, not billing', async () => {
  const f = fixture(), result = await classifyWithJev(f.client, { selected_date: '2026-10-12', collection: 'success', discoveries: 0 }, f.options);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, JEV_API_URL);
  assert.equal(f.requests[0].request.method, 'POST'); assert.equal(f.requests[0].request.redirect, 'error');
  const posted = JSON.parse(f.requests[0].request.body);
  assert.equal(posted.model, policy.model); assert.deepEqual(Object.keys(posted.questions), ['classification', 'confirmation']);
  assert.equal(posted.questions.classification.type, 'choice'); assert.ok(posted.questions.classification.criteria.failure_after_prior_success);
  assert.equal(result.decision.classification, 'successful_no_new_discoveries'); assert.equal(result.decision.requires_live_confirmation, false);
  assert.equal(result.estimated_cost_usd, 400 * .042 / 1e6); assert.equal(result.billing_cost_usd, null);
  assert.equal(result.usage.output_tokens, 20); assert.equal(f.events.at(-1).type, 'model_completed');
  assert.equal(f.events.at(-1).usage.cached_input_tokens, null);
  assert.ok(!JSON.stringify(f.events).includes('DUMMY_FIXTURE_NEVER_SENT'));
});
test('Jev context/dollar/model-call limits stop before another paid request', async () => {
  for (const overrides of [{ maxInputBytes: 10 }, { perRunBudgetUsd: 1e-12 }, { maxModelCalls: 0 }]) {
    const f = fixture(body(), overrides);
    await assert.rejects(classifyWithJev(f.client, {}, f.options), /JEV_CONTEXT_LIMIT|JEV_RUN_BUDGET_LIMIT|JEV_MODEL_CALL_LIMIT/);
    assert.equal(f.requests.length, 0); assert.equal(f.events.length, 0);
  }
});
test('Jev rejects missing usage, mismatched priced models and invalid probability contracts', async () => {
  const invalid = [ { ...body(), usage: undefined }, { ...body(), model: 'jev-latest' },
    { ...body(), answers: { ...body().answers, classification: { ...body().answers.classification,
      probabilities: { ...body().answers.classification.probabilities, successful_collection: .5 } } } } ];
  for (const result of invalid) {
    const f = fixture(result);
    await assert.rejects(classifyWithJev(f.client, {}, f.options), /JEV_RESPONSE_INVALID_OR_USAGE_MISSING|JEV_PRICED_MODEL_MISMATCH|JEV_PROBABILITY_CONTRACT_INVALID/);
    assert.equal(f.events.at(-1).status, 'failed'); assert.ok(f.budget.summary().estimated_or_reserved_usd > 0);
  }
});
test('Jev accepts the observed two-decimal rounding without normalizing or inventing probabilities', async () => {
  const returned = body('failure_after_prior_success');
  returned.answers.classification.confidence = .92;
  returned.answers.classification.probabilities = Object.fromEntries(Object.keys(qualityChoiceQuestions.classification.criteria)
    .map(key => [key, ({failure_after_prior_success:.93,not_attempted_in_period:.01,untracked_or_no_available_checks:.03,insufficient_evidence:.02})[key] ?? 0]));
  const f = fixture(returned), result = await classifyWithJev(f.client, {}, f.options);
  assert.equal(result.decision.classification, 'failure_after_prior_success');
  assert.ok(Math.abs(Object.values(result.probabilities).reduce((sum,value)=>sum+value,0)-.99)<1e-12);
  assert.deepEqual(result.probabilities, returned.answers.classification.probabilities);
  assert.equal(f.events.at(-1).type, 'model_completed');
});
test('Jev failure is sanitized, never retried, and unknown usage retains a conservative reservation', async () => {
  const events = [], budget = new JevSessionBudget(1); let requests = 0;
  const client = new JevClient(policy, 'DUMMY_FIXTURE_NEVER_SENT', budget, async () => {
    requests++; return new Response('private reasoning and DUMMY_FIXTURE_NEVER_SENT', { status: 429 });
  });
  await assert.rejects(classifyWithJev(client, {}, { onModel: event => events.push(event) }), /JEV_MODEL_REQUEST_FAILED/);
  assert.equal(requests, 1); assert.equal(events.at(-1).http_status, 429); assert.equal(events.at(-1).estimated_cost_usd, null);
  assert.ok(budget.summary().estimated_or_reserved_usd > 0); assert.ok(!JSON.stringify(events).includes('DUMMY_FIXTURE_NEVER_SENT'));
});
test('Both providers can reserve from one shared approval budget', () => {
  const shared = new OpenAISessionBudget(.01), reservation = shared.reserve(.008);
  const jev = new JevClient(policy, 'DUMMY_FIXTURE_NEVER_SENT', shared, async () => { throw Error('never'); });
  assert.equal(jev.budget, shared); assert.throws(() => jev.budget.reserve(.008), /SESSION_BUDGET_LIMIT/);
  shared.settle(reservation, .002); assert.equal(shared.summary().remaining_usd, .008);
});
test('Provider comparison reservations survive restart and cannot create a second pilot allowance', t => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-shared-pilot-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'budget.sqlite'), original = new PersistentModelBudget(path, .01, 'fixture-pilot');
  original.reserve(.009); original.close();
  const restarted = new PersistentModelBudget(path, .01, 'fixture-pilot');
  try {
    assert.ok(restarted.summary().remaining_usd < .0011);
    assert.throws(() => restarted.reserve(.009), /SESSION_BUDGET_LIMIT/);
    assert.throws(() => new PersistentModelBudget(path, .02, 'fixture-pilot'), /APPROVED_BUDGET_MISMATCH/);
  } finally { restarted.close(); }
});
test('Jev credential reuse is literal, gated and read-only; placeholders and symlinks are rejected', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-key-fixture-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, '.env.fixture'), text = 'TYPESAFE_API_KEY="DUMMY_FIXTURE_NEVER_SENT"\nUNRELATED=keep\n';
  writeFileSync(path, text); const configured = { ...policy, keyFile: path };
  assert.equal(jevReadiness(configured, {}).available, true); assert.equal(readJevKey(configured, {}), 'DUMMY_FIXTURE_NEVER_SENT');
  assert.equal(readFileSync(path, 'utf8'), text);
  assert.throws(() => readJevKey({ ...configured, authorized: false }, {}), /NOT_AUTHORIZED/);
  symlinkSync(path, join(dir, 'link')); assert.throws(() => readJevKey({ ...configured, keyFile: join(dir, 'link') }, {}), /UNAVAILABLE/);
  writeFileSync(path, 'TYPESAFE_API_KEY=$(unsafe-command)\n'); assert.throws(() => readJevKey(configured, {}), /INVALID/);
  assert.equal(jevReadiness(jevPolicy({}), {}).available, false);
});
test('Jev disagreement stays a review observation without replacing code findings or claiming an agentic tool loop', async () => {
  const f = fixture(body('successful_collection'));
  const result = await runJevInvestigation({ country: 'US', date: '2026-10-12', policy, client: f.client,
    signal: new AbortController().signal, onModel: f.options.onModel,
    sources: [{ source: { id: 'src_' + 'a'.repeat(24), country: 'US' }, date: '2026-10-12', article_activity: { daily: { new_unique_candidate_urls: 0 } },
      endpoints: [{ endpoint_id: 'ep_' + 'b'.repeat(24), type: 'rss', classification: 'successful_no_new_discoveries', health: {} }] }] });
  assert.equal(result.decisions[0].agrees_with_code_evidence, false); assert.equal(result.decisions[0].requires_review, true);
  assert.equal(result.assessment.proposed_steps[0].action, 'confirm_freshness'); assert.equal(result.model_calls, 1);
  assert.equal(result.billing_cost_usd, null);
});
test('OpenAI fixed-case evaluator runs the actual SDK and accounts usage without exposing thoughts', async () => {
  const events = [], requests = [], model = { async getResponse(request) {
    requests.push(request); return { usage: new Usage({ requests: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150 }),
      rawUsage: { input_tokens: 120, output_tokens: 30 }, providerData: { model: 'fixture-model', private_reasoning: 'SECRET_THOUGHT_SENTINEL' },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
        classification: 'successful_no_new_discoveries', requires_live_confirmation: false }) }] }] };
  }, async *getStreamedResponse() { throw Error('never'); } };
  const openaiPolicy = { authorized: true, model: 'fixture-model', keyFile: null, totalBudgetUsd: 1, perRunBudgetUsd: .1,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxModelCalls: 10, maxInputBytes: 48000, maxOutputTokens: 200 };
  const evaluator = new OpenAIQualityEvaluator(openaiPolicy, model, new OpenAISessionBudget(1));
  const value = await evaluator.classify({ discoveries: 0 }, { onModel: event => events.push(event) });
  assert.equal(requests.length, 1); assert.equal(requests[0].tools.length, 0); assert.equal(requests[0].tracing, false);
  assert.equal(requests[0].modelSettings.store, false); assert.equal(requests[0].modelSettings.retry.maxRetries, 0);
  assert.equal(value.decision.classification, 'successful_no_new_discoveries'); assert.equal(value.usage.input_tokens, 120);
  assert.equal(value.billing_cost_usd, null); assert.ok(!JSON.stringify(events).includes('SECRET_THOUGHT_SENTINEL'));
});
test('Comparison shares identical raw evidence, excludes answers, and separates simulated contract proof from accuracy claims', async () => {
  const dataset = loadQualityCases(), seen = { typesafe_jev: [], generic_low_cost_llm: [] };
  const providers = Object.fromEntries(Object.keys(seen).map(method => [method, { evidence_kind: 'simulated_fixture', model: 'fixture',
    evaluate: async evidence => {
      const index = seen[method].length; seen[method].push(evidence);
      return { decision: { classification: dataset.cases[index].expected.classification,
        requires_live_confirmation: dataset.cases[index].expected.requires_live_confirmation },
      usage: { input_tokens: 20, output_tokens: 4 }, estimated_cost_usd: .0001 };
    } }]));
  const report = await compareQualityProviders({ dataset, providers });
  assert.match(report.model_rubric_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(seen.typesafe_jev, seen.generic_low_cost_llm);
  for (const [index, evidence] of seen.typesafe_jev.entries()) {
    const text = JSON.stringify(evidence); assert.ok(!Object.hasOwn(evidence, 'expected'));
    assert.ok(!text.includes(dataset.cases[index].label_reason)); assert.ok(!text.includes(dataset.cases[index].description));
    assert.ok(!text.includes('classification')); assert.ok(!text.includes('requires_live_confirmation'));
  }
  for (const row of report.comparisons.filter(row => row.method !== 'rules')) {
    assert.equal(row.evidence_kind, 'simulated_fixture'); assert.equal(row.evaluated_cases, 10);
    assert.equal(row.metrics.false_positive_findings, 0); assert.equal(row.by_language.ko.total_cases, 4);
    assert.equal(row.api_cost.amount, null); assert.match(row.api_cost.evidence, /not API spend or model accuracy/);
  }
  assert.equal(JSON.stringify(fixedCaseModelEvidence(dataset, dataset.cases[0])).includes('label_reason'), false);
});
test('CLI refuses an existing provider output before credential handling or ledger creation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-provider-output-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'existing.json'); writeFileSync(output, 'keep');
  const script = new URL('../scripts/evaluate-quality.mjs', import.meta.url);
  const run = spawnSync(process.execPath, [script.pathname, '--provider', 'openai', '--output', output], { encoding: 'utf8',
    env: { ...process.env, WNS_QUALITY_TOTAL_BUDGET_USD: '5', WNS_QUALITY_BUDGET_PATH: join(dir, 'never.sqlite'),
      WNS_OPENAI_PAID_APPROVED: '1', WNS_OPENAI_KEY_FILE: join(dir, 'unavailable-key'), WNS_OPENAI_TOTAL_BUDGET_USD: '5',
      WNS_OPENAI_RUN_BUDGET_USD: '.1' } });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /already exists/); assert.equal(readFileSync(output, 'utf8'), 'keep');
});
test('Partial comparison never calls unexecuted cases zero-cost successes or counts missing decisions as negatives', async () => {
  let requests = 0;
  const result = await compareQualityProviders({ providers: { typesafe_jev: { evidence_kind: 'live_api',
    evaluate: async (_evidence, onModel) => { requests++; onModel({ type: 'model_started' }); throw Error('JEV_USAGE_MISSING'); } } } });
  const comparison = result.comparisons.find(row => row.method === 'typesafe_jev');
  assert.equal(requests, 1); assert.equal(comparison.status, 'partial_or_failed');
  assert.equal(comparison.evaluated_cases, 0); assert.equal(comparison.failed_cases, 1); assert.equal(comparison.unexecuted_cases, 9);
  assert.equal(comparison.metrics.exact_classification_accuracy, null); assert.equal(comparison.metrics.false_positive_rate, null);
  assert.equal(comparison.usage_tokens, null); assert.equal(comparison.api_cost.estimated_amount, null);
});
test('CLI API comparison is locked without a shared ceiling and missing TypeSafe access stays not_run', t => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-comparison-budget-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = new URL('../scripts/evaluate-quality.mjs', import.meta.url);
  const env = { ...process.env }; delete env.WNS_QUALITY_TOTAL_BUDGET_USD; delete env.TYPESAFE_API_KEY;
  const rejected = spawnSync(process.execPath, [script.pathname, '--provider', 'jev'], { encoding: 'utf8', env });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /QUALITY_SHARED_BUDGET_REQUIRED/);
  const blocked = spawnSync(process.execPath, [script.pathname, '--provider', 'jev'], { encoding: 'utf8', env: {
    ...env, WNS_QUALITY_TOTAL_BUDGET_USD: '5', WNS_QUALITY_BUDGET_PATH: join(dir, 'budget.sqlite'),
    WNS_JEV_PAID_APPROVED: '1', WNS_JEV_TOTAL_BUDGET_USD: '5', WNS_JEV_RUN_BUDGET_USD: '.05' } });
  assert.equal(blocked.status, 0, blocked.stderr); const report = JSON.parse(blocked.stdout);
  assert.equal(report.comparisons.find(row => row.method === 'typesafe_jev').reason, 'typesafe_key_not_configured');
  assert.equal(report.shared_budget.estimated_or_reserved_usd, 0);
});
