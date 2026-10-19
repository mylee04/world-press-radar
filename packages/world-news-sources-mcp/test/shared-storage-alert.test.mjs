import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../ops/shared-storage-alert.py', import.meta.url));
const harness = String.raw`
import importlib.util, json, pathlib, sqlite3, sys, tempfile, types, urllib.request
from unittest.mock import patch
sys.dont_write_bytecode = True
def forbidden(*args, **kwargs):
    raise AssertionError("Opening SQLite or live network is forbidden")
with patch.object(sqlite3, "connect", side_effect=forbidden), patch.object(urllib.request, "urlopen", side_effect=forbidden):
    spec = importlib.util.spec_from_file_location("storage_alert", sys.argv[1])
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    exec(sys.argv[2])
`;

function run(code) {
  const result = spawnSync('python3', ['-c', harness, helper, code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('anchors forecasts to the latest real completed activity between 12 hours and seven days ago', () => {
  assert.deepEqual(run(String.raw`
now = helper.timestamp("2026-10-19T12:00:00Z")
identity = {"device": 1, "inode": 2}
def row(hours, **changes):
    from datetime import timedelta
    return {"report_version": 1, "mode": "activity", "phase": "after", "ledger_identity": identity, "ledger_bytes": 100, "observed_at": (now - timedelta(hours=hours)).isoformat(), **changes}
with tempfile.TemporaryDirectory(prefix="wns-storage-history-") as directory:
    history = pathlib.Path(directory) / "history.jsonl"
    invalid = [row(11), row(-1), row(169), row(12, mode="health"), row(12, phase="before"), row(12, ledger_identity={"device": 1, "inode": 3}), row(12, observed_at="invalid"), row(12, observed_at="2026-10-18T12:00:00"), {}, [], None]
    history.write_text("not-json\n" + "\n".join(json.dumps(value) for value in invalid))
    rejected = helper.previous_sample(history, identity, now)
    with history.open("a") as stream:
        for value in [row(36, ledger_bytes=36), row(12, ledger_bytes=12), row(24, ledger_bytes=24), row(168, ledger_bytes=168)]:
            stream.write("\n" + json.dumps(value))
    selected = helper.previous_sample(history, identity, now)
    print(json.dumps({"rejected": rejected, "selected_bytes": selected["ledger_bytes"], "selected_at": selected["observed_at"]}))
`), { rejected: null, selected_bytes: 12, selected_at: '2026-10-19T00:00:00+00:00' });
});

test('applies shared-disk, forecast and ledger severity boundaries', () => {
  assert.deepEqual(run(String.raw`
base = {"filesystem_free_bytes": 61 * helper.GIB, "filesystem_preflight_required_bytes": 52 * helper.GIB, "filesystem_preflight_forecast": {"estimated_days_remaining": 20}, "ledger_forecast": {"estimated_days_remaining": 20}, "ledger_bytes": 2 * helper.GIB, "ledger_cap_bytes": 16 * helper.GIB, "ledger_utilization_percent": 20}
cases = [base, {**base, "filesystem_free_bytes": 60 * helper.GIB}, {**base, "filesystem_preflight_forecast": {"estimated_days_remaining": 14}}, {**base, "filesystem_preflight_forecast": {"estimated_days_remaining": 14.01}}, {**base, "ledger_forecast": {"estimated_days_remaining": 14}}, {**base, "filesystem_free_bytes": 55 * helper.GIB}, {**base, "filesystem_preflight_forecast": {"estimated_days_remaining": 3}}, {**base, "ledger_forecast": {"estimated_days_remaining": 3}}, {**base, "filesystem_free_bytes": 52 * helper.GIB}, {**base, "filesystem_free_bytes": 52 * helper.GIB - 1}, {**base, "ledger_bytes": 16 * helper.GIB}, {**base, "ledger_utilization_percent": 80}, {**base, "ledger_utilization_percent": 90}]
print(json.dumps([helper.severity(value) for value in cases]))
`), [0, 1, 1, 0, 1, 2, 2, 2, 2, 3, 3, 1, 2]);
});

test('stays quiet when healthy and suppresses repeated warnings until 24 hours while escalating immediately', () => {
  assert.deepEqual(run(String.raw`
now = helper.timestamp("2026-10-19T12:00:00Z")
state = {"last_sent_at": "2026-10-18T12:00:01Z", "last_sent_level": 1}
print(json.dumps([
    helper.notification_due({}, 0, now), helper.notification_due({}, 1, now),
    helper.notification_due(state, 1, now), helper.notification_due(state, 2, now),
    helper.notification_due({**state, "last_sent_at": "2026-10-18T12:00:00Z"}, 1, now),
    helper.notification_due({**state, "last_sent_level": 3}, 1, now),
    helper.notification_due(state, 0, now)]))
`), [false, true, false, true, true, false, false]);
});

test('attributes growth only to recent matching samples from the same bounded run', () => {
  const result = run(String.raw`
now = helper.timestamp("2026-10-19T05:00:00Z")
with tempfile.TemporaryDirectory(prefix="wns-storage-cycle-") as directory:
    base = pathlib.Path(directory); storage = base / "state/storage-budget"; storage.mkdir(parents=True)
    before = {"phase": "before", "mode": "activity", "ledger_identity": {"device": 1, "inode": 2}, "observed_at": "2026-10-19T03:00:00Z", "ledger_bytes": 100}
    after = {**before, "phase": "after", "observed_at": "2026-10-19T04:00:00Z", "ledger_bytes": 145}
    def check(first, last):
        (storage / "activity-before-latest.json").write_text(json.dumps(first))
        (storage / "activity-after-latest.json").write_text(json.dumps(last))
        return helper.cycle_growth(base, lambda path: json.loads(path.read_text()), now)
    print(json.dumps([
        check(before, after),
        check(before, {**after, "ledger_identity": {"device": 1, "inode": 3}}),
        check({**before, "observed_at": "2026-10-18T03:00:00Z"}, after),
        check({**before, "observed_at": "2026-10-16T03:00:00Z"}, {**after, "observed_at": "2026-10-16T04:00:00Z"}),
        check(before, {**after, "observed_at": "2026-10-19T06:00:00Z"}),
        check(before, {**after, "mode": "health"}),
        check({**before, "observed_at": "2026-10-19T04:30:00Z"}, after)]))
`);
  assert.deepEqual(result, [45, null, null, null, null, null, null]);
});

test('builds a real stat-only budget report and imports the notifier without opening SQLite or network', () => {
  const result = run(String.raw`
notify = helper.module(pathlib.Path(sys.argv[1]).with_name("first-v2-collection-monitor.py"), "monitor_notifier_test")
budget = helper.module(pathlib.Path(sys.argv[1]).with_name("runner-storage-budget.py"), "monitor_budget_test")
with tempfile.TemporaryDirectory(prefix="wns-alert-stat-") as directory:
    base = pathlib.Path(directory); db = base / "activity.sqlite"
    db.write_bytes(b"deliberately not a SQLite database")
    before = db.read_bytes()
    now = helper.timestamp("2026-10-19T12:00:00Z")
    stat = db.stat()
    previous = {"report_version": 1, "mode": "activity", "phase": "after", "ledger_identity": {"device": stat.st_dev, "inode": stat.st_ino}, "ledger_bytes": len(before), "filesystem_free_bytes": 80 * helper.GIB, "observed_at": "2026-10-18T12:00:00Z"}
    with patch.object(budget.os, "statvfs", return_value=types.SimpleNamespace(f_bavail=70 * helper.GIB, f_frsize=1)):
        report = budget.build_report(db, base, "before", "activity", 16384, previous, now)
    print(json.dumps({"notify_imported": callable(notify.telegram), "opens_sqlite": report["opens_sqlite"], "filesystem_status": report["filesystem_sample_status"], "daily_decline": report["filesystem_measured_daily_decline_bytes"], "same_bytes": before == db.read_bytes(), "files": sorted(path.name for path in base.iterdir())}))
`);
  assert.deepEqual(result, { notify_imported: true, opens_sqlite: false, filesystem_status: 'measured', daily_decline: 10 * 1024 ** 3, same_bytes: true, files: ['activity.sqlite'] });
});
