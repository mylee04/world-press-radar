#!/usr/bin/python3
"""Bounded retention for explicitly approved Clinic and FBM artifacts only.

Default is a preview. No database connection, collection or service restart.
Directory removal uses Python's descriptor-based, symlink-safe rmtree.
"""
import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time

CLINIC = Path('/srv/clinic-signals-ru')
FBM = Path('/srv/fbm-ai')
DATABASES = {'clinic-signals.sqlite3', 'workspaces.sqlite3', 'national-inventory.sqlite3', 'access-requests.sqlite3'}
DAILY = re.compile(r'backup-\d{8}T\d{12}Z')
MANUAL = re.compile(r'backup-(?:phase\d+-)?\d{8}T\d{12}Z')
DUMP = re.compile(r'fbm_ai-\d{8}T\d{6}Z\.dump')
RELEASE = re.compile(r'\d{8}-[A-Za-z0-9._-]+')
CONTACT = re.compile(r'(?:phase\d+|moscow-2026|planned|moscow-additions|recent30)-\d{8}T\d{6}Z\.sqlite3')
TEMP = re.compile(r'(?:tmp[A-Za-z0-9_]{8}|\.(?:city-inventory|catalog|residential)-[A-Za-z0-9_]{8})')


def inside(path, root):
    return path == root or root in path.parents


def plain(path, directory=False):
    try:
        mode = path.lstat().st_mode
        return stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)
    except FileNotFoundError:
        return False


def completed_backup(path):
    if not plain(path, True) or not plain(path / 'manifest.json'):
        return False
    try:
        manifest_path = path / 'manifest.json'
        if manifest_path.stat().st_size > 65536:
            return False
        manifest = json.loads(manifest_path.read_text())
        if manifest.get('method') != 'sqlite-online-backup' and manifest.get('status') != 'PASS':
            return False
        entries = manifest['databases']
        if not entries or any(row['name'] not in DATABASES for row in entries):
            return False
        expected = {'manifest.json'}
        for row in entries:
            name = row.get('file', row['name'])
            if name not in (row['name'], row['name'] + '.gz'):
                return False
            file = path / name
            if not plain(file) or file.stat().st_size != row['bytes'] or row['bytes'] <= 0:
                return False
            expected.add(name)
        for extra in path.iterdir():
            if extra.name in expected:
                continue
            if not plain(extra):
                return False
            # Backup integrity reads can leave empty WAL/coordination sidecars.
            if any(extra.name == name + '-wal' for name in DATABASES) and extra.stat().st_size == 0:
                continue
            if any(extra.name == name + '-shm' for name in DATABASES) and extra.stat().st_size <= 32768:
                continue
            if extra.suffix == '.json' and extra.stat().st_size <= 65536:
                continue
            return False
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def candidates(parent, pattern, directory=False, validate=None):
    if not plain(parent, True):
        return []
    return [p for p in parent.iterdir() if pattern.fullmatch(p.name) and plain(p, directory)
        and (validate is None or validate(p))]


