#!/usr/bin/env node
/**
 * Matched full-loop evaluation through the existing InvestigationStore and real in-memory MCP.
 * Offline rules are the default. Paid runs require the existing approved persistent budget.
 * Human gold/adjudication is grading-only; production OpenAI code-label assistance is explicit.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, ftruncateSync, fsyncSync } from 'node:fs';
import { resolve, dirname, parse, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { normalizeRegistry } from '../dist/catalog.js';
import { ActivityStore } from '../dist/activity.js';
import { HealthStore } from '../dist/health.js';
import { createServer } from '../dist/server.js';
import { InvestigationStore } from '../dist/investigation.js';
import { openAIPolicy, openAIReadiness, createPaidOpenAIModel, OpenAISessionBudget } from '../dist/openai-runtime.js';
import { jevPolicy, jevReadiness, createPaidJevClient } from '../dist/jev-runtime.js';
import { PersistentModelBudget } from '../dist/quality-runtime-storage.js';
import { classificationCriteria } from '../dist/quality-decision.js';

export const APPROVED_BUDGET_ID = 'news-quality-pilot-20261013';
export const APPROVED_BUDGET_LIMIT_USD = 5;
const ENGINES = ['rules', 'openai', 'jev'];
const ACTIONS = ['investigate_failure', 'check_official_alternative', 'confirm_freshness', 'initialize_tracking', 'observe_recovery', 'no_change'];
const LIVE_CONFIRMATION_ACTIONS = ['investigate_failure', 'check_official_alternative', 'confirm_freshness'];
const CLASSIFICATIONS = new Set([...Object.keys(classificationCriteria), 'insufficient_endpoint_history']);
const MCP_TOOLS = new Set(['search_sources', 'get_source', 'list_countries', 'get_endpoint_health',
  'get_country_source_inventory', 'get_source_article_activity', 'get_country_article_activity',
  'get_country_collection_quality', 'get_source_collection_quality']);
const forbiddenEvidenceKeys = new Set(['gold', 'source_gold', 'expected', 'label_reason', 'adjudication', 'acceptable_actions']);
const copy = value => JSON.parse(JSON.stringify(value));
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sha = value => createHash('sha256').update(stable(value)).digest('hex');
const endpointKey = row => `${row.source_id}:${row.endpoint_id}`;
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
const safeError = error => typeof error?.message === 'string' && /^[A-Z_]{3,100}$/.test(error.message)
  ? error.message : 'EVALUATION_RUN_FAILED';

export function frozenEvidence(group, dataset) {
  return copy({ country: group.country, date: group.date, now: group.now ?? dataset.now,
    source_ids: group.source_ids, endpoint_ids: group.endpoint_ids,
    registry: group.registry, activity_snapshot: group.activity_snapshot, health_snapshot: group.health_snapshot });
}
function assertNoGold(value, path = 'evidence') {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!forbiddenEvidenceKeys.has(key), `Gold/adjudication key cannot enter model evidence: ${path}.${key}`);
    assertNoGold(item, `${path}.${key}`);
  }
}
export function validateInvestigationDataset(dataset, { allowSynthetic = false } = {}) {
  assert.equal(dataset.version, 1, 'Unsupported investigation evaluation schema');
  assert.ok(typeof dataset.id === 'string' && dataset.id, 'Dataset ID required');
  assert.ok(dataset.real_world_cases === true || allowSynthetic && dataset.fixture_set === true,
    'An explicitly frozen real-case dataset is required');
  assert.ok(Array.isArray(dataset.groups) && dataset.groups.length, 'Nonempty frozen cohorts required');
  const ids = new Set();
  for (const group of dataset.groups) {
    assert.ok(group.id && !ids.has(group.id), 'Cohort IDs must be unique'); ids.add(group.id);
    const evidence = frozenEvidence(group, dataset);
    assert.ok(Number.isFinite(Date.parse(evidence.now)), `Fixed analysis clock required: ${group.id}`);
    assert.match(group.country, /^[A-Z]{2,8}$/); assert.match(group.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Date.parse(group.date) <= Date.parse(evidence.now), 'Selected date exceeds frozen analysis clock');
    assertNoGold(evidence); assert.ok(!evidence.activity_snapshot.history, 'Archive must be materialized before evaluation');
    assert.ok(evidence.activity_snapshot.registry_at, 'Frozen registry timestamp required');
    const catalog = normalizeRegistry(evidence.registry);
    const sources = catalog.sources.filter(source => source.enabled && source.countryCode === group.country);
    assert.deepEqual([...sources.map(source => source.id)].sort(), [...group.source_ids].sort(), 'Cohort source IDs do not match frozen registry');
    assert.deepEqual([...new Set(sources.flatMap(source => source.endpoints.map(endpoint => endpoint.id)))].sort(),
      [...group.endpoint_ids].sort(), 'Cohort endpoint IDs do not match frozen registry');
    assert.ok(sources.length && sources.length <= 12, 'Matched cohort exceeds existing source investigation cap');
    assert.ok(Array.isArray(group.gold) && group.gold.length, 'Endpoint gold required for grading');
    assert.ok(Array.isArray(group.source_gold) && group.source_gold.length, 'Independent source-action gold required');
    const goldIds = new Set();
    const actualPairs = new Set(sources.flatMap(source => source.endpoints.map(endpoint => endpointKey({ source_id: source.id, endpoint_id: endpoint.id }))));
    for (const gold of group.gold) {
      assert.ok(actualPairs.has(endpointKey(gold)), 'Gold source/endpoint pair outside the matched cohort');
      assert.ok(!goldIds.has(endpointKey(gold)), 'Duplicate endpoint gold'); goldIds.add(endpointKey(gold));
      assert.ok(CLASSIFICATIONS.has(gold.classification) && typeof gold.requires_live_confirmation === 'boolean', 'Invalid endpoint adjudication');
    }
    assert.deepEqual([...goldIds].sort(), [...actualPairs].sort(), 'Endpoint gold must cover every eligible source/endpoint pair');
    assert.equal(new Set(group.source_gold.map(row => row.source_id)).size, group.source_gold.length, 'Duplicate source gold');
    assert.deepEqual([...new Set(group.source_gold.map(row => row.source_id))].sort(), [...group.source_ids].sort(), 'Source gold must cover the eligible cohort');
    for (const row of group.source_gold) {
      assert.equal(typeof row.requires_live_confirmation, 'boolean');
      assert.ok(Array.isArray(row.acceptable_actions) && row.acceptable_actions.length
        && row.acceptable_actions.every(action => ACTIONS.includes(action)), 'Invalid source-action adjudication');
    }
    assert.ok(Array.isArray(group.replay) && group.replay.length, 'Frozen MCP response manifest required');
    for (const replay of group.replay) {
      assert.ok(MCP_TOOLS.has(replay.tool) && replay.args && replay.result, 'Invalid frozen MCP manifest item');
      assertNoGold(replay.args); assertNoGold(replay.result);
    }
  }
  return dataset;
}

let clockOwner = null;
/** Isolated/sequential only: analysis reads freeze; provider networking and native timers keep wall time. */
export async function withFrozenAnalysisClock(now, action) {
  if (clockOwner) throw Error('EVALUATION_CONCURRENT_CLOCK_FORBIDDEN');
  const originalNow = Date.now, frozenNow = Date.parse(now);
  if (!Number.isFinite(frozenNow)) throw Error('EVALUATION_CLOCK_INVALID');
  const owner = Symbol('isolated analysis clock');
  clockOwner = owner; Date.now = () => frozenNow;
  const wallClock = async callback => {
    if (clockOwner !== owner) throw Error('EVALUATION_CLOCK_OWNERSHIP_ENDED');
    Date.now = originalNow;
    try { return await callback(); }
    // A lingering provider must not re-freeze Date.now after the outer run failed.
    finally { if (clockOwner === owner) Date.now = () => frozenNow; }
  };
  try { return await action(wallClock); }
  finally { Date.now = originalNow; clockOwner = null; }
}
function stores(evidence) {
  return { catalog: normalizeRegistry(copy(evidence.registry)), health: new HealthStore(copy(evidence.health_snapshot)),
    activity: new ActivityStore(copy(evidence.activity_snapshot)) };
}
/** Preflight manifest equality uses the real MCP SDK; no model key, network, ledger or gold is involved. */
export async function verifyFrozenMcpReplay(group, dataset) {
  const evidence = frozenEvidence(group, dataset);
  return withFrozenAnalysisClock(evidence.now, async () => {
    const { catalog, activity, health } = stores(evidence), server = createServer(catalog, health, activity);
    const client = new Client({ name: 'matched-investigation-replay-preflight', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      for (const replay of group.replay) {
        const response = await client.callTool({ name: replay.tool, arguments: copy(replay.args) });
        assert.notEqual(response.isError, true, 'Frozen MCP preflight failed');
        assert.equal(sha(response.structuredContent), sha(replay.result), `Frozen MCP evidence drift: ${group.id}/${replay.tool}`);
      }
      return { status: 'verified', manifest_calls: group.replay.length, frozen_evidence_sha256: sha(evidence),
        replay_sha256: sha(group.replay), transport: 'real_MCP_SDK_in_memory', network_requests: 0 };
    } finally { await client.close().catch(() => {}); await server.close().catch(() => {}); }
  });
}

export function classifyExecution(run, durationMs) {
  const codes = [run.summary, ...run.events.filter(event => event.error).map(event => event.error)].filter(value => typeof value === 'string');
  if (run.limit_reached && durationMs >= run.limits.max_duration_ms - 20
    || codes.some(code => /TIMEOUT|TIMED_OUT|RUN_CANCELLED/.test(code))) return 'timeout';
  if (run.status === 'failed') return 'execution_failed';
  if (run.limit_reached) return 'limit_reached';
  return 'completed';
}
function binaryMetrics(rows) {
  const counts = { true_positive: 0, false_positive: 0, true_negative: 0, false_negative: 0 };
  for (const row of rows) {
    if (row.expected && row.observed) counts.true_positive++;
    else if (!row.expected && row.observed) counts.false_positive++;
    else if (row.expected && !row.observed) counts.false_negative++;
    else counts.true_negative++;
  }
  return { ...counts, false_positive_rate: ratio(counts.false_positive, counts.false_positive + counts.true_negative),
    false_negative_rate: ratio(counts.false_negative, counts.false_negative + counts.true_positive) };
}
export function gradeInvestigationRun(group, run, { executionStatus = 'completed' } = {}) {
  const gold = new Map(group.gold.map(row => [endpointKey(row), row]));
  const findings = new Map(run.findings.map(row => [endpointKey(row), row]));
  const codeRows = group.gold.map(expected => {
    const observed = findings.get(endpointKey(expected));
    return { source_id: expected.source_id, endpoint_id: expected.endpoint_id, inspected: Boolean(observed),
      classification_correct: observed ? observed.classification === expected.classification : null,
      confirmation_correct: observed ? observed.assessment?.requires_live_confirmation === expected.requires_live_confirmation : null,
      expected: { classification: expected.classification, requires_live_confirmation: expected.requires_live_confirmation },
      observed: observed ? { classification: observed.classification,
        requires_live_confirmation: observed.assessment?.requires_live_confirmation ?? null } : null };
  });
  const inspectedSources = [...new Set(run.findings.map(row => row.source_id))];
  const inspectedEndpoints = [...new Set(run.findings.map(row => row.endpoint_id))];
  const scope = { eligible_source_ids: group.source_ids, eligible_endpoint_ids: group.endpoint_ids,
    inspected_source_ids: inspectedSources, inspected_endpoint_ids: inspectedEndpoints,
    omitted_source_ids: group.source_ids.filter(id => !inspectedSources.includes(id)),
    omitted_endpoint_ids: group.endpoint_ids.filter(id => !inspectedEndpoints.includes(id)),
    source_coverage: ratio(inspectedSources.length, group.source_ids.length), endpoint_coverage: ratio(inspectedEndpoints.length, group.endpoint_ids.length) };
  const result = { execution_status: executionStatus, scope,
    code_validated_findings: { attribution: 'Deterministic production code after reads, shared by all engines; not independent model accuracy.',
      evaluated_endpoints: codeRows.filter(row => row.inspected).length,
      correct_classifications: codeRows.filter(row => row.classification_correct).length,
      classification_accuracy_on_inspected: ratio(codeRows.filter(row => row.classification_correct).length, codeRows.filter(row => row.inspected).length), rows: codeRows },
    raw_jev_decisions: null, assisted_openai_proposals: null };
  if (run.cost.provider === 'jev') {
    const decisions = run.model_assessment?.decisions ?? [];
    const rows = decisions.map(observed => {
      const expected = gold.get(endpointKey(observed));
      const equivalent = expected?.classification === 'insufficient_endpoint_history' && observed.classification === 'insufficient_evidence';
      return { source_id: observed.source_id, endpoint_id: observed.endpoint_id, expected: expected ?? null, observed,
        classification_correct: expected ? observed.classification === expected.classification || equivalent : false,
        confirmation_correct: expected ? observed.requires_live_confirmation === expected.requires_live_confirmation : false,
        outside_cohort: !expected };
    });
    result.raw_jev_decisions = { attribution: 'Raw structured endpoint decisions before code agreement/confidence gating; gold is grading-only.',
      evaluated_endpoints: rows.length, correct_classifications: rows.filter(row => row.classification_correct).length,
      classification_accuracy_on_evaluated: ratio(rows.filter(row => row.classification_correct).length, rows.length),
      omitted_endpoint_ids: group.gold.filter(row => !decisions.some(observed => endpointKey(row) === endpointKey(observed))).map(row => row.endpoint_id),
      finding_decisions: binaryMetrics(rows.filter(row => row.expected).map(row => ({ expected: row.expected.requires_live_confirmation,
        observed: row.observed.requires_live_confirmation }))), rows };
  }
  if (run.cost.provider === 'openai') {
    const sourceGold = new Map(group.source_gold.map(row => [row.source_id, row]));
    const raw = run.model_assessment?.proposal_validation?.original_proposed_steps ?? [];
    const accepted = run.model_assessment?.proposed_steps ?? [];
    const rows = raw.map(observed => {
      const expected = sourceGold.get(observed.source_id);
      return { source_id: observed.source_id, expected: expected ?? null, observed,
        supported_by_source_gold: Boolean(expected?.acceptable_actions.includes(observed.action)),
        retained_after_production_guard: accepted.some(step => stable(step) === stable(observed)),
        targeted_failure_proposal: ['investigate_failure', 'check_official_alternative'].includes(observed.action),
        live_confirmation_proposal: LIVE_CONFIRMATION_ACTIONS.includes(observed.action),
        outside_cohort: !expected };
    });
    const proposed = [...new Set(raw.map(row => row.source_id))];
    result.assisted_openai_proposals = { attribution: 'Assisted SOURCE-action evaluation. Production source-quality tools expose deterministic code classifications; this is not independent endpoint classifier accuracy.',
      raw_steps: rows.length, supported_steps: rows.filter(row => row.supported_by_source_gold).length,
      supported_action_rate: ratio(rows.filter(row => row.supported_by_source_gold).length, rows.length),
      guard_rejected_steps: run.model_assessment?.proposal_validation?.rejected_count ?? 0,
      proposed_source_ids: proposed, unproposed_source_ids: group.source_ids.filter(id => !proposed.includes(id)),
      source_proposal_coverage: ratio(proposed.length, group.source_ids.length),
      relevant_sources_without_live_confirmation_proposal: group.source_gold.filter(row => row.requires_live_confirmation
        && !raw.some(step => step.source_id === row.source_id && LIVE_CONFIRMATION_ACTIONS.includes(step.action))).map(row => row.source_id),
      live_confirmation_decisions_on_proposed_sources: binaryMetrics(group.source_gold.filter(row => proposed.includes(row.source_id)).map(row => ({ expected: row.requires_live_confirmation,
        observed: raw.some(step => step.source_id === row.source_id && LIVE_CONFIRMATION_ACTIONS.includes(step.action)) }))), rows };
  }
  const sourceGold = new Map(group.source_gold.map(row => [row.source_id, row]));
  result.post_guard_source_actions = { attribution: 'Downstream accepted source actions; separate from original model decisions and deterministic endpoint findings.',
    rows: (run.model_assessment?.proposed_steps ?? []).map(observed => ({ source_id: observed.source_id, observed,
      supported_by_source_gold: Boolean(sourceGold.get(observed.source_id)?.acceptable_actions.includes(observed.action)) })) };
  return result;
}

export async function executeFrozenInvestigation(group, dataset, engine, provider = {}, budget = new OpenAISessionBudget(0)) {
  const evidence = frozenEvidence(group, dataset), before = performance.now();
  return withFrozenAnalysisClock(evidence.now, async wallClock => {
    const { catalog, health, activity } = stores(evidence);
    const options = { budget };
    if (engine === 'openai') {
      options.policy = provider.policy;
      options.createModel = () => {
        const model = provider.createModel();
        return { getResponse: request => wallClock(() => model.getResponse(request)),
          async *getStreamedResponse() { throw Error('EVALUATION_STREAM_NOT_SUPPORTED'); } };
      };
    } else if (engine === 'jev') {
      options.jevPolicy = provider.policy;
      options.createJevClient = sharedBudget => {
        const client = provider.createClient(sharedBudget);
        return { evaluate: (...args) => wallClock(() => client.evaluate(...args)) };
      };
    }
    const store = new InvestigationStore(catalog, health, activity, false, options);
    let run;
    try { run = store.start({ country: group.country, date: group.date, engine }); }
    catch (error) { return { execution_status: 'start_failed', error: safeError(error), duration_ms: performance.now() - before,
      frozen_evidence_sha256: sha(evidence), run: null, grading: null }; }
    const waitUntil = performance.now() + run.limits.max_duration_ms + 30000;
    while (run.status === 'running' && performance.now() < waitUntil) await new Promise(done => setTimeout(done, 10));
    // A hung execution cannot be restarted or followed by another frozen-clock run in this process.
    if (run.status === 'running') throw Error('EVALUATION_RUNTIME_DID_NOT_TERMINATE');
    const duration = performance.now() - before, status = classifyExecution(run, duration);
    return { execution_status: status, error: status === 'execution_failed' ? safeError(new Error(run.summary)) : null,
      duration_ms: duration, frozen_evidence_sha256: sha(evidence), run: copy(run), grading: gradeInvestigationRun(group, run, { executionStatus: status }) };
  });
}

function repeatVariability(rows) {
  const range = values => values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
  return [...new Set(rows.map(row => row.group_id))].map(groupId => {
    const planned = rows.filter(row => row.group_id === groupId), executed = planned.filter(row => row.result);
    const signatures = executed.map(row => sha({ status: row.result.execution_status,
      scope: row.result.grading?.scope ?? null,
      decisions: row.result.grading?.raw_jev_decisions?.rows.map(item => ({ source_id: item.source_id,
        endpoint_id: item.endpoint_id, classification: item.observed.classification,
        requires_live_confirmation: item.observed.requires_live_confirmation })) ?? null,
      proposals: row.result.grading?.assisted_openai_proposals?.rows.map(item => ({ source_id: item.source_id,
        action: item.observed.action, retained: item.retained_after_production_guard })) ?? null,
      code: row.result.grading?.code_validated_findings.rows.map(item => ({ source_id: item.source_id,
        endpoint_id: item.endpoint_id, observed: item.observed })) ?? null }));
    return { group_id: groupId, intended_repeats: planned.length, executed_repeats: executed.length,
      completed_repeats: executed.filter(row => row.result.execution_status === 'completed').length,
      distinct_decision_and_coverage_signatures: new Set(signatures).size,
      wall_duration_ms: range(executed.map(row => row.result.duration_ms)),
      mcp_tool_calls: range(executed.map(row => row.result.run?.tool_calls).filter(Number.isFinite)),
      estimated_usage_cost_usd: range(executed.map(row => row.result.run?.cost.estimated_model_cost_usd
        ?? (row.engine === 'rules' ? 0 : null)).filter(Number.isFinite)) };
  });
}
export function summarizeInvestigationEvaluation(results, engine) {
  const rows = results.filter(row => row.engine === engine), executed = rows.filter(row => row.result),
    completed = rows.filter(row => row.result?.execution_status === 'completed');
  const code = executed.flatMap(row => row.result.grading?.code_validated_findings.rows ?? []), inspected = code.filter(row => row.inspected);
  const jev = executed.flatMap(row => row.result.grading?.raw_jev_decisions?.rows ?? []);
  const openai = executed.flatMap(row => row.result.grading?.assisted_openai_proposals?.rows ?? []);
  const gated = executed.flatMap(row => row.result.grading?.post_guard_source_actions?.rows ?? []);
  const runs = executed.map(row => row.result.run).filter(Boolean), modelEvents = runs.flatMap(run => run.events.filter(event => /^model_/.test(event.type)));
  const unknownUsage = row => row.model_usage_unknown === true || Boolean(row.result?.run
    && row.result.run.cost.estimated_model_cost_usd === null && row.engine !== 'rules');
  const usageIncomplete = rows.some(unknownUsage), live = rows.filter(row => row.evidence_kind === 'live_api'),
    simulated = rows.filter(row => row.evidence_kind === 'simulated_fixture');
  const calls = cohort => cohort.reduce((n, row) => n + (row.result?.run?.cost.model_calls ?? 0), 0);
  const tokens = cohort => cohort.some(unknownUsage) ? null : { input_tokens: cohort.reduce((n, row) => n + (row.result?.run?.cost.input_tokens ?? 0), 0),
    output_tokens: cohort.reduce((n, row) => n + (row.result?.run?.cost.output_tokens ?? 0), 0) };
  const estimatedCost = cohort => cohort.some(unknownUsage) ? null : cohort.reduce((n, row) => n + (row.result?.run?.cost.estimated_model_cost_usd ?? 0), 0);
  return { intended_runs: rows.length, completed_runs: completed.length,
    evidence_kinds: [...new Set(rows.map(row => row.evidence_kind))],
    execution_failed_runs: rows.filter(row => ['execution_failed', 'start_failed'].includes(row.result?.execution_status ?? row.status)).length,
    timeout_runs: rows.filter(row => row.result?.execution_status === 'timeout').length,
    limited_runs: rows.filter(row => row.result?.execution_status === 'limit_reached').length,
    unexecuted_runs: rows.filter(row => !row.result && row.status !== 'execution_failed').length,
    unknown_model_usage_runs: rows.filter(unknownUsage).length,
    inspected_endpoint_observations: inspected.length,
    intended_endpoint_observations: rows.reduce((n, row) => n + (row.eligible_endpoint_pairs?.length ?? row.eligible_endpoint_ids?.length ?? 0), 0),
    code_classification_accuracy_on_inspected: ratio(inspected.filter(row => row.classification_correct).length, inspected.length),
    raw_jev_classification_accuracy_on_evaluated: engine === 'jev' ? ratio(jev.filter(row => row.classification_correct).length, jev.length) : null,
    raw_jev_evaluated_endpoint_observations: engine === 'jev' ? jev.length : null,
    assisted_openai_supported_action_rate: engine === 'openai' ? ratio(openai.filter(row => row.supported_by_source_gold).length, openai.length) : null,
    assisted_openai_raw_steps: engine === 'openai' ? openai.length : null,
    assisted_openai_guard_rejected_steps: engine === 'openai' ? openai.filter(row => !row.retained_after_production_guard).length : null,
    post_guard_source_actions: gated.length,
    post_guard_unsupported_source_actions: gated.filter(row => !row.supported_by_source_gold).length,
    post_guard_unsupported_action_rate: ratio(gated.filter(row => !row.supported_by_source_gold).length, gated.length),
    model_invocations: rows.some(row => row.model_usage_unknown) ? null : calls(rows),
    known_model_invocations: calls(rows),
    api_model_calls: live.some(row => row.model_usage_unknown) ? null : calls(live),
    known_api_model_calls: calls(live),
    simulated_model_invocations: simulated.some(row => row.model_usage_unknown) ? null : calls(simulated),
    actual_mcp_tool_calls: runs.reduce((n, run) => n + run.tool_calls, 0),
    actual_mcp_tool_errors: runs.reduce((n, run) => n + run.events.filter(event => event.tool && event.status === 'failed').length, 0),
    model_errors: modelEvents.filter(event => event.type === 'model_failed').length,
    wall_duration_ms: executed.reduce((n, row) => n + row.result.duration_ms, 0),
    duration_and_tool_totals_complete: !rows.some(row => row.status === 'execution_failed' && !row.result),
    execution_observation_scope: 'Durations and tool/error totals cover returned terminal runs; interrupted no-result executions are incomplete, not measured zero.',
    usage_tokens: tokens(rows), live_api_usage_tokens: tokens(live),
    estimated_usage_cost_usd: usageIncomplete ? null : estimatedCost(rows),
    estimated_api_cost_usd: estimatedCost(live), simulated_estimated_cost_usd: estimatedCost(simulated),
    billing_cost_usd: null, server_cost_usd: null,
    cost_basis: 'Live API estimates use provider-reported usage times approved rates; simulated usage/cost is separate. Unresolved reservations remain in the authoritative shared budget. Not a billing receipt; server cost is unmeasured.',
    accuracy_scope: engine === 'openai' ? 'Assisted source proposals with code-label exposure; no independent endpoint-classification claim.'
      : engine === 'jev' ? 'Raw endpoint choices; reported code agreement/gates are a separate downstream stage.' : 'Deterministic code findings on inspected frozen evidence.',
    repeat_variability: repeatVariability(rows),
  };
}
export async function evaluateInvestigationDataset({ dataset, providers = {}, repeats = 1, budget = new OpenAISessionBudget(0),
  onCheckpoint = async () => {}, allowSynthetic = false } = {}) {
  validateInvestigationDataset(dataset, { allowSynthetic });
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10, 'Repeats must be 1–10');
  const engines = ['rules', ...['openai', 'jev'].filter(engine => providers[engine])];
  for (const engine of engines.filter(engine => engine !== 'rules')) assert.ok(['live_api', 'simulated_fixture'].includes(providers[engine].evidence_kind), 'Paid/simulated provider evidence kind required');
  const report = { version: 1, kind: 'matched_full_investigation_loop', dataset_id: dataset.id, dataset_sha256: sha(dataset),
    real_world_cases: dataset.real_world_cases === true, executed_at: new Date().toISOString(), status: 'running', repeats,
    clock_policy: 'Frozen analysis Date.now only in this isolated sequential evaluator; wall clock during provider calls. Event ISO timestamps and performance/native deadlines are actual execution time.',
    evidence_policy: 'Identical frozen source/endpoint cohort and actual in-memory MCP evidence for every engine. Gold, adjudication and prose are grading-only. Production OpenAI code-derived labels remain visible and are explicitly assisted evaluation.',
    scope_policy: 'Bounded selected cohort, not full national production inventory. Existing adaptive tools and production source/endpoint caps are unchanged; omitted work is never scored as a correct decision.',
    provenance: dataset.provenance ?? null, limitations: dataset.limitations ?? [], replay_preflight: [], results: [], summaries: {},
    shared_budget_before: budget.summary(), shared_budget_after: null,
    operations: { publisher_requests: 0, production_mcp_requests: 0, registry_changes: 0, scheduled_jobs_started: 0,
      paid_retry_or_resume: false, tracing_enabled: false, model_output_storage_requested: false } };
  // All replay manifests are verified before the first model request or credential read.
  for (const group of dataset.groups) report.replay_preflight.push({ group_id: group.id, ...await verifyFrozenMcpReplay(group, dataset) });
  for (let repeat = 0; repeat < repeats; repeat++) for (let index = 0; index < dataset.groups.length; index++) {
    const group = dataset.groups[index], offset = (repeat + index) % engines.length;
    for (const engine of [...engines.slice(offset), ...engines.slice(0, offset)]) report.results.push({ group_id: group.id, country: group.country,
      selected_date: group.date, repeat: repeat + 1, engine, evidence_kind: engine === 'rules' ? 'offline_actual_MCP' : providers[engine].evidence_kind,
      eligible_source_ids: group.source_ids, eligible_endpoint_ids: group.endpoint_ids,
      eligible_endpoint_pairs: group.gold.map(({ source_id, endpoint_id }) => ({ source_id, endpoint_id })),
      status: 'not_started', result: null });
  }
  await onCheckpoint(report);
  let stopPaidReason = null;
  const providerStops = new Map(), consecutiveFailures = new Map();
  for (const row of report.results) {
    const stopped = row.engine !== 'rules' && (stopPaidReason ?? providerStops.get(row.engine));
    if (stopped) { row.status = 'not_run_due_to_paid_guard'; row.reason = stopped;
      report.summaries = Object.fromEntries(engines.map(engine => [engine, summarizeInvestigationEvaluation(report.results, engine)]));
      await onCheckpoint(report); continue; }
    const group = dataset.groups.find(group => group.id === row.group_id);
    row.status = 'running'; await onCheckpoint(report);
    try {
      row.result = await executeFrozenInvestigation(group, dataset, row.engine, providers[row.engine], budget);
      row.status = row.result.execution_status;
    } catch (error) {
      // Do not advance to another case while a nonterminating SDK task could still reserve budget.
      row.status = 'execution_failed'; row.error = safeError(error); report.status = 'interrupted_requires_review';
      if (row.engine !== 'rules') row.model_usage_unknown = true;
      report.shared_budget_after = budget.summary();
      report.summaries = Object.fromEntries(engines.map(engine => [engine, summarizeInvestigationEvaluation(report.results, engine)]));
      await onCheckpoint(report); throw error;
    }
    const errorCodes = [row.result.error, row.result.run?.summary, ...(row.result.run?.events ?? []).map(event => event.error)].filter(Boolean);
    if (row.engine !== 'rules' && errorCodes.some(code => /SESSION_BUDGET|RUN_BUDGET|COST_BOUND|USAGE_MISSING|USAGE_COST_UNKNOWN|EXECUTION_NOT_AUTHORIZED|KEY_SOURCE/.test(code)))
      stopPaidReason = 'AUTHORITATIVE_BUDGET_OR_USAGE_GUARD_STOPPED_PAID_EXECUTION';
    if (row.engine !== 'rules') {
      const modelHttp = (row.result.run?.events ?? []).filter(event => event.type === 'model_failed')
        .map(event => event.result?.http_status ?? event.http_status);
      if (modelHttp.some(status => [401, 403, 429].includes(Number(status))))
        providerStops.set(row.engine, 'PROVIDER_AUTH_ACCESS_OR_RATE_FAILURE_STOPPED_FURTHER_EXECUTION');
      if (errorCodes.some(code => /PRICED_MODEL/.test(code)))
        providerStops.set(row.engine, 'PROVIDER_PRICED_MODEL_MISMATCH_STOPPED_FURTHER_EXECUTION');
      const failed = ['execution_failed', 'start_failed', 'timeout'].includes(row.result.execution_status);
      consecutiveFailures.set(row.engine, failed ? (consecutiveFailures.get(row.engine) ?? 0) + 1 : 0);
      if (consecutiveFailures.get(row.engine) >= 3)
        providerStops.set(row.engine, 'THREE_CONSECUTIVE_PROVIDER_EXECUTION_FAILURES_STOPPED_FURTHER_EXECUTION');
    }
    report.shared_budget_after = budget.summary();
    report.summaries = Object.fromEntries(engines.map(engine => [engine, summarizeInvestigationEvaluation(report.results, engine)]));
    await onCheckpoint(report);
  }
  report.status = report.results.every(row => row.status === 'completed') ? 'completed' : 'partial_or_failed';
  report.shared_budget_after = budget.summary();
  report.summaries = Object.fromEntries(engines.map(engine => [engine, summarizeInvestigationEvaluation(report.results, engine)]));
  await onCheckpoint(report); return report;
}

