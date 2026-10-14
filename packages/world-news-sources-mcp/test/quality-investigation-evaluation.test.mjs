import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Usage } from '@openai/agents';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { normalizeRegistry } from '../dist/catalog.js';
import { ActivityStore } from '../dist/activity.js';
import { HealthStore } from '../dist/health.js';
import { createServer } from '../dist/server.js';
import { OpenAISessionBudget } from '../dist/openai-runtime.js';
import { JevClient } from '../dist/jev-runtime.js';
import { APPROVED_BUDGET_ID, frozenEvidence, validateInvestigationDataset, withFrozenAnalysisClock,
  verifyFrozenMcpReplay, executeFrozenInvestigation, evaluateInvestigationDataset,
  summarizeInvestigationEvaluation, preflightApprovedBudget, createPrivateResultFile,
  parseInvestigationEvaluationOptions, classifyExecution } from '../scripts/evaluate-investigation.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const analysisNow = '2026-10-13T02:00:00.000Z';
const openaiPolicy = { authorized: true, model: 'fixture-model', keyFile: null, totalBudgetUsd: 1, perRunBudgetUsd: .2,
  inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxModelCalls: 4, maxInputBytes: 48000, maxOutputTokens: 800 };
const jevPolicy = { authorized: true, model: 'jev-1.13.0', keyFile: null, totalBudgetUsd: 1, perRunBudgetUsd: .1,
  inputUsdPerMillion: .042, maxModelCalls: 12, maxInputBytes: 24000, timeoutMs: 1000 };
const functionCall = (name, args) => ({ type: 'function_call', callId: `fixture-${name}`, name,
  arguments: JSON.stringify(args), status: 'completed' });