def retained_and_expired(paths, keep):
    ordered = sorted(paths, key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
    return ordered[:keep], ordered[keep:]


def process_paths():
    """Read paths only, never process arguments, environments or data contents."""
    found = set()
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        links = [proc / 'cwd', proc / 'exe']
        try:
            links.extend((proc / 'fd').iterdir())
        except OSError:
            pass
        for link in links:
            try:
                value = os.readlink(link).removesuffix(' (deleted)')
                if value.startswith(('/srv/clinic-signals-ru/', '/srv/fbm-ai/')):
                    found.add(Path(value))
            except OSError:
                pass
        try:
            with (proc / 'maps').open() as stream:
                for line in stream:
                    parts = line.split(maxsplit=5)
                    if len(parts) == 6 and parts[5].startswith(('/srv/clinic-signals-ru/', '/srv/fbm-ai/')):
                        found.add(Path(parts[5].strip().removesuffix(' (deleted)')))
        except OSError:
            pass
    return found


def build_plan(scope='all', clinic=CLINIC, fbm=FBM, references=None, now=None):
    now = time.time() if now is None else now
    references = process_paths() if references is None else references
    result = {'retained': [], 'candidates': [], 'skipped': []}

    def add(path, root, kind):
        if not inside(path, root) or any(inside(ref, path) for ref in references):
            result['skipped'].append({'path': str(path), 'reason': 'referenced_or_outside_scope'})
            return
        if any(parent.is_symlink() for parent in [path, *path.parents] if inside(parent, root)):
            result['skipped'].append({'path': str(path), 'reason': 'linked_path'})
            return
        info = path.lstat()
        result['candidates'].append({'path': str(path), 'root': str(root), 'kind': kind,
            'device': info.st_dev, 'inode': info.st_ino, 'mtime_ns': info.st_mtime_ns})

    def family(paths, keep, root, kind):
        retained, expired = retained_and_expired(paths, keep)
        result['retained'].extend(str(p) for p in retained)
        for path in expired:
            # A staging/backup writer may be about to activate a recent artifact.
            if now - path.stat().st_mtime < 7200:
                result['skipped'].append({'path': str(path), 'reason': 'younger_than_two_hours'})
            else:
                add(path, root, kind)

    if scope in ('all', 'clinic') and plain(clinic, True):
        releases = clinic / 'releases'
        current = (clinic / 'current').resolve(strict=True)
        if current.parent != releases or not plain(current, True):
            raise ValueError('Unexpected current Clinic release')
        paths = candidates(releases, RELEASE, True)
        rollback = sorted([p for p in paths if p != current], key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)[:2]
        protected = {current, *rollback}
        result['retained'].extend(str(p) for p in protected)
        for path in paths:
            if path not in protected:
                if now - path.stat().st_mtime < 7200:
                    result['skipped'].append({'path': str(path), 'reason': 'young_release'})
                else:
                    add(path, releases, 'clinic_release')
        family(candidates(clinic / 'backups', DAILY, True, completed_backup), 3, clinic / 'backups', 'clinic_daily')
        manual = clinic / 'backups/contact-goal7000'
        family(candidates(manual, MANUAL, True, completed_backup), 1, manual, 'clinic_manual')
        contacts = clinic / 'data/.contact-backups'
        family(candidates(contacts, CONTACT), 1, contacts, 'clinic_contact_backup')
    if scope in ('all', 'clinic', 'clinic-temps') and plain(clinic, True):
        data = clinic / 'data'
        for path in candidates(data, TEMP):
            if now - path.stat().st_mtime >= 3600:
                add(path, data, 'clinic_temp')

    if scope in ('all', 'fbm', 'fbm-backups') and plain(fbm, True):
        backups = fbm / 'backups/postgres'
        def dump_header(path):
            with path.open('rb') as stream:
                return stream.read(5) == b'PGDMP'
        family(candidates(backups, DUMP, validate=dump_header), 7, backups, 'fbm_daily')
        if scope != 'fbm-backups':
            for parent in [fbm / name for name in ('deploy-backup-15f2f25c', 'deploy-backup-6d7d3133', 'deploy-backup-security-20260926')]:
                if not plain(parent, True):
                    continue
                for name in ('previous-build', 'next-build'):
                    path = parent / name
                    if plain(path, True) and now - path.stat().st_mtime >= 7200:
                        add(path, parent, 'fbm_old_build')
    return result


def remove_candidates(plan, clinic=CLINIC, references=None, temp_lock=True):
    if not shutil.rmtree.avoids_symlink_attacks:
        raise RuntimeError('Symlink-safe directory removal required')
    references = process_paths() if references is None else references
    removed, skipped = [], []
    with ExitStack() as stack:
        can_remove_temp = not temp_lock
        if temp_lock and any(row['kind'] == 'clinic_temp' for row in plan['candidates']):
            lock_path = clinic / 'data/.collection-worker.lock'
            # Open the original coordination inode without creating or replacing it.
            if plain(lock_path):
                handle = stack.enter_context(lock_path.open('r'))
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    can_remove_temp = True
                except BlockingIOError:
                    pass
        for row in plan['candidates']:
            path, root = Path(row['path']), Path(row['root'])
            reason = None
            if row['kind'] == 'clinic_temp' and not can_remove_temp:
                reason = 'collector_busy'
            elif not inside(path, root) or path == root or path.is_symlink():
                reason = 'unsafe_path'
            elif any(parent.is_symlink() for parent in path.parents if inside(parent, root)):
                reason = 'linked_parent'
            elif any(inside(ref, path) for ref in references):
                reason = 'active_process_reference'
            elif row['kind'] == 'clinic_release' and (clinic / 'current').resolve() == path:
                reason = 'current_release'
            try:
                info = path.lstat()
            except FileNotFoundError:
                reason = 'already_absent'
            else:
                if (info.st_dev, info.st_ino, info.st_mtime_ns) != (row['device'], row['inode'], row['mtime_ns']):
                    reason = 'changed_since_preview'
            if reason:
                skipped.append({'path': str(path), 'reason': reason})
                continue
            if row['kind'] == 'clinic_manual':
                # Preserve small original audit manifests/proofs in their old folder.
                for file in path.iterdir():
                    if plain(file) and any(file.name in (name, name + '.gz', name + '-wal', name + '-shm') for name in DATABASES):
                        file.unlink()
            elif stat.S_ISDIR(info.st_mode):
                shutil.rmtree(path)
            elif stat.S_ISREG(info.st_mode):
                path.unlink()
            else:
                skipped.append({'path': str(path), 'reason': 'unexpected_file_type'})
                continue
            removed.append(str(path))
    return {'removed': removed, 'skipped': skipped}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--scope', choices=('all', 'clinic', 'clinic-temps', 'fbm', 'fbm-backups'), default='all')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Root operator required for process-reference inspection')
    # The after-collector sweep must not wait for a long old-release removal.
    # Both paths still acquire the original worker lock before touching temp files.
    lock_name = 'shared-project-retention-temps.lock' if args.scope == 'clinic-temps' else 'shared-project-retention.lock'
    with (Path('/run/lock') / lock_name).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'retention': 'busy'}))
            return
        free_before = shutil.disk_usage('/srv').free
        plan = build_plan(args.scope)
        result = {'at': datetime.now(timezone.utc).isoformat(), 'scope': args.scope, 'apply': args.apply,
            'plan': plan, 'free_before': free_before}
        if args.apply:
            result['result'] = remove_candidates(plan)
            result['free_after'] = shutil.disk_usage('/srv').free
            result['net_free_change_bytes'] = result['free_after'] - free_before
            directory = Path('/var/lib/shared-project-retention')
            directory.mkdir(mode=0o700, exist_ok=True)
            target = directory / ('latest-' + args.scope + '.json')
            temporary = target.with_suffix('.tmp')
            temporary.write_text(json.dumps(result, indent=2) + '\n')
            os.replace(temporary, target)
        print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
