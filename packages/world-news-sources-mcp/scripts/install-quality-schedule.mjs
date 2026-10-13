import { mkdir, readFile, open, lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { safeDirectory } from './quality-daily.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const LABEL = 'com.worldpressradar.quality-daily';
const UNIT = 'world-press-radar-quality';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const shell = value => `'${value.replaceAll("'", "'\\''")}'`;
const systemd = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;

export function scheduleOptions(args, platform = process.platform) {
  const names = new Set(['--target', '--output', '--node', '--report-dir', '--history', '--not-before-utc-hour']);
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const [name, ...tail] = args[index].split('=');
    if (Object.hasOwn(parsed, name)) throw Error('QUALITY_SCHEDULE_DUPLICATE_OPTION');
    if (name === '--apply') { if (tail.length) throw Error('QUALITY_SCHEDULE_INVALID_OPTION'); parsed[name] = true; }
    else if (names.has(name)) {
      const value = tail.length ? tail.join('=') : args[++index];
      if (value === undefined || value.startsWith('--')) throw Error('QUALITY_SCHEDULE_MISSING_OPTION'); parsed[name] = value;
    } else throw Error('QUALITY_SCHEDULE_UNKNOWN_OPTION');
  }
  const target = parsed['--target'] ?? (platform === 'darwin' ? 'launchd' : 'systemd');
  if (!['launchd', 'systemd', 'cron'].includes(target)) throw Error('QUALITY_SCHEDULE_INVALID_TARGET');
  const hour = Number(parsed['--not-before-utc-hour'] ?? 9);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw Error('QUALITY_SCHEDULE_INVALID_HOUR');
  const options = { target, apply: !!parsed['--apply'], output: resolve(parsed['--output'] ?? join(packageRoot, 'output/news-quality/schedule')),
    node: resolve(parsed['--node'] ?? process.execPath), workingDirectory: packageRoot,
    reportDirectory: resolve(parsed['--report-dir'] ?? join(packageRoot, 'output/news-quality/daily')),
    history: resolve(parsed['--history'] ?? process.env.WNS_QUALITY_HISTORY_PATH ?? join(packageRoot, 'output/news-quality/history.sqlite')), notBeforeUtcHour: hour };
  if (Object.values(options).some(value => typeof value === 'string' && /[\u0000-\u001f]/.test(value))) throw Error('QUALITY_SCHEDULE_INVALID_PATH');
  return options;
}

export function scheduleFiles(options) {
  const script = join(options.workingDirectory, 'scripts/quality-daily.mjs');
  const args = [options.node, script, '--scheduled', `--output=${options.reportDirectory}`, `--history=${options.history}`, `--not-before-utc-hour=${options.notBeforeUtcHour}`];
  if (options.target === 'launchd') return [{ name: `${LABEL}.plist`, text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(options.workingDirectory)}</string>
<key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>60</integer>
<key>StandardOutPath</key><string>${xml(join(options.reportDirectory, 'schedule.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.reportDirectory, 'schedule-error.log'))}</string>
</dict></plist>
` }];
  if (options.target === 'systemd') return [{ name: `${UNIT}.service`, text: `[Unit]
Description=World Press Radar daily read-only quality report
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${systemd(options.workingDirectory)}
ExecStart=${args.map(systemd).join(' ')}
UMask=0077
NoNewPrivileges=true
TimeoutStartSec=600
` }, { name: `${UNIT}.timer`, text: `[Unit]
Description=World Press Radar quality daily dispatcher

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=60
Unit=${UNIT}.service

[Install]
WantedBy=timers.target
` }];
  return [{ name: `${UNIT}.cron`, text: `# Dispatch hourly; receipt enforces one report per previous UTC day after ${options.notBeforeUtcHour}:00 UTC.
# Merge this dedicated line manually. Do not replace the existing collector crontab.
${`0 * * * * cd ${shell(options.workingDirectory)} && ${args.map(shell).join(' ')} >> ${shell(join(options.reportDirectory, 'schedule.log'))} 2>> ${shell(join(options.reportDirectory, 'schedule-error.log'))}`.replaceAll('%', '\\%')}
` }];
}

async function writeExclusive(path, text) {
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('QUALITY_SCHEDULE_UNSAFE_FILE');
    if (await readFile(path, 'utf8') === text) return; throw Error('QUALITY_SCHEDULE_EXISTING_FILE_DIFFERS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(text); } finally { await handle.close(); }
}

function command(file, args) {
  const result = spawnSync(file, args, { stdio: 'ignore', timeout: 30000 });
  if (result.error || result.status !== 0) throw Error('QUALITY_SCHEDULE_ACTIVATION_FAILED');
}

export async function prepareSchedule(options) {
  // Generating definitions changes no running scheduler, environment secret or collector job.
  const files = scheduleFiles(options);
  await safeDirectory(options.output);
  for (const file of files) await writeExclusive(join(options.output, file.name), file.text);
  if (!options.apply) return { status: 'prepared_not_installed', target: options.target, files: files.map(file => join(options.output, file.name)),
    daily_after_utc_hour: options.notBeforeUtcHour, engine: 'rules', model_calls: 0, existing_collector_changed: false };
  if (options.target === 'cron') throw Error('QUALITY_SCHEDULE_CRON_REQUIRES_MANUAL_MERGE');
  await access(options.node, constants.X_OK);
  await access(join(options.workingDirectory, 'dist/quality-history.js'), constants.R_OK);
  await safeDirectory(options.reportDirectory);
  if (options.target === 'launchd') {
    if (process.platform !== 'darwin' || typeof process.getuid !== 'function') throw Error('QUALITY_SCHEDULE_WRONG_PLATFORM');
    const directory = join(homedir(), 'Library/LaunchAgents'); await safeDirectory(directory);
    const destination = join(directory, files[0].name);
    // Do not overwrite or unload an existing job, including an earlier quality job.
    try { await lstat(destination); throw Error('QUALITY_SCHEDULE_ALREADY_INSTALLED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeExclusive(destination, files[0].text);
    command('launchctl', ['bootstrap', `gui/${process.getuid()}`, destination]);
  } else {
    if (process.platform !== 'linux') throw Error('QUALITY_SCHEDULE_WRONG_PLATFORM');
    const directory = join(homedir(), '.config/systemd/user'); await safeDirectory(directory);
    for (const file of files) { try { await lstat(join(directory, file.name)); throw Error('QUALITY_SCHEDULE_ALREADY_INSTALLED'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; } }
    for (const file of files) await writeExclusive(join(directory, file.name), file.text);
    command('systemctl', ['--user', 'daemon-reload']); command('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]);
  }
  return { status: 'installed', target: options.target, engine: 'rules', existing_collector_changed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await prepareSchedule(scheduleOptions(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', error: /^[A-Z][A-Z0-9_]{3,100}$/.test(error.message) ? error.message : 'QUALITY_SCHEDULE_FAILED' })); process.exitCode = 1; }
}
