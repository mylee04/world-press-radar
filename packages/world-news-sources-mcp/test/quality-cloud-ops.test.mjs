import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prepareQualityCloud } from '../scripts/prepare-quality-cloud.mjs';
import { cloudOptions, cloudUnitFiles, verifyCloudBundle, installCloud, validateCloudRuntime } from '../scripts/install-quality-cloud.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'quality-cloud-ops-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const code = join(directory, 'source');
  const files = ['package.json', 'package-lock.json', 'dashboard/index.html', 'dashboard/app.js', 'dashboard/styles.css', 'scripts/quality-daily.mjs',
    'scripts/collect-activity.mjs', 'scripts/install-quality-cloud.mjs', 'dist/http-cloud.js'];
  for (const file of files) { await mkdir(join(code, file, '..'), { recursive: true }); await writeFile(join(code, file), file.endsWith('.json') ? '{}' : '// code\n'); }
  for (const forbidden of ['data/registry.json', 'output/runtime.sqlite', '.env.local', '.vercel/token.json']) {
    await mkdir(join(code, forbidden, '..'), { recursive: true }); await writeFile(join(code, forbidden), 'must never be bundled');
  }
  const bundle = join(directory, 'bundle'); await prepareQualityCloud({ packageRoot: code, output: bundle, revision: 'test-20261013' });
  const collector = join(directory, 'production/packages/world-news-sources-mcp');
  await mkdir(join(collector, 'audits'), { recursive: true }); await mkdir(join(collector, 'activity/history'), { recursive: true });
  await mkdir(join(directory, 'production/data'), { recursive: true });
  await writeFile(join(directory, 'production/data/rss-atlas.json'), '{"countries":[]}'); await writeFile(join(collector, 'audits/health-latest.json'), '{}');
  await writeFile(join(collector, 'activity/production.sqlite'), 'production ledger must not change');
  const shardBytes = Buffer.from('fixture compressed bytes'), sha256 = createHash('sha256').update(shardBytes).digest('hex'), shardFile = `2026-10-${sha256}.json.gz`;
  await writeFile(join(collector, 'activity/history', shardFile), shardBytes);
  await writeFile(join(collector, 'activity/activity-snapshot.json'), JSON.stringify({ version: 1, lane: 'production', generated_at: '2026-10-13T03:53:49Z',
    history: { version: 1, complete: true, shards: [{ month: '2026-10', file: shardFile, bytes: shardBytes.length, records: 1, sha256 }] } }));
  const options = cloudOptions(['--bundle', bundle, '--collector-package', collector, '--base', join(directory, 'app'), '--state', join(directory, 'state'),
    '--env-file', join(directory, 'config/runtime.env'), '--units', join(directory, 'units')], directory);
  await mkdir(join(directory, 'config')); const gateway = join(directory, 'config/gateway.token'); await writeFile(gateway, 'fixture gateway', { mode: 0o600 });
  const lines = ['WNS_PORT=3401', 'WNS_QUALITY_REMOTE=0', `WNS_QUALITY_STATE_DIR=${options.state}`, `WNS_QUALITY_HISTORY_PATH=${join(options.state, 'history.sqlite')}`,
    `WNS_REGISTRY_PATH=${options.registry}`, `WNS_HEALTH_PATH=${join(collector, 'audits/health-latest.json')}`, `WNS_ACTIVITY_PATH=${join(collector, 'activity/activity-snapshot.json')}`,
    `WNS_ACTIVITY_DB=${options.activityDb}`, 'WNS_QUALITY_PUBLIC_ORIGINS=https://news.bymyleslee.com', `WNS_QUALITY_GATEWAY_TOKEN_FILE=${gateway}`];
  await writeFile(options.envFile, lines.join('\n') + '\n', { mode: 0o600 });
  return { directory, options, lines, collector, code, bundle, shardFile };
}