/** Fail closed rather than constructing a fresh database, budget ID or allowance. */
export function preflightApprovedBudget(path, budgetId = APPROVED_BUDGET_ID, limitUsd = APPROVED_BUDGET_LIMIT_USD) {
  if (budgetId !== APPROVED_BUDGET_ID || limitUsd !== APPROVED_BUDGET_LIMIT_USD) throw Error('EVALUATION_APPROVED_BUDGET_MISMATCH');
  let info; try { info = lstatSync(path); } catch { throw Error('EVALUATION_EXISTING_BUDGET_REQUIRED'); }
  if (!info.isFile() || info.isSymbolicLink()) throw Error('EVALUATION_UNSAFE_BUDGET_PATH');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT limit_usd,held_usd FROM model_budgets WHERE id=?').get(budgetId);
    if (!row || Number(row.limit_usd) !== limitUsd || !Number.isFinite(Number(row.held_usd)) || Number(row.held_usd) < 0)
      throw Error('EVALUATION_EXISTING_APPROVED_BUDGET_REQUIRED');
    return { budget_id: budgetId, authorization_limit_usd: Number(row.limit_usd), estimated_or_reserved_usd: Number(row.held_usd),
      remaining_usd: Math.max(0, Number(row.limit_usd) - Number(row.held_usd)), existing_ledger: true };
  } finally { db.close(); }
}
/** Exclusive new private file; a crash checkpoint is never interpreted as permission to rerun paid work. */
export function createPrivateResultFile(output) {
  const absolute = resolve(output), root = parse(absolute).root;
  let current = root;
  for (const part of dirname(absolute).slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { const info = lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) throw Error('EVALUATION_UNSAFE_OUTPUT_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(current, { mode: 0o700 }); }
  }
  const fd = openSync(absolute, 'wx', 0o600);
  return { path: absolute, checkpoint(report) { const text = JSON.stringify(report, null, 2) + '\n'; ftruncateSync(fd, 0); writeSync(fd, text, 0, 'utf8'); fsyncSync(fd); },
    close() { closeSync(fd); } };
}
export function parseInvestigationEvaluationOptions(args) {
  const options = { cases: null, provider: 'rules', output: null, repeats: 1 };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const [flag, inline] = args[index].split('=', 2);
    if (!['--cases', '--provider', '--output', '--repeats'].includes(flag) || seen.has(flag)) throw Error('EVALUATION_USAGE_INVALID');
    seen.add(flag); const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw Error('EVALUATION_USAGE_INVALID');
    options[flag.slice(2)] = flag === '--repeats' ? Number(value) : value;
  }
  if (!options.cases || !options.output || !['rules', 'openai', 'jev', 'all'].includes(options.provider)
    || !Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 10) throw Error('EVALUATION_USAGE_INVALID');
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseInvestigationEvaluationOptions(args), dataset = JSON.parse(readFileSync(resolve(options.cases), 'utf8'));
  validateInvestigationDataset(dataset);
  const output = createPrivateResultFile(options.output), providers = {};
  let budget = new OpenAISessionBudget(0);
  try {
    if (options.provider !== 'rules') {
      const openai = openAIPolicy(), jev = jevPolicy();
      const selected = options.provider === 'all' ? ['openai', 'jev'] : [options.provider];
      for (const engine of selected) {
        const policy = engine === 'openai' ? openai : jev, readiness = engine === 'openai' ? openAIReadiness(policy) : jevReadiness(policy);
        if (!readiness.available) throw Error(engine === 'openai' ? 'OPENAI_EXECUTION_NOT_AUTHORIZED' : 'JEV_EXECUTION_NOT_AUTHORIZED');
        if (policy.totalBudgetUsd !== APPROVED_BUDGET_LIMIT_USD) throw Error('EVALUATION_APPROVED_BUDGET_MISMATCH');
      }
      const path = process.env.WNS_QUALITY_BUDGET_PATH;
      if (!path) throw Error('EVALUATION_EXISTING_BUDGET_PATH_REQUIRED');
      const id = process.env.WNS_QUALITY_BUDGET_ID ?? APPROVED_BUDGET_ID;
      preflightApprovedBudget(path, id);
      budget = new PersistentModelBudget(path, APPROVED_BUDGET_LIMIT_USD, id);
      if (selected.includes('openai')) providers.openai = { evidence_kind: 'live_api', policy: openai, createModel: () => createPaidOpenAIModel(openai) };
      if (selected.includes('jev')) providers.jev = { evidence_kind: 'live_api', policy: jev, createClient: shared => createPaidJevClient(jev, shared) };
    }
    const report = await evaluateInvestigationDataset({ dataset, providers, repeats: options.repeats, budget,
      onCheckpoint: report => output.checkpoint(report) });
    console.log(JSON.stringify({ status: report.status, dataset_id: report.dataset_id, repeats: report.repeats,
      output: output.path, summaries: report.summaries, shared_budget: report.shared_budget_after }, null, 2));
    if (report.status !== 'completed') process.exitCode = 1;
    return report;
  } finally { output.close(); if (typeof budget.close === 'function') budget.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
