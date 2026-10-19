import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../ops/shared-project-retention.py', import.meta.url));
const harness = String.raw`
import importlib.util, json, os, pathlib, sqlite3, sys, tempfile, time, urllib.request
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("retention", sys.argv[1])
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
def forbidden(*args, **kwargs):
    raise AssertionError("Real processes, SQLite and live network are forbidden")
with tempfile.TemporaryDirectory(prefix="wns-retention-fixture-") as directory:
    base = pathlib.Path(directory).resolve(); clinic = base / "clinic"; fbm = base / "fbm"
    for path in [clinic / "releases", clinic / "data", fbm / "backups/postgres"]:
        path.mkdir(parents=True)
    now = time.time()
    def old(path, rank=0):
        os.utime(path, (now - 20000 + rank, now - 20000 + rank)); return path
    def release(name, rank=0):
        path = clinic / "releases" / name; path.mkdir(); (path / "build.txt").write_text(name)
        return old(path, rank)
    current = release("20261001-current")
    (clinic / "current").symlink_to(current, target_is_directory=True)
    def backup(parent, name, rank=0):
        path = parent / name; path.mkdir(parents=True)
        (path / "clinic-signals.sqlite3").write_bytes(b"fixture")
        (path / "manifest.json").write_text(json.dumps({"method": "sqlite-online-backup", "databases": [{"name": "clinic-signals.sqlite3", "bytes": 7}]}))
        return old(path, rank)
    def contact(day, rank=0):
        path = clinic / "data/.contact-backups" / ("planned-202610%02dT000000Z.sqlite3" % day)
        path.parent.mkdir(exist_ok=True); path.write_bytes(b"contact fixture"); return old(path, rank)
    def plan(scope="all", references=None):
        return helper.build_plan(scope, clinic, fbm, references=set() if references is None else references, now=now)
    original_rmtree = helper.shutil.rmtree
    def bounded_rmtree(path, *args, **kwargs):
        target = pathlib.Path(path).absolute()
        if target != base and base not in target.parents:
            raise AssertionError("Removal outside temporary fixture")
        return original_rmtree(path, *args, **kwargs)
    bounded_rmtree.avoids_symlink_attacks = original_rmtree.avoids_symlink_attacks
    with patch.object(helper, "process_paths", side_effect=forbidden), patch.object(sqlite3, "connect", side_effect=forbidden), patch.object(urllib.request, "urlopen", side_effect=forbidden), patch.object(helper.shutil, "rmtree", bounded_rmtree):
        exec(sys.argv[2])
`;

