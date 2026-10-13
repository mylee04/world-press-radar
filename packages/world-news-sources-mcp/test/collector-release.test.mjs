import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareCollectorRelease, collectorCodePath } from '../scripts/prepare-collector-release.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'collector-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package'), output = join(directory, 'bundle');
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'dist/activity-ledger.js', 'dist/collection-schedule.js',
    'scripts/collect-activity.mjs', 'scripts/prepare-vercel.mjs', 'scripts/quality-cloud-gateway.mjs', 'scripts/install-collector-release.py', 'test/inventory.test.mjs'];
  for (const path of files) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), '// fixture\n'); }
  return { root, output, directory, options: { packageRoot: root, output, revision: 'daily-quality-test' } };
}

test('collector release transfers exact code while excluding credentials, registry and private history', async t => {
  const f = await fixture(t);
  for (const path of ['.env', 'output/typesafe.env', '.vercel/auth.json', 'data/rss-atlas.json', 'activity/production.sqlite', 'audits/health-latest.json', 'metrics/wrangler.jsonc']) {
    await mkdir(dirname(join(f.root, path)), { recursive: true }); await writeFile(join(f.root, path), 'never-transfer');
    assert.equal(collectorCodePath(path), false);
  }
  const result = await prepareCollectorRelease(f.options);
  assert.equal(result.status, 'prepared_code_only'); assert.equal(result.production_data_copied, false);
  const manifest = JSON.parse(await readFile(join(f.output, 'COLLECTOR-CODE-MANIFEST.json'), 'utf8'));
  assert.equal(manifest.contains_credentials, false); assert.equal(manifest.files.length, 10);
  assert.ok(manifest.files.some(file => file.path === 'test/inventory.test.mjs'));
  assert.ok(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.deepEqual((await readdir(f.output)).sort(), ['COLLECTOR-CODE-MANIFEST.json', 'packages']);
});

test('collector code bundle refuses symlinks and leaves an existing bundle intact', async t => {
  const f = await fixture(t);
  await symlink(join(f.root, '.env'), join(f.root, 'dist/secret.js')); await writeFile(join(f.root, '.env'), 'never-read');
  await assert.rejects(prepareCollectorRelease(f.options), /UNSAFE_FILE/);
  await rm(join(f.root, 'dist/secret.js')); await prepareCollectorRelease(f.options);
  const before = await readFile(join(f.output, 'COLLECTOR-CODE-MANIFEST.json'));
  await assert.rejects(prepareCollectorRelease(f.options), /OUTPUT_EXISTS/);
  assert.deepEqual(await readFile(join(f.output, 'COLLECTOR-CODE-MANIFEST.json')), before);
});

test('collector installer independently verifies the code hash and rejects extra files before any operational action', async t => {
  const f = await fixture(t); await prepareCollectorRelease(f.options);
  const installer = new URL('../scripts/install-collector-release.py', import.meta.url);
  const verify = () => spawnSync('python3', ['-c',
    'import runpy,sys; module=runpy.run_path(sys.argv[1]); from pathlib import Path; module["verify_bundle"](Path(sys.argv[2]))',
    installer.pathname, f.output], { encoding: 'utf8' });
  assert.equal(verify().status, 0);
  await writeFile(join(f.output, 'secret.env'), 'unlisted');
  let invalid = verify(); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /UNLISTED_BUNDLE_FILE/);
  await rm(join(f.output, 'secret.env'));
  await writeFile(join(f.output, 'packages/world-news-sources-mcp/dist/activity-ledger.js'), '// altered\n');
  invalid = verify(); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /CODE_HASH_MISMATCH/);
});

test('a registry edit during export stops activation and keeps the current pointer; provider credentials never enter validation env', async t => {
  const f = await fixture(t), installer = new URL('../scripts/install-collector-release.py', import.meta.url);
  const result = spawnSync('python3', ['-c', `import runpy,sys,os
from pathlib import Path
m=runpy.run_path(sys.argv[1]); base=Path(sys.argv[2]).resolve(); old=base/'old'; new=base/'new'; old.mkdir(); new.mkdir()
for root in [old,new]:
 (root/'data').mkdir(); (root/'data/rss-atlas.json').write_text('before')
current=base/'current'; current.symlink_to(old)
hashes={'data/rss-atlas.json':m['hash_file'](old/'data/rss-atlas.json')}
(old/'data/rss-atlas.json').write_text('operator-change-during-export')
try:
 m['verify_activation_metadata'](old,new,hashes)
 os.replace(new,current)
 raise AssertionError('must not activate')
except RuntimeError as error:
 assert str(error)=='COLLECTOR_RELEASE_AUTHORITATIVE_DATA_CHANGED_BEFORE_ACTIVATION', str(error)
assert current.resolve()==old
os.environ.update(OPENAI_API_KEY='fixture',TYPESAFE_API_KEY='fixture',WNS_JEV_KEY_FILE='/private/fixture',WNS_OPENAI_PAID_APPROVED='1',VERCEL_TOKEN='fixture',WNS_ACTIVITY_DB='/private/fixture')
env=m['offline_environment']()
assert not any(key.startswith(('WNS_','VERCEL_')) or key in ['OPENAI_API_KEY','TYPESAFE_API_KEY'] for key in env)
`, installer.pathname, f.directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('offline activation gate rejects a zero-case test run and a manifest without the real test suite', async t => {
  const f = await fixture(t), installer = new URL('../scripts/install-collector-release.py', import.meta.url);
  const result = spawnSync('python3', ['-c', `import runpy,sys
from pathlib import Path
m=runpy.run_path(sys.argv[1]); log=Path(sys.argv[2])/'test.log'; manifest={'files':[{'path':'test/case_'+str(i)+'.test.mjs'} for i in range(20)]}
log.write_text('# tests 0\\n# pass 0\\n# fail 0\\n')
try: m['tested_cases'](log,manifest); raise AssertionError('zero tests must not pass')
except RuntimeError as error: assert str(error)=='COLLECTOR_RELEASE_OFFLINE_TEST_SUITE_INCOMPLETE'
log.write_text('# tests 25\\n# pass 25\\n# fail 0\\n'); assert m['tested_cases'](log,manifest)==25
try: m['tested_cases'](log,{'files':[]}); raise AssertionError('no files must not pass')
except RuntimeError as error: assert str(error)=='COLLECTOR_RELEASE_OFFLINE_TEST_SUITE_INCOMPLETE'
`, installer.pathname, f.directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
