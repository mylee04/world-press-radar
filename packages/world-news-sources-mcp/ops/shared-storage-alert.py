#!/usr/bin/env python3
"""Stat-only shared disk warning, independent of collection and the desktop app."""
import argparse
from datetime import datetime, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sys

GIB = 1024 ** 3
DAY = 86400


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def timestamp(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("sample_timezone_required")
    return result


def previous_sample(history, identity, now):
    """Use a real completed activity sample, separated by at least 12 hours."""
    if not history.exists():
        return None
    if history.stat().st_size > 256 * 8192:
        raise ValueError("storage_history_exceeds_retained_limit")
    candidates = []
    for line in history.read_text().splitlines():
        try:
            row = json.loads(line)
            hours = (now - timestamp(row["observed_at"])).total_seconds() / 3600
            if (row.get("report_version") == 1 and row.get("mode") == "activity"
                    and row.get("phase") == "after" and row.get("ledger_identity") == identity
                    and 12 <= hours <= 168):
                candidates.append(row)
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
    return max(candidates, key=lambda row: timestamp(row["observed_at"])) if candidates else None


def severity(report):
    free = report["filesystem_free_bytes"]
    fs_days = report["filesystem_preflight_forecast"]["estimated_days_remaining"]
    db_days = report["ledger_forecast"]["estimated_days_remaining"]
    utilization = report["ledger_utilization_percent"]
    if free < report["filesystem_preflight_required_bytes"] or report["ledger_bytes"] >= report["ledger_cap_bytes"]:
        return 3
    if free <= 55 * GIB or fs_days <= 3 or db_days <= 3 or utilization >= 90:
        return 2
    if free <= 60 * GIB or fs_days <= 14 or db_days <= 14 or utilization >= 80:
        return 1
    return 0


def notification_due(state, level, now):
    if level == 0:
        return False
    if not state.get("last_sent_at"):
        return True
    elapsed = (now - timestamp(state["last_sent_at"])).total_seconds()
    return level > state.get("last_sent_level", 0) or elapsed >= DAY


def cycle_growth(base, load, now):
    paths = [base / "state/storage-budget" / ("activity-" + phase + "-latest.json") for phase in ("before", "after")]
    if not all(p.exists() for p in paths):
        return None
    first, last = [load(p) for p in paths]
    if (first.get("phase") != "before" or last.get("phase") != "after"
            or first.get("mode") != "activity" or last.get("mode") != "activity"
            or first.get("ledger_identity") != last.get("ledger_identity")
            or not 0 <= (timestamp(last["observed_at"]) - timestamp(first["observed_at"])).total_seconds() <= 8 * 3600
            or not 0 <= (now - timestamp(last["observed_at"])).total_seconds() <= 2 * DAY):
        return None
    return last["ledger_bytes"] - first["ledger_bytes"]


def message(report, level, growth):
    labels = {1: "사전 경고", 2: "긴급 경고", 3: "수집 실행 기준 도달"}
    fs_days = report["filesystem_preflight_forecast"]["estimated_days_remaining"]
    rate = report["filesystem_forecast_daily_decline_bytes"] / GIB
    measured = report["filesystem_sample_status"] == "measured"
    basis = "공용 디스크의 최근 순감소" if measured else "보수적인 계획 기준(실측 표본 부족)"
    growth_text = "종료 표본 대기" if growth is None else f"{growth / 1024 ** 2:+.1f} MiB"
    return (f"World Press Radar 저장공간 {labels[level]}\n"
        f"서버 여유: {report['filesystem_free_bytes'] / GIB:.1f} GiB\n"
        "수집 시작 기준: 52 GiB, 보존 여유 기준: 50 GiB\n"
        f"공용 공간 감소 추정: {rate:.2f} GiB/일 ({basis})\n"
        f"현재 추세의 52 GiB 도달 예상: 약 {fs_days:.1f}일\n"
        f"뉴스 원장(DB와 WAL): {report['ledger_bytes'] / GIB:.2f} GiB / 한도 16 GiB\n"
        f"최근 정기 수집의 원장 증가: {growth_text}\n"
        f"원장 한도 도달 계획값: 약 {report['ledger_forecast']['estimated_days_remaining']:.1f}일\n"
        "공용 공간에는 다른 프로젝트도 포함됩니다. 단기 추정이며 확보 공간을 보장하지 않습니다.\n"
        "기록과 파일은 삭제하지 않았고 수집 설정도 바꾸지 않았습니다.\n"
        "매시간 확인하며, 같은 경고는 24시간 뒤에만 다시 알립니다. 위험 단계가 높아지면 바로 알립니다.")


def main():
    os.umask(0o077)
    sys.dont_write_bytecode = True
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    args = parser.parse_args()
    directory = args.base / "state/storage-alert"
    if directory.is_symlink():
        raise ValueError("linked_alert_directory_not_allowed")
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory / "run.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        notify = module(args.base / "bin/first-v2-collection-monitor.py", "private_notification")
        credentials = notify.load(args.credentials)
        if credentials.get("chat_type") != "private" or not str(credentials.get("chat_id", "")).isdigit() or int(credentials["chat_id"]) <= 0:
            raise ValueError("private_notification_target_required")
        state_path = directory / "notification-state.json"
        state = notify.load(state_path) if state_path.exists() else {}
        now = datetime.now(timezone.utc)
        try:
            budget = module(args.base / "bin/storage-budget-report.py", "capacity_report")
            db = args.base / "state/activity.sqlite"
            stat = db.stat()
            identity = {"device": stat.st_dev, "inode": stat.st_ino}
            previous = previous_sample(args.base / "state/storage-budget/history.jsonl", identity, now)
            report = budget.build_report(db, args.base, "before", "activity", 16384, previous, now)
            # This is a capacity sample, not evidence of a new collection cycle.
            report["sample_context"] = "hourly_capacity_monitor"
            report["comparison_sample_at"] = previous["observed_at"] if previous else None
            level = severity(report)
            report["alert_level"] = level
            notify.save(directory / "latest.json", report)
            text = message(report, level, cycle_growth(args.base, notify.load, now)) if level else None
        except Exception as error:
            # Only exception classes are public; URL exceptions can contain credentials.
            level = 3
            report = {"observed_at": now.isoformat(), "alert_level": level, "monitor_error_type": type(error).__name__}
            notify.save(directory / "latest.json", report)
            text = "World Press Radar 저장공간 확인 실패\n확인 작업을 점검해야 합니다. 오류 종류: " + type(error).__name__ + "\n수집 기록과 파일은 변경하지 않았습니다."
        state.update({"checked_at": now.isoformat(), "current_level": level})
        if notification_due(state, level, now):
            sent = notify.telegram(credentials, "sendMessage", {"chat_id": credentials["chat_id"],
                "text": text, "link_preview_options": {"is_disabled": True}})
            state.update({"last_sent_at": datetime.now(timezone.utc).isoformat(), "last_sent_level": level,
                "last_message_id": sent["message_id"], "sent_count": state.get("sent_count", 0) + 1})
            print(json.dumps({"storage_alert": "delivered", "level": level}))
        else:
            print(json.dumps({"storage_alert": "quiet", "level": level}))
        notify.save(state_path, state)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"storage_alert": "error", "error_type": type(error).__name__}))
        raise SystemExit(1)
