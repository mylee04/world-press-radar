#!/usr/bin/env node
/**
 * Default: offline rules evaluation. Explicit --provider enables authorized bounded API comparisons.
 * All evidence is the same synthetic fixture set; expected labels and descriptive answers are never sent to providers.
 * Usage: node scripts/evaluate-quality.mjs [--provider openai|jev|all] [--output <new-result.json>]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { normalizeRegistry } from '../dist/catalog.js';
import { ActivityStore } from '../dist/activity.js';
import { HealthStore } from '../dist/health.js';
import { getSourceQualityDetail } from '../dist/quality.js';
import { openAIPolicy, openAIReadiness, createPaidOpenAIModel } from '../dist/openai-runtime.js';
import { OpenAIQualityEvaluator } from '../dist/openai-quality-evaluation.js';
import { jevPolicy, jevReadiness, createPaidJevClient } from '../dist/jev-runtime.js';
import { classifyWithJev } from '../dist/jev-investigation.js';
import { classificationCriteria, classificationInstructions, confirmationInstructions } from '../dist/quality-decision.js';

const caseFile = new URL('../evaluation/cases.json', import.meta.url);
const successStatuses = new Set(['working_nonempty', 'valid_empty']);
const has = (object, key) => Object.hasOwn(object, key);

export function loadQualityCases() {
  return JSON.parse(readFileSync(caseFile, 'utf8'));
}

function validateCases(dataset) {
  if (dataset.version !== 1 || dataset.fixture_set !== true || !Array.isArray(dataset.cases) || !dataset.cases.length)
    throw new Error('Evaluation requires a nonempty explicitly synthetic v1 fixture set');
  if (!Number.isFinite(Date.parse(dataset.now)) || !/^\d{4}-\d{2}-\d{2}$/.test(dataset.selected_date))
    throw new Error('Evaluation requires a fixed clock and selected UTC date');
  const ids = new Set();
  for (const fixture of dataset.cases) {
    if (!fixture.id || ids.has(fixture.id)) throw new Error('Evaluation case IDs must be unique');
    ids.add(fixture.id);
    if (!['en', 'ko', 'ja'].includes(fixture.language) || !Array.isArray(fixture.collections)
      || typeof fixture.expected?.classification !== 'string' || typeof fixture.expected?.requires_live_confirmation !== 'boolean')
      throw new Error(`Invalid fixed-case label: ${fixture.id}`);
    // Reserved example domains make it explicit these endpoints are never live publisher targets.
    const hostname = new URL(fixture.endpoint.url).hostname;
    if (!hostname.endsWith('.example')) throw new Error(`Fixture URL must use a reserved .example domain: ${fixture.id}`);
    for (const collection of fixture.collections) {
      if (!Number.isFinite(Date.parse(collection.at))) throw new Error(`Invalid fixture observation time: ${fixture.id}`);
      if (has(collection, 'new_urls') && (!Number.isInteger(collection.new_urls) || collection.new_urls < 0))
        throw new Error(`Invalid fixture first-discovery count: ${fixture.id}`);
      if (collection.baseline && collection.new_urls !== 0)
        throw new Error(`A fixture baseline cannot contribute first discoveries: ${fixture.id}`);
    }
  }
}

/** Hydrate simplified fixtures into the existing stores rather than reimplementing their decisions. */
function fixtureStores(dataset, fixture) {
  const catalog = normalizeRegistry({ countries: [{ code: fixture.country, name: fixture.country, feeds: [{
    name: fixture.name, language: fixture.language, enabled: true,
    [fixture.endpoint.type === 'rss' ? 'url' : 'sitemapUrl']: fixture.endpoint.url,
  }] }] });
  const source = catalog.sources[0], endpoint = source.endpoints[0];
  const collections = fixture.collections.map((row, index) => ({
    id: `fixture:${fixture.id}:${index}`, endpoint_id: endpoint.id, checked_at: row.at,
    status: row.status, format: row.format, reason: row.reason ?? null,
    source_ids: [source.id], countries: [fixture.country],
    source_new: { [source.id]: row.new_urls ?? 0 }, country_new: { [fixture.country]: row.new_urls ?? 0 },
    baseline_sources: row.baseline ? [source.id] : [],
    observed_urls: successStatuses.has(row.status) && row.format !== 'sitemapindex' ? row.new_urls ?? 0 : 0,
    uncertain_urls: 0, index_children_excluded: row.format === 'sitemapindex',
  })).sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));
  const first = collections[0]?.checked_at ?? null, last = collections.at(-1)?.checked_at ?? null;
  const activity = new ActivityStore({
    version: 1, lane: 'production', generated_at: dataset.snapshot_at,
    tracking_start: first, available_since: dataset.available_since, registry_at: dataset.snapshot_at,
    semantics: 'Synthetic fixture: first-discovered candidate URL counts; binding baselines excluded; not publication counts.',
    bindings: [{ source_id: source.id, endpoint_id: endpoint.id, baseline_at: fixture.baseline_at,
      first_observed_at: first, last_attempt_at: last }],
    collections,
    scope_starts: { source: first ? { [source.id]: first } : {}, country: first ? { [fixture.country]: first } : {} },
    // The fixed watermark intentionally leaves the selected day partial.
    scope_latest: { source: last ? { [source.id]: last } : {}, country: { [fixture.country]: dataset.snapshot_at } },
  });
  const health = new HealthStore({ version: 1, observations: fixture.health ? [{
    endpointId: endpoint.id, type: endpoint.type, url: endpoint.url, ...fixture.health,
  }] : [] });
  return { catalog, source, activity, health };
}

