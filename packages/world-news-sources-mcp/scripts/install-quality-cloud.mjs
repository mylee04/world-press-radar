import { mkdir, readdir, lstat, stat, readFile, writeFile, copyFile, rename, symlink, realpath, open, unlink } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';

const KIND = 'world-press-radar-quality-code-only';
const UNIT_MARKER = '# Managed by world-press-radar quality cloud installer v1';
const WEB = 'world-press-radar-quality-web.service', DAILY = 'world-press-radar-quality-daily.service', TIMER = 'world-press-radar-quality-daily.timer';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (base, path) => { const rel = relative(base, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const unit = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
const fail = code => { throw Error(`QUALITY_CLOUD_${code}`); };
// Scalar path settings do not use ExecStart's argument quoting. Restrict paths to an
// unambiguous absolute spelling; never emit literal quotes around WorkingDirectory.
const unitPath = value => {
  if (!isAbsolute(value) || /[\s\\"'%\u0000-\u001f]/.test(value)) fail('UNSUPPORTED_SYSTEMD_PATH');
  return value;
};
const envNames = new Set(['WNS_PORT', 'WNS_REGISTRY_PATH', 'WNS_LEGACY_HEALTH_PATH', 'WNS_HEALTH_PATH', 'WNS_ACTIVITY_PATH', 'WNS_ACTIVITY_DB', 'WNS_QUALITY_MODE',
  'WNS_QUALITY_STATE_DIR', 'WNS_QUALITY_HISTORY_PATH', 'WNS_QUALITY_RUNTIME_PATH', 'WNS_QUALITY_BUDGET_PATH', 'WNS_QUALITY_BUDGET_ID', 'WNS_QUALITY_TOTAL_BUDGET_USD',
  'WNS_QUALITY_REMOTE', 'WNS_QUALITY_PUBLIC_ORIGINS', 'WNS_QUALITY_GATEWAY_TOKEN_FILE', 'WNS_QUALITY_ADMIN_TOKEN_FILE',
  'WNS_QUALITY_REPAIR_ENABLED', 'WNS_QUALITY_REGISTRY_ROOT', 'WNS_QUALITY_REPAIR_STATE_DIR',
  'WNS_OPENAI_PAID_APPROVED', 'WNS_OPENAI_MODEL', 'WNS_OPENAI_KEY_FILE', 'WNS_OPENAI_TOTAL_BUDGET_USD', 'WNS_OPENAI_RUN_BUDGET_USD',
  'WNS_OPENAI_INPUT_USD_PER_MILLION', 'WNS_OPENAI_OUTPUT_USD_PER_MILLION', 'WNS_JEV_PAID_APPROVED', 'WNS_JEV_MODEL', 'WNS_JEV_KEY_FILE',
  'WNS_JEV_TOTAL_BUDGET_USD', 'WNS_JEV_RUN_BUDGET_USD', 'WNS_JEV_INPUT_USD_PER_MILLION']);

export function cloudOptions(args, home = process.env.HOME) {
  const parsed = {}, values = new Set(['--bundle', '--base', '--state', '--env-file', '--collector-package', '--activity-db', '--registry', '--node', '--units', '--revision']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; if (Object.hasOwn(parsed, key)) fail('DUPLICATE_OPTION');
    if (['--stage', '--activate'].includes(key)) parsed[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith('--')) parsed[key] = args[++i];
    else fail('INVALID_OPTIONS');
  }
  if (!parsed['--bundle'] || !parsed['--collector-package']) fail('BUNDLE_AND_COLLECTOR_REQUIRED');
  const base = resolve(parsed['--base'] ?? join(home, '.local/share/world-press-radar-quality-app'));
  const state = resolve(parsed['--state'] ?? join(home, '.local/share/world-press-radar-quality'));
  const options = { bundle: resolve(parsed['--bundle']), base, state, envFile: resolve(parsed['--env-file'] ?? join(home, '.config/world-press-radar-quality/runtime.env')),
    collectorPackage: resolve(parsed['--collector-package']), activityDb: resolve(parsed['--activity-db'] ?? join(parsed['--collector-package'], 'activity/production.sqlite')),
    registry: resolve(parsed['--registry'] ?? resolve(parsed['--collector-package'], '../../data/rss-atlas.json')), node: resolve(parsed['--node'] ?? process.execPath),
    unitsDirectory: resolve(parsed['--units'] ?? join(home, '.config/systemd/user')), revision: parsed['--revision'],
    stage: !!parsed['--stage'] || !!parsed['--activate'], activate: !!parsed['--activate'] };
  if (Object.values(options).some(value => typeof value === 'string' && /[\u0000-\u001f]/.test(value))) fail('INVALID_PATH');
  if (contained(options.bundle, options.base) || contained(options.base, options.bundle) || contained(options.base, options.state) || contained(options.state, options.base)) fail('OVERLAPPING_CODE_AND_STATE');
  for (const protectedRoot of [resolve(options.collectorPackage, '../..'), dirname(options.activityDb)])
    for (const appPath of [options.base, options.state, options.bundle])
      if (contained(protectedRoot, appPath) || contained(appPath, protectedRoot)) fail('OVERLAPPING_COLLECTOR_AND_APP');
  return options;
}

export async function safeCloudDirectory(path, create = false) {
  const ancestors = []; for (let current = resolve(path); dirname(current) !== current; current = dirname(current)) ancestors.push(current);
  for (const current of ancestors.reverse()) {
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_DIRECTORY'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) continue; await mkdir(current, { mode: 0o700 }); }
  }
}

async function regular(path, privateFile = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_FILE');
  if (privateFile && ((info.mode & 0o077) || typeof process.getuid === 'function' && info.uid !== process.getuid())) fail('PRIVATE_FILE_PERMISSIONS');
  return info;
}

export async function verifyCloudBundle(path, revision) {
  await safeCloudDirectory(path);
  await regular(join(path, 'quality-cloud-manifest.json'));
  const manifest = JSON.parse(await readFile(join(path, 'quality-cloud-manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.kind !== KIND || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(manifest.revision)
    || revision && manifest.revision !== revision || !Array.isArray(manifest.files) || manifest.files.length > 150) fail('INVALID_MANIFEST');
  const listed = new Set(); let size = 0;
  for (const file of manifest.files) {
    if (!/^(?:package(?:-lock)?\.json|dashboard\/(?:index\.html|app\.js|styles\.css)|dist\/[A-Za-z0-9_-]+\.js|scripts\/(?:quality-daily|collect-activity|install-quality-cloud)\.mjs)$/.test(file.path)
      || listed.has(file.path) || !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('INVALID_MANIFEST_FILE');
    listed.add(file.path); await regular(join(path, file.path)); const bytes = await readFile(join(path, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('CODE_HASH_MISMATCH'); size += bytes.length;
  }
  if (size > 16 * 1024 * 1024 || !listed.has('dist/http-cloud.js') || !listed.has('scripts/quality-daily.mjs') || !listed.has('package-lock.json')) fail('INCOMPLETE_CODE_BUNDLE');
  const walk = async (directory, prefix = '') => {
    for (const name of await readdir(directory)) {
      const item = prefix + name, info = await lstat(join(directory, name));
      if (info.isSymbolicLink()) fail('UNSAFE_BUNDLE_SYMLINK');
      if (info.isDirectory()) await walk(join(directory, name), item + '/');
      else if (!listed.has(item) && item !== 'quality-cloud-manifest.json') fail('UNLISTED_BUNDLE_FILE');
    }
  }; await walk(path);
  return manifest;
}

export function cloudUnitFiles(options) {
  const current = join(options.base, 'current'), history = join(options.state, 'history.sqlite'), runtime = join(options.state, 'runtime.sqlite'), reports = join(options.state, 'daily');
  return [{ name: WEB, text: `${UNIT_MARKER}\n[Unit]\nDescription=World Press Radar public quality application\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${unitPath(current)}\nEnvironmentFile=${unitPath(options.envFile)}\nExecStart=${unit(options.node)} ${unit(join(current, 'dist/http-cloud.js'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=160\nUMask=0077\nNoNewPrivileges=true\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n` },
    { name: DAILY, text: `${UNIT_MARKER}\n[Unit]\nDescription=World Press Radar daily read-only quality analysis\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nWorkingDirectory=${unitPath(current)}\nEnvironmentFile=${unitPath(options.envFile)}\nExecStart=${unit(options.node)} ${unit(join(current, 'scripts/quality-daily.mjs'))} --local --scheduled ${unit(`--output=${reports}`)} ${unit(`--history=${history}`)} ${unit(`--runtime=${runtime}`)} --not-before-utc-hour=9\nUMask=0077\nNoNewPrivileges=true\nTimeoutStartSec=600\nStandardOutput=journal\nStandardError=journal\n` },
    { name: TIMER, text: `${UNIT_MARKER}\n[Unit]\nDescription=World Press Radar quality report dispatcher\n\n[Timer]\nOnCalendar=hourly\nPersistent=true\nRandomizedDelaySec=60\nUnit=${DAILY}\n\n[Install]\nWantedBy=timers.target\n` }];
}

export async function validateCloudRuntime(options) {
  // Never emit environment contents or secret file contents. Values are used only for equality/path checks.
  if ((await regular(options.envFile, true)).size > 16384) fail('ENV_FILE_SIZE_LIMIT');
  const env = {};
  for (const line of (await readFile(options.envFile, 'utf8')).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\r\n]*))$/.exec(line);
    if (!match || !envNames.has(match[1]) || Object.hasOwn(env, match[1])) fail('ENV_FILE_PATHS_AND_FLAGS_ONLY');
    env[match[1]] = match[2] ?? match[3] ?? match[4];
    if (/[\u0000-\u001f]/.test(env[match[1]])) fail('INVALID_ENV_VALUE');
  }
  if (env.WNS_QUALITY_REMOTE !== '0' || env.WNS_QUALITY_STATE_DIR !== options.state
    || env.WNS_QUALITY_HISTORY_PATH !== join(options.state, 'history.sqlite')
    || env.WNS_QUALITY_RUNTIME_PATH && env.WNS_QUALITY_RUNTIME_PATH !== join(options.state, 'runtime.sqlite')) fail('STATE_CONFIGURATION_MISMATCH');
  const expectedData = {
    WNS_REGISTRY_PATH: options.registry,
    WNS_HEALTH_PATH: join(options.collectorPackage, 'audits/health-latest.json'),
    WNS_ACTIVITY_PATH: join(options.collectorPackage, 'activity/activity-snapshot.json'),
    WNS_ACTIVITY_DB: options.activityDb,
  };
  for (const [key, path] of Object.entries(expectedData)) {
    if (resolve(env[key] ?? '') !== path) fail('COLLECTOR_DATA_PATH_MISMATCH');
    await regular(path);
  }
  if ((await regular(expectedData.WNS_ACTIVITY_PATH)).size > 16 * 1024 * 1024) fail('ACTIVITY_MANIFEST_SIZE_LIMIT');
  const activity = JSON.parse(await readFile(expectedData.WNS_ACTIVITY_PATH, 'utf8'));
  if (activity.version !== 1 || activity.lane !== 'production' || !activity.history || activity.history.version !== 1
    || activity.history.complete !== true || !Array.isArray(activity.history.shards) || activity.history.shards.length > 120) fail('COMPLETE_PRODUCTION_HISTORY_REQUIRED');
  const months = new Set();
  for (const shard of activity.history.shards) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(shard.month) || months.has(shard.month) || !/^[a-f0-9]{64}$/.test(shard.sha256)
      || shard.file !== `${shard.month}-${shard.sha256}.json.gz` || !Number.isInteger(shard.bytes) || shard.bytes < 1 || shard.bytes > 10 * 1024 * 1024) fail('INVALID_HISTORY_SHARD');
    months.add(shard.month); const shardPath = join(dirname(expectedData.WNS_ACTIVITY_PATH), 'history', shard.file);
    if ((await regular(shardPath)).size !== shard.bytes || digest(await readFile(shardPath)) !== shard.sha256) fail('HISTORY_SHARD_HASH_MISMATCH');
  }
  if (!env.WNS_QUALITY_PUBLIC_ORIGINS || env.WNS_QUALITY_PUBLIC_ORIGINS.split(',').some(origin => {
    try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin; } catch { return true; }
  })) fail('PUBLIC_ORIGIN_REQUIRED');
  for (const key of ['WNS_QUALITY_GATEWAY_TOKEN_FILE', 'WNS_QUALITY_ADMIN_TOKEN_FILE', 'WNS_OPENAI_KEY_FILE', 'WNS_JEV_KEY_FILE'])
    if (env[key]) { if (!isAbsolute(env[key]) || contained(options.base, env[key]) || contained(options.bundle, env[key])) fail('PRIVATE_FILE_OUTSIDE_CODE_REQUIRED'); await regular(env[key], true); }
  if (!env.WNS_QUALITY_GATEWAY_TOKEN_FILE) fail('GATEWAY_TOKEN_FILE_REQUIRED');
  if (env.WNS_QUALITY_REPAIR_ENABLED && !['0', '1'].includes(env.WNS_QUALITY_REPAIR_ENABLED)) fail('INVALID_REPAIR_FLAG');
  if (env.WNS_QUALITY_REPAIR_ENABLED === '1') {
    const approvedRoot = env.WNS_QUALITY_REGISTRY_ROOT, repairState = env.WNS_QUALITY_REPAIR_STATE_DIR;
    if (!approvedRoot || !repairState || !isAbsolute(approvedRoot) || !isAbsolute(repairState)
      || !contained(approvedRoot, options.registry) || !contained(approvedRoot, repairState) || !env.WNS_QUALITY_ADMIN_TOKEN_FILE) fail('EXPLICIT_REPAIR_SCOPE_REQUIRED');
    const canonicalRoot = await realpath(approvedRoot);
    await safeCloudDirectory(canonicalRoot);
    await safeCloudDirectory(join(canonicalRoot, relative(approvedRoot, repairState)));
  }
  if (!env.WNS_PORT || !/^\d+$/.test(env.WNS_PORT) || Number(env.WNS_PORT) < 1024 || Number(env.WNS_PORT) > 65535) fail('INVALID_LISTEN_PORT');
  const budget = Number(env.WNS_QUALITY_TOTAL_BUDGET_USD ?? 0);
  if (!Number.isFinite(budget) || budget < 0 || budget > 5) fail('APPROVED_BUDGET_LIMIT');
  // Retain the original pilot authorization id instead of allocating a new cloud allowance.
  if (budget && (env.WNS_QUALITY_BUDGET_ID !== 'news-quality-pilot-20261013' || env.WNS_QUALITY_BUDGET_PATH !== join(options.state, 'runtime.sqlite'))) fail('SHARED_PILOT_BUDGET_REQUIRED');
  return { collector_data_paths_validated: true, credentials_in_env_file: false, listen_port: Number(env.WNS_PORT), model_budget_cap_usd: budget,
    activity_snapshot_at: activity.generated_at ?? null, history_shards_verified: months.size };
}

async function existingCurrent(options) {
  const path = join(options.base, 'current');
  let exists = false;
  try {
    const info = await lstat(path); exists = true; if (!info.isSymbolicLink()) fail('CURRENT_MUST_BE_MANAGED_LINK');
    const target = await realpath(path);
    if (!contained(join(options.base, 'releases'), target)) fail('UNOWNED_CURRENT_RELEASE');
    await safeCloudDirectory(target); await regular(join(target, '.quality-release.json'));
    const marker = JSON.parse(await readFile(join(target, '.quality-release.json'), 'utf8'));
    if (marker.kind !== KIND || marker.base !== options.base) fail('UNOWNED_CURRENT_RELEASE');
    return target;
  } catch (error) { if (error.code === 'ENOENT') { if (exists) fail('INCOMPLETE_CURRENT_RELEASE'); return null; } throw error; }
}

export async function inspectCloudInstall(options) {
  const manifest = await verifyCloudBundle(options.bundle, options.revision);
  for (const directory of [options.base, options.state, options.unitsDirectory]) await safeCloudDirectory(directory);
  const current = await existingCurrent(options);
  for (const file of cloudUnitFiles(options)) {
    try { await regular(join(options.unitsDirectory, file.name)); const text = await readFile(join(options.unitsDirectory, file.name), 'utf8');
      if (!text.startsWith(UNIT_MARKER + '\n')) fail('UNOWNED_SYSTEMD_UNIT'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const runtime = await validateCloudRuntime(options);
  const nodeInfo = await stat(options.node); if (!nodeInfo.isFile() || !(nodeInfo.mode & 0o111)) fail('NODE_EXECUTABLE_REQUIRED');
  const version = spawnSync(options.node, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000 });
  const nodeVersion = version.stdout?.trim().split('.').map(Number) ?? [];
  if (version.status !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(version.stdout) || nodeVersion[0] < 22 || nodeVersion[0] === 22 && nodeVersion[1] < 13) fail('NODE_22_REQUIRED');
  return { manifest, current, runtime, release: join(options.base, 'releases', manifest.revision),
    result: { status: 'validated_dry_run', revision: manifest.revision, ...runtime, existing_release_present: !!current,
      production_data_copied: false, collector_code_changed: false, collector_timer_changed: false, model_calls: 0, service_activated: false } };
}

function command(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, stdio: 'ignore', timeout: 180000 });
  if (result.error || result.status !== 0) fail('INSTALL_COMMAND_FAILED');
}

async function verifySystemdDefinitions(options, release, run) {
  const directory = join(release, 'systemd-verify'); await safeCloudDirectory(directory, true);
  const files = cloudUnitFiles({ ...options, base: release });
  // Use the staged real code path for verification: first installation has no current link yet.
  for (const file of files) {
    const text = file.text.replaceAll(join(release, 'current'), release), destination = join(directory, file.name);
    try {
      await regular(destination); if (await readFile(destination, 'utf8') !== text) fail('STAGED_VERIFY_CONFIG_MISMATCH');
    } catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(destination, text, { flag: 'wx', mode: 0o600 }); }
  }
  try { run('systemd-analyze', ['--user', 'verify', ...files.map(file => join(directory, file.name))]); }
  catch { fail('SYSTEMD_UNIT_VERIFICATION_FAILED'); }
}

async function loopbackHealth(port) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.ok) {
        const payload = await response.json();
        if (payload.status === 'ok' && payload.service === 'news-quality' && payload.persistence === 'sqlite' && payload.metadata_reload_failed === false) return;
      }
    } catch { /* Initial process startup may not have bound the loopback socket yet. */ }
    if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 200));
  }
  fail('ACTIVATION_HEALTH_FAILED');
}

