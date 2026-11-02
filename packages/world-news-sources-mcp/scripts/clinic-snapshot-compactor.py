#!/usr/bin/python3
"""Compact verified Clinic HTML representations in short, idle-only batches."""
import argparse
from datetime import datetime, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
DATA = Path('/srv/clinic-signals-ru/data')
LIBRARY = Path('/srv/clinic-signals-ru/current/collector/snapshot_store.py')
STATE = Path('/var/lib/clinic-snapshot-compactor')
FAMILIES = ('opening-evidence', 'reviewed-openings', 'reviewed-contacts')
NAME = re.compile(r'[a-f0-9]{64}\.html')
MAX_FILE = 16 * 1024 * 1024


def plain(path, directory=False):
    try:
        mode = path.lstat().st_mode
        return (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)) and path.resolve(strict=True) == path.absolute()
    except OSError:
        return False


def readers_running(proc=Path('/proc')):
    """Inspect executable argument names only and never return process contents."""
    names = {'dental_contact_observations.py', 'reindex-telegram-candidates.py'}
    try:
        processes = proc.iterdir()
        for process in processes:
            if not process.name.isdigit():
                continue
            try:
                arguments = (process / 'cmdline').read_bytes().split(b'\0')
            except FileNotFoundError:
                continue
            except PermissionError:
                return True
            for argument in arguments:
                token = argument.decode('utf-8', errors='replace')
                if Path(token).name in names or token == 'collector.dental_contact_observations':
                    return True
        return False
    except OSError:
        return True


def collector_idle(runner=subprocess.run):
    """An inactive unit is required before an independent timer takes the lock."""
    try:
        result = runner(['systemctl', 'show', 'clinic-signals-ru-monitor.service',
            '--property=ActiveState', '--value'], check=True, capture_output=True,
            text=True, timeout=3)
        return result.stdout.strip() == 'inactive'
    except (OSError, subprocess.SubprocessError):
        return False


def batch(data, compact, apply=False, max_seconds=20, max_raw_bytes=256 * 1024 * 1024,
          max_files=2000, now=None, clock=time.monotonic, readers_busy=None):
    started = clock()
    now = time.time() if now is None else now
    report = {'version': 1, 'at': datetime.now(timezone.utc).isoformat(), 'apply': apply,
        'status': 'preview' if not apply else 'completed', 'examined': 0, 'eligible': 0,
        'compressed': 0, 'raw_bytes': 0, 'stored_bytes': 0, 'allocated_reduction_bytes': 0,
        'attempted_raw_bytes': 0, 'skipped': {}, 'bounded': False}
    def skip(reason):
        report['skipped'][reason] = report['skipped'].get(reason, 0) + 1
    if not plain(data, True):
        report['status'] = 'unsafe_data_root'
        return report
    roots = [data / name / 'snapshots' for name in FAMILIES]
    if not all(plain(root, True) for root in roots):
        report['status'] = 'unsafe_snapshot_root'
        return report
    if readers_running() if readers_busy is None else readers_busy:
        report['status'] = 'reader_busy'
        return report
    lock_path = data / '.collection-worker.lock'
    if not plain(lock_path):
        report['status'] = 'collection_lock_unavailable'
        return report
    with lock_path.open('r') as lock:
        original = os.fstat(lock.fileno())
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            report['status'] = 'collector_busy'
            return report
        current = lock_path.stat()
        if not plain(lock_path) or (original.st_dev, original.st_ino) != (current.st_dev, current.st_ino):
            report['status'] = 'collection_lock_changed'
            return report
        free = os.statvfs(data)
        report['free_before'] = free.f_bavail * free.f_frsize
        stop = False
        for root in roots:
            if stop:
                break
            with os.scandir(root) as entries:
                for entry in entries:
                    if clock() - started >= max_seconds or report['eligible'] >= max_files:
                        report['bounded'] = True
                        stop = True
                        break
                    report['examined'] += 1
                    if not NAME.fullmatch(entry.name):
                        continue
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        skip('disappeared')
                        continue
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        skip('linked_or_nonregular')
                        continue
                    if info.st_size > MAX_FILE:
                        skip('oversized')
                        continue
                    if now - info.st_mtime < 3600:
                        skip('recent')
                        continue
                    if report['attempted_raw_bytes'] + info.st_size > max_raw_bytes:
                        report['bounded'] = True
                        stop = True
                        break
                    # Recheck parent boundaries after planning and before the helper writes.
                    if not plain(root, True):
                        report['status'] = 'snapshot_root_changed'
                        stop = True
                        break
                    report['eligible'] += 1
                    report['attempted_raw_bytes'] += info.st_size
                    if not apply:
                        continue
                    try:
                        result = compact(Path(entry.path), max_bytes=MAX_FILE, min_age_seconds=3600)
                        if result.get('compressed') is not True:
                            skip('helper_skipped')
                            continue
                        if result.get('original_sha_verified') is not True:
                            raise ValueError('Unverified compaction result')
                        sizes = (result.get('raw_bytes'), result.get('stored_bytes'), result.get('allocated_reduction_bytes'))
                        if any(type(value) is not int or value < 0 for value in sizes):
                            raise ValueError('Invalid compaction counters')
                        report['compressed'] += 1
                        for key, value in zip(('raw_bytes', 'stored_bytes', 'allocated_reduction_bytes'), sizes):
                            report[key] += value
                    except Exception:
                        skip('verification_or_io_error')
        free = os.statvfs(data)
        report['free_after'] = free.f_bavail * free.f_frsize
        report['net_free_change_bytes'] = report['free_after'] - report['free_before']
    report['elapsed_seconds'] = round(clock() - started, 3)
    return report


def save(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--after-collection', action='store_true',
        help='Run from the synchronous collector stop hook; retain the original file lock')
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps(batch(DATA, None)))
        return
    if not args.after_collection and not collector_idle():
        print(json.dumps({'version': 1, 'at': datetime.now(timezone.utc).isoformat(),
            'apply': True, 'status': 'collector_busy', 'compressed': 0, 'raw_bytes': 0,
            'stored_bytes': 0, 'allocated_reduction_bytes': 0}))
        return
    if STATE.is_symlink():
        raise ValueError('Linked state directory')
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / 'run.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'maintenance_busy'}))
            return
        spec = importlib.util.spec_from_file_location('clinic_snapshot_store', LIBRARY)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        report = batch(DATA, helper.compact_snapshot, apply=True)
        cumulative_path = STATE / 'cumulative.json'
        cumulative = {'version': 1, 'batches': 0, 'compressed': 0, 'raw_bytes': 0, 'stored_bytes': 0, 'allocated_reduction_bytes': 0}
        if cumulative_path.exists():
            if cumulative_path.stat().st_size > 4096:
                raise ValueError('Oversized compaction counters')
            cumulative.update(json.loads(cumulative_path.read_text()))
        cumulative['batches'] += 1
        for key in ('compressed', 'raw_bytes', 'stored_bytes', 'allocated_reduction_bytes'):
            cumulative[key] += report[key]
        cumulative['updated_at'] = report['at']
        save(STATE / 'latest.json', report)
        save(cumulative_path, cumulative)
        print(json.dumps(report))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'error', 'error_type': type(error).__name__}))
        raise SystemExit(1)
