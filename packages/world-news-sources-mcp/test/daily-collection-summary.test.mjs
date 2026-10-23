import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../ops/daily-collection-summary.py', import.meta.url));
const harness = String.raw`
import copy, importlib.util, json, pathlib, sqlite3, sys, tempfile, urllib.request
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("daily_summary", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
def parse_start(service):
    return helper.at(service["started_at"]) if service.get("started_at") else None
def cycle(identity="current", day="2026-10-23", endpoints=None):
    endpoints = endpoints or ["article"]
    return {"id": identity, "lane": "production", "scope": "due_endpoints", "started_at": day + "T03:03:00Z", "finished_at": day + "T03:43:00Z", "status": "partial", "registry_digest": "unchanged", "eligible_endpoint_ids": endpoints,
        "scheduling": {"active_endpoint_ids": endpoints, "deferred_endpoints": [], "already_checked_today_endpoint_ids": []}}
def row(endpoint, status="working_nonempty", format="rss", country_new=None, category=None):
    return {"endpoint_id": endpoint, "status": status, "format": format, "country_new": json.dumps(country_new if country_new is not None else {"US": 0}), "category": category}
def rejected(action):
    try:
        action()
    except ValueError as error:
        return str(error)
    return None
with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Live network is forbidden")):
    exec(sys.argv[2])
`;

