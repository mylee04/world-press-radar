import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { OpenAISessionBudget } from './openai-runtime.js';
import type { InvestigationRun } from './investigation.js';

function database(path: string) {
  if (path !== ':memory:') {
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw Error('QUALITY_STORAGE_UNSAFE_PATH');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  if (path !== ':memory:') chmodSync(path, 0o600);
  return db;
}

/** Claim the state directory before reconciling interrupted jobs; duplicate servers fail closed. */
export class QualityRuntimeLease {
  private readonly db: DatabaseSync;
  private readonly nonce = randomUUID();
  constructor(path: string) {
    this.db = database(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS quality_runtime_owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,nonce TEXT NOT NULL);');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.db.prepare('SELECT pid FROM quality_runtime_owner WHERE id=1').get();
      if (owner) {
        let alive = true;
        try { process.kill(Number(owner.pid), 0); }
        catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw Error('QUALITY_RUNTIME_ALREADY_RUNNING');
      }
      this.db.prepare('INSERT INTO quality_runtime_owner VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce').run(process.pid,this.nonce);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  close() {
    this.db.prepare('DELETE FROM quality_runtime_owner WHERE id=1 AND nonce=?').run(this.nonce);
    this.db.close();
  }
}

/** One approved pilot ceiling across providers, CLI invocations and restarts. */
export class PersistentModelBudget extends OpenAISessionBudget {
  private readonly db: DatabaseSync;
  private readonly ids = new WeakMap<object, string>();
  constructor(path: string, limitUsd: number, readonly budgetId = 'news-quality-pilot-20261013') {
    super(limitUsd);
    if (!(limitUsd > 0) || !Number.isFinite(limitUsd) || !/^[a-zA-Z0-9_-]{1,80}$/.test(budgetId)) throw Error('QUALITY_BUDGET_INVALID');
    this.db = database(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS model_budgets(id TEXT PRIMARY KEY, limit_usd REAL NOT NULL, held_usd REAL NOT NULL); CREATE TABLE IF NOT EXISTS model_reservations(id TEXT PRIMARY KEY,budget_id TEXT NOT NULL,upper_usd REAL NOT NULL,settled_usd REAL,at TEXT NOT NULL);');
    this.db.prepare('INSERT INTO model_budgets VALUES(?,?,0) ON CONFLICT DO NOTHING').run(budgetId, limitUsd);
    const current = this.db.prepare('SELECT limit_usd FROM model_budgets WHERE id=?').get(budgetId)!;
    if (Number(current.limit_usd) !== limitUsd) { this.db.close(); throw Error('QUALITY_APPROVED_BUDGET_MISMATCH'); }
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  override reserve(upperBoundUsd: number) {
    if (!Number.isFinite(upperBoundUsd) || upperBoundUsd < 0) throw Error('OPENAI_SESSION_BUDGET_LIMIT');
    const id = randomUUID();
    this.transaction(() => {
      const updated = this.db.prepare('UPDATE model_budgets SET held_usd=held_usd+? WHERE id=? AND held_usd+?<=limit_usd+0.000000000001').run(upperBoundUsd,this.budgetId,upperBoundUsd);
      if (!Number(updated.changes)) throw Error('OPENAI_SESSION_BUDGET_LIMIT');
      this.db.prepare('INSERT INTO model_reservations VALUES(?,?,?,NULL,?)').run(id,this.budgetId,upperBoundUsd,new Date().toISOString());
    });
    const reservation = { upperBoundUsd, settled: false }; this.ids.set(reservation,id); return reservation;
  }
  override settle(reservation: { upperBoundUsd: number; settled: boolean }, usageEstimateUsd: number) {
    const id = this.ids.get(reservation);
    if (!id || reservation.settled) throw Error('OPENAI_BUDGET_ALREADY_SETTLED');
    if (!Number.isFinite(usageEstimateUsd) || usageEstimateUsd < 0) throw Error('OPENAI_USAGE_COST_UNKNOWN');
    this.transaction(() => {
      const row = this.db.prepare('SELECT settled_usd FROM model_reservations WHERE id=? AND budget_id=?').get(id,this.budgetId);
      if (!row || row.settled_usd !== null) throw Error('OPENAI_BUDGET_ALREADY_SETTLED');
      this.db.prepare('UPDATE model_reservations SET settled_usd=? WHERE id=?').run(usageEstimateUsd,id);
      this.db.prepare('UPDATE model_budgets SET held_usd=held_usd+? WHERE id=?').run(usageEstimateUsd-reservation.upperBoundUsd,this.budgetId);
    });
    reservation.settled = true;
    if (usageEstimateUsd > reservation.upperBoundUsd + 1e-12) throw Error('OPENAI_COST_BOUND_EXCEEDED');
  }
  override summary() {
    const row = this.db.prepare('SELECT limit_usd,held_usd FROM model_budgets WHERE id=?').get(this.budgetId)!;
    return { authorization_limit_usd: Number(row.limit_usd), estimated_or_reserved_usd: Number(row.held_usd),
      remaining_usd: Math.max(0,Number(row.limit_usd)-Number(row.held_usd)), persistence: 'sqlite_across_providers_and_restarts' };
  }
  close() { this.db.close(); }
}

/** Run evidence is durable; pending work is never silently restarted after a crash. */
export class QualityRunStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = database(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS quality_runs(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,started_at TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS quality_run_date ON quality_runs(started_at);');
  }
  save(run: InvestigationRun) {
    const payload = JSON.stringify(run);
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024) throw Error('QUALITY_RUN_STORAGE_LIMIT');
    this.db.prepare('INSERT INTO quality_runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(run.id,run.request_id??null,run.started_at,run.status,payload);
  }
  get(id: string) { const row = this.db.prepare('SELECT payload FROM quality_runs WHERE id=?').get(id); return row ? JSON.parse(String(row.payload)) as InvestigationRun : undefined; }
  getByRequestId(id: string) { const row = this.db.prepare('SELECT payload FROM quality_runs WHERE request_id=?').get(id); return row ? JSON.parse(String(row.payload)) as InvestigationRun : undefined; }
  list(limit = 20) { return this.db.prepare('SELECT payload FROM quality_runs ORDER BY started_at DESC LIMIT ?').all(Math.min(100,Math.max(1,limit))).map(row=>JSON.parse(String(row.payload)) as InvestigationRun); }
  reconcileInterrupted() {
    const rows = this.db.prepare("SELECT payload FROM quality_runs WHERE status='running'").all();
    for (const row of rows) {
      const run = JSON.parse(String(row.payload)) as InvestigationRun;
      run.status = 'failed'; run.finished_at = new Date().toISOString(); run.summary = '서버 재시작으로 조사가 중단됐습니다. 저장된 근거만 표시하며 자동 재실행하지 않았습니다.';
      if (run.cost.provider !== 'rules') { run.cost.estimated_model_cost_usd = null; run.cost.cost_basis = 'interrupted; conservative_reservations_retained'; }
      this.save(run);
    }
    return rows.length;
  }
  close() { this.db.close(); }
}
