import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dailyOptions, runDaily, captureRemoteRegistry, investigationCountries } from '../scripts/quality-daily.mjs';
import { scheduleOptions, scheduleFiles, prepareSchedule } from '../scripts/install-quality-schedule.mjs';

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
