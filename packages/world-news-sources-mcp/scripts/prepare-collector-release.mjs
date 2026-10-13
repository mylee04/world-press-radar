import { mkdir, readdir, lstat, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixed = ['package.json', 'package-lock.json', 'tsconfig.json'];
const fixtureFiles = new Set(['expansion/registry-additions.json', 'expansion/verified-health-additions.json',
  'expansion/robots-policy.mjs', 'expansion/second-pass-live-before.json', 'expansion/first-pass-checkpoints.json',
  'expansion/remaining13/checkpoints.json', 'expansion/remaining13/targeted.json', 'expansion/remaining13/registry-additions.json',
  'expansion/remaining13/verified-health-additions.json', 'expansion/remaining13/verified-existing-health.json']);
export const collectorCodePath = path => fixed.includes(path) || fixtureFiles.has(path)
  || /^(?:src\/[A-Za-z0-9_-]+\.ts|dist\/[A-Za-z0-9_-]+\.(?:js|d\.ts)|scripts\/[A-Za-z0-9_-]+\.(?:mjs|py)|test\/[A-Za-z0-9_-]+(?:\.test)?\.mjs|dashboard\/(?:index\.html|app\.js|styles\.css)|site\/(?:[A-Za-z0-9_-]+\.(?:html|css|svg)|\.well-known\/openai-apps-challenge)|metrics\/(?:worker\.mjs|schema\.sql|report\.sql)|plugin\/(?:plugin\.json|mcp\.json|skills\/find-news-sources\/(?:SKILL\.md|agents\/openai\.yaml)))$/.test(path);

export async function prepareCollectorRelease({ packageRoot = root, output, revision }) {
  if (!output || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(revision ?? '')) throw Error('COLLECTOR_RELEASE_INVALID_OPTIONS');
  const destination = resolve(output);
  try { await lstat(destination); throw Error('COLLECTOR_RELEASE_OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const listed = [];
  const walk = async (directory, prefix = '') => {
    for (const name of await readdir(directory)) {
      if (name === 'node_modules' || name === 'output' || name === '.deploy-vercel' || name === '.vercel') continue;
      const path = prefix + name, info = await lstat(join(directory, name));
      if (info.isDirectory() && /^(?:src|dist|scripts|test|dashboard|site|metrics|plugin|expansion)(?:\/|$)/.test(path)) await walk(join(directory, name), path + '/');
      else if (collectorCodePath(path)) {
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw Error('COLLECTOR_RELEASE_UNSAFE_FILE');
        listed.push(path);
      }
    }
  };
  await walk(packageRoot);
  for (const required of [...fixed, 'dist/activity-ledger.js', 'dist/collection-schedule.js', 'scripts/collect-activity.mjs',
    'scripts/prepare-vercel.mjs', 'scripts/quality-cloud-gateway.mjs', 'scripts/install-collector-release.py'])
    if (!listed.includes(required)) throw Error('COLLECTOR_RELEASE_BUILD_REQUIRED');
  const manifest = { version: 1, kind: 'world-press-radar-collector-code-only', revision,
    prepared_at: new Date().toISOString(), files: [], contains_registry: false, contains_activity_ledger: false,
    contains_credentials: false, authoritative_data_source: 'existing-oracle-release-only' };
  for (const path of listed.sort()) {
    const bytes = await readFile(join(packageRoot, path));
    manifest.files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 32 * 1024 * 1024) throw Error('COLLECTOR_RELEASE_CODE_SIZE_LIMIT');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    const target = join(destination, 'packages/world-news-sources-mcp', file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(packageRoot, file.path), target);
  }
  await writeFile(join(destination, 'COLLECTOR-CODE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'prepared_code_only', output: destination, revision, files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), credentials_copied: false, production_data_copied: false, activated: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), parsed = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (!['--output', '--revision'].includes(key) || parsed[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('COLLECTOR_RELEASE_INVALID_OPTIONS');
      parsed[key] = args[++i];
    }
    console.log(JSON.stringify(await prepareCollectorRelease({ output: parsed['--output'], revision: parsed['--revision'] })));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', error: /^COLLECTOR_RELEASE_[A-Z_]+$/.test(error.message) ? error.message : 'COLLECTOR_RELEASE_PREPARATION_FAILED' })); process.exitCode = 1;
  }
}