/** No labels, rule result, source reputation, description or label_reason can leak into model evidence. */
export function fixedCaseModelEvidence(dataset, fixture) {
  return { selected_date: dataset.selected_date, fixed_analysis_clock: dataset.now,
    snapshot_at: dataset.snapshot_at, language: fixture.language, country: fixture.country,
    endpoint_type: fixture.endpoint.type, baseline_at: fixture.baseline_at,
    collections: fixture.collections.map(row => ({ at: row.at, status: row.status, format: row.format ?? null,
      new_urls: has(row, 'new_urls') ? row.new_urls : null, baseline: row.baseline === true,
      reason: row.reason ?? null })), saved_health: fixture.health ?? null,
    semantics: 'First-discovered candidate article URLs after binding baseline, not publications. Final saved day partial. Collection history may be absent. This is synthetic evidence, never a current live observation.' };
}

export function summarizeQualityResults(rows) {
  const total = rows.length, correct = rows.filter(row => row.classification_correct).length;
  const counts = {
    true_positive_findings: 0, false_positive_findings: 0, true_negative_findings: 0, missed_relevant_findings: 0,
  };
  for (const row of rows) {
    const expected = row.expected.requires_live_confirmation, observed = row.observed.requires_live_confirmation;
    if (expected && observed) counts.true_positive_findings++;
    else if (!expected && observed) counts.false_positive_findings++;
    else if (expected && !observed) counts.missed_relevant_findings++;
    else counts.true_negative_findings++;
  }
  const negative = counts.true_negative_findings + counts.false_positive_findings;
  const positive = counts.true_positive_findings + counts.missed_relevant_findings;
  return {
    total_cases: total, exact_classification_correct: correct,
    exact_classification_accuracy: total ? correct / total : null,
    evidence_contract_failures: rows.filter(row => row.evidence_mismatches.length).length,
    ...counts,
    false_positive_rate: negative ? counts.false_positive_findings / negative : null,
    missed_relevant_finding_rate: positive ? counts.missed_relevant_findings / positive : null,
    duration_ms: rows.reduce((n, row) => n + row.duration_ms, 0),
    finding_definition: 'An endpoint finding explicitly requiring live confirmation of failure, access failure, or stale content. This is not a confirmed outage; unknown tracking and missing content dates remain separate labels.',
  };
}

