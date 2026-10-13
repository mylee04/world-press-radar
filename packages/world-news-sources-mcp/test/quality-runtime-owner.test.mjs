import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
