#!/usr/bin/env python3
"""Operator disk guard. No deletion, database write, or child process.

Called inside the existing shared flock. Regular runs reserve 50 GiB plus
2 GiB collection growth without creating a backup. Legacy backup phases retain
their original reservation. Other filesystem writers are outside this guard.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys

GIB = 1024 ** 3
FLOOR_BYTES = 50 * GIB
GROWTH_BYTES = 2 * GIB


def required_bytes(phase, backup_bytes):
    if phase == "before-backup":
        return FLOOR_BYTES + backup_bytes + GROWTH_BYTES
    if phase in ("before-run", "after-backup"):
        return FLOOR_BYTES + GROWTH_BYTES
    if phase in ("pre-copy", "postflight"):
        return FLOOR_BYTES
    raise ValueError("Unknown disk guard phase")


def backup_size(db):
    if not db.is_file() or db.stat().st_size == 0:
        raise RuntimeError("Existing nonempty ledger is required")
    connection = sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        pages = connection.execute("PRAGMA page_count").fetchone()[0]
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        # Logical pages include committed WAL pages not checkpointed to the DB.
        return max(db.stat().st_size, pages * page_size)
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("before-run", "before-backup", "after-backup", "pre-copy", "postflight"))
    parser.add_argument("db", type=Path)
    parser.add_argument("base", type=Path)
    args = parser.parse_args()
    db = args.db.resolve()
    base = args.base.resolve()
    if not db.is_file() or db.stat().st_size == 0:
        raise RuntimeError("Existing nonempty ledger is required")
    guarded_path = base if args.phase == "before-run" else base / "backups"
    if os.stat(db).st_dev != os.stat(guarded_path).st_dev:
        raise RuntimeError("Ledger and guarded path must share the guarded filesystem")
    expected_backup = backup_size(db) if args.phase == "before-backup" else 0
    filesystem = os.statvfs(guarded_path)
    free = filesystem.f_bavail * filesystem.f_frsize
    required = required_bytes(args.phase, expected_backup)
    print(json.dumps({"disk_guard": args.phase, "free_bytes": free, "required_free_bytes": required,
        "floor_bytes": FLOOR_BYTES, "growth_reserved_bytes": GROWTH_BYTES,
        "next_backup_reserved_bytes": expected_backup, "passed": free >= required}, separators=(",", ":")), flush=True)
    if free < required:
        raise RuntimeError("50 GiB reserve plus this phase budget is unavailable; no further pipeline work")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"disk_guard_error": str(error), "type": type(error).__name__}), file=sys.stderr, flush=True)
        sys.exit(75)