export function evaluateQualityCases(dataset = loadQualityCases()) {
  validateCases(dataset);
  const started = performance.now(), now = Date.parse(dataset.now);
  const rows = dataset.cases.map(fixture => {
    const caseStarted = performance.now();
    const { catalog, source, activity, health } = fixtureStores(dataset, fixture);
    const detail = getSourceQualityDetail(catalog, activity, health, { source_id: source.id, date: dataset.selected_date }, now);
    if (detail.endpoints.length !== 1) throw new Error(`Expected a single fixture endpoint: ${fixture.id}`);
    const endpoint = detail.endpoints[0];
    const observed = {
      classification: endpoint.classification, requires_live_confirmation: endpoint.requires_live_confirmation,
      daily_discoveries: detail.article_activity.daily.new_unique_candidate_urls,
      initialization: detail.initialization, content_freshness: endpoint.health.content_freshness,
      newest_content_at: endpoint.health.newest_content_at,
    };
    const evidenceMismatches = Object.keys(fixture.expected).filter(key => key !== 'classification'
      && observed[key] !== fixture.expected[key]).map(key => ({ field: key, expected: fixture.expected[key], observed: observed[key] }));
    return { id: fixture.id, language: fixture.language, country: fixture.country, synthetic_fixture: true,
      description: fixture.description, label_reason: fixture.label_reason,
      expected: fixture.expected, observed, classification_correct: observed.classification === fixture.expected.classification,
      evidence_mismatches: evidenceMismatches, evidence: endpoint.evidence,
      period: detail.period, duration_ms: performance.now() - caseStarted };
  });
  const metrics = summarizeQualityResults(rows);
  const byLanguage = Object.fromEntries(['en', 'ko', 'ja'].map(language => [language,
    summarizeQualityResults(rows.filter(row => row.language === language))]));
  return {
    version: 1, case_set_id: dataset.id,
    case_set_sha256: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
    executed_at: new Date().toISOString(), fixed_analysis_clock: dataset.now,
    synthetic_fixtures: true, provenance: dataset.provenance, limitations: dataset.limitations,
    status: rows.every(row => row.classification_correct && !row.evidence_mismatches.length) ? 'passed' : 'failed',
    rules: { status: 'completed', metrics, by_language: byLanguage, wall_duration_ms: performance.now() - started,
      model_calls: 0, api_cost: { currency: 'USD', amount: 0, evidence: 'Offline code execution; no model or API provider called.' },
      server_cost: { amount: null, status: 'not_measured' } },
    comparisons: [
      { method: 'rules', status: 'completed', result: 'rules' },
      { method: 'typesafe_jev', status: 'not_run', model_calls: 0, metrics: null, usage_tokens: null, api_cost: null,
        reason: 'No authorized paid comparison or provider usage evidence. No performance or price estimate is fabricated.' },
      { method: 'generic_low_cost_llm', status: 'not_run', model_calls: 0, metrics: null, usage_tokens: null, api_cost: null,
        reason: 'No authorized paid comparison or provider usage evidence. No performance or price estimate is fabricated.' },
    ],
    cases: rows,
  };
}