function run(code) {
  const result = spawnSync('python3', ['-c', harness, helper, code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('uses the 03:00 UTC collection boundary and never treats an old successful service as the current run', () => {
  const result = run(String.raw`
expected = helper.expected_run(helper.at("2026-10-23T03:00:00Z"))
old = {"started_at": "2026-10-22T03:00:24Z", "ActiveState": "inactive", "Result": "success", "ExecMainStatus": "0"}
current = {**old, "started_at": "2026-10-23T03:00:24Z"}
print(json.dumps({"boundaries": [helper.expected_run(helper.at(value)).isoformat() for value in ["2026-10-23T02:59:59Z", "2026-10-23T03:00:00Z"]], "stages": [
    helper.stage({}, expected, parse_start), helper.stage(old, expected, parse_start),
    helper.stage({**current, "ActiveState": "active"}, expected, parse_start),
    helper.stage({**current, "Result": "exit-code", "ExecMainStatus": "1"}, expected, parse_start),
    helper.stage(current, expected, parse_start)]}))
`);
  assert.deepEqual(result.boundaries, ['2026-10-22T03:00:00+00:00', '2026-10-23T03:00:00+00:00']);
  assert.deepEqual(result.stages, ['missing', 'missing', 'running', 'failed', 'complete']);
});

test('separates article success, index-only and failures, and counts only unattempted deferrals as held', () => {
  const result = run(String.raw`
c = cycle(endpoints=["article", "empty", "index", "restricted", "limited", "held", "checked"])
c["scheduling"].update({"deferred_endpoints": [{"endpoint_id": "limited"}, {"endpoint_id": "held"}, {"endpoint_id": "checked"}], "already_checked_today_endpoint_ids": ["checked"]})
rows = [row("article", country_new={"US": 0, "KR": 6}), row("empty", status="valid_empty", country_new={"US": 0, "KR": 0}), row("index", format="sitemapindex", country_new={"KR": 999}), row("restricted", status="blocked", category="access_restricted"), row("limited", status="http_error", category="rate_limited")]
print(json.dumps({"metrics": helper.metrics(c, rows), "unobserved": helper.metrics(c, rows[2:])["top_countries"], "zero": helper.metrics(c, [row("article", country_new={"US": 0})])["top_countries"], "duplicate": rejected(lambda: helper.metrics(c, rows + [rows[0]])), "missing": rejected(lambda: helper.metrics({**c, "attempted_endpoint_ids": ["article", "held"]}, [rows[0]])), "unknown": rejected(lambda: helper.metrics(c, [{**rows[0], "country_new": None}]))}))
`);
  assert.equal(result.metrics.attempted, 5);
  assert.equal(result.metrics.article_success, 2);
  assert.equal(result.metrics.index_only, 1);
  assert.equal(result.metrics.failed, 2);
  assert.equal(result.metrics.unattempted_deferred, 1);
  assert.equal(result.metrics.already_checked, 1);
  assert.deepEqual(result.metrics.top_countries, [['KR', 6], ['US', 0]]);
  assert.equal(result.unobserved, null);
  assert.deepEqual(result.zero, [['US', 0]]);
  assert.equal(result.duplicate, 'repeated_cycle_endpoint');
  assert.equal(result.missing, 'cycle_observations_incomplete');
  assert.equal(result.unknown, 'invalid_new_url_count');
});

test('reads only the indexed date window and selected cycle, with a hard row bound and recorded prior-cycle comparison', () => {
  const result = run(String.raw`
with tempfile.TemporaryDirectory(prefix="wns-daily-summary-") as directory:
    base = pathlib.Path(directory); (base / "state").mkdir()
    db = base / "state/activity.sqlite"
    with sqlite3.connect(db) as connection:
        connection.row_factory = sqlite3.Row
        connection.executescript("CREATE TABLE collections(endpoint_id TEXT,checked_at TEXT,status TEXT,format TEXT,details TEXT); CREATE INDEX collection_time ON collections(checked_at); CREATE TABLE collection_cycles(payload TEXT); CREATE TABLE registry(source_id TEXT,country TEXT,enabled INTEGER);")
        current, previous = cycle(), cycle("previous", "2026-10-22")
        for c in [current, previous]:
            connection.execute("INSERT INTO collection_cycles VALUES(?)", (json.dumps(c),))
        def add(identity, checked_at, cycle_id, status="working_nonempty"):
            connection.execute("INSERT INTO collections VALUES(?,?,?,?,?)", (identity, checked_at, status, "rss", json.dumps({"cycle_id": cycle_id, "country_new": {"US": 0}, "recovery": {"category": "document_validation"}})))
        add("article", "2026-10-23T03:20:00Z", "current")
        add("other-cycle", "2026-10-23T04:20:00Z", "inspection")
        add("out-of-window", "2026-10-24T03:20:00Z", "current")
        add("article", "2026-10-22T03:20:00Z", "previous", "malformed")
        connection.executemany("INSERT INTO registry VALUES(?,?,?)", [("source", "US", 1), ("source", "US", 1), ("disabled", "KR", 0)])
        selected = helper.rows_for_cycle(connection, current)
        connection.commit()
        service = {"started_at": "2026-10-23T03:00:24Z", "Result": "success"}
        report = helper.build_report(base, helper.at("2026-10-23T03:00:00Z"), service, "complete", parse_start, helper.at("2026-10-23T04:00:00Z"))
        connection.executemany("INSERT INTO collections VALUES(?,?,?,?,?)", [(str(i), "2026-10-23T05:00:00Z", "working_nonempty", "rss", '{"cycle_id":"current","country_new":{}}') for i in range(10000)])
        bound = rejected(lambda: helper.rows_for_cycle(connection, current))
        print(json.dumps({"selected": [r["endpoint_id"] for r in selected], "bound": bound, "report": {k: report[k] for k in ["cycle_id", "article_success", "success_delta", "failure_delta", "registry_changed", "sources", "countries"]}}))
`);
  assert.deepEqual(result.selected, ['article']);
  assert.equal(result.bound, 'daily_observation_bound_exceeded');
  assert.deepEqual(result.report, { cycle_id: 'current', article_success: 1, success_delta: 1, failure_delta: -1, registry_changed: false, sources: 1, countries: 1 });
});

test('attributes storage growth only to matching per-run samples, rejecting stale dates and ledger identity changes', () => {
  const result = run(String.raw`
with tempfile.TemporaryDirectory(prefix="wns-daily-storage-") as directory:
    base = pathlib.Path(directory); storage = base / "state/storage-budget"; storage.mkdir(parents=True)
    report = {"service_started_at": "2026-10-23T03:00:24Z", "finished_at": "2026-10-23T03:43:00Z"}
    first = {"phase": "before", "mode": "activity", "ledger_identity": {"inode": 1}, "observed_at": "2026-10-23T03:01:00Z", "ledger_bytes": 100}
    last = {**first, "phase": "after", "observed_at": "2026-10-23T03:44:00Z", "ledger_bytes": 140}
    def check(before, after):
        (storage / "activity-before-latest.json").write_text(json.dumps(before))
        (storage / "activity-after-latest.json").write_text(json.dumps(after))
        return helper.matched_growth(base, report, lambda p: json.loads(p.read_text()))
    print(json.dumps([check(first, last), check({**first, "observed_at": "2026-10-22T03:01:00Z"}, last), check(first, {**last, "ledger_identity": {"inode": 2}}), check(first, {**last, "observed_at": "2026-10-24T03:44:00Z"})]))
`);
  assert.deepEqual(result, [40, null, null, null]);
});

test('renders honest progress and failure states and distinguishes missing discoveries from a confirmed zero', () => {
  const result = run(String.raw`
base = {"day": "2026-10-23", "state": "complete", "sources": 1, "countries": 1, "success_delta": 1, "failure_delta": -1, **helper.metrics(cycle(), [row("article", country_new={"US": 0})])}
print(json.dumps({"complete": helper.message(base), "unknown": helper.message({**base, "top_countries": None}), "running": helper.message({"day": "2026-10-23", "state": "running"}), "failed": helper.message({"day": "2026-10-23", "state": "failed"})}))
`);
  assert.match(result.complete, /미국 0/);
  assert.match(result.complete, /최초 수집분 제외/);
  assert.match(result.complete, /발행 기사 수나 전 세계 고유 합계가 아닙니다/);
  assert.match(result.complete, /수정·복구 완료 건수는 아닙니다/);
  assert.match(result.unknown, /성공 관측이 없어 미확인/);
  assert.match(result.running, /진행 중/);
  assert.doesNotMatch(result.running, /정상 종료/);
  assert.match(result.failed, /실패, 확인 필요/);
  assert.doesNotMatch(result.failed, /정상 종료/);
  assert.ok(Object.values(result).every(value => !value.includes(String.fromCodePoint(0x2014))));
});
