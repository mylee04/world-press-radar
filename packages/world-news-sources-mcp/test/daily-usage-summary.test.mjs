import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../ops/daily-collection-summary.py', import.meta.url));
const harness = String.raw`
import copy, importlib.util, io, json, pathlib, sys, urllib.error, urllib.request
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("daily_summary", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
def product(traffic="unclassified", channel="mcp", **values):
    row = {"day": "2026-10-23", "traffic": traffic, "channel": channel}
    row.update(dict.fromkeys(["events", "identity_provided", "identity_missing", "identity_excluded", "identity_suppressed", "identity_disabled", "search_nonempty", "search_zero_matches", "search_empty_page", "search_unknown", "export_nonempty", "export_empty", "export_unknown"], 0))
    row.update(values)
    row["known_successful_searches"] = sum(row[k] for k in ["search_nonempty", "search_zero_matches", "search_empty_page"])
    row["successful_exports"] = sum(row[k] for k in ["export_nonempty", "export_empty", "export_unknown"])
    row["zero_match_percent"] = round(100 * row["search_zero_matches"] / row["known_successful_searches"], 2) if row["known_successful_searches"] else None
    return row
def usage():
    return {"version": 1, "state": "observed", "day": "2026-10-23", "observed_at": "2026-10-24T00:03:00Z", "repeat_enabled": True,
        "product": [product(events=17, identity_provided=4, identity_missing=13, search_nonempty=6, search_zero_matches=2, search_empty_page=1, search_unknown=3, export_nonempty=3, export_empty=1, export_unknown=1),
            product("inspection", events=99, identity_excluded=99, search_nonempty=90, export_nonempty=9),
            product(channel="web_export", events=7, identity_excluded=7, export_nonempty=7)],
        "calls": [{"traffic": "unclassified", "calls": 42, "successes": 39, "errors": 3}, {"traffic": "inspection", "calls": 99, "successes": 99, "errors": 0}],
        "repeat": {"status": "observed", "observed_keys": 4, "returning_keys_prior_7_days": 1, "lookback_complete": False, "population": "observed_pseudonymous_keys_only"},
        "coverage": {"first_product_day": "2026-10-20", "first_presence_day": "2026-10-20", "lookback_days_available": 3, "product_status": "observed", "product_complete": False}}
with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Live network is forbidden")):
    exec(sys.argv[2])
`;