/** Injected providers must explicitly declare simulated/live; model quality is never inferred from fixture mocks. */
export async function compareQualityProviders({ dataset = loadQualityCases(), providers = {} } = {}) {
  const report = evaluateQualityCases(dataset);
  report.model_rubric_sha256 = createHash('sha256').update(JSON.stringify({ classificationCriteria,
    classificationInstructions, confirmationInstructions })).digest('hex');
  for (const [method, provider] of Object.entries(providers)) {
    if (!['typesafe_jev', 'generic_low_cost_llm'].includes(method) || !['live_api', 'simulated_fixture'].includes(provider.evidence_kind))
      throw Error('Evaluation provider must declare an allowed method and evidence_kind');
    const started = performance.now(), rows = [], observations = [];
    let calls = 0, knownInput = 0, knownOutput = 0, knownEstimate = 0, incompleteUsage = false;
    for (const fixture of dataset.cases) {
      const before = performance.now(), modelEvents = [];
      try {
        const value = await provider.evaluate(fixedCaseModelEvidence(dataset, fixture), event => modelEvents.push(event));
        if (!value || typeof value.decision?.classification !== 'string' || typeof value.decision?.requires_live_confirmation !== 'boolean'
          || !Number.isSafeInteger(value.usage?.input_tokens) || !Number.isSafeInteger(value.usage?.output_tokens)
          || value.usage.input_tokens < 0 || value.usage.output_tokens < 0 || !Number.isFinite(value.estimated_cost_usd) || value.estimated_cost_usd < 0)
          throw Error('PROVIDER_EVALUATION_CONTRACT_INVALID');
        calls += modelEvents.filter(event => event.type === 'model_started').length || 1;
        knownInput += value.usage.input_tokens; knownOutput += value.usage.output_tokens; knownEstimate += value.estimated_cost_usd;
        const observed = value.decision;
        rows.push({ id: fixture.id, language: fixture.language, country: fixture.country, status: 'completed',
          expected: { classification: fixture.expected.classification, requires_live_confirmation: fixture.expected.requires_live_confirmation },
          observed, classification_correct: observed.classification === fixture.expected.classification,
          evidence_mismatches: observed.requires_live_confirmation === fixture.expected.requires_live_confirmation ? []
            : [{ field: 'requires_live_confirmation', expected: fixture.expected.requires_live_confirmation, observed: observed.requires_live_confirmation }],
          model: value.model ?? provider.model ?? null, confidence: value.confidence ?? null,
          usage_tokens: value.usage, estimated_api_cost_usd: value.estimated_cost_usd, billing_cost_usd: null,
          duration_ms: performance.now() - before });
      } catch (error) {
        const startedCalls = modelEvents.filter(event => event.type === 'model_started').length;
        calls += startedCalls;
        const eventUsage = modelEvents.filter(event => event.usage);
        if (startedCalls && !eventUsage.length) incompleteUsage = true;
        for (const event of eventUsage) {
          knownInput += event.usage.input_tokens; knownOutput += event.usage.output_tokens;
          if (Number.isFinite(event.estimated_cost_usd)) knownEstimate += event.estimated_cost_usd;
          else incompleteUsage = true;
        }
        // Never echo SDK/provider error bodies that could contain keys, prompts or private reasoning.
        const code = typeof error?.message === 'string' && /^[A-Z_]{3,100}$/.test(error.message) ? error.message : 'PROVIDER_EVALUATION_FAILED';
        rows.push({ id: fixture.id, language: fixture.language, country: fixture.country, status: 'failed',
          error: code, duration_ms: performance.now() - before, observed: null, usage_tokens: null, billing_cost_usd: null });
      }
      observations.push(...modelEvents.map(({ type, status, model, duration_ms, usage, estimated_cost_usd, error, http_status }) =>
        ({ type, status, model, duration_ms, usage, estimated_cost_usd, error, http_status })));
      // Approval/context/usage failures are not retried. Remaining cases stay explicitly unexecuted.
      if (rows.at(-1).status === 'failed' && /BUDGET|USAGE_MISSING|COST_BOUND|NOT_AUTHORIZED/.test(rows.at(-1).error)) break;
    }
    const completed = rows.filter(row => row.status === 'completed');
    const outcome = { method, model: provider.model ?? completed[0]?.model ?? null,
      status: rows.length === dataset.cases.length && completed.length === rows.length ? 'completed' : 'partial_or_failed',
      evidence_kind: provider.evidence_kind, synthetic_fixtures: true, intended_cases: dataset.cases.length,
      evaluated_cases: completed.length, failed_cases: rows.filter(row => row.status === 'failed').length,
      unexecuted_cases: dataset.cases.length - rows.length, model_calls: calls,
      metrics: summarizeQualityResults(completed),
      by_language: Object.fromEntries(['en', 'ko', 'ja'].map(language => [language,
        { ...summarizeQualityResults(completed.filter(row => row.language === language)),
          intended_cases: dataset.cases.filter(row => row.language === language).length,
          failed_cases: rows.filter(row => row.language === language && row.status === 'failed').length }])),
      wall_duration_ms: performance.now() - started,
      configured_pricing: provider.pricing ?? null,
      usage_tokens: incompleteUsage ? null : { input_tokens: knownInput, output_tokens: knownOutput },
      known_usage_tokens: { input_tokens: knownInput, output_tokens: knownOutput },
      api_cost: { currency: 'USD', amount: null, estimated_amount: incompleteUsage ? null : knownEstimate,
        known_estimated_amount: knownEstimate, billing_status: 'not_available',
        evidence: provider.evidence_kind === 'live_api' ? 'Provider-reported token usage times configured rates; not a billing receipt.'
          : 'Simulated fixture usage for contract testing only; not API spend or model accuracy evidence.' },
      cases: rows, observations,
      limitations: ['Ten synthetic cases; language counts are small and cannot establish production accuracy.',
        'Grouped by source-language label; mostly structured evidence, not a multilingual semantic benchmark.',
        'Metrics exclude failed/unexecuted cases; evaluate coverage alongside accuracy.',
        'Label descriptions and rule-derived classifications were excluded from provider inputs.'] };
    const index = report.comparisons.findIndex(row => row.method === method); report.comparisons[index] = outcome;
  }
  report.comparison_execution_status = !Object.keys(providers).length ? 'not_run'
    : report.comparisons.filter(row => Object.hasOwn(providers, row.method)).every(row => row.status === 'completed')
      ? 'completed' : 'partial_or_failed';
  return report;
}

