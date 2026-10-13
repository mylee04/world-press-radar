import { mkdir, readdir, lstat, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixedFiles = ['package.json', 'package-lock.json', 'dashboard/index.html', 'dashboard/app.js', 'dashboard/styles.css',
  'scripts/quality-daily.mjs', 'scripts/collect-activity.mjs', 'scripts/install-quality-cloud.mjs'];

export async function prepareQualityCloud({ packageRoot = root, output, revision }) {
  if (!output || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(revision ?? '')) throw Error('QUALITY_CLOUD_INVALID_OPTIONS');
  const destination = resolve(output);
  try { await lstat(destination); throw Error('QUALITY_CLOUD_OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const dist = await readdir(join(packageRoot, 'dist'));
  const files = [...fixedFiles, ...dist.filter(file => /^[A-Za-z0-9_-]+\.js$/.test(file)).map(file => `dist/${file}`)].sort();
  if (!files.includes('dist/http-cloud.js')) throw Error('QUALITY_CLOUD_BUILD_REQUIRED');
  const manifest = { version: 1, kind: 'world-press-radar-quality-code-only', revision, node_major_minimum: 22,
    prepared_at: new Date().toISOString(), files: [], contains_registry: false, contains_activity_ledger: false, contains_credentials: false };
  // Exact code whitelist: no data, audits, histories, output, .env, .vercel or node_modules.
  for (const file of files) {
    const source = join(packageRoot, file), stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw Error('QUALITY_CLOUD_UNSAFE_CODE_FILE');
    const bytes = await readFile(source);
    manifest.files.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
  }
  if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 16 * 1024 * 1024) throw Error('QUALITY_CLOUD_CODE_SIZE_LIMIT');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = join(destination, file); await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await copyFile(join(packageRoot, file), target);
  }
  await writeFile(join(destination, 'quality-cloud-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'prepared_code_only', output: destination, revision, files: files.length, credentials_copied: false,
    production_data_copied: false, service_activated: false, collector_timer_changed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), parsed = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (!['--output', '--revision'].includes(key) || parsed[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('QUALITY_CLOUD_INVALID_OPTIONS');
      parsed[key] = args[++i];
    }
    console.log(JSON.stringify(await prepareQualityCloud({ output: parsed['--output'], revision: parsed['--revision'] })));
  } catch (error) { console.error(JSON.stringify({ status: 'failed', error: /^QUALITY_CLOUD_[A-Z_]+$/.test(error.message) ? error.message : 'QUALITY_CLOUD_PREPARATION_FAILED' })); process.exitCode = 1; }
}