function run(code) {
  const result = spawnSync('python3', ['-c', harness, helperPath, code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('separates declared inspection and web exports, and excludes unknown results from zero-match search rates', () => {
  const lines = run(String.raw`print(json.dumps(helper.usage_lines(usage())))`);
  const text = lines.join('\n');
  const [unclassified, inspection] = text.split('점검 표시 호출:');
  assert.match(text, /UTC 2026-10-23 하루/);
  assert.match(unclassified, /미분류 호출: 42회/);
  assert.match(inspection, /99회/);
  assert.match(unclassified, /MCP 내보내기 성공 5회 \(내용 있음 3 \/ 빈 파일 1 \/ 내용 미확인 1\)/);
  assert.match(unclassified, /웹 파일 다운로드 내보내기 성공 7회/);
  assert.match(unclassified, /빈 검색 비율 22\.2% \(2\/9회\)/);
  assert.match(unclassified, /페이지 끝 1회, 결과 미확인 3회/);
  assert.match(unclassified, /새 지표 관측 17\/42회/);
  assert.match(inspection, /MCP 내보내기 성공 9회/);
  assert.match(text, /미분류에도 자체 점검·자동 호출이 섞이며/);
  assert.ok(!text.includes(String.fromCodePoint(0x2014)));
});

test('distinguishes unobserved metrics from recorded zero results without inventing a zero-percent search rate', () => {
  const result = run(String.raw`
missing = usage(); missing.update({"state": "unobserved", "product": [], "calls": []})
recorded = usage(); recorded["product"] = [product(events=1, identity_missing=1, search_nonempty=1)]
no_search = usage(); no_search["product"] = [product(events=1, identity_missing=1, export_nonempty=1)]
print(json.dumps({"missing": "\n".join(helper.usage_lines(missing)), "zero": "\n".join(helper.usage_lines(recorded)), "no_search": "\n".join(helper.usage_lines(no_search))}))
`);
  assert.match(result.missing, /관측 기록 없음/);
  assert.match(result.missing, /미확인/);
  assert.doesNotMatch(result.missing, /0회|0\.0%/);
  assert.match(result.zero, /MCP 내보내기 성공 0회/);
  assert.match(result.zero, /빈 검색 비율 0\.0% \(0\/1회\)/);
  assert.match(result.no_search, /빈 검색 비율 미확인/);
  assert.doesNotMatch(result.no_search, /빈 검색 비율 0\.0%/);
});

test('reports repeat use only for observed pseudonymous keys with partial history and missing identity disclosed', () => {
  const result = run(String.raw`
observed = usage()
missing = usage(); missing["repeat"].update({"status": "unobserved", "observed_keys": None, "returning_keys_prior_7_days": None})
disabled = usage(); disabled["repeat_enabled"] = False; disabled["repeat"].update({"status": "disabled", "observed_keys": None, "returning_keys_prior_7_days": None})
print(json.dumps({name: "\n".join(helper.usage_lines(value)) for name, value in [("observed", observed), ("missing", missing), ("disabled", disabled)]}))
`);
  assert.match(result.observed, /관측 식별자 4개 중 이전 날짜 재방문 1개/);
  assert.match(result.observed, /일부만 관측 \(3\/7일\)/);
  assert.match(result.observed, /식별정보 미제공 13회/);
  assert.match(result.observed, /고유 인원·만족도가 아닙니다/);
  assert.match(result.missing, /재방문 추정:.*관측 없음, 미확인/);
  assert.match(result.disabled, /재방문 추정:.*비활성 상태, 미확인/);
  assert.doesNotMatch(result.missing + result.disabled, /관측 식별자 0개/);
});

test('fetches the most recently closed UTC day independently of the collection window with bounded read-only authentication', () => {
  const result = run(String.raw`
seen = {}
token = "local-read-scope-secret-12345678901234567890"
credentials = {"url": helper.USAGE_URL, "token": token}
class Response(io.BytesIO):
    def read(self, size=-1):
        seen["read_bound"] = size
        return super().read(size)
def fake(request, timeout):
    seen.update({"url": request.full_url, "method": request.get_method(), "auth_ok": request.get_header("Authorization") == "Bearer " + token, "user_agent": request.get_header("User-agent"), "timeout": timeout})
    return Response(json.dumps(usage()).encode())
now = helper.at("2026-10-24T03:03:00Z")
report = helper.fetch_usage(credentials, now, opener=fake)
print(json.dumps({"seen": seen, "state": report["state"], "usage_day": report["day"], "collection_day": helper.expected_run(now).date().isoformat(), "leaks_secret": token in json.dumps(report)}))
`);
  assert.equal(result.state, 'observed');
  assert.equal(result.usage_day, '2026-10-23');
  assert.equal(result.collection_day, '2026-10-24');
  const url = new URL(result.seen.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, '/v1/daily-report');
  assert.equal(url.search, '?day=2026-10-23');
  assert.equal(result.seen.method, 'GET');
  assert.equal(result.seen.auth_ok, true);
  assert.equal(result.seen.user_agent, 'WorldNewsSources-DailySummary/1.0');
  assert.equal(result.seen.read_bound, 65537);
  assert.ok(result.seen.timeout > 0 && result.seen.timeout <= 15);
  assert.equal(result.leaks_secret, false);
});

test('usage failures are masked and leave the collection summary intact instead of reporting fabricated usage zeroes', () => {
  const result = run(String.raw`
token = "local-read-scope-secret-12345678901234567890"
credentials = {"url": helper.USAGE_URL, "token": token}
now = helper.at("2026-10-24T03:03:00Z")
def failed(request, timeout):
    raise urllib.error.HTTPError(request.full_url, 401, "private diagnostic " + token, {}, None)
def oversized(request, timeout):
    return io.BytesIO(b" " * 65537)
def malformed(request, timeout):
    value = usage(); value["product"][0]["search_zero_matches"] = True
    return io.BytesIO(json.dumps(value).encode())
reports = [helper.fetch_usage(credentials, now, opener=opener) for opener in [failed, oversized, malformed]]
external_calls = []
external = helper.fetch_usage({"url": "https://untrusted.example/v1/daily-report", "token": token}, now, opener=lambda *a, **k: external_calls.append(1))
reports.append(external)
report = {"day": "2026-10-24", "state": "complete", "active": 10, "attempted": 9, "article_success": 7, "failed": 1, "index_only": 1, "unattempted_deferred": 1, "causes": [], "sources": 10, "countries": 2, "top_countries": [["US", 0]], "usage": reports[0]}
print(json.dumps({"reports": reports, "text": helper.message(report), "external_calls": external_calls, "leaks_secret": token in json.dumps(reports)}))
`);
  assert.ok(result.reports.every(report => report.state === 'unavailable' && report.day === '2026-10-23'));
  assert.equal(result.leaks_secret, false);
  assert.deepEqual(result.external_calls, []);
  assert.match(result.text, /수집·후속 작업 정상 종료/);
  assert.match(result.text, /기사 후보 수집 성공 7개 \/ 검사 실패 1개/);
  assert.match(result.text, /최초 수집분 제외/);
  assert.match(result.text, /사용 통계 조회 실패: 미확인/);
  assert.doesNotMatch(result.text, /내보내기 성공 0회|빈 검색 비율 0\.0%/);
});