test('cloud code bundle is a fixed whitelist with no metadata or private state', async t => {
  const { bundle } = await fixture(t), manifest = await verifyCloudBundle(bundle, 'test-20261013');
  assert.equal(manifest.files.length, 9); assert.equal(manifest.contains_credentials, false);
  assert.deepEqual((await readdir(bundle)).sort(), ['dashboard', 'dist', 'package-lock.json', 'package.json', 'quality-cloud-manifest.json', 'scripts']);
  await writeFile(join(bundle, '.env'), 'unlisted'); await assert.rejects(verifyCloudBundle(bundle), /UNLISTED_BUNDLE_FILE/);
});

test('cloud dry-run leaves all production metadata, ledger, state and units untouched', async t => {
  const { options, directory } = await fixture(t), before = await readFile(options.activityDb);
  const result = await installCloud(options);
  assert.equal(result.status, 'validated_dry_run'); assert.equal(result.service_activated, false); assert.equal(result.model_calls, 0);
  assert.equal(result.history_shards_verified, 1); assert.deepEqual(await readFile(options.activityDb), before);
  assert.equal((await readdir(directory)).includes('app'), false); assert.equal((await readdir(directory)).includes('state'), false);
});

test('cloud validation rejects checksum mismatch and symbolic bundle files', async t => {
  const { bundle } = await fixture(t);
  await writeFile(join(bundle, 'dist/http-cloud.js'), 'changed'); await assert.rejects(verifyCloudBundle(bundle), /CODE_HASH_MISMATCH/);
  await rm(join(bundle, 'dist/http-cloud.js')); await symlink('../package.json', join(bundle, 'dist/http-cloud.js'));
  await assert.rejects(verifyCloudBundle(bundle), /UNSAFE_FILE/);
});

test('cloud runtime only accepts paths and flags, refusing pasted API secrets or broad env injection', async t => {
  const { options, lines } = await fixture(t);
  await writeFile(options.envFile, lines.join('\n') + '\nOPENAI_API_KEY=fixture\n');
  await assert.rejects(validateCloudRuntime(options), /ENV_FILE_PATHS_AND_FLAGS_ONLY/);
  await writeFile(options.envFile, lines.join('\n') + '\nNODE_OPTIONS=--require=unexpected\n');
  await assert.rejects(validateCloudRuntime(options), /ENV_FILE_PATHS_AND_FLAGS_ONLY/);
  await writeFile(options.envFile, lines.join('\n') + '\n'); await chmod(options.envFile, 0o644);
  await assert.rejects(validateCloudRuntime(options), /PRIVATE_FILE_PERMISSIONS/);
});

test('cloud validation rejects local/foreign data and bad history without replacing anything', async t => {
  const { options, lines, collector, shardFile } = await fixture(t);
  await writeFile(options.envFile, lines.map(line => line.startsWith('WNS_ACTIVITY_DB=') ? 'WNS_ACTIVITY_DB=/tmp/fixture.sqlite' : line).join('\n') + '\n');
  await assert.rejects(validateCloudRuntime(options), /COLLECTOR_DATA_PATH_MISMATCH/);
  await writeFile(options.envFile, lines.join('\n') + '\n'); await writeFile(join(collector, 'activity/history', shardFile), 'bad bytes');
  await assert.rejects(validateCloudRuntime(options), /HISTORY_SHARD_HASH_MISMATCH/);
});

test('cloud units are rules-only, graceful always-on service and separate hourly UTC-gated job', async t => {
  const { options } = await fixture(t), files = cloudUnitFiles(options), web = files.find(file => file.name.includes('-web.')),
    daily = files.find(file => file.name.endsWith('-daily.service')), timer = files.find(file => file.name.endsWith('.timer'));
  assert.match(web.text, /http-cloud\.js/); assert.match(web.text, /Restart=on-failure/); assert.match(web.text, /TimeoutStopSec=160/);
  assert.match(daily.text, /--local --scheduled/); assert.match(daily.text, /--runtime=.*runtime\.sqlite/); assert.match(daily.text, /--not-before-utc-hour=9/); assert.match(timer.text, /OnCalendar=hourly/);
  assert.ok(files.every(file => !/collect-activity|OPENAI_API_KEY|TYPESAFE_API_KEY|--force/.test(file.text)));
  await mkdir(options.unitsDirectory); await writeFile(join(options.unitsDirectory, web.name), '[Service]\nExecStart=unrelated\n');
  await assert.rejects(installCloud(options), /UNOWNED_SYSTEMD_UNIT/);
});

