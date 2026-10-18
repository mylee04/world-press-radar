import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../ops/first-v2-collection-monitor.py', import.meta.url));
const harness = String.raw`
import copy, importlib.util, json, pathlib, sqlite3, sys, tempfile
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("collection_monitor", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
def rejected(action):
    try:
        action()
    except ValueError as error:
        return str(error)
    return None
with patch.object(helper.urllib.request, "urlopen", side_effect=AssertionError("Live network is forbidden")):
    exec(sys.argv[2])
`;

function run(code) {
  const result = spawnSync('python3', ['-c', harness, helper, code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('waits for the target service run and distinguishes running, successful and failed runs', () => {
  assert.deepEqual(run(String.raw`
expected = helper.at("2026-10-19T03:00:00Z")
old = {"ExecMainStartTimestamp": "Sun 2026-10-18 03:16:26 UTC", "ActiveState": "inactive", "Result": "success", "ExecMainStatus": "0"}
current = {**old, "ExecMainStartTimestamp": "Mon 2026-10-19 03:00:24 UTC"}
print(json.dumps([
    helper.stage(old, expected, expected - helper.timedelta(seconds=1)),
    helper.stage(old, expected, expected + helper.timedelta(minutes=1)),
    helper.stage(old, expected, expected + helper.timedelta(minutes=30)),
    helper.stage({**current, "ActiveState": "active"}, expected, expected + helper.timedelta(hours=1)),
    helper.stage(current, expected, expected + helper.timedelta(hours=2)),
    helper.stage({**current, "Result": "exit-code", "ExecMainStatus": "1"}, expected, expected + helper.timedelta(hours=2))]))
`), ['scheduled', 'waiting', 'not_started', 'running', 'finished', 'failed']);
});

test('checks distinct cycle observations and excludes first-binding discoveries from source and country NEW', () => {
  const result = run(String.raw`
with sqlite3.connect(":memory:") as connection:
    connection.execute("CREATE TABLE bindings(source_id TEXT,endpoint_id TEXT,country TEXT,PRIMARY KEY(source_id,endpoint_id))")
    connection.execute("INSERT INTO bindings VALUES('source','endpoint','US')")
    cycle = {"id": "cycle", "attempted_endpoint_ids": ["endpoint"], "successful_article_endpoint_ids": ["endpoint"], "status": "completed"}
    row = {"endpoint_id": "endpoint", "status": "working_nonempty", "format": "rss", "details": {"cycle_id": "cycle", "baseline_sources": ["source"], "source_new": {"source": 0}, "country_new": {"US": 0}}}
    valid = helper.validate_rows(connection, cycle, [row])
    source_bad = copy.deepcopy(row); source_bad["details"]["source_new"]["source"] = 1
    country_bad = copy.deepcopy(row); country_bad["details"]["country_new"]["US"] = 1
    print(json.dumps({"valid": valid, "errors": [
        rejected(lambda: helper.validate_rows(connection, cycle, [row, row])),
        rejected(lambda: helper.validate_rows(connection, cycle, [source_bad])),
        rejected(lambda: helper.validate_rows(connection, cycle, [country_bad])),
        rejected(lambda: helper.validate_rows(connection, cycle, []))]}))
`);
  assert.equal(result.valid.attempted, 1);
  assert.equal(result.valid.article_success, 1);
  assert.equal(result.valid.failed, 0);
  assert.deepEqual(result.errors, ['repeated_cycle_endpoint_observation', 'source_baseline_not_excluded', 'country_baseline_not_excluded', 'cycle_attempt_count_mismatch']);
});

test('requires fresh public activity and preserves explicit zero, null and historical counts', () => {
  const result = run(String.raw`
baseline = {"previous_us_utc_day": "2026-10-18", "previous_us_new_urls": 0, "tracking_start": "2026-10-01T01:36:12.370Z"}
result = {"new_day": "2026-10-19", "us_new": 0, "finished_at": "2026-10-19T04:00:00Z"}
data = {"snapshot_at": "2026-10-19T04:05:00Z", "tracking_start": baseline["tracking_start"], "metric": "first_discovered_unique_candidate_url_after_binding_baseline", "items": [{"period": "2026-10-18", "new_unique_candidate_urls": 0}, {"period": "2026-10-19", "new_unique_candidate_urls": 0}]}
calls = []
def check(payload, expected=result):
    def mocked_post(url, body, headers):
        calls.append({"url": url, "body": body, "headers": headers})
        return {"result": {"structuredContent": payload}}
    with patch.object(helper, "post", side_effect=mocked_post):
        return helper.public_verified(baseline, expected)
fresh = check(data)
stale = check({**data, "snapshot_at": "2026-10-18T04:00:00Z"})
null_data = copy.deepcopy(data); null_data["items"][1]["new_unique_candidate_urls"] = None
null_result = {**result, "us_new": None}
historical_bad = copy.deepcopy(data); historical_bad["items"][0]["new_unique_candidate_urls"] = None
missing = {**data, "items": data["items"][:1]}
print(json.dumps({"fresh": fresh, "stale": stale, "null": check(null_data, null_result), "errors": [
    rejected(lambda: check(null_data)), rejected(lambda: check(data, null_result)),
    rejected(lambda: check(historical_bad)), rejected(lambda: check(missing, null_result))], "request": calls[0]}))
`);
  assert.equal(result.fresh, true);
  assert.equal(result.stale, false);
  assert.equal(result.null, true);
  assert.ok(result.errors.every(value => value === 'public_activity_does_not_match_ledger'));
  assert.equal(result.request.url, 'https://news.bymyleslee.com/mcp');
  assert.equal(result.request.headers['X-World-News-Traffic'], 'inspection');
  assert.deepEqual(result.request.body.params, { name: 'get_country_article_activity', arguments: { country: 'US', start_date: '2026-10-18', end_date: '2026-10-19', timezone: 'UTC', limit: 2 } });
});

test('uses matching per-run DB and WAL samples and labels fallback growth after migration', () => {
  const result = run(String.raw`
with tempfile.TemporaryDirectory(prefix="wns-v2-monitor-") as directory:
    base = pathlib.Path(directory); storage = base / "state/storage-budget"; storage.mkdir(parents=True)
    (base / "state/activity.sqlite").write_bytes(b"x" * 110)
    (base / "state/activity.sqlite-wal").write_bytes(b"x" * 20)
    baseline = {"expected_run_at_utc": "2026-10-19T03:00:00Z", "db_bytes": 100, "wal_bytes": 0}
    cycle = {"started_at": "2026-10-19T03:01:00Z", "finished_at": "2026-10-19T04:00:00Z"}
    before = {"phase": "before", "mode": "activity", "ledger_identity": {"device": 1, "inode": 2}, "observed_at": "2026-10-19T03:00:30Z", "ledger_bytes": 100}
    after = {**before, "phase": "after", "observed_at": "2026-10-19T04:01:00Z", "ledger_bytes": 145, "db_bytes": 140, "wal_bytes": 5}
    def check(first, last):
        (storage / "activity-before-latest.json").write_text(json.dumps(first))
        (storage / "activity-after-latest.json").write_text(json.dumps(last))
        return helper.storage_growth(base, baseline, cycle)
    print(json.dumps({"matching": check(before, after), "old": check({**before, "observed_at": "2026-10-18T03:00:00Z"}, after), "mismatched": check(before, {**after, "ledger_identity": {"device": 1, "inode": 3}})}))
`);
  assert.deepEqual(result.matching, { growth_bytes: 45, growth_basis: 'this_cycle_db_plus_wal', db_bytes: 140, wal_bytes: 5 });
  for (const key of ['old', 'mismatched']) assert.deepEqual(result[key], { growth_bytes: 30, growth_basis: 'cumulative_since_saved_post_migration_baseline', db_bytes: 110, wal_bytes: 20 });
});