function run(code) {
  const result = spawnSync('python3', ['-c', harness, helper, code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('protects the current release, two newest rollback releases and process-referenced old releases', () => {
  assert.deepEqual(run(String.raw`
referenced = release("20261002-referenced", 1)
expired = release("20261003-expired", 2)
rollback1 = release("20261004-rollback", 3)
rollback2 = release("20261005-rollback", 4)
result = plan("clinic", {referenced / "build.txt"})
print(json.dumps({"retained": sorted(pathlib.Path(p).name for p in result["retained"]), "candidates": [pathlib.Path(r["path"]).name for r in result["candidates"]], "skipped": [(pathlib.Path(r["path"]).name, r["reason"]) for r in result["skipped"]]}))
`), { retained: ['20261001-current', '20261004-rollback', '20261005-rollback'], candidates: ['20261003-expired'], skipped: [['20261002-referenced', 'referenced_or_outside_scope']] });
});

test('retains three complete Clinic daily backups, one manual, one contact and seven FBM dumps', () => {
  const result = run(String.raw`
for i in range(5): backup(clinic / "backups", "backup-202610%02dT000000000000Z" % (i + 1), i)
for i in range(3): backup(clinic / "backups/contact-goal7000", "backup-phase1-202610%02dT000000000000Z" % (i + 1), i)
for i in range(3): contact(i + 1, i)
for i in range(9):
    path = fbm / "backups/postgres" / ("fbm_ai-202610%02dT000000Z.dump" % (i + 1)); path.write_bytes(b"PGDMPfixture"); old(path, i)
result = plan()
print(json.dumps({"retained": sorted(str(pathlib.Path(p).relative_to(base)) for p in result["retained"]), "expired": sorted(str(pathlib.Path(r["path"]).relative_to(base)) for r in result["candidates"])}))
`);
  const daily = day => `clinic/backups/backup-202610${String(day).padStart(2, '0')}T000000000000Z`;
  const manual = day => `clinic/backups/contact-goal7000/backup-phase1-202610${String(day).padStart(2, '0')}T000000000000Z`;
  const contact = day => `clinic/data/.contact-backups/planned-202610${String(day).padStart(2, '0')}T000000Z.sqlite3`;
  const dump = day => `fbm/backups/postgres/fbm_ai-202610${String(day).padStart(2, '0')}T000000Z.dump`;
  assert.deepEqual(result.retained, ['clinic/releases/20261001-current', ...[3, 4, 5].map(daily), manual(3), contact(3), ...[3, 4, 5, 6, 7, 8, 9].map(dump)].sort());
  assert.deepEqual(result.expired, [...[1, 2].map(daily), ...[1, 2].map(manual), ...[1, 2].map(contact), ...[1, 2].map(dump)].sort());
});

test('recognizes bounded backup sidecars and removes old manual databases while preserving audit proof', () => {
  assert.deepEqual(run(String.raw`
parent = clinic / "backups/contact-goal7000"
expired = backup(parent, "backup-phase1-20261001T000000000000Z")
latest = backup(parent, "backup-phase1-20261002T000000000000Z", 1)
for path, rank in [(expired, 0), (latest, 1)]:
    (path / "clinic-signals.sqlite3-wal").write_bytes(b"")
    (path / "clinic-signals.sqlite3-shm").write_bytes(b"x" * 32768)
    (path / "dedupe-proof.json").write_text('{"verified":true}')
    old(path, rank)
unknown = backup(parent, "backup-phase1-20261003T000000000000Z", 2)
(unknown / "unknown-large.json").write_text(json.dumps({"original": "x" * 70000})); old(unknown, 2)
recognized = helper.completed_backup(expired)
large_rejected = not helper.completed_backup(unknown)
latest_before = {p.name: p.read_bytes() for p in latest.iterdir()}
expired_proof = {name: (expired / name).read_bytes() for name in ["manifest.json", "dedupe-proof.json"]}
result = helper.remove_candidates(plan("clinic"), clinic, references=set())
print(json.dumps({"recognized": recognized, "large_rejected": large_rejected, "removed_only_old_manual": result["removed"] == [str(expired)], "old_files": sorted(p.name for p in expired.iterdir()), "proof_preserved": all((expired / name).read_bytes() == value for name, value in expired_proof.items()), "latest_unchanged": latest_before == {p.name: p.read_bytes() for p in latest.iterdir()}, "unknown_database_preserved": (unknown / "clinic-signals.sqlite3").read_bytes() == b"fixture"}))
`), { recognized: true, large_rejected: true, removed_only_old_manual: true, old_files: ['dedupe-proof.json', 'manifest.json'], proof_preserved: true, latest_unchanged: true, unknown_database_preserved: true });
});

test('preserves unknown directories, incomplete backups, invalid dump files and original data', () => {
  assert.deepEqual(run(String.raw`
unknown_release = clinic / "releases/original-source"; unknown_release.mkdir()
unknown_backup = clinic / "backups/unclassified"; unknown_backup.mkdir(parents=True)
incomplete = backup(clinic / "backups", "backup-20261009T000000000000Z")
(incomplete / "keep-original.txt").write_text("unclassified original")
original = clinic / "data/clinic-signals.sqlite3"; original.write_bytes(b"original database fixture")
unknown_file = clinic / "data/tmp1234"; unknown_file.write_bytes(b"not an approved temporary name"); old(unknown_file)
invalid_dump = fbm / "backups/postgres/fbm_ai-20261009T000000Z.dump"; invalid_dump.write_bytes(b"original, not a PostgreSQL dump"); old(invalid_dump)
expired = contact(1); contact(2, 1)
result = helper.remove_candidates(plan(), clinic, references=set())
print(json.dumps({"removed_only_known": result["removed"] == [str(expired)], "unknown_survive": all(p.exists() for p in [unknown_release, unknown_backup, incomplete, unknown_file, invalid_dump]), "original": original.read_text()}))
`), { removed_only_known: true, unknown_survive: true, original: 'original database fixture' });
});

test('unlinks release data symlinks without following them into the preserved source data', () => {
  assert.deepEqual(run(String.raw`
expired = release("20261002-expired", 1)
release("20261003-rollback", 2); release("20261004-rollback", 3)
marker = clinic / "data/source-original.txt"; marker.write_text("preserved source")
(expired / "data").symlink_to(clinic / "data", target_is_directory=True); old(expired, 1)
result = helper.remove_candidates(plan("clinic"), clinic, references=set())
print(json.dumps({"removed": result["removed"] == [str(expired)], "release_absent": not expired.exists(), "source_data": marker.read_text(), "current_exists": current.exists()}))
`), { removed: true, release_absent: true, source_data: 'preserved source', current_exists: true });
});

test('fails closed when a candidate inode or modification time changes after preview', () => {
  assert.deepEqual(run(String.raw`
replaced = contact(1); changed = contact(2, 1); contact(3, 2)
preview = plan("clinic")
original_stat = replaced.stat()
replacement = replaced.with_suffix(".replacement"); replacement.write_bytes(b"new protected bytes")
os.utime(replacement, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns)); os.replace(replacement, replaced)
changed_stat = changed.stat(); os.utime(changed, ns=(changed_stat.st_atime_ns, changed_stat.st_mtime_ns + 1000000))
result = helper.remove_candidates(preview, clinic, references=set())
print(json.dumps({"removed": result["removed"], "reasons": sorted(row["reason"] for row in result["skipped"]), "replaced_bytes": replaced.read_text(), "changed_survives": changed.exists()}))
`), { removed: [], reasons: ['changed_since_preview', 'changed_since_preview'], replaced_bytes: 'new protected bytes', changed_survives: true });
});

test('defers stale temporary files while the collector holds its lock and retains the coordination inode', () => {
  assert.deepEqual(run(String.raw`
lock = clinic / "data/.collection-worker.lock"; lock.write_text("coordination")
lock_inode = lock.stat().st_ino
stale = clinic / "data/tmpABCDEFGH"; stale.write_text("stale fixture"); old(stale)
fresh = clinic / "data/tmpIJKLMNOP"; fresh.write_text("active temporary fixture")
preview = plan("clinic-temps")
with lock.open("r") as held:
    helper.fcntl.flock(held, helper.fcntl.LOCK_EX | helper.fcntl.LOCK_NB)
    busy = helper.remove_candidates(preview, clinic, references=set())
    survived_busy = stale.exists()
    helper.fcntl.flock(held, helper.fcntl.LOCK_UN)
after = helper.remove_candidates(preview, clinic, references=set())
print(json.dumps({"busy_removed": busy["removed"], "busy_reasons": [row["reason"] for row in busy["skipped"]], "survived_busy": survived_busy, "removed_after": after["removed"] == [str(stale)], "fresh_survives": fresh.exists(), "lock_same_inode": lock.stat().st_ino == lock_inode, "lock_bytes": lock.read_text()}))
`), { busy_removed: [], busy_reasons: ['collector_busy'], survived_busy: true, removed_after: true, fresh_survives: true, lock_same_inode: true, lock_bytes: 'coordination' });
});
