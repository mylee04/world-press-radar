#!/usr/bin/env python3
"""One scheduled-cycle follow-up. Read the ledger, then notify a private chat.

This helper never starts collection, scans URL bodies, or changes the ledger.
The systemd timer owns scheduling. Credentials and receipts stay outside Git.
"""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import urllib.request


def at(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def load(path):
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("oversized_monitor_input")
    return json.loads(path.read_text())


def save(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def post(url, body, headers=None):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=25) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("oversized_network_response")
    try:
        return json.loads(data)
    except ValueError:
        for line in data.decode().splitlines():
            if line.startswith("data:"):
                value = json.loads(line[5:])
                if "result" in value or "error" in value:
                    return value
        raise ValueError("invalid_network_response")


def telegram(credentials, method, body):
    result = post("https://api.telegram.org/bot" + credentials["token"] + "/" + method, body)
    if not result.get("ok"):
        raise ValueError("telegram_request_rejected")
    return result["result"]


def service_state():
    result = subprocess.run(["systemctl", "--user", "show", "world-news-activity.service",
        "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus",
        "-p", "ExecMainStartTimestamp", "-p", "ExecMainExitTimestamp"],
        check=True, capture_output=True, text=True, timeout=10)
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def started_at(service):
    value = service.get("ExecMainStartTimestamp", "")
    return datetime.strptime(value, "%a %Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc) if value else None


def stage(service, expected, now):
    if now < expected:
        return "scheduled"
    started = started_at(service)
    if started is None or started < expected:
        return "not_started" if now >= expected + timedelta(minutes=30) else "waiting"
    if service["ActiveState"] in ("active", "activating", "deactivating"):
        return "overdue" if now >= expected + timedelta(hours=9) else "running"
    return "finished" if service.get("Result") == "success" and service.get("ExecMainStatus") == "0" else "failed"


def validate_rows(connection, cycle, rows):
    selected = [row for row in rows if row["details"].get("cycle_id") == cycle["id"]]
    endpoints = [row["endpoint_id"] for row in selected]
    if len(endpoints) != len(set(endpoints)):
        raise ValueError("repeated_cycle_endpoint_observation")
    if set(endpoints) != set(cycle["attempted_endpoint_ids"]):
        raise ValueError("cycle_attempt_count_mismatch")
    successful = [row for row in selected if row["status"] in ("working_nonempty", "valid_empty")]
    articles = [row for row in successful if row["format"] != "sitemapindex"]
    if {row["endpoint_id"] for row in articles} != set(cycle["successful_article_endpoint_ids"]):
        raise ValueError("cycle_article_count_mismatch")
    for row in selected:
        details = row["details"]
        for source in details["baseline_sources"]:
            if details["source_new"].get(source) != 0:
                raise ValueError("source_baseline_not_excluded")
            binding = connection.execute("SELECT country FROM bindings WHERE source_id=? AND endpoint_id=?",
                (source, row["endpoint_id"])).fetchone()
            if not binding or details["country_new"].get(binding[0]) != 0:
                raise ValueError("country_baseline_not_excluded")
    return {"attempted": len(selected), "article_success": len(articles),
        "failed": len(selected) - len(successful), "index_only": len(successful) - len(articles),
        "deferred": len(cycle.get("scheduling", {}).get("deferred_endpoints", [])),
        "already_checked": len(cycle.get("scheduling", {}).get("already_checked_today_endpoint_ids", [])),
        "cycle_status": cycle["status"], "cycle_reason": cycle.get("failure_reason")}


def storage_growth(base, baseline, cycle):
    directory = base / "state/storage-budget"
    before, after = directory / "activity-before-latest.json", directory / "activity-after-latest.json"
    if before.exists() and after.exists():
        first, last = load(before), load(after)
        if (first.get("phase") == "before" and last.get("phase") == "after"
                and first.get("mode") == last.get("mode") == "activity"
                and first.get("ledger_identity") == last.get("ledger_identity")
                and at(baseline["expected_run_at_utc"]) <= at(first["observed_at"]) <= at(cycle["started_at"])
                and at(last["observed_at"]) >= at(cycle["finished_at"])):
            return {"growth_bytes": last["ledger_bytes"] - first["ledger_bytes"],
                "growth_basis": "this_cycle_db_plus_wal", "db_bytes": last["db_bytes"], "wal_bytes": last["wal_bytes"]}
    db = base / "state/activity.sqlite"
    wal = Path(str(db) + "-wal")
    db_bytes, wal_bytes = db.stat().st_size, wal.stat().st_size if wal.exists() else 0
    return {"growth_bytes": db_bytes + wal_bytes - baseline["db_bytes"] - baseline["wal_bytes"],
        "growth_basis": "cumulative_since_saved_post_migration_baseline", "db_bytes": db_bytes, "wal_bytes": wal_bytes}


def verify(base, baseline):
    db = base / "state/activity.sqlite"
    with (base / "state/activity-snapshot.json").open() as snapshot:
        prefix = snapshot.read(4096)
    version = re.search(r'"normalization_version"\s*:\s*"([^"]+)"', prefix)
    if not version or version[1] != baseline["normalization_version"]:
        raise ValueError("normalization_version_changed")
    with (base / "logs/activity.log").open("rb") as log:
        log.seek(0, os.SEEK_END)
        log.seek(max(baseline["activity_log_offset"], log.tell() - 8 * 1024 * 1024))
        tail = log.read(8 * 1024 * 1024).decode(errors="replace")
    receipts = []
    for line in tail.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and value.get("verification") == "ledger-ok":
                receipts.append(value)
        except ValueError:
            continue
    if not receipts or "activity pipeline completed successfully" not in tail:
        raise ValueError("regular_completion_receipt_missing")
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.row_factory = sqlite3.Row
        columns = {row[1] for row in connection.execute("PRAGMA table_info(binding_urls)")}
        if "url_id" not in columns or "url" in columns:
            raise ValueError("url_storage_is_not_format_2")
        if connection.execute("SELECT 1 FROM writer_lock LIMIT 1").fetchone():
            raise ValueError("writer_lease_remains")
        if any(Path(str(db) + ".spool").glob("*.json")):
            raise ValueError("uncommitted_spool_remains")
        metadata = dict(connection.execute("SELECT key,value FROM metadata"))
        if metadata.get("tracking_start") != baseline["tracking_start"] or baseline["normalization_version"] != "article-url-v1":
            raise ValueError("tracking_start_changed")
        previous = connection.execute("SELECT checked_at FROM collections WHERE id=?",
            (baseline["previous_latest_collection"][0],)).fetchone()
        if not previous or previous[0] != baseline["previous_latest_collection"][1]:
            raise ValueError("previous_observation_changed")
        old_count = connection.execute("SELECT COUNT(*) FROM collections INDEXED BY collection_time WHERE checked_at<=?",
            (baseline["baseline_cutoff"],)).fetchone()[0]
        if old_count != baseline["previous_observation_count"]:
            raise ValueError("previous_observation_count_changed")
        added_count = connection.execute("SELECT COUNT(*) FROM collections INDEXED BY collection_time WHERE checked_at>?", (baseline["baseline_cutoff"],)).fetchone()[0]
        if receipts[-1]["collections"] != old_count + added_count:
            raise ValueError("completion_observation_count_mismatch")
        old = [tuple(row) for row in connection.execute("SELECT source_id,endpoint_id,country,baseline_at FROM bindings WHERE baseline_at IS NOT NULL AND baseline_at<=? ORDER BY source_id,endpoint_id", (baseline["baseline_cutoff"],))]
        digest = hashlib.sha256(json.dumps(old, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if len(old) != baseline["known_initialized_bindings"] or digest != baseline["known_baselines_sha256"]:
            raise ValueError("saved_binding_baselines_changed")
        cycles = [json.loads(row[0]) for row in connection.execute("SELECT payload FROM collection_cycles LIMIT 257")]
        expected = at(baseline["expected_run_at_utc"])
        candidates = [c for c in cycles if c["lane"] == "production" and c["scope"] == "due_endpoints" and expected <= at(c["started_at"]) < expected + timedelta(hours=8)]
        if len(cycles) > 256 or len(candidates) != 1:
            raise ValueError("target_cycle_not_unique")
        cycle = candidates[0]
        if cycle["status"] not in ("completed", "partial") or not cycle.get("finished_at"):
            raise ValueError("target_cycle_not_completed")
        day = expected.strftime("%Y-%m-%d")
        end = (expected + timedelta(days=1)).strftime("%Y-%m-%d") + "T00:00:00.000Z"
        rows = [dict(row) for row in connection.execute("SELECT endpoint_id,checked_at,status,format,details FROM collections INDEXED BY collection_time WHERE checked_at>=? AND checked_at<? ORDER BY checked_at LIMIT 10001", (day + "T00:00:00.000Z", end))]
        if len(rows) > 10000:
            raise ValueError("observation_window_exceeds_bound")
        for row in rows:
            row["details"] = json.loads(row["details"])
        result = validate_rows(connection, cycle, rows)
        us_success = [r for r in rows if "US" in r["details"]["countries"] and r["status"] in ("working_nonempty", "valid_empty") and r["format"] != "sitemapindex"]
        us_new = sum(r["details"]["country_new"].get("US", 0) for r in us_success) if us_success else None
        independent_us = connection.execute("SELECT COUNT(*) FROM scope_urls INDEXED BY scope_discovery WHERE scope_kind='country' AND scope_id='US' AND baseline=0 AND kind='candidate' AND first_seen>=? AND first_seen<?", (day + "T00:00:00.000Z", end)).fetchone()[0]
        if us_new is not None and independent_us != us_new:
            raise ValueError("country_new_differs_from_saved_discoveries")
    return {**result, **storage_growth(base, baseline, cycle), "cycle_id": cycle["id"],
        "finished_at": cycle["finished_at"], "new_day": day, "us_new": us_new,
        "baseline_preserved": True, "history_preserved": True, "storage_version": 2}


def public_verified(baseline, result):
    response = post("https://news.bymyleslee.com/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "get_country_article_activity", "arguments": {"country": "US",
            "start_date": baseline["previous_us_utc_day"], "end_date": result["new_day"], "timezone": "UTC", "limit": 2}}},
        {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", "X-World-News-Traffic": "inspection"})
    data = response.get("result", {}).get("structuredContent")
    if not data or at(data["snapshot_at"]) < at(result["finished_at"]):
        return False
    values = {item["period"]: item["new_unique_candidate_urls"] for item in data["items"]}
    if (baseline["previous_us_utc_day"] not in values or result["new_day"] not in values
            or data["tracking_start"] != baseline["tracking_start"]
            or data.get("metric") != "first_discovered_unique_candidate_url_after_binding_baseline"
            or values.get(baseline["previous_us_utc_day"]) != baseline["previous_us_new_urls"]
            or values.get(result["new_day"]) != result["us_new"]):
        raise ValueError("public_activity_does_not_match_ledger")
    return True


def summary(result):
    if result["status"] != "verified":
        reasons = {"regular_collection_not_started": "예정 시각 이후 30분이 지났지만 수집이 시작되지 않았습니다.",
            "regular_collection_failed": "정기 수집이 실패로 종료됐습니다.",
            "regular_collection_overdue": "정기 수집이 9시간을 넘겨 아직 종료되지 않았습니다.",
            "public_snapshot_still_stale": "공개 플러그인에 이번 수집 결과가 아직 반영되지 않았습니다."}
        reason = reasons.get(result["reason"], "검증 항목 확인이 필요합니다: " + result["reason"])
        return "World Press Radar 정기 수집 확인 필요\n" + reason + "\n수집 재실행과 데이터 삭제는 하지 않았습니다."
    growth = result["growth_bytes"] / 1024 ** 2
    basis = "이번 회차" if result["growth_basis"] == "this_cycle_db_plus_wal" else "변환 후 기준 대비 누적"
    new_count = "집계 없음(성공 관측 없음)" if result["us_new"] is None else f"{result['us_new']:,}개"
    return ("World Press Radar 새 저장 구조 첫 정기 수집 확인 완료\n"
        f"시도 {result['attempted']:,}개, 기사 후보 수집 성공 {result['article_success']:,}개\n"
        f"검사 실패 {result['failed']:,}개, 인덱스만 확인 {result['index_only']:,}개, 대기 {result['deferred']:,}개\n"
        f"회차 상태: {result['cycle_status']}\n"
        f"원장 증가: {growth:+.1f} MiB ({basis}, DB와 WAL 합계)\n"
        f"서버 여유: {result['free_bytes'] / 1024 ** 3:.1f} GiB\n"
        "기존 기록과 최초 수집 제외 기준 유지, 공개 플러그인 반영 확인\n"
        f"미국 UTC {result['new_day']} 신규 URL: {new_count}\n"
        "신규 URL은 발행 기사 수가 아닙니다.\nhttps://news.bymyleslee.com/quality/")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    args = parser.parse_args()
    operation = args.base / "operations/url-storage-v2-20261018"
    with (operation / "monitor.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt = operation / "telegram-delivery.json"
        if receipt.exists():
            return
        baseline = load(operation / "next-regular-monitor-baseline.json")
        now = datetime.now(timezone.utc)
        expected = at(baseline["expected_run_at_utc"])
        state = stage(service_state(), expected, now)
        result_path = operation / "first-regular-result.json"
        if state in ("scheduled", "waiting", "running"):
            return
        try:
            cached = load(result_path) if result_path.exists() else None
            if cached and cached.get("status") == "needs_attention":
                result = cached
            elif state != "finished":
                raise ValueError("regular_collection_" + state)
            else:
                result = cached or verify(args.base, baseline)
                if not public_verified(baseline, result):
                    if now < expected + timedelta(hours=10):
                        save(result_path, result)
                        return
                    raise ValueError("public_snapshot_still_stale")
                result["status"] = "verified"
        except Exception as error:
            # Error URLs can contain credentials. Only fixed codes/types go to logs/chat.
            code = str(error) if type(error) is ValueError and str(error).replace("_", "").isalnum() else type(error).__name__
            if not isinstance(error, ValueError) and now < expected + timedelta(hours=10):
                print(json.dumps({"monitor": "retry_later", "error_type": type(error).__name__}))
                return
            result = {"status": "needs_attention", "reason": code}
        fs = os.statvfs(args.base)
        result["free_bytes"] = fs.f_bavail * fs.f_frsize
        result["checked_at"] = now.isoformat()
        save(result_path, result)
        credentials = load(args.credentials)
        if credentials["chat_type"] != "private" or not str(credentials["chat_id"]).isdigit():
            raise ValueError("private_notification_target_required")
        sent = telegram(credentials, "sendMessage", {"chat_id": credentials["chat_id"],
            "text": summary(result), "link_preview_options": {"is_disabled": True}})
        save(receipt, {"delivered_at": datetime.now(timezone.utc).isoformat(), "message_id": sent["message_id"], "status": result["status"]})
        subprocess.run(["systemctl", "--user", "disable", "--now", "world-news-first-v2-monitor.timer"], check=True, timeout=10, capture_output=True)
        print(json.dumps({"monitor": "delivered", "status": result["status"]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"monitor": "error", "error_type": type(error).__name__}))
        raise SystemExit(1)
