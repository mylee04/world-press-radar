import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dailyOptions, runDaily, captureRemoteRegistry, investigationCountries } from '../scripts/quality-daily.mjs';
import { scheduleOptions, scheduleFiles, prepareSchedule } from '../scripts/install-quality-schedule.mjs';
import { normalizeRegistry } from '../dist/catalog.js';
import { QualityRunStore, QualityRuntimeLease } from '../dist/quality-runtime-storage.js';
import { QualityHistoryStore } from '../dist/quality-history.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');
async function temporary(action) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'quality-daily-'));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const config = directory => dailyOptions([`--output=${directory}/reports`, `--history=${directory}/history.sqlite`], NOW, {});
const fakeRuntime = () => {
  const calls = [], overview = { date: '2026-10-12', items: [
    { country: 'US', completed_cycle_baseline: { state: 'comparable_completed_cycles', reasons: [{ metric: 'success_rate', delta_percentage_points: -30 }] } },
    { country: 'KR', completed_cycle_baseline: { state: 'insufficient_completed_cycle_history', reasons: [] }, anomaly: { state: 'insufficient_baseline' } },
  ], runtime: { inventory_partial: false, failed_country_lookups: 0 } };
  const runtime = { calls, history: {
    observeOverview(value) { calls.push(['overview', value.date]); },
    observeRegistry(value) { calls.push(['registry', value.complete]); return { state: 'initial_observation_baseline', added: 0 }; },
    decorateOverview(value) { return value; },
  }, async overview() { return overview; }, async registry() { return { complete: true, sources: [] }; },
  async investigate(country, date) { calls.push(['investigate', country]); return { id: 'rules-real-run', country, date, status: 'completed', cost: { provider: 'rules', model_calls: 0, model_cost_usd: 0 } }; },
  async close() { calls.push(['close']); } };
  return runtime;
};

test('daily options reject current UTC days, invalid limits and paid engine options', () => {
  assert.equal(dailyOptions([], NOW, {}).date, '2026-10-12');
  assert.throws(() => dailyOptions(['--date=2026-10-13'], NOW, {}), /CLOSED_UTC_DAY/);
  assert.throws(() => dailyOptions(['--date=2026-02-30'], NOW, {}), /CLOSED_UTC_DAY/);
  assert.throws(() => dailyOptions(['--max-investigations=6'], NOW, {}), /INVALID_LIMIT/);
  assert.throws(() => dailyOptions(['--engine=openai'], NOW, {}), /UNKNOWN_OPTION/);
  assert.equal(dailyOptions([], NOW, {}).runtime, null);
  assert.equal(dailyOptions([], NOW, { WNS_QUALITY_RUNTIME_PATH: '/tmp/quality/runtime.sqlite' }).runtime, '/tmp/quality/runtime.sqlite');
  assert.equal(dailyOptions(['--runtime=/tmp/explicit.sqlite'], NOW, { WNS_QUALITY_RUNTIME_PATH: '/tmp/env.sqlite' }).runtime, '/tmp/explicit.sqlite');
  assert.throws(() => dailyOptions(['--runtime='], NOW, {}), /INVALID_PATH/);
});

test('bounded selection requires actual comparable baseline or existing review signal', () => {
  const result = investigationCountries({ completed_cycle_common_signal: { state: 'investigate_common_collector_first' }, items: [
    { country: 'US', anomaly: { state: 'insufficient_baseline', reasons: [] }, metrics: { success_rate: { value: 0 } } },
    { country: 'KR', completed_cycle_baseline: { state: 'comparable_completed_cycles', reasons: [{ delta_percentage_points: -30 }] } },
    { country: 'JP', anomaly: { state: 'review_needed', reasons: [{ delta_percentage_points: -16 }] } },
  ] }, 1);
  assert.deepEqual(result, { countries: ['KR'], total: 2, commonCollectorFirst: true });
});

