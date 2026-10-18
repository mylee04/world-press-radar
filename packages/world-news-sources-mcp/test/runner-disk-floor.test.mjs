import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../ops/runner-disk-floor.py', import.meta.url));
const gib = 1024 ** 3;
const harness = String.raw`
import contextlib, hashlib, importlib.util, io, json, os, pathlib, sqlite3, sys, tempfile, types
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("disk_floor", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
options = json.loads(sys.argv[2])
with tempfile.TemporaryDirectory(prefix="wns-disk-guard-") as directory:
    base = pathlib.Path(directory).resolve()
    db = base / "activity.sqlite"
    writer = None
    if options.get("ledger", "valid") == "valid":
        writer = sqlite3.connect(db)
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE observations (id INTEGER PRIMARY KEY, baseline INTEGER, value BLOB)")
        writer.execute("INSERT INTO observations VALUES (1, 1, zeroblob(?))", (65536,))
        writer.commit()
    elif options["ledger"] == "empty":
        db.touch()
    if options.get("backups", False):
        (base / "backups").mkdir()
    def snapshot():
        return {str(path.relative_to(base)): {"bytes": path.stat().st_size,
            "mtime_ns": path.stat().st_mtime_ns,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in base.rglob("*") if path.is_file()}
    before = snapshot()
    output = io.StringIO()
    filesystem = types.SimpleNamespace(f_bavail=options["free"], f_frsize=1)
    def no_backup_size(_):
        raise AssertionError("A regular preflight must not inspect backup size")
    size_context = patch.object(guard, "backup_size", no_backup_size) if options.get("forbid_backup_size") else contextlib.nullcontext()
    error = None
    with patch.object(sys, "argv", [str(spec.origin), options["phase"], str(db), str(base)]), \
         patch.object(guard.os, "statvfs", return_value=filesystem) as filesystem_call, \
         size_context, contextlib.redirect_stdout(output):
        try:
            guard.main()
        except Exception as failure:
            error = {"type": type(failure).__name__, "message": str(failure)}
    after = snapshot()
    rows = writer.execute("SELECT id,baseline,length(value) FROM observations").fetchall() if writer else None
    result = {"guard": json.loads(output.getvalue()) if output.getvalue() else None,
        "error": error, "before": before, "after": after,
        "guarded_path": str(filesystem_call.call_args.args[0].relative_to(base)) if filesystem_call.called else None,
        "backups_exist": (base / "backups").exists(), "rows": rows}
    if writer:
        writer.close()
    print(json.dumps(result))
`;

function run(options) {
  const result = spawnSync('python3', ['-c', harness, guard, JSON.stringify(options)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('regular preflight admits exactly 52 GiB without a backup directory or backup-size query', () => {
  const result = run({ phase: 'before-run', free: 52 * gib, forbid_backup_size: true });
  assert.equal(result.error, null);
  assert.equal(result.guard.passed, true);
  assert.equal(result.guard.required_free_bytes, 52 * gib);
  assert.equal(result.guard.next_backup_reserved_bytes, 0);
  assert.equal(result.guarded_path, '.');
  assert.equal(result.backups_exist, false);
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(result.rows, [[1, 1, 65536]]);
});

test('regular preflight refuses one byte below its growth budget and the 50 GiB floor', () => {
  for (const free of [52 * gib - 1, 50 * gib]) {
    const result = run({ phase: 'before-run', free, forbid_backup_size: true });
    assert.equal(result.guard.passed, false);
    assert.equal(result.error.type, 'RuntimeError');
    assert.match(result.error.message, /no further pipeline work/);
    assert.deepEqual(result.after, result.before);
    assert.equal(result.backups_exist, false);
  }
});

test('regular preflight refuses missing and empty ledgers without creating a replacement', () => {
  for (const ledger of ['missing', 'empty']) {
    const result = run({ phase: 'before-run', free: 100 * gib, ledger, forbid_backup_size: true });
    assert.equal(result.guard, null);
    assert.equal(result.error.type, 'RuntimeError');
    assert.match(result.error.message, /Existing nonempty ledger/);
    assert.deepEqual(result.after, result.before);
    assert.equal(result.backups_exist, false);
  }
});

test('legacy pre-backup sizing reserves committed WAL pages and leaves persistent ledger files intact', () => {
  const result = run({ phase: 'before-backup', free: 100 * gib, backups: true });
  assert.equal(result.error, null);
  assert.equal(result.guard.passed, true);
  assert.ok(result.guard.next_backup_reserved_bytes > result.before['activity.sqlite'].bytes);
  assert.equal(result.guard.required_free_bytes, 52 * gib + result.guard.next_backup_reserved_bytes);
  assert.equal(result.guarded_path, 'backups');
  // SQLite read locks may update SHM reader marks, but not the DB or WAL.
  for (const file of ['activity.sqlite', 'activity.sqlite-wal'])
    assert.deepEqual(result.after[file], result.before[file]);
  assert.deepEqual(result.rows, [[1, 1, 65536]]);
});

test('postflight retains exactly 50 GiB and refuses one byte below', () => {
  const admitted = run({ phase: 'postflight', free: 50 * gib, backups: true, forbid_backup_size: true });
  assert.equal(admitted.error, null);
  assert.equal(admitted.guard.required_free_bytes, 50 * gib);
  assert.equal(admitted.guard.passed, true);
  const refused = run({ phase: 'postflight', free: 50 * gib - 1, backups: true, forbid_backup_size: true });
  assert.equal(refused.guard.passed, false);
  assert.equal(refused.error.type, 'RuntimeError');
  assert.deepEqual(refused.after, refused.before);
});