test('cloud never allocates a fresh pilot budget or exceeds the approved cap', async t => {
  const { options, lines } = await fixture(t);
  await writeFile(options.envFile, lines.join('\n') + '\nWNS_QUALITY_TOTAL_BUDGET_USD=6\n');
  await assert.rejects(validateCloudRuntime(options), /APPROVED_BUDGET_LIMIT/);
  await writeFile(options.envFile, lines.join('\n') + '\nWNS_QUALITY_TOTAL_BUDGET_USD=5\nWNS_QUALITY_BUDGET_ID=new-allowance\n');
  await assert.rejects(validateCloudRuntime(options), /SHARED_PILOT_BUDGET_REQUIRED/);
});

test('cloud app code and state cannot overlap authoritative collector directories', async t => {
  const { options } = await fixture(t);
  assert.throws(() => cloudOptions(['--bundle', options.bundle, '--collector-package', options.collectorPackage,
    '--base', join(options.collectorPackage, 'new-app')]), /OVERLAPPING_COLLECTOR_AND_APP/);
  assert.throws(() => cloudOptions(['--bundle', options.bundle, '--collector-package', options.collectorPackage,
    '--state', join(options.collectorPackage, 'activity')]), /OVERLAPPING_COLLECTOR_AND_APP/);
});

test('staged releases reject symbolic directories before activation', async t => {
  const { options, directory } = await fixture(t);
  await mkdir(join(options.base, 'releases'), { recursive: true }); await mkdir(join(directory, 'foreign-code'));
  await symlink(join(directory, 'foreign-code'), join(options.base, 'releases/test-20261013'));
  await assert.rejects(installCloud({ ...options, stage: true, activate: true }, { platform: 'linux', command: () => {} }), /UNSAFE_DIRECTORY/);
  assert.equal((await readdir(directory)).includes('units'), false);
});

test('stage then activation records actual previous release once and preserves rollback evidence on retry', async t => {
  const { options, code, directory } = await fixture(t), calls = [];
  const command = (binary, args, cwd) => {
    calls.push({ binary, args });
    if (binary === 'npm') { mkdirSync(join(cwd, 'node_modules/@modelcontextprotocol/node'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules/@modelcontextprotocol/node/package.json'), '{}'); }
  };
  const services = { platform: 'linux', command };
  const staged = await installCloud({ ...options, stage: true }, services); assert.equal(staged.status, 'staged_not_activated');
  const bundleB = join(directory, 'bundle-b'); await prepareQualityCloud({ packageRoot: code, output: bundleB, revision: 'newer-b' });
  const activeB = await installCloud({ ...options, bundle: bundleB, stage: true, activate: true }, services);
  assert.equal(activeB.previous_release, null);
  const activeA = await installCloud({ ...options, stage: true, activate: true }, services);
  assert.equal(activeA.previous_release, activeB.release);
  const receiptPath = join(activeA.release, '.quality-activation.json'), receiptBefore = await readFile(receiptPath),
    backup = join(activeA.release, 'previous-units/world-press-radar-quality-web.service'), backupBefore = await readFile(backup);
  const retry = await installCloud({ ...options, stage: true, activate: true }, services);
  assert.equal(retry.previous_release, activeB.release); assert.deepEqual(await readFile(receiptPath), receiptBefore); assert.deepEqual(await readFile(backup), backupBefore);
  assert.ok(calls.filter(call => call.binary === 'systemctl').every(call => call.args.every(arg => !arg.includes('world-news-audit'))));
  assert.equal((await readFile(options.activityDb)).toString(), 'production ledger must not change');
});
