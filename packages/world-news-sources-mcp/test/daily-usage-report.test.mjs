import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import collector, { aggregateStatements, dailyReport, validateReportDay } from '../metrics/worker.mjs';

const fixedNow = new Date('2026-10-24T12:00:00Z');
const reportSecret = 'local-report-read-scope-unique-key-123456789';
const writeSecret = 'local-report-write-scope-different-key-123456';
const key = 'a'.repeat(64), other = 'b'.repeat(64);
function database() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../metrics/schema.sql', import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      return {bind(...args) {return {
        async all() {return {results: raw.prepare(sql).all(...args)};},
        async first() {return raw.prepare(sql).get(...args) ?? null;},
        async run() {return raw.prepare(sql).run(...args);}, sql, args,
      };}};
    },
    async batch(statements) {
      raw.exec('BEGIN IMMEDIATE');
      try { for (const {sql, args} of statements) raw.prepare(sql).run(...args); raw.exec('COMMIT'); }
      catch(error) {raw.exec('ROLLBACK'); throw error;}
    },
  };
  return {raw, env: {DB, METRICS_REPORT_SECRET: reportSecret, METRICS_WRITE_SECRET: writeSecret, REPEAT_USAGE_ENABLED: '1'}};
}
const value = (overrides = {}) => ({tool: 'search_sources', traffic: 'unclassified', outcome: 'success', duration_ms: 10,
  product: {channel: 'mcp', identity: 'provided', actor_key: key, search: 'nonempty'}, ...overrides});
const add = (env, event, day = '2026-10-23') => env.DB.batch(aggregateStatements(env.DB, event, new Date(`${day}T12:00:00Z`), true));
const reportUrl = query => new URL(`https://metrics.example/v1/daily-report${query}`);

test('daily report accepts one exact closed UTC day within 30 days and no arbitrary query options', () => {
  for (const day of ['2026-10-23', '2026-09-24']) assert.equal(validateReportDay(reportUrl(`?day=${day}`), fixedNow), day);
  for (const query of ['', '?day=2026-10-24', '?day=2026-10-25', '?day=2026-09-23', '?day=2026-02-30',
    '?day=2026-10-23&day=2026-10-23', '?day=2026-10-23&sql=SELECT', '?day=2026-10-23&limit=1', '?day=2026-1-2', '?day=2026-10-23T00:00:00Z']) {
    assert.throws(() => validateReportDay(reportUrl(query), fixedNow));
  }
});

