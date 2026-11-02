import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import collector, {dailyReport, runtimeStatements, validateRuntimeAggregate} from '../metrics/worker.mjs';

const writeSecret = 'local-runtime-write-secret-1234567890123456';
const reportSecret = 'local-runtime-report-secret-123456789012345';
const now = new Date('2026-11-02T12:00:00Z');
const sample = extra => ({revision: 'cpu-optimized-v1', traffic: 'unclassified', route: 'mcp',
  outcome: 'success', overlap: false, cpu_us: 1200, wall_ms: 12, ...extra});
function database() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../metrics/schema.sql', import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {return {bind(...args) {return {sql, args,
      async all() {return {results: raw.prepare(sql).all(...args)};},
      async first() {return raw.prepare(sql).get(...args) ?? null;},
      async run() {return raw.prepare(sql).run(...args);},
    };}};},
    async batch(statements) {
      raw.exec('BEGIN IMMEDIATE');
      try {for (const {sql, args} of statements) raw.prepare(sql).run(...args); raw.exec('COMMIT');}
      catch (error) {raw.exec('ROLLBACK'); throw error;}
    },
  };
  return {raw, env: {DB, METRICS_WRITE_SECRET: writeSecret, METRICS_REPORT_SECRET: reportSecret}};
}
const request = (body, token = writeSecret) => new Request('https://metrics.example/v1/runtime-aggregate', {
  method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify(body),
});

test('runtime migration is additive and idempotent, preserving original counters', () => {
  const {raw} = database();
  try {
    raw.exec("DROP TABLE daily_runtime_cpu; INSERT INTO daily_tool_usage(day,tool,traffic,calls) VALUES ('2026-10-01','search_sources','inspection',5)");
    const migration = readFileSync(new URL('../metrics/migrations/0001-runtime-cpu.sql', import.meta.url), 'utf8');
    raw.exec(migration); raw.exec(migration);
    assert.equal(raw.prepare('SELECT calls FROM daily_tool_usage').get().calls, 5);
    assert.deepEqual(raw.prepare('PRAGMA table_info(daily_runtime_cpu)').all().map(r => r.name),
      ['day', 'traffic', 'route', 'outcome', 'revision', 'eligible_calls', 'overlap_calls', 'cpu_us', 'wall_ms']);
  } finally {raw.close();}
});

test('strict numeric projection distinguishes isolated zero CPU from overlapping unknown CPU', () => {
  for (const input of [sample({cpu_us: 0, wall_ms: 0}), sample({cpu_us: 120000000, wall_ms: 120000}),
    sample({overlap: true, cpu_us: null}), sample({traffic: 'inspection', route: 'health', outcome: 'error'})]) {
    assert.equal(validateRuntimeAggregate(input), input);
  }
  for (const input of [sample({cpu_us: null}), sample({overlap: true, cpu_us: 0}), sample({overlap: 1}),
    sample({cpu_us: -1}), sample({cpu_us: 0.1}), sample({cpu_us: 120000001}), sample({wall_ms: 120001}),
    sample({wall_ms: NaN}), sample({revision: 'arbitrary-user-value'}), sample({route: '/private-query?q=sensitive'}),
    sample({traffic: 'external'}), sample({outcome: 'unknown'}), sample({actor_key: 'private identity'}),
    sample({query: 'private query'}), {...sample(), cpu_us: undefined}]) assert.throws(() => validateRuntimeAggregate(input));
});

test('runtime sums only eligible windows, separates inspection and prunes its own thirty-day rows', async () => {
  const {raw, env} = database();
  try {
    raw.exec("INSERT INTO daily_tool_usage(day,tool,traffic,calls) VALUES ('2020-01-01','search_sources','inspection',5)");
    await env.DB.batch(runtimeStatements(env.DB, sample(), new Date('2026-10-03T12:00:00Z')));
    await env.DB.batch(runtimeStatements(env.DB, sample(), now));
    await env.DB.batch(runtimeStatements(env.DB, sample({overlap: true, cpu_us: null, wall_ms: 500}), now));
    await env.DB.batch(runtimeStatements(env.DB, sample({cpu_us: 0, wall_ms: 0}), now));
    await env.DB.batch(runtimeStatements(env.DB, sample({traffic: 'inspection', cpu_us: 9000}), now));
    const rows = raw.prepare('SELECT * FROM daily_runtime_cpu ORDER BY traffic').all();
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[1].eligible_calls, rows[1].overlap_calls, rows[1].cpu_us, rows[1].wall_ms], [2, 1, 1200, 12]);
    assert.equal(rows[0].traffic, 'inspection'); assert.equal(rows[0].cpu_us, 9000);
    assert.equal(raw.prepare('SELECT calls FROM daily_tool_usage').get().calls, 5);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM daily_runtime_cpu WHERE day='2026-10-03'").get().n, 0);
  } finally {raw.close();}
});

test('runtime HTTP requires the write credential and rejects unwanted fields before any writes', async () => {
  const {raw, env} = database();
  try {
    for (const [input, token, status] of [[sample(), reportSecret, 401], [sample({query: 'private'}), writeSecret, 400],
      [sample({overlap: true, cpu_us: 3}), writeSecret, 400]]) {
      const response = await collector.fetch(request(input, token), env);
      assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM daily_runtime_cpu').get().n, 0);
    assert.equal((await collector.fetch(new Request('https://metrics.example/v1/runtime-aggregate'), env)).status, 405);
    const response = await collector.fetch(request(sample({traffic: 'inspection'})), env);
    assert.equal(response.status, 204); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(raw.prepare('SELECT eligible_calls FROM daily_runtime_cpu').get().eligible_calls, 1);
    for (const table of ['daily_tool_usage', 'daily_product_usage', 'usage_actor_days']) {
      assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    }
  } finally {raw.close();}
});

test('private daily report preserves old data and reports runtime absence without fabricating measurements', async () => {
  const {raw, env} = database();
  try {
    let report = await dailyReport(env, '2026-11-01', now);
    assert.deepEqual(report.runtime_cpu, {version: 1, measurement: 'isolated_process_cpu_v1', state: 'unobserved', rows: []});
    await env.DB.batch(runtimeStatements(env.DB, sample({overlap: true, cpu_us: null}), new Date('2026-11-01T12:00:00Z')));
    report = await dailyReport(env, '2026-11-01', now);
    assert.equal(report.runtime_cpu.state, 'observed');
    assert.equal(report.runtime_cpu.rows[0].overlap_calls, 1); assert.equal(report.runtime_cpu.rows[0].eligible_calls, 0);
    assert.deepEqual(report.calls, []); assert.deepEqual(report.product, []);
    assert.equal(report.coverage.product_status, 'unobserved');
  } finally {raw.close();}
});