test('daily saves immutable report and reuses receipt without another MCP or model call', async () => temporary(async directory => {
  const runtime = fakeRuntime(), options = config(directory);
  const first = await runDaily(options, { now: () => NOW, runtimeFactory: async () => runtime });
  assert.equal(first.status, 'completed'); assert.equal(first.model_calls, 0);
  const report = JSON.parse(await readFile(first.report_path, 'utf8'));
  assert.deepEqual(report.investigations.map(run => run.country), ['US']); assert.equal(report.registry_observation.added, 0);
  assert.equal(report.automated_registry_changes, false); assert.equal(report.publisher_live_checks, false);
  const second = await runDaily(options, { now: () => NOW, runtimeFactory: async () => { throw Error('SHOULD_NOT_RUN'); } });
  assert.equal(second.status, 'already_recorded'); assert.equal(second.report_path, first.report_path);
  assert.deepEqual(runtime.calls, [['overview', '2026-10-12'], ['registry', true], ['investigate', 'US'], ['close']]);
  assert.equal((await readdir(options.output)).includes('.quality-daily.lock'), false);
}));

test('partial registry capture preserves quality report and remains retryable', async () => temporary(async directory => {
  const runtime = fakeRuntime(); runtime.registry = async () => { throw Error('QUALITY_DAILY_REGISTRY_CHANGED_DURING_READ'); };
  const result = await runDaily(config(directory), { now: () => NOW, runtimeFactory: async () => runtime });
  assert.equal(result.status, 'partial'); assert.ok(result.errors.includes('QUALITY_DAILY_REGISTRY_CHANGED_DURING_READ'));
  const again = await runDaily(config(directory), { now: () => NOW, runtimeFactory: async () => fakeRuntime() });
  assert.equal(again.status, 'completed'); assert.notEqual(again.report_path, result.report_path);
}));

test('scheduled dispatcher does not read MCP or make filesystem writes before UTC daily window', async () => temporary(async directory => {
  const options = { ...config(directory), scheduled: true };
  const result = await runDaily(options, { now: () => Date.parse('2026-10-13T08:59:00Z'), runtimeFactory: async () => { throw Error('SHOULD_NOT_RUN'); } });
  assert.equal(result.status, 'waiting_for_daily_window'); assert.deepEqual(await readdir(directory), []);
}));

test('concurrent lock, symlink history and inherited paid engines fail closed', async () => temporary(async directory => {
  const options = config(directory); const runtime = fakeRuntime();
  runtime.investigate = async () => ({ status: 'completed', cost: { provider: 'openai', model_calls: 1 } });
  await assert.rejects(runDaily(options, { now: () => NOW, runtimeFactory: async () => runtime }), /PAID_ENGINE_FORBIDDEN/);
  assert.equal((await readdir(options.output)).includes('.quality-daily.lock'), false);
  await writeFile(join(options.output, '.quality-daily.lock'), 'existing operator lock');
  await assert.rejects(runDaily(options, { now: () => NOW }), /ALREADY_RUNNING_OR_STALE_LOCK/);
  await rm(join(options.output, '.quality-daily.lock'));
  await writeFile(join(directory, 'elsewhere'), 'unchanged'); await symlink(join(directory, 'elsewhere'), options.history);
  await assert.rejects(runDaily(options, { now: () => NOW }), /UNSAFE_HISTORY/);
}));

test('shared runtime path rejects symlink files and directories before starting a run', async () => temporary(async directory => {
  const options = config(directory), existing = join(directory, 'existing.sqlite');
  await writeFile(existing, 'unchanged');
  const linked = join(directory, 'linked.sqlite'); await symlink(existing, linked);
  const runtimeFactory = async () => { throw Error('SHOULD_NOT_RUN'); };
  await assert.rejects(runDaily({ ...options, runtime: linked }, { now: () => NOW, runtimeFactory }), /UNSAFE_RUNTIME/);
  await assert.rejects(runDaily({ ...options, runtime: directory }, { now: () => NOW, runtimeFactory }), /UNSAFE_RUNTIME/);
  assert.equal(await readFile(existing, 'utf8'), 'unchanged');
}));

