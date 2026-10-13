import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { encodeHistory } from '../dist/activity-history.js';
import { collectBundle } from '../scripts/deploy-project-api.mjs';

test('Vercel preparation uses the explicit production metadata and its sibling verified history', async t => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'wns-vercel-fresh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const folder of ['dist', 'dashboard', 'site', 'scripts']) cpSync(join(packageRoot, folder), join(directory, folder), { recursive: true, filter: source => !source.endsWith('.env') });
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(packageRoot, file), join(directory, file));
  symlinkSync(join(packageRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const staged = join(directory, 'fresh'); mkdirSync(join(staged, 'history'), { recursive: true });
  const record = { checked_at: '2026-10-13T03:53:00.000Z', endpoint_id: 'fresh-endpoint', status: 'working_nonempty', format: 'rss', uncertain_urls: 0,
    baseline_sources: [], source_new: { fresh: 4 }, country_new: { US: 4 }, newest_content_at: '2026-10-13T03:30:00.000Z', date_kind: 'feed_item_date' };
  const bytes = encodeHistory([record]), sha256 = createHash('sha256').update(bytes).digest('hex');
  const shard = { month: '2026-10', file: `2026-10-${sha256}.json.gz`, sha256, bytes: bytes.length, records: 1 };
  writeFileSync(join(staged, 'history', shard.file), bytes);
  const metadata = {
    registry: { countries: [{ code: 'US', name: 'United States', feeds: [{ name: 'Fresh production fixture', url: 'https://publisher.example/fresh', enabled: true }] }] },
    legacy: { results: [{ countryCode: 'US', outlet: 'Fresh production fixture', url: 'https://publisher.example/fresh', checkedAt: record.checked_at, valid: true, httpCode: 200 }] },
    health: { version: 1, observations: [] },
    activity: { version: 1, lane: 'production', snapshot_at: record.checked_at, collections: [], history: { version: 1, complete: true, shards: [shard] } },
  };
  for (const [name, value] of Object.entries(metadata)) writeFileSync(join(staged, `${name}.json`), JSON.stringify(value));
  const env = { ...process.env, WNS_REGISTRY_PATH: join(staged, 'registry.json'), WNS_LEGACY_HEALTH_PATH: join(staged, 'legacy.json'), WNS_HEALTH_PATH: join(staged, 'health.json'), WNS_ACTIVITY_PATH: join(staged, 'activity.json') };
  const run = spawnSync(process.execPath, ['scripts/prepare-vercel.mjs'], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const bundle = join(directory, '.deploy-vercel');
  const registry = JSON.parse(readFileSync(join(bundle, 'metadata/registry.json'), 'utf8'));
  assert.equal(registry.countries[0].feeds[0].name, 'Fresh production fixture');
  assert.equal(JSON.parse(readFileSync(join(bundle, 'metadata/activity.json'), 'utf8')).snapshot_at, record.checked_at);
  assert.deepEqual(readFileSync(join(bundle, 'metadata/activity-history', shard.file)), bytes);
  assert.ok(existsSync(join(bundle, 'dist/health.js')), 'template-only runtime imports must also be copied');
  assert.ok(existsSync(join(bundle, 'dist/quality-cloud-gateway.mjs')));
  const files = await collectBundle(bundle);
  assert.ok(files.some(file => file.file === `metadata/activity-history/${shard.file}`));
  assert.ok(!files.some(file => /(?:sqlite|\.env|fresh\/)/.test(file.file)));
  assert.equal(JSON.parse(readFileSync(join(staged, 'registry.json'), 'utf8')).countries[0].feeds[0].name, 'Fresh production fixture');
});

test('an explicitly missing metadata path stops preparation before any upload', t => {
  const root = mkdtempSync(join(tmpdir(), 'wns-metadata-missing-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ['scripts/prepare-vercel.mjs'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, WNS_REGISTRY_PATH: join(root, 'missing.json') }, encoding: 'utf8' });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /WNS_REGISTRY_PATH does not exist/);
});
