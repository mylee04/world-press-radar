import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../ops/daily-collection-summary.py', import.meta.url));
const harness = String.raw`
import copy, importlib.util, json, sys, urllib.request
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("daily_summary", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
def counts(**values):
    result = dict.fromkeys(helper.PRODUCT_COUNTS, 0)
    result.update(values)
    return result
def usage(day="2026-10-23"):
    return {"state": "observed", "day": day, "repeat_enabled": True,
        "product": [
            {"traffic": "unclassified", "channel": "mcp", **counts(events=5, search_nonempty=2, search_zero_matches=1, export_nonempty=1, identity_provided=1, identity_missing=1, identity_disabled=3)},
            {"traffic": "inspection", "channel": "mcp", **counts(events=13, search_nonempty=13, identity_excluded=13)}],
        "calls": [{"traffic": "unclassified", "calls": 18}, {"traffic": "inspection", "calls": 13}],
        "repeat": {"status": "observed", "observed_keys": 1, "returning_keys_prior_7_days": 0, "lookback_complete": False},
        "coverage": {"first_product_day": "2026-10-23", "first_presence_day": "2026-10-23", "lookback_days_available": 0, "product_status": "observed", "product_complete": False}}
def document():
    return {"version": 1, "entries": [{"id": "product-validation-20261023", "day": "2026-10-23", "channel": "mcp", "calls": 4,
        "product": counts(events=4, search_nonempty=2, search_zero_matches=1, export_nonempty=1, identity_provided=1, identity_disabled=3),
        "known_operator_presence": True}]}
def group(report, traffic):
    return next(row for row in report["product"] if row["traffic"] == traffic and row["channel"] == "mcp")
with patch.object(urllib.request, "urlopen", side_effect=AssertionError("Live network is forbidden")), patch.object(urllib.request, "build_opener", side_effect=AssertionError("Live network is forbidden")):
    exec(sys.argv[2])
`;

