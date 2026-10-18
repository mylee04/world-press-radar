import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../ops/runner-storage-budget.py', import.meta.url));
const gib = 1024 ** 3;
const baseline = 223834112;
const harness = String.raw`
import contextlib, datetime, hashlib, importlib.util, io, json, pathlib, sys, tempfile, types
from unittest.mock import patch
sys.dont_write_bytecode = True
def forbidden_sqlite(*args, **kwargs):
    raise AssertionError("Storage reporting must not open SQLite")
sys.modules["sqlite3"] = types.SimpleNamespace(connect=forbidden_sqlite)
spec = importlib.util.spec_from_file_location("storage_budget", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
options = json.loads(sys.argv[2])
with tempfile.TemporaryDirectory(prefix="wns-storage-report-") as directory:
    base = pathlib.Path(directory).resolve()
    db = base / "activity.sqlite"
    if not options.get("missing"):
        with db.open("wb") as stream:
            stream.write(b"stat-only fixture, deliberately not SQLite")
            stream.truncate(options.get("db_bytes", 4096))
    if options.get("wal_bytes"):
        with pathlib.Path(str(db) + "-wal").open("wb") as stream:
            stream.write(b"retained pending bytes")
            stream.truncate(options["wal_bytes"])
    at = datetime.datetime(2026, 10, 18, 4, tzinfo=datetime.timezone.utc)
    previous = None
    if "previous_bytes" in options:
        stat = db.stat()
        previous = {"report_version": 1,
            "ledger_identity": {"device": stat.st_dev, "inode": stat.st_ino + int(options.get("different_ledger", False))},
            "ledger_bytes": options["previous_bytes"],
            "observed_at": helper.utc_text(at - datetime.timedelta(hours=options.get("elapsed_hours", 24)))}
    def snapshot():
        result = {}
        for path in base.iterdir():
            stat = path.stat()
            with path.open("rb") as stream:
                first = stream.read(64)
                stream.seek(max(0, stat.st_size - 64))
                last = stream.read(64)
            result[path.name] = {"bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns,
                "inode": stat.st_ino, "end_bytes": hashlib.sha256(first + last).hexdigest()}
        return result
    before = snapshot()
    filesystem = types.SimpleNamespace(f_bavail=options.get("free_bytes", 100 * helper.GIB), f_frsize=1)
    result, error = None, None
    with patch.object(helper.os, "statvfs", return_value=filesystem):
        try:
            result = helper.build_report(db, base, "after", "activity", options.get("max_db_mib", 16384), previous, at)
        except Exception as failure:
            error = {"type": type(failure).__name__, "message": str(failure)}
    print(json.dumps({"report": result, "error": error, "before": before, "after": snapshot()}))
`;