function managedUnitStatus(name) {
  const result = spawnSync('systemctl', ['--user', 'show', '--property=LoadState', '--property=ActiveState', name], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) fail('UNIT_STATUS_UNAVAILABLE');
  const values = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')));
  if (!values.LoadState || !values.ActiveState) fail('UNIT_STATUS_UNAVAILABLE');
  return { loadState: values.LoadState, activeState: values.ActiveState };
}

function stopManagedUnit(name, run, status) {
  const state = status(name);
  // A previous invalid definition has no process to stop and systemctl stop can itself fail.
  // Skip only that verified inactive condition; any live/starting service still has to stop.
  if (['bad-setting', 'not-found'].includes(state.loadState) && ['inactive', 'failed'].includes(state.activeState)) return;
  run('systemctl', ['--user', 'stop', name]);
}

async function verifyInstalledRelease(options, checked) {
  await safeCloudDirectory(checked.release);
  await safeCloudDirectory(join(checked.release, 'systemd'));
  await safeCloudDirectory(join(checked.release, 'node_modules/@modelcontextprotocol/node'));
  await regular(join(checked.release, '.quality-release.json'));
  const marker = JSON.parse(await readFile(join(checked.release, '.quality-release.json'), 'utf8'));
  if (marker.kind !== KIND || marker.base !== options.base || marker.revision !== checked.manifest.revision) fail('UNOWNED_RELEASE');
  const installedManifest = await readFile(join(checked.release, 'quality-cloud-manifest.json'));
  if (digest(installedManifest) !== digest(await readFile(join(options.bundle, 'quality-cloud-manifest.json')))) fail('STAGED_MANIFEST_MISMATCH');
  for (const file of checked.manifest.files) {
    await safeCloudDirectory(dirname(join(checked.release, file.path)));
    await regular(join(checked.release, file.path));
    const bytes = await readFile(join(checked.release, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('STAGED_CODE_HASH_MISMATCH');
  }
  for (const file of cloudUnitFiles(options)) {
    await regular(join(checked.release, 'systemd', file.name));
    if (await readFile(join(checked.release, 'systemd', file.name), 'utf8') !== file.text) fail('STAGED_UNIT_CONFIG_MISMATCH');
  }
  await regular(join(checked.release, 'node_modules/@modelcontextprotocol/node/package.json'));
}

export async function installCloud(options, services = {}) {
  const run = services.command ?? command;
  const checked = await inspectCloudInstall(options);
  if (!options.stage) return checked.result;
  const lockPath = join(options.base, '.install.lock'); await safeCloudDirectory(options.base, true);
  let lock; try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail('INSTALL_ALREADY_RUNNING_OR_STALE_LOCK'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    // A prior installer may have completed between this invocation's dry-run and lock acquisition.
    // Refresh ownership under the lock before recording/replacing the current release.
    const refreshed = await inspectCloudInstall(options); checked.current = refreshed.current;
    checked.result = refreshed.result;
    let existing = false;
    try { await lstat(checked.release); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (!options.activate) fail('RELEASE_EXISTS');
      await verifyInstalledRelease(options, checked);
    } else {
      await safeCloudDirectory(checked.release, true);
      for (const file of [...checked.manifest.files.map(file => file.path), 'quality-cloud-manifest.json']) {
        await safeCloudDirectory(dirname(join(checked.release, file)), true); await copyFile(join(options.bundle, file), join(checked.release, file));
      }
      // Fixed lock, production deps, lifecycle scripts disabled. No credential/data bundle.
      run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], checked.release);
      for (const file of checked.manifest.files.filter(file => file.path.endsWith('.js') || file.path.endsWith('.mjs')))
        run(options.node, ['--check', join(checked.release, file.path)]);
      await writeFile(join(checked.release, '.quality-release.json'), JSON.stringify({ kind: KIND, base: options.base,
        revision: checked.manifest.revision, installed_at: new Date().toISOString(), previous_release: checked.current }) + '\n', { flag: 'wx', mode: 0o600 });
      const definitions = join(checked.release, 'systemd'); await safeCloudDirectory(definitions, true);
      for (const file of cloudUnitFiles(options)) await writeFile(join(definitions, file.name), file.text, { flag: 'wx', mode: 0o600 });
    }
    if ((services.platform ?? process.platform) === 'linux') await verifySystemdDefinitions(options, checked.release, run);
    if (!options.activate) return { ...checked.result, status: 'staged_not_activated', release: checked.release };
    if ((services.platform ?? process.platform) !== 'linux') fail('SYSTEMD_LINUX_REQUIRED');
    // Durable app storage remains outside every code release. No history is reset or replaced.
    await safeCloudDirectory(options.state, true); await safeCloudDirectory(join(options.state, 'daily'), true); await safeCloudDirectory(options.unitsDirectory, true);
    const backups = join(checked.release, 'previous-units'); await safeCloudDirectory(backups, true);
    const receiptPath = join(checked.release, '.quality-activation.json'); let receipt;
    try { await regular(receiptPath); receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      if (receipt.kind !== KIND || receipt.base !== options.base || receipt.revision !== checked.manifest.revision
        || checked.current !== receipt.previous_release && checked.current !== checked.release) fail('ACTIVATION_OWNERSHIP_CHANGED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!receipt) {
      const unitBackups = [];
      for (const file of cloudUnitFiles(options)) {
        const target = join(options.unitsDirectory, file.name), backup = join(backups, file.name);
        try {
          const content = await readFile(target); await copyFile(target, backup, constants.COPYFILE_EXCL);
          unitBackups.push({ name: file.name, existed: true, sha256: digest(content) });
        } catch (error) { if (error.code !== 'ENOENT') throw error; unitBackups.push({ name: file.name, existed: false }); }
      }
      receipt = { kind: KIND, base: options.base, revision: checked.manifest.revision, previous_release: checked.current,
        activation_started_at: new Date().toISOString(), unit_backups: unitBackups };
      await writeFile(receiptPath, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    }
    // Stop only our own units; a scheduled collector is never stopped or changed here.
    if (checked.current && checked.current !== checked.release)
      for (const name of [TIMER, DAILY, WEB]) stopManagedUnit(name, run, services.unitStatus ?? managedUnitStatus);
    if (checked.current !== checked.release) {
      const link = join(options.base, `.current-${randomUUID()}`); await symlink(checked.release, link); await rename(link, join(options.base, 'current'));
    }
    for (const file of cloudUnitFiles(options)) await writeFile(join(options.unitsDirectory, file.name), file.text, { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']); run('systemctl', ['--user', 'enable', '--now', WEB, TIMER]);
    // is-active with several units succeeds when only one is active; require each individually.
    try {
      run('systemctl', ['--user', 'is-active', '--quiet', WEB]); run('systemctl', ['--user', 'is-active', '--quiet', TIMER]);
    } catch { fail('ACTIVATION_NOT_READY'); }
    await (services.health ?? loopbackHealth)(checked.runtime.listen_port);
    try {
      run('systemctl', ['--user', 'is-active', '--quiet', WEB]); run('systemctl', ['--user', 'is-active', '--quiet', TIMER]);
    } catch { fail('ACTIVATION_NOT_READY'); }
    return { ...checked.result, status: 'activated', release: checked.release, previous_release: receipt.previous_release, service_activated: true,
      quality_daily_timer_activated: true, collector_timer_changed: false, persistent_user_manager_required: true };
  } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await installCloud(cloudOptions(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', error: /^QUALITY_CLOUD_[A-Z_]+$/.test(error.message) ? error.message : 'QUALITY_CLOUD_INSTALL_FAILED' })); process.exitCode = 1; }
}