function run(code) {
  const result = spawnSync('python3', ['-c', harness, helperPath, code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('moves verified own checks into inspection only in a deterministic report copy while preserving raw counters and keys', () => {
  const result = run(String.raw`
raw, evidence = usage(), document()
raw_before, evidence_before = copy.deepcopy(raw), copy.deepcopy(evidence)
adjusted = helper.classify_usage(raw, evidence)
print(json.dumps({"input_unchanged": raw == raw_before and evidence == evidence_before, "deterministic": adjusted == helper.classify_usage(raw, evidence),
    "classification": adjusted["classification"], "calls": adjusted["calls"], "unclassified": group(adjusted, "unclassified"), "inspection": group(adjusted, "inspection"), "repeat_unchanged": adjusted["repeat"] == raw["repeat"], "already_applied_unchanged": helper.classify_usage(adjusted, evidence) == adjusted}))
`);
  assert.equal(result.input_unchanged, true);
  assert.equal(result.deterministic, true);
  assert.equal(result.repeat_unchanged, true);
  assert.equal(result.already_applied_unchanged, true);
  assert.equal(result.classification.status, 'verified_overlay');
  assert.equal(result.classification.declared_inspection_calls, 13);
  assert.equal(result.classification.verified_unmarked_calls, 4);
  assert.equal(result.classification.unidentified_calls, 14);
  assert.equal(result.classification.known_operator_presence, true);
  assert.equal(result.calls.find(row => row.traffic === 'unclassified').calls, 14);
  assert.equal(result.calls.find(row => row.traffic === 'inspection').calls, 17);
  assert.equal(result.unclassified.events, 1);
  assert.equal(result.unclassified.identity_missing, 1);
  assert.equal(result.unclassified.search_nonempty + result.unclassified.search_zero_matches + result.unclassified.export_nonempty, 0);
  assert.equal(result.inspection.events, 17);
  assert.equal(result.inspection.search_nonempty, 15);
  assert.equal(result.inspection.search_zero_matches, 1);
  assert.equal(result.inspection.export_nonempty, 1);
});

test('rejects missing, duplicate, invalid and cumulatively excessive corrections atomically with raw totals intact', () => {
  const result = run(String.raw`
raw = usage()
duplicate = document(); duplicate["entries"].append(copy.deepcopy(duplicate["entries"][0]))
overflow = document(); overflow["entries"][0]["product"].update({"search_nonempty": 1, "search_zero_matches": 2})
cumulative = document(); other = copy.deepcopy(cumulative["entries"][0]); other["id"] = "second-verified-check"; cumulative["entries"].append(other)
invalid = document(); invalid["entries"][0]["calls"] = True
results = [helper.classify_usage(raw, value) for value in [None, duplicate, overflow, cumulative, invalid]]
print(json.dumps([{"status": report["classification"]["status"], "raw_counts": report["calls"] == raw["calls"] and report["product"] == raw["product"], "text": "\n".join(helper.usage_lines(report))} for report in results]))
`);
  for (const report of result) {
    assert.equal(report.status, 'unavailable');
    assert.equal(report.raw_counts, true);
    assert.match(report.text, /분류.*미확인|분류.*불가|분류.*실패|보정.*미확인|보정.*실패/);
  }
});

test('renders own activity separately without turning operator exports or incomplete repeat history into external adoption', () => {
  const result = run(String.raw`
current = helper.classify_usage(usage(), document())
prior_presence = helper.classify_usage(usage("2026-10-24"), document())
without_presence = helper.classify_usage(usage("2026-10-24"), {"version": 1, "entries": []})
print(json.dumps({"current": "\n".join(helper.usage_lines(current)), "prior": "\n".join(helper.usage_lines(prior_presence)), "partial": "\n".join(helper.usage_lines(without_presence)), "prior_history": prior_presence["classification"]["known_operator_history"]}))
`);
  assert.match(result.current, /점검 표시 호출: 13회/);
  assert.match(result.current, /확인된 미표시 자체 점검: 4회/);
  assert.match(result.current, /주체 미확인 호출: 14회/);
  assert.match(result.current, /자체 점검 합계: 17회/);
  assert.match(result.current, /외부 사용 후보 신호:.*0회.*외부 사용 확정 아님/);
  const unidentified = result.current.split('주체 미확인 상세:')[1].split('자체 점검 합계:')[0];
  assert.match(unidentified, /MCP 내보내기 성공 0회/);
  assert.match(unidentified, /빈 검색 비율 미확인/);
  assert.doesNotMatch(unidentified, /빈 검색 비율 0\.0%/);
  assert.match(result.current, /외부 재방문 추정: 미확인.*보류/);
  assert.equal(result.prior_history, true);
  assert.match(result.prior, /외부 재방문 추정: 미확인.*보류/);
  assert.match(result.partial, /재방문 비교 기간 일부만 관측 \(0\/7일\)/);
  assert.match(result.partial, /도입 전 사용은 미확인/);
  assert.ok(Object.values(result).every(value => typeof value !== 'string' || !value.includes(String.fromCodePoint(0x2014))));
});

test('keeps future-day declared checks separate and applies only corrections for the exact report day', () => {
  const result = run(String.raw`
raw = usage("2026-10-24")
reports = [helper.classify_usage(raw, value) for value in [{"version": 1, "entries": []}, document()]]
print(json.dumps([{"classification": report["classification"], "counts_unchanged": report["calls"] == raw["calls"] and report["product"] == raw["product"]} for report in reports]))
`);
  for (const report of result) {
    assert.equal(report.classification.status, 'verified_overlay');
    assert.equal(report.classification.declared_inspection_calls, 13);
    assert.equal(report.classification.verified_unmarked_calls, 0);
    assert.equal(report.classification.unidentified_calls, 18);
    assert.equal(report.classification.known_operator_presence, false);
    assert.equal(report.counts_unchanged, true);
  }
});