function run(options = {}) {
  const result = spawnSync('python3', ['-c', harness, helper, JSON.stringify(options)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('reports a 16 GiB bounded cap and a separate filesystem forecast with explicit baseline provenance', () => {
  const result = run({ db_bytes: 6 * gib, wal_bytes: 8 * 1024 ** 2 });
  const report = result.report;
  assert.equal(result.error, null);
  assert.equal(report.collector_max_db_mib, 16384);
  assert.equal(report.ledger_bytes, 6 * gib + 8 * 1024 ** 2);
  assert.equal(report.ledger_cap_bytes, 16 * gib);
  assert.equal(report.forecast_daily_growth_bytes, baseline);
  assert.match(report.baseline.provenance, /recent two-cycle/);
  assert.equal(report.filesystem_floor_bytes, 50 * gib);
  assert.equal(report.filesystem_preflight_required_bytes, 52 * gib);
  assert.equal(report.forecast_is_guarantee, false);
  assert.equal(report.other_filesystem_writers_modeled, false);
  assert.equal(report.warning_codes.length, 0);
  assert.deepEqual(result.before, result.after);
});

test('uses faster measured growth over a sufficiently separated sample and clamps negative growth to zero', () => {
  const growing = run({ db_bytes: 6 * gib, previous_bytes: 5 * gib, elapsed_hours: 48 }).report;
  assert.equal(growing.measured_daily_growth_bytes, gib / 2);
  assert.equal(growing.forecast_daily_growth_bytes, gib / 2);
  assert.equal(growing.forecast_growth_basis, 'measured_above_baseline');
  assert.equal(growing.ledger_forecast.estimated_days_remaining, 20);
  const checkpointed = run({ db_bytes: 5 * gib, previous_bytes: 6 * gib, elapsed_hours: 24 }).report;
  assert.equal(checkpointed.measured_daily_growth_bytes, 0);
  assert.equal(checkpointed.forecast_daily_growth_bytes, baseline);
  assert.equal(checkpointed.forecast_growth_basis, 'baseline_floor');
});

test('does not extrapolate short, future or different-ledger samples', () => {
  for (const [extra, status] of [
    [{ elapsed_hours: 1 }, 'sample_interval_too_short'],
    [{ elapsed_hours: -1 }, 'previous_sample_in_future'],
    [{ different_ledger: true }, 'ledger_identity_changed'],
  ]) {
    const report = run({ db_bytes: 6 * gib, previous_bytes: 5 * gib, ...extra }).report;
    assert.equal(report.sample_status, status);
    assert.equal(report.measured_daily_growth_bytes, null);
    assert.equal(report.forecast_daily_growth_bytes, baseline);
  }
});

test('distinguishes impending ledger cap from filesystem reserve warnings', () => {
  const ledgerLimited = run({ db_bytes: 7 * gib, max_db_mib: 8192, free_bytes: 60 * gib }).report;
  assert.ok(ledgerLimited.warning_codes.includes('ledger_cap_within_14_days'));
  assert.ok(!ledgerLimited.warning_codes.some(code => code.startsWith('filesystem_')));
  const diskLimited = run({ db_bytes: 6 * gib, free_bytes: 51 * gib }).report;
  assert.ok(diskLimited.warning_codes.includes('filesystem_free_below_52_gib_preflight'));
  assert.ok(!diskLimited.warning_codes.includes('filesystem_free_below_50_gib_floor'));
  assert.ok(!diskLimited.warning_codes.some(code => code.startsWith('ledger_')));
});

test('warns at 80 percent even when the estimate remains beyond 14 days, and reports exhausted limits', () => {
  const high = run({ db_bytes: 13 * gib }).report;
  assert.ok(high.warning_codes.includes('ledger_utilization_at_least_80_percent'));
  assert.ok(!high.warning_codes.includes('ledger_cap_within_14_days'));
  const full = run({ db_bytes: 16 * gib, free_bytes: 50 * gib }).report;
  assert.ok(full.warning_codes.includes('ledger_cap_exhausted'));
  assert.equal(full.ledger_forecast.estimated_days_remaining, 0);
  assert.ok(!full.warning_codes.includes('filesystem_free_below_50_gib_floor'));
  assert.equal(full.filesystem_floor_forecast.estimated_days_remaining, 0);
});

test('reads file metadata without opening SQLite, creating backups or changing invalid SQLite fixture bytes', () => {
  const result = run({ wal_bytes: 4096 });
  assert.equal(result.error, null);
  assert.equal(result.report.opens_sqlite, false);
  assert.equal(result.report.changes_limits, false);
  assert.equal(result.report.deletes_files, false);
  assert.deepEqual(Object.keys(result.after).sort(), ['activity.sqlite', 'activity.sqlite-wal']);
  assert.deepEqual(result.after, result.before);
  const missing = run({ missing: true });
  assert.equal(missing.error.type, 'FileNotFoundError');
  assert.deepEqual(missing.after, {});
});

test('rejects collector limits outside the existing supported upper bound', () => {
  for (const max_db_mib of [0, 16385, 1.5]) {
    const result = run({ max_db_mib });
    assert.equal(result.error.type, 'ValueError');
    assert.deepEqual(result.before, result.after);
  }
});