const message = proposed_steps => ({ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Synthetic saved evidence assessment.', proposed_steps }) }] });

async function datasetFixture({ feeds = [{ name: 'Fixture Zero', url: 'https://zero.fixture.example/feed' }], failure = false } = {}) {
  const registry = { countries: [{ code: 'US', name: 'US', feeds }] }, catalog = normalizeRegistry(registry);
  const sources = catalog.sources, endpoint_ids = [...new Set(sources.flatMap(source => source.endpoints.map(endpoint => endpoint.id)))];
  const collections = sources.flatMap(source => source.endpoints.flatMap(endpoint => ['2026-10-11', '2026-10-12', '2026-10-13'].map(date => ({
    endpoint_id: endpoint.id, checked_at: `${date}T01:00:00.000Z`,
    status: failure && date === '2026-10-12' ? 'timeout' : 'working_nonempty', format: 'rss', source_ids: [source.id],
    countries: ['US'], source_new: { [source.id]: 0 }, country_new: { US: 0 }, baseline_sources: [], uncertain_urls: 0 }))));
  const activity_snapshot = { version: 1, lane: 'production', generated_at: analysisNow,
    registry_at: '2026-10-13T01:00:00.000Z', tracking_start: '2026-10-01T00:00:00.000Z',
    available_since: '2026-10-01T00:00:00.000Z', semantics: 'Synthetic first-discovered URL fixture',
    scope_starts: { source: Object.fromEntries(sources.map(source => [source.id, '2026-10-01T00:00:00.000Z'])), country: { US: '2026-10-01T00:00:00.000Z' } },
    scope_latest: { source: Object.fromEntries(sources.map(source => [source.id, '2026-10-13T01:00:00.000Z'])), country: { US: '2026-10-13T01:00:00.000Z' } },
    bindings: sources.flatMap(source => source.endpoints.map(endpoint => ({ source_id: source.id, endpoint_id: endpoint.id,
      baseline_at: '2026-10-01T00:00:00.000Z' }))), collections };
  const group = { id: 'zero-fixture', country: 'US', date: '2026-10-12', now: analysisNow,
    source_ids: sources.map(source => source.id), endpoint_ids, registry, activity_snapshot,
    health_snapshot: { version: 1, observations: [] }, replay: [],
    gold: sources.flatMap(source => source.endpoints.map(endpoint => ({ source_id: source.id, endpoint_id: endpoint.id,
      classification: failure ? 'failure_after_prior_success' : 'successful_no_new_discoveries', requires_live_confirmation: failure }))),
    source_gold: sources.map(source => ({ source_id: source.id, requires_live_confirmation: failure,
      acceptable_actions: failure ? ['investigate_failure', 'confirm_freshness'] : ['no_change'] })),
    label_reason: 'GOLD_LABEL_REASON_SENTINEL', description: 'GOLD_DESCRIPTION_SENTINEL', provenance: ['GOLD_PROVENANCE_SENTINEL'] };
  const dataset = { version: 1, id: 'synthetic-full-loop-regression', fixture_set: true, real_world_cases: false,
    now: analysisNow, groups: [group] };
  await withFrozenAnalysisClock(analysisNow, async () => {
    const server = createServer(catalog, new HealthStore(group.health_snapshot), new ActivityStore(activity_snapshot));
    const client = new Client({ name: 'synthetic-manifest', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const calls = [
        ['get_country_collection_quality', { country: 'US', date: group.date, limit: 50 }],
        ['get_country_source_inventory', { country: 'US', include_disabled: true, limit: 50 }],
        ['search_sources', { country: 'US', enabled: true, offset: 0, limit: 50 }],
        ...sources.flatMap(source => [
          ['get_source', { source_id: source.id }],
          ['get_source_collection_quality', { source_id: source.id, date: group.date }],
        ]),
        ['get_endpoint_health', { endpoint_ids }],
        ['get_country_article_activity', { country: 'US', start_date: group.date, end_date: group.date, timezone: 'UTC', limit: 50 }],
        ['get_source_article_activity', { source_id: sources[0].id, start_date: group.date, end_date: group.date, timezone: 'UTC', limit: 50 }],
      ];
      for (const [tool, args] of calls) {
        const result = await client.callTool({ name: tool, arguments: args });
        assert.notEqual(result.isError, true); group.replay.push({ tool, args, result: result.structuredContent });
      }
    } finally { await client.close(); await server.close(); }
  });
  return dataset;
}
function mockOpenAI(group, { action = 'no_change', omit = false, fail = null } = {}) {
  const requests = [], wallTimes = [];
  const outputs = omit ? [message([])] : [functionCall('search_country_sources', { query: null, offset: 0, limit: 10 }),
    functionCall('read_source_quality', { source_id: group.source_ids[0] }),
    message([{ source_id: group.source_ids[0], action, reason: 'Synthetic model proposal.' }])];
  const provider = { evidence_kind: 'simulated_fixture', policy: openaiPolicy, createModel: () => {
    let index = 0;
    return { async getResponse(request) {
      requests.push(request); wallTimes.push(Date.now());
      if (fail) throw fail();
      const output = outputs[index++]; if (!output) throw Error('UNEXPECTED_FIXTURE_TURN');
      return { usage: new Usage({ requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
        rawUsage: { input_tokens: 100, output_tokens: 20 }, output: [output],
        providerData: { model: 'fixture-model', private_reasoning: 'PRIVATE_REASONING_SENTINEL' } };
    }, async *getStreamedResponse() { throw Error('TEST_STREAM_DISABLED'); } };
  } };
  return { provider, requests, wallTimes };
}
function mockJev({ classification = 'successful_collection', confirmation = 'no', httpStatus = 200 } = {}) {
  const requests = [], wallTimes = [];
  const provider = { evidence_kind: 'simulated_fixture', policy: jevPolicy,
    createClient: budget => new JevClient(jevPolicy, 'DUMMY_FIXTURE_NEVER_SENT', budget, async (_url, init) => {
      requests.push(JSON.parse(init.body)); wallTimes.push(Date.now());
      if (httpStatus !== 200) return new Response('Synthetic failure.', { status: httpStatus });
      const questions = JSON.parse(init.body).questions;
      const answer = (question, choice) => ({ type: 'choice', choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) });
      return Response.json({ model: jevPolicy.model, answers: { classification: answer(questions.classification, classification),
        confirmation: answer(questions.confirmation, confirmation) }, usage: { input_tokens: 500, output_tokens: 40 } });
    }) };
  return { provider, requests, wallTimes };
}
const evaluate = (dataset, options = {}) => evaluateInvestigationDataset({ dataset, allowSynthetic: true,
  budget: new OpenAISessionBudget(1), ...options });

test('frozen actual MCP evidence excludes grading prose, validates exact source/endpoint pairs, and detects replay drift', async () => {
  const dataset = await datasetFixture({ feeds: [{ name: 'Fixture Zero', url: 'https://zero.fixture.example/feed' },
    { name: 'Fixture Other', url: 'https://other.fixture.example/feed' }] });
  assert.equal(validateInvestigationDataset(dataset, { allowSynthetic: true }), dataset);
  const group = dataset.groups[0];
  assert.doesNotMatch(JSON.stringify(frozenEvidence(group, dataset)), /GOLD_.*_SENTINEL|acceptable_actions|requires_live_confirmation/);
  const verified = await verifyFrozenMcpReplay(group, dataset);
  assert.equal(verified.manifest_calls, 10); assert.equal(verified.network_requests, 0);
  const invalid = mutate => { const data = clone(dataset); mutate(data.groups[0]);
    assert.throws(() => validateInvestigationDataset(data, { allowSynthetic: true })); };
  invalid(row => row.gold.pop());
  invalid(row => row.gold[0].endpoint_id = row.gold[1].endpoint_id);
  invalid(row => row.gold[0].classification = 'healthy_zero_is_an_outage');
  invalid(row => row.source_gold.push(clone(row.source_gold[0])));
  invalid(row => row.activity_snapshot.gold = 'LEAK');
  invalid(row => row.replay[0].result.expected = 'LEAK');
  const drifted = clone(group); drifted.replay[0].result.snapshot_at = '2000-01-01T00:00:00Z';
  await assert.rejects(verifyFrozenMcpReplay(drifted, dataset), /Frozen MCP evidence drift/);
  assert.throws(() => validateInvestigationDataset(dataset), /real-case dataset/);
});

test('rules/OpenAI/Jev keep identical frozen cohort and real MCP reads while grading original model errors separately', async () => {
  const dataset = await datasetFixture(), group = dataset.groups[0], openai = mockOpenAI(group, { action: 'investigate_failure' }),
    jev = mockJev({ classification: 'failure_after_prior_success', confirmation: 'yes' });
  const report = await evaluate(dataset, { providers: { openai: openai.provider, jev: jev.provider } });
  assert.equal(report.status, 'completed'); assert.equal(report.results.length, 3);
  assert.equal(new Set(report.results.map(row => row.result.frozen_evidence_sha256)).size, 1);
  for (const row of report.results) {
    assert.equal(row.result.grading.code_validated_findings.classification_accuracy_on_inspected, 1);
    assert.deepEqual(row.result.grading.scope.omitted_endpoint_ids, []);
    assert.ok(row.result.run.events.some(event => event.tool === 'get_source_collection_quality' && event.status === 'completed'));
  }
  const proposal = report.results.find(row => row.engine === 'openai').result.grading.assisted_openai_proposals;
  assert.equal(proposal.supported_action_rate, 0); assert.equal(proposal.guard_rejected_steps, 1);
  assert.equal(proposal.live_confirmation_decisions_on_proposed_sources.false_positive, 1);
  assert.equal(proposal.rows[0].observed.action, 'investigate_failure'); assert.equal(proposal.rows[0].retained_after_production_guard, false);
  const jevResult = report.results.find(row => row.engine === 'jev').result;
  assert.equal(jevResult.grading.raw_jev_decisions.classification_accuracy_on_evaluated, 0);
  assert.equal(jevResult.grading.raw_jev_decisions.finding_decisions.false_positive, 1);
  assert.equal(jevResult.run.model_assessment.decisions[0].confidence, 1);
  assert.equal(jevResult.grading.post_guard_source_actions.rows[0].observed.action, 'confirm_freshness');
  assert.equal(report.summaries.openai.api_model_calls, 0); assert.equal(report.summaries.openai.simulated_model_invocations, 3);
  assert.equal(report.summaries.jev.api_model_calls, 0); assert.equal(report.summaries.jev.simulated_model_invocations, 1);
  assert.equal(report.summaries.openai.estimated_api_cost_usd, 0);
  assert.ok(report.summaries.openai.simulated_estimated_cost_usd > 0);
  assert.equal(report.operations.publisher_requests, 0); assert.equal(report.operations.production_mcp_requests, 0);
  assert.ok([...openai.wallTimes, ...jev.wallTimes].every(now => now !== Date.parse(analysisNow)));
  assert.doesNotMatch(JSON.stringify(openai.requests) + JSON.stringify(jev.requests), /GOLD_.*_SENTINEL|DUMMY_FIXTURE_NEVER_SENT/);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_REASONING_SENTINEL|DUMMY_FIXTURE_NEVER_SENT/);
  assert.ok(openai.requests.every(request => request.tracing === false && request.modelSettings.store === false && request.modelSettings.retry.maxRetries === 0));
});

test('adaptive OpenAI omission remains omission rather than correct accuracy or a failure', async () => {
  const dataset = await datasetFixture(), openai = mockOpenAI(dataset.groups[0], { omit: true });
  const report = await evaluate(dataset, { providers: { openai: openai.provider } });
  const result = report.results.find(row => row.engine === 'openai').result;
  assert.equal(result.execution_status, 'completed'); assert.equal(openai.requests.length, 1);
  assert.deepEqual(result.grading.scope.omitted_endpoint_ids, dataset.groups[0].endpoint_ids);
  assert.equal(result.grading.code_validated_findings.classification_accuracy_on_inspected, null);
  assert.equal(result.grading.assisted_openai_proposals.supported_action_rate, null);
  assert.equal(report.summaries.openai.intended_endpoint_observations, 1);
  assert.equal(report.summaries.openai.inspected_endpoint_observations, 0);
});

test('selected-date failure ignores later recovery through real MCP and source confirm_freshness has consistent finding recall', async () => {
  const dataset = await datasetFixture({ failure: true }), group = dataset.groups[0];
  const rules = await executeFrozenInvestigation(group, dataset, 'rules');
  assert.equal(rules.run.findings[0].classification, 'failure_after_prior_success');
  assert.equal(rules.run.findings[0].assessment.last_collection.checked_at, '2026-10-12T01:00:00.000Z');
  assert.equal(rules.grading.code_validated_findings.classification_accuracy_on_inspected, 1);
  const openai = mockOpenAI(group, { action: 'confirm_freshness' });
  const result = await executeFrozenInvestigation(group, dataset, 'openai', openai.provider, new OpenAISessionBudget(1));
  assert.equal(result.grading.assisted_openai_proposals.supported_action_rate, 1);
  assert.equal(result.grading.assisted_openai_proposals.live_confirmation_decisions_on_proposed_sources.true_positive, 1);
  assert.deepEqual(result.grading.assisted_openai_proposals.relevant_sources_without_live_confirmation_proposal, []);
});

test('frozen clock restores on failed runs and pending wall-clock callback cannot freeze it after outer failure', async () => {
  const originalNow = Date.now;
  let finish, pending;
  const gate = new Promise(resolve => { finish = resolve; });
  await assert.rejects(withFrozenAnalysisClock(analysisNow, async wallClock => {
    assert.equal(Date.now(), Date.parse(analysisNow));
    pending = wallClock(async () => { assert.equal(Date.now, originalNow); await gate; });
    throw Error('OUTER_FIXTURE_FAILURE');
  }), /OUTER_FIXTURE_FAILURE/);
  assert.equal(Date.now, originalNow);
  finish(); await pending; assert.equal(Date.now, originalNow);
  await withFrozenAnalysisClock(analysisNow, async () => {
    await assert.rejects(withFrozenAnalysisClock(analysisNow, async () => {}), /CONCURRENT_CLOCK/);
  });
  const dataset = await datasetFixture(), model = mockOpenAI(dataset.groups[0], { fail: () => Error('PRIVATE_FAILURE_SENTINEL') });
  const failed = await executeFrozenInvestigation(dataset.groups[0], dataset, 'openai', model.provider, new OpenAISessionBudget(1));
  assert.equal(failed.execution_status, 'execution_failed'); assert.equal(Date.now, originalNow);
  assert.equal(failed.run.cost.estimated_model_cost_usd, null);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_FAILURE_SENTINEL/);
});

test('HTTP auth/access/rate failures stop the affected provider without retrial and rules continue', async () => {
  for (const status of [401, 403, 429]) {
    const dataset = await datasetFixture(), model = mockOpenAI(dataset.groups[0], { fail: () => Object.assign(Error('private provider error'), { status }) });
    dataset.groups.push({ ...clone(dataset.groups[0]), id: 'second-fixture' });
    const report = await evaluate(dataset, { providers: { openai: model.provider } });
    assert.equal(model.requests.length, 1, `HTTP ${status} must not trigger a later paid call`);
    const paid = report.results.filter(row => row.engine === 'openai');
    assert.equal(paid[0].status, 'execution_failed'); assert.equal(paid[1].status, 'not_run_due_to_paid_guard');
    assert.match(paid[1].reason, /AUTH_ACCESS_OR_RATE/);
    assert.equal(report.summaries.rules.completed_runs, 2); assert.equal(report.summaries.openai.intended_endpoint_observations, 2);
    assert.equal(report.summaries.openai.inspected_endpoint_observations, 0);
    assert.equal(report.summaries.openai.usage_tokens, null);
  }
  const dataset = await datasetFixture(), jev = mockJev({ httpStatus: 429 });
  const report = await evaluate(dataset, { providers: { jev: jev.provider }, repeats: 2 });
  assert.equal(jev.requests.length, 1);
  assert.equal(report.results.filter(row => row.engine === 'jev')[1].status, 'not_run_due_to_paid_guard');
});

test('three repeated ordinary execution errors halt only that provider and retain every intended endpoint denominator', async () => {
  const dataset = await datasetFixture(), model = mockOpenAI(dataset.groups[0], { fail: () => Error('private transient fixture failure') });
  const report = await evaluate(dataset, { providers: { openai: model.provider }, repeats: 4 });
  assert.equal(model.requests.length, 3); assert.equal(report.summaries.rules.completed_runs, 4);
  assert.equal(report.summaries.openai.execution_failed_runs, 3); assert.equal(report.summaries.openai.unexecuted_runs, 1);
  assert.equal(report.summaries.openai.intended_endpoint_observations, 4);
  assert.match(report.results.filter(row => row.engine === 'openai')[3].reason, /THREE_CONSECUTIVE/);
  assert.ok(report.shared_budget_after.estimated_or_reserved_usd > 0, 'Unknown usage must retain the existing conservative reservations');
});

test('repeats rotate provider order, checkpoint every terminal run, and report variation only across actual repeated decisions', async () => {
  const dataset = await datasetFixture(), openai = mockOpenAI(dataset.groups[0]), jev = mockJev({ classification: 'successful_no_new_discoveries' });
  const checkpoints = [];
  const report = await evaluate(dataset, { providers: { openai: openai.provider, jev: jev.provider }, repeats: 3,
    onCheckpoint: report => checkpoints.push(clone(report)) });
  assert.deepEqual(report.results.map(row => row.engine), ['rules', 'openai', 'jev', 'openai', 'jev', 'rules', 'jev', 'rules', 'openai']);
  assert.equal(checkpoints[0].results.length, 9); assert.ok(checkpoints[0].results.every(row => row.status === 'not_started'));
  for (const row of report.results) assert.ok(checkpoints.some(checkpoint => checkpoint.results.some(saved => saved.repeat === row.repeat
    && saved.engine === row.engine && saved.status === 'completed' && saved.result)));
  for (const summary of Object.values(report.summaries)) {
    assert.equal(summary.intended_endpoint_observations, 3); assert.equal(summary.inspected_endpoint_observations, 3);
    assert.equal(summary.repeat_variability[0].distinct_decision_and_coverage_signatures, 1);
    assert.equal(summary.repeat_variability[0].completed_repeats, 3);
  }
});

test('summary keeps failed-start/unexecuted/hung intended scope and reports unknown interrupted paid usage', () => {
  const rows = [
    { engine: 'openai', group_id: 'x', evidence_kind: 'live_api', status: 'start_failed', eligible_endpoint_pairs: [{}, {}],
      result: { execution_status: 'start_failed', duration_ms: 1, run: null, grading: null } },
    { engine: 'openai', group_id: 'y', evidence_kind: 'live_api', status: 'not_run_due_to_paid_guard', eligible_endpoint_pairs: [{}], result: null },
    { engine: 'openai', group_id: 'z', evidence_kind: 'live_api', status: 'execution_failed', eligible_endpoint_pairs: [{}],
      model_usage_unknown: true, result: null },
  ];
  const summary = summarizeInvestigationEvaluation(rows, 'openai');
  assert.equal(summary.intended_runs, 3); assert.equal(summary.intended_endpoint_observations, 4);
  assert.equal(summary.execution_failed_runs, 2); assert.equal(summary.unexecuted_runs, 1);
  assert.equal(summary.api_model_calls, null); assert.equal(summary.known_api_model_calls, 0);
  assert.equal(summary.estimated_api_cost_usd, null); assert.equal(summary.live_api_usage_tokens, null);
  assert.equal(summary.unknown_model_usage_runs, 1); assert.equal(summary.code_classification_accuracy_on_inspected, null);
  const run = { status: 'completed', limit_reached: true, limits: { max_duration_ms: 100 }, events: [], summary: 'bounded' };
  assert.equal(classifyExecution(run, 100), 'timeout'); assert.equal(classifyExecution(run, 1), 'limit_reached');
  assert.equal(classifyExecution({ ...run, limit_reached: false, status: 'failed' }, 1), 'execution_failed');
});

test('existing approved ledger is read-only in preflight and exclusive output remains private with no overwrite/resume', t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'investigation-evaluation-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, 'missing.sqlite');
  assert.throws(() => preflightApprovedBudget(missing), /EXISTING_BUDGET_REQUIRED/); assert.equal(existsSync(missing), false);
  const path = join(dir, 'runtime.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE model_budgets (id TEXT PRIMARY KEY,limit_usd REAL,held_usd REAL)');
  db.prepare('INSERT INTO model_budgets VALUES (?,?,?)').run(APPROVED_BUDGET_ID, 5, .013497892); db.close();
  const before = readFileSync(path), ready = preflightApprovedBudget(path);
  assert.equal(ready.estimated_or_reserved_usd, .013497892); assert.equal(ready.authorization_limit_usd, 5);
  assert.equal(ready.existing_ledger, true); assert.deepEqual(readFileSync(path), before);
  assert.throws(() => preflightApprovedBudget(path, 'new-budget'), /APPROVED_BUDGET_MISMATCH/);
  assert.throws(() => preflightApprovedBudget(path, APPROVED_BUDGET_ID, 6), /APPROVED_BUDGET_MISMATCH/);
  const output = join(dir, 'private', 'result.json'), writer = createPrivateResultFile(output);
  try { writer.checkpoint({ status: 'running' }); writer.checkpoint({ status: 'completed' }); }
  finally { writer.close(); }
  assert.equal(statSync(output).mode & 0o777, 0o600); assert.equal(statSync(join(dir, 'private')).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { status: 'completed' });
  assert.throws(() => createPrivateResultFile(output), /EEXIST/);
  symlinkSync(join(dir, 'private'), join(dir, 'link'));
  assert.throws(() => createPrivateResultFile(join(dir, 'link', 'unsafe.json')), /UNSAFE_OUTPUT_PATH/);
  assert.equal(existsSync(join(dir, 'private', 'unsafe.json')), false);
  assert.deepEqual(parseInvestigationEvaluationOptions(['--cases', 'cases.json', '--provider=all', '--repeats=3', '--output', 'new.json']),
    { cases: 'cases.json', provider: 'all', repeats: 3, output: 'new.json' });
  for (const args of [[], ['--cases', 'a', '--output', 'b', '--repeats', '0'], ['--cases', 'a', '--output', 'b', '--output', 'c'],
    ['--cases', 'a', '--output', '--provider'], ['--cases', 'a', '--output', 'b', '--resume']])
    assert.throws(() => parseInvestigationEvaluationOptions(args), /USAGE_INVALID/);
});
