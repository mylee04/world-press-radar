import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadQualityCases, evaluateQualityCases, summarizeQualityResults } from '../scripts/evaluate-quality.mjs';

const dataset = loadQualityCases();
const report = evaluateQualityCases(dataset);
const result = id => report.cases.find(row => row.id === id);
const script = new URL('../scripts/evaluate-quality.mjs', import.meta.url);

test('fixed labels describe explicitly synthetic English, Korean and Japanese cases', () => {
  assert.equal(dataset.fixture_set, true);
  assert.match(dataset.provenance, /Synthetic/);
  assert.deepEqual(new Set(dataset.cases.map(row => row.language)), new Set(['en', 'ko', 'ja']));
  assert.equal(dataset.cases.length, 10);
  assert.equal(new Set(dataset.cases.map(row => row.id)).size, 10);
  assert.ok(dataset.cases.every(row => new URL(row.endpoint.url).hostname.endsWith('.example')));
  assert.ok(dataset.cases.every(row => row.label_reason.length > 30));
});

for (const fixture of dataset.cases) {
  test(`fixed quality decision: ${fixture.id}`, () => {
    const row = result(fixture.id);
    assert.equal(row.observed.classification, fixture.expected.classification, fixture.label_reason);
    assert.deepEqual(row.evidence_mismatches, [], fixture.label_reason);
    assert.equal(row.evidence.current_live_state_verified, false);
    assert.equal(row.period.state, fixture.collections.length ? 'partial_snapshot_window' : 'not_tracked');
    assert.equal(row.period.observation_window_closed, false);
  });
}

test('failure, recovery and unavailable tracking keep distinct dated evidence', () => {
  const failed = result('donga-national-regression');
  assert.equal(failed.evidence.prior_success_at, '2026-10-10T01:00:00.000Z');
  assert.equal(failed.evidence.last_collection_status, 'timeout');
  assert.equal(failed.observed.daily_discoveries, null);
  const recovered = result('donga-science-recovery');
  assert.equal(recovered.evidence.health_observation_status, 'unhealthy');
  assert.equal(recovered.evidence.health_checked_at, '2026-10-11T01:00:00.000Z');
  assert.equal(recovered.evidence.last_collection_at, '2026-10-12T01:00:00.000Z');
  assert.equal(recovered.observed.daily_discoveries, 21);
  const missing = result('nyt-technology-untracked');
  assert.equal(missing.evidence.prior_success_at, null);
  assert.equal(missing.evidence.last_collection_at, null);
  assert.equal(missing.observed.daily_discoveries, null);
  assert.equal(missing.observed.initialization, 'not_initialized');
});

test('successful zero, index-only and missing dates do not become identical zero/freshness values', () => {
  const zero = result('texas-tribune-successful-zero');
  assert.equal(zero.observed.daily_discoveries, 0);
  assert.equal(zero.observed.requires_live_confirmation, false);
  const index = result('sitemap-index-only');
  assert.equal(index.observed.daily_discoveries, null);
  assert.equal(index.evidence.last_collection_status, 'working_nonempty');
  const undated = result('missing-content-dates');
  assert.equal(undated.observed.daily_discoveries, 4);
  assert.equal(undated.observed.content_freshness, 'missing');
  assert.equal(undated.observed.newest_content_at, null);
  const access = result('yomiuri-access-gap');
  assert.equal(access.evidence.prior_success_at, null);
  assert.equal(access.observed.requires_live_confirmation, true);
  assert.equal(access.observed.classification, 'access_failure_without_normal_baseline');
});

test('offline report records genuine durations and no invented model results or costs', () => {
  assert.equal(report.status, 'passed');
  assert.equal(report.rules.metrics.total_cases, 10);
  assert.equal(report.rules.metrics.exact_classification_accuracy, 1);
  assert.equal(report.rules.metrics.false_positive_findings, 0);
  assert.equal(report.rules.metrics.missed_relevant_findings, 0);
  assert.equal(report.rules.model_calls, 0);
  assert.deepEqual(report.rules.server_cost, { amount: null, status: 'not_measured' });
  assert.equal(report.rules.api_cost.amount, 0);
  assert.equal(report.rules.api_cost.currency, 'USD');
  assert.ok(report.rules.wall_duration_ms >= 0);
  assert.ok(report.cases.every(row => Number.isFinite(row.duration_ms) && row.duration_ms >= 0));
  assert.equal(report.rules.by_language.en.total_cases, 3);
  assert.equal(report.rules.by_language.ko.total_cases, 4);
  assert.equal(report.rules.by_language.ja.total_cases, 3);
  assert.match(report.rules.metrics.finding_definition, /not a confirmed outage/);
  for (const comparison of report.comparisons.filter(row => row.method !== 'rules')) {
    assert.equal(comparison.status, 'not_run');
    assert.equal(comparison.model_calls, 0);
    assert.equal(comparison.metrics, null);
    assert.equal(comparison.usage_tokens, null);
    assert.equal(comparison.api_cost, null);
  }
  assert.equal(report.case_set_sha256, evaluateQualityCases(dataset).case_set_sha256);
});

test('metrics count an explicit false positive and missed relevant finding independently of classification accuracy', () => {
  const row = (expected, observed, correct, duration) => ({
    expected: { requires_live_confirmation: expected }, observed: { requires_live_confirmation: observed },
    classification_correct: correct, evidence_mismatches: [], duration_ms: duration,
  });
  const metrics = summarizeQualityResults([
    row(true, true, true, 2), row(false, true, false, 3),
    row(true, false, false, 5), row(false, false, true, 7),
  ]);
  assert.equal(metrics.true_positive_findings, 1);
  assert.equal(metrics.false_positive_findings, 1);
  assert.equal(metrics.true_negative_findings, 1);
  assert.equal(metrics.missed_relevant_findings, 1);
  assert.equal(metrics.exact_classification_accuracy, 0.5);
  assert.equal(metrics.false_positive_rate, 0.5);
  assert.equal(metrics.missed_relevant_finding_rate, 0.5);
  assert.equal(metrics.duration_ms, 17);
  assert.equal(summarizeQualityResults([]).exact_classification_accuracy, null);
});

test('CLI writes only an explicitly named new result and never overwrites an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-evaluation-'));
  try {
    const output = join(dir, 'result.json');
    const run = spawnSync(process.execPath, [script.pathname, '--output', output], {
      cwd: dir, encoding: 'utf8', env: { ...process.env,
        OPENAI_API_KEY: 'fixture-marker-never-a-real-secret', TYPESAFE_API_KEY: 'fixture-provider-marker' },
    });
    assert.equal(run.status, 0, run.stderr);
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(written.status, 'passed');
    assert.deepEqual(written, JSON.parse(run.stdout));
    assert.deepEqual(readdirSync(dir), ['result.json']);
    assert.doesNotMatch(run.stdout + run.stderr, /fixture-marker-never-a-real-secret|fixture-provider-marker/);
    writeFileSync(output, 'preserve existing output');
    const again = spawnSync(process.execPath, [script.pathname, '--output', output], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already exists/);
    assert.equal(readFileSync(output, 'utf8'), 'preserve existing output');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI rejects unspecified positional paths and incomplete output flags before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-evaluation-options-'));
  try {
    for (const args of [['unexpected.json'], ['--output'], ['--output', '--help'], ['--unknown']]) {
      const run = spawnSync(process.execPath, [script.pathname, ...args], { cwd: dir, encoding: 'utf8' });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /Usage:/);
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