test('a separate daily process persists actual rules runs alongside active server jobs and recorded cycle cohorts', async () => temporary(async directory => {
  const registry = { countries: [{ code: 'US', name: 'United States', feeds: [{ name: 'Synthetic Daily Fixture', url: 'https://daily.fixture.example/rss.xml' }] }] };
  const catalog = normalizeRegistry(registry), source = catalog.sources[0], endpoint = source.endpoints[0];
  const terminalDates = ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'];
  const cycle = (date, running = false) => ({ id: `synthetic-cycle-${date}`, lane: 'production',
    started_at: `${date}T03:00:00.000Z`, finished_at: running ? null : `${date}T04:00:00.000Z`,
    status: running ? 'running' : 'completed', scope: 'due_endpoints', registry_digest: 'a'.repeat(64),
    country_endpoints: { US: [endpoint.id] }, eligible_endpoint_ids: [endpoint.id], planned_endpoint_ids: [endpoint.id],
    attempted_endpoint_ids: running ? [] : [endpoint.id], successful_article_endpoint_ids: !running && date !== '2026-10-12' ? [endpoint.id] : [], failure_reason: null });
  const snapshot = { version: 1, lane: 'production', generated_at: '2026-10-13T04:00:00.000Z',
    registry_at: '2026-10-13T01:00:00.000Z', tracking_start: '2026-09-01T00:00:00.000Z', available_since: '2026-09-01T00:00:00.000Z',
    semantics: 'Synthetic saved evidence fixture; no publisher network requests',
    bindings: [{ source_id: source.id, endpoint_id: endpoint.id, baseline_at: '2026-09-01T00:00:00.000Z' }],
    collections: terminalDates.map(date => ({ endpoint_id: endpoint.id, checked_at: `${date}T03:30:00.000Z`,
      status: date === '2026-10-12' ? 'timeout' : 'working_nonempty', format: date === '2026-10-12' ? null : 'rss',
      source_ids: [source.id], countries: ['US'], source_new: { [source.id]: date === '2026-10-12' ? null : 0 },
      country_new: { US: date === '2026-10-12' ? null : 0 }, baseline_sources: [], uncertain_urls: 0 })),
    collection_cycles: [...terminalDates.map(date => cycle(date)), cycle('2026-10-13', true)] };
  const registryPath = join(directory, 'registry.json'), activityPath = join(directory, 'activity.json'), healthPath = join(directory, 'health.json');
  await Promise.all([writeFile(registryPath, JSON.stringify(registry)), writeFile(activityPath, JSON.stringify(snapshot)),
    writeFile(healthPath, JSON.stringify({ version: 1, observations: [] }))]);
  const options = dailyOptions(['--local', `--output=${directory}/reports`, `--history=${directory}/history.sqlite`,
    `--runtime=${directory}/runtime.sqlite`, '--date=2026-10-12'], NOW, {});
  const lease = new QualityRuntimeLease(options.runtime), serverStore = new QualityRunStore(options.runtime);
  const unrelatedRun = { id: randomUUID(), request_id: randomUUID(), country: 'US', date: '2026-10-12',
    status: 'running', started_at: '2026-10-13T05:00:00.000Z', finished_at: null,
    events: [], findings: [], summary: null, cost: { provider: 'openai', model_calls: 1, model_cost_usd: null, server_cost_usd: null } };
  serverStore.save(unrelatedRun);
  const env = { ...process.env, WNS_REGISTRY_PATH: registryPath, WNS_ACTIVITY_PATH: activityPath, WNS_HEALTH_PATH: healthPath,
    WNS_LEGACY_HEALTH_PATH: join(directory, 'absent-legacy.json') };
  const invoke = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/quality-daily.mjs', import.meta.url)),
    '--local', `--output=${options.output}`, `--history=${options.history}`, `--runtime=${options.runtime}`, '--date=2026-10-12'], { env, timeout: 15000 });
  try {
    const first = JSON.parse((await invoke()).stdout);
    assert.equal(first.status, 'completed'); assert.equal(first.model_calls, 0);
    assert.deepEqual(serverStore.get(unrelatedRun.id), unrelatedRun, 'the daily process never reconciles or changes a live paid server job');
    const persisted = serverStore.list(20).filter(run => run.id !== unrelatedRun.id);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'completed'); assert.equal(persisted[0].mode, 'rules_only_cached_mcp');
    assert.equal(persisted[0].cost.provider, 'rules'); assert.equal(persisted[0].cost.model_calls, 0);
    assert.ok(persisted[0].tool_calls > 0); assert.ok(persisted[0].events.some(event => event.tool && event.result && event.status === 'completed'));
    const reader = new QualityRunStore(options.runtime);
    try { assert.deepEqual(reader.get(persisted[0].id), persisted[0]); } finally { reader.close(); }
    const history = new QualityHistoryStore(options.history);
    try {
      const cycles = history.db.prepare('SELECT id,payload FROM quality_cycles ORDER BY id').all();
      assert.deepEqual(cycles.map(row => row.id), terminalDates.map(date => `synthetic-cycle-${date}`));
      assert.ok(cycles.every(row => JSON.parse(row.payload).status === 'completed'));
      const baseline = history.decorateOverview({ date: '2026-10-12', items: [{ country: 'US', period: { date: '2026-10-12' } }] }).items[0].completed_cycle_baseline;
      assert.equal(baseline.state, 'comparable_completed_cycles'); assert.equal(baseline.samples, 3);
      assert.equal(baseline.reasons[0].current, 0);
      assert.equal(history.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quality_runtime_owner'").get(), undefined,
        'owner state exists only in the runtime database, not the quality history');
    } finally { history.close(); }
    const second = JSON.parse((await invoke()).stdout);
    assert.equal(second.status, 'already_recorded'); assert.equal(second.report_path, first.report_path);
    assert.equal(serverStore.list(20).length, 2, 'completed receipt prevents a second actual rules start');
    assert.throws(() => new QualityRuntimeLease(options.runtime), /ALREADY_RUNNING/, 'the server still owns its original runtime lease');
    await assert.rejects(runDaily({ ...options, runtime: null }, { now: () => NOW, runtimeFactory: async () => { throw Error('SHOULD_NOT_RUN'); } }), /RECEIPT_CONFIG_CONFLICT/);
  } finally { serverStore.close(); lease.close(); }
}));

