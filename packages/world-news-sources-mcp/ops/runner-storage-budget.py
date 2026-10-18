#!/usr/bin/env python3
"""Read-only storage sample and capacity estimate for the existing runner.

Print one JSON record. This helper does not open SQLite, write files, delete
data, change limits, or stop a collection. The wrapper owns bounded report
retention; the disk floor and collector enforce their existing limits.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import sys

GIB = 1024 ** 3
MIB = 1024 ** 2
FLOOR_BYTES = 50 * GIB
GROWTH_RESERVE_BYTES = 2 * GIB
BASELINE_DAILY_GROWTH_BYTES = 223834112
MINIMUM_SAMPLE_HOURS = 12
WARNING_DAYS = 14


def utc_text(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def previous_sample_window(previous, identity, at):
    if previous is None:
        return "no_previous_sample", None
    try:
        if previous.get("report_version") != 1:
            return "invalid_previous_sample", None
        if previous.get("ledger_identity") != identity:
            return "ledger_identity_changed", None
        prior_at = datetime.fromisoformat(previous["observed_at"].replace("Z", "+00:00"))
        if prior_at.tzinfo is None:
            return "invalid_previous_sample", None
        hours = (at - prior_at).total_seconds() / 3600
        if hours < 0:
            return "previous_sample_in_future", None
        if hours < MINIMUM_SAMPLE_HOURS:
            return "sample_interval_too_short", hours
        return "measured", hours
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        return "invalid_previous_sample", None


def previous_growth(previous, identity, total_bytes, at):
    status, hours = previous_sample_window(previous, identity, at)
    if status != "measured":
        return None, status, hours
    try:
        prior_total = previous["ledger_bytes"]
        if isinstance(prior_total, bool) or not isinstance(prior_total, int) or prior_total < 0:
            return None, "invalid_previous_sample", hours
        # WAL checkpoints can reduce this physical total. Negative growth is
        # zero for the measured rate, not evidence of future free capacity.
        daily = max(0, math.ceil((total_bytes - prior_total) * 24 / hours))
        return daily, "measured", hours
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        return None, "invalid_previous_sample", hours


def previous_filesystem_decline(previous, identity, free_bytes, at):
    status, hours = previous_sample_window(previous, identity, at)
    if status != "measured":
        return None, status, hours
    try:
        if previous.get("mode") != "activity" or previous.get("phase") != "after":
            return None, "previous_sample_not_completed_activity", hours
        prior_free = previous["filesystem_free_bytes"]
        if isinstance(prior_free, bool) or not isinstance(prior_free, int) or prior_free < 0:
            return None, "invalid_previous_filesystem_free_bytes", hours
        # This net filesystem change includes all projects and reclamation.
        # A cleanup cannot establish a negative future consumption rate.
        decline = max(0, math.ceil((prior_free - free_bytes) * 24 / hours))
        return decline, "measured", hours
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        return None, "invalid_previous_filesystem_free_bytes", hours


def forecast(headroom, daily_growth, at):
    days = max(0, headroom) / daily_growth
    # A timestamp is useful for near-term planning; extremely small artificial
    # fixture rates should not overflow datetime.
    try:
        estimated_at = utc_text(at + timedelta(days=days))
    except OverflowError:
        estimated_at = None
    return {"estimated_days_remaining": round(days, 2), "estimated_limit_at": estimated_at}


def build_report(db, base, phase, mode, max_db_mib=16384, previous=None, at=None):
    if isinstance(max_db_mib, bool) or not isinstance(max_db_mib, int) or not 1 <= max_db_mib <= 16384:
        raise ValueError("max-db-mib must be an integer from 1 to 16384")
    if phase not in ("before", "after") or mode not in ("activity", "health"):
        raise ValueError("Unknown runner phase or mode")
    at = at or datetime.now(timezone.utc)
    if at.tzinfo is None:
        raise ValueError("Observation time must include a timezone")
    db, base = Path(db).resolve(), Path(base).resolve()
    db_stat = db.stat()
    if not db.is_file() or db_stat.st_size == 0:
        raise RuntimeError("Existing nonempty ledger is required")
    if db_stat.st_dev != base.stat().st_dev:
        raise RuntimeError("Ledger and runner base must share the guarded filesystem")
    wal = Path(str(db) + "-wal")
    try:
        wal_bytes = wal.stat().st_size
    except FileNotFoundError:
        wal_bytes = 0
    total_bytes = db_stat.st_size + wal_bytes
    fs = os.statvfs(base)
    free_bytes = fs.f_bavail * fs.f_frsize
    identity = {"device": db_stat.st_dev, "inode": db_stat.st_ino}
    measured, sample_status, elapsed_hours = previous_growth(previous, identity, total_bytes, at)
    daily_growth = max(BASELINE_DAILY_GROWTH_BYTES, measured or 0)
    filesystem_decline, filesystem_sample_status, filesystem_elapsed_hours = previous_filesystem_decline(previous, identity, free_bytes, at)
    filesystem_daily_decline = max(daily_growth, filesystem_decline or 0)
    cap_bytes = max_db_mib * MIB
    required_free = FLOOR_BYTES + GROWTH_RESERVE_BYTES
    ledger_forecast = forecast(cap_bytes - total_bytes, daily_growth, at)
    filesystem_preflight_forecast = forecast(free_bytes - required_free, filesystem_daily_decline, at)
    filesystem_floor_forecast = forecast(free_bytes - FLOOR_BYTES, filesystem_daily_decline, at)
    warnings = []
    if total_bytes >= cap_bytes:
        warnings.append("ledger_cap_exhausted")
    if total_bytes >= cap_bytes * 0.8:
        warnings.append("ledger_utilization_at_least_80_percent")
    if ledger_forecast["estimated_days_remaining"] <= WARNING_DAYS:
        warnings.append("ledger_cap_within_14_days")
    if free_bytes < FLOOR_BYTES:
        warnings.append("filesystem_free_below_50_gib_floor")
    if free_bytes < required_free:
        warnings.append("filesystem_free_below_52_gib_preflight")
    if filesystem_preflight_forecast["estimated_days_remaining"] <= WARNING_DAYS:
        warnings.append("filesystem_preflight_within_14_days")
    return {
        "report_version": 1, "observed_at": utc_text(at), "mode": mode, "phase": phase,
        "ledger_identity": identity, "db_bytes": db_stat.st_size, "wal_bytes": wal_bytes,
        "ledger_bytes": total_bytes, "collector_max_db_mib": max_db_mib,
        "ledger_cap_bytes": cap_bytes, "ledger_headroom_bytes": max(0, cap_bytes - total_bytes),
        "ledger_utilization_percent": round(total_bytes / cap_bytes * 100, 2),
        "filesystem_free_bytes": free_bytes, "filesystem_floor_bytes": FLOOR_BYTES,
        "filesystem_preflight_required_bytes": required_free,
        "sample_status": sample_status, "sample_elapsed_hours": elapsed_hours,
        "measured_daily_growth_bytes": measured,
        "forecast_daily_growth_bytes": daily_growth,
        "forecast_growth_basis": "measured_above_baseline" if measured is not None and measured > BASELINE_DAILY_GROWTH_BYTES else "baseline_floor",
        "filesystem_sample_status": filesystem_sample_status,
        "filesystem_sample_elapsed_hours": filesystem_elapsed_hours,
        "filesystem_measured_daily_decline_bytes": filesystem_decline,
        "filesystem_forecast_daily_decline_bytes": filesystem_daily_decline,
        "filesystem_forecast_rate_basis": "measured_total_filesystem_decline" if filesystem_decline is not None and filesystem_decline > daily_growth else "conservative_news_growth",
        "baseline": {"bytes_per_day": BASELINE_DAILY_GROWTH_BYTES, "provenance": "operator-supplied recent two-cycle growth estimate"},
        "ledger_forecast": ledger_forecast, "filesystem_preflight_forecast": filesystem_preflight_forecast,
        "filesystem_floor_forecast": filesystem_floor_forecast,
        "forecast_is_guarantee": False, "other_filesystem_writers_modeled": False,
        "filesystem_forecast_includes_total_measured_decline": filesystem_decline is not None,
        "other_filesystem_writers_attributed": False,
        "forecast_limitations": ["DB plus WAL is a physical sample and can change during checkpoints or collection.",
            "Total filesystem decline includes other projects, cleanup and volume changes; individual causes are not attributed.",
            "Cleanup or reclamation can mask simultaneous growth; negative net decline is clamped to zero.",
            "Future publisher volume and unrelated project writes are unknown.",
            "A larger bounded ledger cap postpones its limit; it does not provide unlimited retention."],
        "warning_codes": warnings, "status": "warning" if warnings else "ok",
        "changes_limits": False, "deletes_files": False, "opens_sqlite": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--phase", required=True, choices=("before", "after"))
    parser.add_argument("--mode", required=True, choices=("activity", "health"))
    parser.add_argument("--max-db-mib", type=int, default=16384)
    parser.add_argument("--previous", type=Path)
    args = parser.parse_args()
    previous = None
    previous_status = None
    if args.previous and args.previous.exists():
        try:
            if args.previous.stat().st_size > 65536:
                raise ValueError("Oversized previous report")
            previous = json.loads(args.previous.read_text())
        except (OSError, ValueError):
            previous_status = "invalid_previous_report_file"
    result = build_report(args.db, args.base, args.phase, args.mode, args.max_db_mib, previous)
    if previous_status:
        result["sample_status"] = previous_status
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"storage_budget_error": str(error), "type": type(error).__name__}), file=sys.stderr, flush=True)
        sys.exit(1)