function parseArguments(args) {
  let output, provider;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  for (let i = 0; i < args.length; i++) {
    if (!['--output', '--provider'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Usage: node scripts/evaluate-quality.mjs [--provider openai|jev|all] [--output <new-result.json>]');
    if (args[i] === '--output') { if (output !== undefined) throw Error('Usage: duplicate --output'); output = resolve(args[++i]); }
    else { if (provider !== undefined || !['openai', 'jev', 'all'].includes(args[i + 1])) throw Error('Usage: --provider openai|jev|all'); provider = args[++i]; }
  }
  return { output, provider };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/evaluate-quality.mjs [--provider openai|jev|all] [--output <new-result.json>]\nDefault: offline synthetic fixtures. Providers require explicit paid approval, credentials, configured rates, and a shared WNS_QUALITY_TOTAL_BUDGET_USD. Outputs must be new files.\n');
    return;
  }
  if (options.output) {
    // Refuse bad output destinations before credential parsing or any paid provider invocation.
    try { lstatSync(options.output); const error = Error('Output file already exists'); error.code = 'EEXIST'; throw error; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!statSync(dirname(options.output)).isDirectory()) throw Error('Output parent must be an existing directory');
  }
  let result;
  if (!options.provider) result = evaluateQualityCases();
  else {
    const commonLimit = Number(process.env.WNS_QUALITY_TOTAL_BUDGET_USD);
    if (!(commonLimit > 0) || !Number.isFinite(commonLimit)) throw Error('QUALITY_SHARED_BUDGET_REQUIRED');
    const { PersistentModelBudget } = await import('../dist/quality-runtime-storage.js');
    const budgetPath = process.env.WNS_QUALITY_BUDGET_PATH || fileURLToPath(new URL('../output/news-quality/runtime.sqlite', import.meta.url));
    const budget = new PersistentModelBudget(budgetPath, commonLimit, process.env.WNS_QUALITY_BUDGET_ID || 'news-quality-pilot-20261013');
    try {
    const providers = {}, blocked = [];
    if (['openai', 'all'].includes(options.provider)) {
      const policy = openAIPolicy(); policy.totalBudgetUsd = Math.min(policy.totalBudgetUsd, commonLimit);
      policy.maxModelCalls = loadQualityCases().cases.length;
      const ready = openAIReadiness(policy);
      if (ready.available) {
        const evaluator = new OpenAIQualityEvaluator(policy, createPaidOpenAIModel(policy), budget);
        providers.generic_low_cost_llm = { evidence_kind: 'live_api', model: policy.model,
          pricing: { input_usd_per_million: policy.inputUsdPerMillion, output_usd_per_million: policy.outputUsdPerMillion,
            cache_discount: 'not_applied; conservative_estimate' },
          evaluate: (evidence, onModel) => evaluator.classify(evidence, { onModel }) };
      } else blocked.push({ method: 'generic_low_cost_llm', ...ready });
    }
    if (['jev', 'all'].includes(options.provider)) {
      const policy = jevPolicy(); policy.totalBudgetUsd = Math.min(policy.totalBudgetUsd, commonLimit);
      const ready = jevReadiness(policy);
      if (ready.available) {
        const client = createPaidJevClient(policy, budget);
        providers.typesafe_jev = { evidence_kind: 'live_api', model: policy.model,
          pricing: { input_usd_per_million: policy.inputUsdPerMillion, output_usd_per_million: 0 },
          evaluate: (evidence, onModel) => classifyWithJev(client, evidence, { onModel }) };
      } else blocked.push({ method: 'typesafe_jev', ...ready });
    }
    result = await compareQualityProviders({ providers });
    for (const item of blocked) {
      const row = result.comparisons.find(row => row.method === item.method); row.reason = item.reason; row.readiness = item;
    }
    result.shared_budget = budget.summary();
    } finally { budget.close(); }
  }
  const json = `${JSON.stringify(result, null, 2)}\n`;
  // Write exactly the user-requested path. Refuse to overwrite an existing file or follow a leaf symlink.
  if (options.output) writeFileSync(options.output, json, { flag: 'wx', mode: 0o600 });
  process.stdout.write(json);
  if (result.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    const message = error?.code === 'EEXIST' ? 'Output file already exists; choose a new result path.' : error.message;
    process.stderr.write(`Quality evaluation failed: ${message}\n`);
    process.exitCode = 1;
  }
}