test('complete remote registry capture includes disabled sources and rejects changing or incomplete pages', async () => {
  const source = { id: 'src_one', countryCode: 'US', name: 'One', enabled: false, registrationCount: 1, endpoints: [] };
  const seen = [];
  const call = async (name, args) => { seen.push([name, args]); return name === 'search_sources'
    ? { items: [source], total: 1, next_offset: null } : { registry_snapshot_at: '2026-10-13T03:00:00Z', global_totals: { active_countries: 72 } }; };
  const registry = await captureRemoteRegistry(call, '2026-10-13T12:00:00Z');
  assert.equal(registry.complete, true); assert.equal(registry.sources[0].enabled, false);
  assert.equal(Object.hasOwn(seen[1][1], 'enabled'), false);
  await assert.rejects(captureRemoteRegistry(async name => name === 'search_sources' ? { items: [source], total: 2, next_offset: null } : {}), /REGISTRY_INCOMPLETE/);
  let inventories = 0;
  await assert.rejects(captureRemoteRegistry(async name => name === 'search_sources' ? { items: [source], total: 1, next_offset: null }
    : { registry_snapshot_at: inventories++ ? '2026-10-13T04:00:00Z' : '2026-10-13T03:00:00Z' }), /REGISTRY_CHANGED/);
});

test('scheduler preparation contains no provider key or paid policy and changes no installed job', async () => temporary(async directory => {
  const options = scheduleOptions([`--output=${directory}/definitions`], 'darwin');
  const result = await prepareSchedule(options);
  assert.equal(result.status, 'prepared_not_installed'); assert.equal(result.existing_collector_changed, false);
  const content = await readFile(result.files[0], 'utf8');
  assert.ok(content.includes('<integer>3600</integer>')); assert.ok(content.includes('--scheduled'));
  assert.ok(!/OPENAI|TYPESAFE|API_KEY|PAID_APPROVED/.test(content));
  await writeFile(result.files[0], 'operator edit'); await assert.rejects(prepareSchedule(options), /EXISTING_FILE_DIFFERS/);
}));

test('scheduler definitions quote shell, XML and systemd paths without replacing collector jobs', () => {
  const base = scheduleOptions([], 'linux');
  const cron = scheduleFiles({ ...base, target: 'cron', workingDirectory: "/work/a'b%name" })[0].text;
  assert.ok(cron.includes("'\\''")); assert.ok(cron.includes('\\%'));
  const unit = scheduleFiles({ ...base, target: 'systemd', workingDirectory: '/work/a%name$b' })[0].text;
  assert.ok(unit.includes('a%%name$$b'));
  const plist = scheduleFiles({ ...base, target: 'launchd', workingDirectory: '/work/a&b' })[0].text;
  assert.ok(plist.includes('a&amp;b')); assert.ok(!plist.includes('EnvironmentVariables'));
});
