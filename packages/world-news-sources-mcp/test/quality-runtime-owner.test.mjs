import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { QualityRuntimeLease, QualityRunStore, PersistentModelBudget } from '../dist/quality-runtime-storage.js';
import { createLocalQualityRuntime } from '../dist/quality-local-runtime.js';

test('A duplicate runtime cannot reconcile a live owner investigation or reset its shared budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-owner-')), path = join(dir, 'runtime.sqlite');
  const owner = new QualityRuntimeLease(path), runs = new QualityRunStore(path), budget = new PersistentModelBudget(path, 5);
  try {
    runs.save({ id: 'pending-owner-fixture', status: 'running', started_at: new Date().toISOString(), events: [], cost: { provider: 'openai' } });
    budget.reserve(.25);
    assert.throws(() => createLocalQualityRuntime({ WNS_QUALITY_STATE_DIR: dir }), /QUALITY_RUNTIME_ALREADY_RUNNING/);
    assert.equal(runs.get('pending-owner-fixture').status, 'running');
    assert.equal(budget.summary().estimated_or_reserved_usd, .25);
  } finally { runs.close(); budget.close(); owner.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('An exited owner can be claimed atomically without releasing uncertain paid reservations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-owner-dead-')), path = join(dir, 'runtime.sqlite');
  try {
    const module = new URL('../dist/quality-runtime-storage.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {QualityRuntimeLease,PersistentModelBudget} from ${JSON.stringify(module)}; new QualityRuntimeLease(process.argv[1]); const b=new PersistentModelBudget(process.argv[1],5); b.reserve(.2); b.close();`, path], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const next = new QualityRuntimeLease(path), budget = new PersistentModelBudget(path, 5);
    try { assert.equal(budget.summary().estimated_or_reserved_usd, .2); assert.equal(budget.summary().remaining_usd, 4.8); }
    finally { budget.close(); next.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP reconciliation leaves a live daily writer untouched and recovers it only after that process exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-daily-owner-')), path = join(dir, 'runtime.sqlite');
  const module = new URL('../dist/quality-runtime-storage.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {QualityRunStore} from ${JSON.stringify(module)}; const store=new QualityRunStore(process.argv[1]); store.save({id:'daily-live-fixture',status:'running',started_at:new Date().toISOString(),events:[],cost:{provider:'rules'}}); process.send('ready'); process.on('message',()=>{store.close();process.exit(0);});`, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let store;
  try {
    const [ready] = await once(child, 'message'); assert.equal(ready, 'ready');
    store = new QualityRunStore(path);
    const before = store.get('daily-live-fixture');
    assert.equal(store.reconcileInterrupted(), 0);
    assert.deepEqual(store.get('daily-live-fixture'), before);
    assert.equal(JSON.stringify(store.list()).includes('owner_pid'), false);
    child.send('exit'); const [code] = await once(child, 'exit'); assert.equal(code, 0);
    assert.equal(store.reconcileInterrupted(), 1);
    assert.equal(store.get('daily-live-fixture').status, 'failed');
    assert.equal(store.reconcileInterrupted(), 0);
  } finally { if (child.exitCode === null) child.kill(); store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('five-column legacy stores migrate additively and reconcile only unknown legacy ownership', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-owner-migration-')), path = join(dir, 'runtime.sqlite');
  const legacy = new DatabaseSync(path), run = { id: 'legacy-unowned-fixture', status: 'running', started_at: new Date().toISOString(), events: [], cost: { provider: 'openai' } };
  legacy.exec('CREATE TABLE quality_runs(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,started_at TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL)');
  legacy.prepare('INSERT INTO quality_runs VALUES(?,?,?,?,?)').run(run.id, null, run.started_at, run.status, JSON.stringify(run)); legacy.close();
  const migrated = new QualityRunStore(path);
  try {
    assert.deepEqual(migrated.get(run.id), run);
    assert.equal(migrated.reconcileInterrupted(), 1);
    assert.equal(migrated.get(run.id).cost.cost_basis, 'interrupted; conservative_reservations_retained');
    migrated.save({ ...run, id: 'current-live-fixture' });
    assert.equal(migrated.reconcileInterrupted(), 0);
    assert.equal(migrated.get('current-live-fixture').status, 'running');
    const details = new DatabaseSync(path);
    try { assert.equal(Number(details.prepare('SELECT owner_pid FROM quality_runs WHERE id=?').get('current-live-fixture').owner_pid), process.pid); }
    finally { details.close(); }
  } finally { migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});