test('private report uses independent read credentials, fixed GET route and no-store on errors', async () => {
  const {raw, env} = database();
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const request = (secret = reportSecret, method = 'GET', query = `?day=${yesterday}`) => new Request(reportUrl(query), {method, headers: {authorization: `Bearer ${secret}`}});
    for (const secret of [writeSecret, 'wrong', '']) {
      const response = await collector.fetch(request(secret), env);
      assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await collector.fetch(request(reportSecret, 'POST'), env)).status, 405);
    assert.equal((await collector.fetch(request(reportSecret, 'GET', `?day=${yesterday}&extra=1`), env)).status, 400);
    const response = await collector.fetch(request(), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).day, yesterday);
    const write = new Request('https://metrics.example/v1/aggregate', {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${reportSecret}`}, body: JSON.stringify(value())});
    assert.equal((await collector.fetch(write, env)).status, 401);
    const broken = {...env, DB: {prepare() {throw new Error('must not reveal SQL or private values');}}};
    const failed = await collector.fetch(request(), broken);
    assert.equal(failed.status, 503); assert.equal(await failed.text(), 'Report unavailable');
  } finally {raw.close();}
});

test('daily report keeps declared inspection, unclassified and web exports separate without exposing keys', async () => {
  const {raw, env} = database();
  try {
    for (const search of ['nonempty', 'zero_matches', 'empty_page', 'unknown']) await add(env, value({product: {channel: 'mcp', identity: 'missing', search}}));
    await add(env, value({traffic: 'inspection', product: {channel: 'mcp', identity: 'excluded', search: 'nonempty'}}));
    await add(env, value({tool: 'export_source_pack', product: {channel: 'mcp', identity: 'provided', actor_key: key, export: 'nonempty'}}));
    await add(env, value({tool: 'export_source_pack', product: {channel: 'web_export', identity: 'excluded', export: 'empty'}}));
    await add(env, value({tool: 'export_source_pack', traffic: 'inspection', product: {channel: 'web_export', identity: 'excluded', export: 'nonempty'}}));
    const report = await dailyReport(env, '2026-10-23', fixedNow);
    assert.equal(report.product.length, 4);
    const mcp = report.product.find(row => row.traffic === 'unclassified' && row.channel === 'mcp');
    assert.equal(mcp.known_successful_searches, 3); assert.equal(mcp.search_zero_matches, 1);
    assert.equal(mcp.search_empty_page, 1); assert.equal(mcp.search_unknown, 1); assert.equal(mcp.zero_match_percent, 33.33);
    assert.equal(mcp.successful_exports, 1); assert.equal(mcp.export_nonempty, 1); assert.equal(mcp.identity_missing, 4);
    assert.equal(report.product.find(row => row.channel === 'web_export' && row.traffic === 'unclassified').export_empty, 1);
    assert.deepEqual(report.calls.map(row => [row.traffic, row.calls]), [['inspection', 1], ['unclassified', 5]]);
    assert.equal(report.repeat.observed_keys, 1); assert.equal(report.repeat.status, 'observed');
    assert.equal(report.repeat.lookback_complete, false); assert.equal(report.coverage.product_complete, false);
    assert.ok(!JSON.stringify(report).includes(key)); assert.ok(!JSON.stringify(report).includes('actor_key'));
  } finally {raw.close();}
});

test('return counts require a previous UTC day in the prior seven days and retained presence', async () => {
  const {raw, env} = database();
  try {
    await add(env, value(), '2026-10-16');
    await add(env, value(), '2026-10-23'); await add(env, value(), '2026-10-23');
    await add(env, value({product: {channel: 'mcp', identity: 'provided', actor_key: other, search: 'nonempty'}}), '2026-10-15');
    await add(env, value({product: {channel: 'mcp', identity: 'provided', actor_key: other, search: 'nonempty'}}), '2026-10-23');
    const report = await dailyReport(env, '2026-10-23', fixedNow);
    assert.equal(report.repeat.observed_keys, 2); assert.equal(report.repeat.returning_keys_prior_7_days, 1);
    assert.equal(report.repeat.lookback_complete, true); assert.equal(report.coverage.lookback_days_available, 7);
    // Stale expired rows must not leak counts if scheduled pruning was delayed.
    await add(env, value(), '2026-09-24');
    const expired = await dailyReport(env, '2026-09-24', fixedNow);
    assert.equal(expired.product[0].identity_provided, 1);
    assert.equal(expired.repeat.observed_keys, null);
    assert.equal(expired.repeat.returning_keys_prior_7_days, null);
    assert.equal(expired.coverage.first_presence_day, null);
  } finally {raw.close();}
});

test('unobserved data and disabled or missing identity coverage remain null rather than fabricated zero', async () => {
  const {raw, env} = database();
  try {
    let report = await dailyReport(env, '2026-10-23', fixedNow);
    assert.deepEqual(report.product, []); assert.deepEqual(report.calls, []);
    assert.equal(report.coverage.product_status, 'unobserved'); assert.equal(report.repeat.observed_keys, null);
    await add(env, value({product: {channel: 'mcp', identity: 'missing', search: 'nonempty'}}));
    report = await dailyReport(env, '2026-10-23', fixedNow);
    assert.equal(report.repeat.status, 'unobserved'); assert.equal(report.repeat.returning_keys_prior_7_days, null);
    await add(env, value());
    report = await dailyReport({...env, REPEAT_USAGE_ENABLED: '0'}, '2026-10-23', fixedNow);
    assert.equal(report.repeat.status, 'disabled'); assert.equal(report.repeat.observed_keys, null);
    assert.equal(report.repeat.returning_keys_prior_7_days, null);
  } finally {raw.close();}
});
