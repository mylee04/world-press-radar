#!/usr/bin/env python3
"""Stage a code-only release, then explicitly activate after an intact ledger backup.

The existing runner, credentials, ledger path and timer units remain unchanged.
No HTTP collection or deployment is performed by this installer.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time

PACKAGE = Path('packages/world-news-sources-mcp')
KIND = 'world-press-radar-collector-code-only'
CODE = re.compile(r'^(?:package(?:-lock)?\.json|tsconfig\.json|src/[A-Za-z0-9_-]+\.ts|dist/[A-Za-z0-9_-]+\.(?:js|d\.ts)|scripts/[A-Za-z0-9_-]+\.(?:mjs|py)|test/[A-Za-z0-9_-]+(?:\.test)?\.mjs|dashboard/(?:index\.html|app\.js|styles\.css)|site/(?:[A-Za-z0-9_-]+\.(?:html|css|svg)|\.well-known/openai-apps-challenge)|metrics/(?:worker\.mjs|schema\.sql|report\.sql)|plugin/(?:plugin\.json|mcp\.json|skills/find-news-sources/(?:SKILL\.md|agents/openai\.yaml))|expansion/(?:robots-policy\.mjs|(?:registry-additions|verified-health-additions|second-pass-live-before|first-pass-checkpoints)\.json|remaining13/(?:registry-additions|verified-health-additions|verified-existing-health|checkpoints|targeted)\.json))$')


def fail(code):
    raise RuntimeError('COLLECTOR_RELEASE_' + code)


def emit(**value):
    print(json.dumps(value), flush=True)


def regular(path):
    if path.is_symlink() or not path.is_file():
        fail('UNSAFE_FILE')
    return path


def hash_file(path):
    digest = hashlib.sha256()
    with regular(path).open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b''):
            digest.update(block)
    return digest.hexdigest()


def private_json(path, value):
    with path.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    path.chmod(0o600)


def command(arguments, log, cwd=None, timeout=600, env=None):
    with log.open('ab') as stream:
        result = subprocess.run(arguments, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
    log.chmod(0o600)
    if result.returncode:
        fail('COMMAND_FAILED')


def offline_environment():
    # Validation and archive export must not inherit model approvals, key paths,
    # a deployment token or private application state from an operator shell.
    allowed = {'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
               'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
               'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'}
    return dict({key: value for key, value in os.environ.items() if key in allowed},
                PATH='/usr/bin:/bin', NPM_CONFIG_UPDATE_NOTIFIER='false')


def tested_cases(log, manifest):
    test_files = sum(bool(re.fullmatch(r'test/[A-Za-z0-9_-]+\.test\.mjs', file['path'])) for file in manifest['files'])
    summaries = re.findall(r'^# tests (\d+)\s*$', log.read_text(), re.MULTILINE)
    failures = re.findall(r'^# fail (\d+)\s*$', log.read_text(), re.MULTILINE)
    if test_files < 20 or not summaries or int(summaries[-1]) < test_files or not failures or int(failures[-1]) != 0:
        fail('OFFLINE_TEST_SUITE_INCOMPLETE')
    return int(summaries[-1])


def verify_activation_metadata(expected, release, data_hashes):
    # An operator edit during the slow backup/export must never disappear.
    for path, digest in data_hashes.items():
        if hash_file(expected / path) != digest:
            fail('AUTHORITATIVE_DATA_CHANGED_BEFORE_ACTIVATION')
        if not path.startswith(str(PACKAGE / 'activity') + '/') and hash_file(release / path) != digest:
            fail('STAGED_METADATA_CHANGED_BEFORE_ACTIVATION')


def data_files(release):
    paths = [Path('data/rss-atlas.json'), Path('audits/readme_rss_health_latest.json'),
             PACKAGE / 'activity/activity-snapshot.json']
    for folder in [release / 'audits', release / PACKAGE / 'audits']:
        for path in folder.rglob('*'):
            if path.is_symlink():
                fail('UNSAFE_DATA_LINK')
            if path.is_file() and path.suffix in ['.json', '.md']:
                paths.append(path.relative_to(release))
    activity = json.loads(regular(release / PACKAGE / 'activity/activity-snapshot.json').read_text())
    if activity.get('version') != 1 or activity.get('lane') != 'production' or not activity.get('history', {}).get('complete'):
        fail('COMPLETE_HISTORY_REQUIRED')
    for shard in activity['history']['shards']:
        if not re.fullmatch(r'\d{4}-\d{2}-[a-f0-9]{64}\.json\.gz', shard.get('file', '')):
            fail('INVALID_HISTORY_FILENAME')
        path = PACKAGE / 'activity/history' / shard['file']
        source = regular(release / path)
        if source.stat().st_size != shard['bytes'] or hash_file(source) != shard['sha256']:
            fail('HISTORY_HASH_MISMATCH')
        paths.append(path)
    for name in ['recovery-latest.json', 'recovery-deferred.json']:
        path = PACKAGE / 'activity' / name
        if (release / path).exists():
            paths.append(path)
    return sorted(set(paths)), activity


def verify_bundle(bundle):
    manifest = json.loads(regular(bundle / 'COLLECTOR-CODE-MANIFEST.json').read_text())
    if manifest.get('version') != 1 or manifest.get('kind') != KIND or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', manifest.get('revision', '')):
        fail('INVALID_MANIFEST')
    seen, size = set(), 0
    for file in manifest.get('files', []):
        path = file.get('path', '')
        if not CODE.fullmatch(path) or path in seen or not re.fullmatch(r'[a-f0-9]{64}', file.get('sha256', '')):
            fail('INVALID_MANIFEST_FILE')
        source = regular(bundle / PACKAGE / path)
        if source.stat().st_size != file.get('bytes') or source.stat().st_size > 4 * 1024**2 or hash_file(source) != file['sha256']:
            fail('CODE_HASH_MISMATCH')
        seen.add(path)
        size += file['bytes']
    required = {'package-lock.json', 'dist/activity-ledger.js', 'dist/collection-schedule.js', 'scripts/collect-activity.mjs',
                'scripts/prepare-vercel.mjs', 'scripts/quality-cloud-gateway.mjs', 'scripts/install-collector-release.py'}
    if not required <= seen or size > 32 * 1024**2 or len(seen) > 400:
        fail('INCOMPLETE_BUNDLE')
    listed = {str(PACKAGE / path) for path in seen} | {'COLLECTOR-CODE-MANIFEST.json'}
    for path in bundle.rglob('*'):
        if path.is_symlink() or path.is_file() and str(path.relative_to(bundle)) not in listed:
            fail('UNLISTED_BUNDLE_FILE')
    return manifest


def ledger_evidence(db):
    with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as connection:
        result = {'collections': connection.execute('SELECT count(*) FROM collections').fetchone()[0],
                'urls': connection.execute('SELECT count(*) FROM urls').fetchone()[0],
                'bindings': connection.execute('SELECT count(*) FROM bindings').fetchone()[0],
                'first_check': connection.execute('SELECT min(checked_at) FROM collections').fetchone()[0],
                'last_check': connection.execute('SELECT max(checked_at) FROM collections').fetchone()[0]}
        baselines = connection.execute('SELECT source_id,endpoint_id,country,baseline_at FROM bindings ORDER BY source_id,endpoint_id').fetchall()
        result['baselines_sha256'] = hashlib.sha256(json.dumps(baselines, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        result['tracking_start'] = connection.execute('SELECT value FROM metadata WHERE key=?', ('tracking_start',)).fetchone()[0]
        return result


def verified_prebackup(base, receipt_path, db, before):
    receipt_path = regular(Path(receipt_path).resolve())
    if receipt_path.parent != base / 'backups' or receipt_path.stat().st_size > 128 * 1024:
        fail('INVALID_BACKUP_RECEIPT_PATH')
    receipt = json.loads(receipt_path.read_text())
    backup = regular(Path(receipt.get('backup', '')).resolve())
    if backup.parent != base / 'backups' or not re.fullmatch(r'rollout-[A-Za-z0-9._-]+\.sqlite', backup.name):
        fail('INVALID_BACKUP_PATH')
    wal = Path(str(db) + '-wal')
    if receipt.get('kind') != 'world-press-radar-rollout-readonly-backup' or receipt.get('version') != 1 or receipt.get('source') != str(db) \
        or receipt.get('quick_check') != 'ok' or receipt.get('source_wal_bytes') != 0 or (wal.exists() and wal.stat().st_size) \
        or receipt.get('ledger') != before or receipt.get('source_bytes') != db.stat().st_size or receipt.get('backup_bytes') != backup.stat().st_size \
        or hash_file(db) != receipt.get('source_sha256') or hash_file(backup) != receipt.get('backup_sha256') or ledger_evidence(backup) != before:
        fail('PREBACKUP_COMPARE_AND_SWAP_MISMATCH')
    return backup


def current_release(base, expected):
    current = base / 'current'
    if not current.is_symlink() or current.resolve() != expected:
        fail('CURRENT_COMPARE_AND_SWAP_MISMATCH')
    if expected.parent != (base / 'releases').resolve():
        fail('UNMANAGED_CURRENT')


def idle_services():
    for unit in ['world-news-activity.service', 'world-news-health.service']:
        result = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ActiveState', '--value'], capture_output=True, text=True, check=True)
        if result.stdout.strip() not in ['inactive', 'failed']:
            fail('COLLECTOR_NOT_IDLE')


def run(options):
    os.umask(0o077)
    base, bundle, expected = Path(options.base).expanduser().resolve(), Path(options.bundle).resolve(), Path(options.expected_current).resolve()
    manifest = verify_bundle(bundle)
    release = base / 'releases' / manifest['revision']
    if release == expected:
        fail('NEW_RELEASE_REQUIRED')
    state = base / 'state'
    with (state / 'run.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('COLLECTOR_LOCK_BUSY')
        current_release(base, expected)
        idle_services()
        files, prior_activity = data_files(expected)
        registry_hash = hash_file(expected / 'data/rss-atlas.json')
        data_hashes = {str(path): hash_file(expected / path) for path in files}
        units = Path.home() / '.config/systemd/user'
        timer_hashes = {name: hash_file(units / name) for name in ['world-news-activity.timer', 'world-news-health.timer']}
        if not options.activate:
            if release.exists():
                fail('RELEASE_EXISTS')
            release.mkdir(mode=0o700)
            for path in [Path('COLLECTOR-CODE-MANIFEST.json')] + [PACKAGE / file['path'] for file in manifest['files']]:
                destination = release / path
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(regular(bundle / path), destination)
                destination.chmod(0o600)
            for path in files:
                destination = release / path
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(regular(expected / path), destination)
                destination.chmod(0o600)
            project = json.loads(regular(state / 'project.json').read_text())
            if project.get('projectId') != 'prj_BJ4NiHnL2RbmtjojGUogPS2faQJs' or project.get('orgId') != 'team_L8qng538xRzhNBoq38X6p8sN':
                fail('WRONG_VERCEL_PROJECT')
            project_path = release / PACKAGE / '.deploy-vercel/.vercel/project.json'
            project_path.parent.mkdir(parents=True, mode=0o700)
            private_json(project_path, project)
            log = release / 'STAGE-VALIDATION.log'
            env = offline_environment()
            emit(status='installing_dependencies', release=str(release), production_data_source=str(expected), production_ledger_modified=False)
            command(['/usr/bin/npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], log, release / PACKAGE, env=env)
            command(['/usr/bin/npm', 'run', 'typecheck'], log, release / PACKAGE, env=env)
            command(['/usr/bin/npm', 'test'], log, release / PACKAGE, timeout=900, env=env)
            passed = tested_cases(log, manifest)
            for path, digest in data_hashes.items():
                if hash_file(expected / path) != digest or hash_file(release / path) != digest:
                    fail('PRODUCTION_DATA_CHANGED_DURING_STAGE')
            private_json(release / 'COLLECTOR-STAGED.json', {'kind': KIND, 'revision': manifest['revision'], 'previous_release': str(expected),
                         'registry_sha256': registry_hash, 'data_hashes': data_hashes, 'timer_hashes': timer_hashes,
                         'activity_generated_at': prior_activity.get('generated_at'), 'offline_test_cases_passed': passed,
                         'staged_at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
            emit(status='staged_not_activated', release=str(release), registry_sha256=registry_hash, history_shards=len(prior_activity['history']['shards']),
                 current_release=str(expected), offline_test_cases_passed=passed, timer_changed=False, publisher_requests=0, model_calls=0)
            return
        marker = json.loads(regular(release / 'COLLECTOR-STAGED.json').read_text())
        if marker.get('previous_release') != str(expected) or marker.get('registry_sha256') != registry_hash or marker.get('timer_hashes') != timer_hashes:
            fail('STAGED_BASELINE_CHANGED')
        if marker.get('offline_test_cases_passed') != tested_cases(release / 'STAGE-VALIDATION.log', manifest):
            fail('STAGED_TEST_VALIDATION_CHANGED')
        for file in manifest['files']:
            if hash_file(release / PACKAGE / file['path']) != file['sha256']:
                fail('STAGED_CODE_HASH_MISMATCH')
        for path, digest in marker['data_hashes'].items():
            if hash_file(expected / path) != digest or hash_file(release / path) != digest:
                fail('STAGED_DATA_HASH_MISMATCH')
        db = regular(state / 'activity.sqlite')
        if list((state / 'activity.sqlite.spool').glob('*.json')):
            fail('PENDING_SPOOLS_REQUIRE_REVIEW')
        if shutil.disk_usage(base).free < db.stat().st_size + 20 * 1024**3:
            fail('INSUFFICIENT_BACKUP_DISK')
        before = ledger_evidence(db)
        started = time.monotonic()
        if options.backup_receipt:
            emit(status='verifying_prebackup', collections=before['collections'])
            backup = verified_prebackup(base, options.backup_receipt, db, before)
        else:
            backup = base / 'backups' / ('rollout-' + manifest['revision'] + '.sqlite')
            if backup.exists():
                fail('BACKUP_ALREADY_EXISTS_REVIEW_REQUIRED')
            emit(status='consistent_backup_started', backup=str(backup), db_bytes=db.stat().st_size, collections=before['collections'])
            with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as source, sqlite3.connect(str(backup)) as target:
                source.backup(target, pages=1024, sleep=0.01)
                if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    fail('BACKUP_QUICK_CHECK_FAILED')
            backup.chmod(0o600)
            if ledger_evidence(backup) != before:
                fail('BACKUP_EVIDENCE_MISMATCH')
        emit(status='consistent_backup_verified', backup=str(backup), elapsed_seconds=round(time.monotonic() - started, 3), db_bytes=backup.stat().st_size)
        log = release / 'ACTIVATION-EXPORT.log'
        env = dict(offline_environment(), WNS_ACTIVITY_DB=str(db), WNS_REGISTRY_PATH=str(release / 'data/rss-atlas.json'),
                   WNS_HEALTH_PATH=str(release / PACKAGE / 'audits/health-latest.json'),
                   WNS_LEGACY_HEALTH_PATH=str(release / 'audits/readme_rss_health_latest.json'))
        command(['/usr/bin/node', 'scripts/collect-activity.mjs', '--export-only', '--db', str(db)], log, release / PACKAGE, timeout=1800, env=env)
        after = ledger_evidence(db)
        if after != before:
            fail('LEDGER_HISTORY_CHANGED_DURING_EXPORT')
        _, updated_activity = data_files(release)
        if any(updated_activity.get(key) != prior_activity.get(key) for key in ['tracking_start', 'scope_starts', 'scope_latest']):
            fail('TRACKING_BOUNDARY_CHANGED')
        if updated_activity.get('snapshot_coverage', {}).get('exported_collections') != before['collections']:
            fail('INCOMPLETE_EXPORT')
        prior_baselines = {(row['source_id'], row['endpoint_id']): row['baseline_at'] for row in prior_activity['bindings']}
        updated_baselines = {(row['source_id'], row['endpoint_id']): row['baseline_at'] for row in updated_activity['bindings']}
        if prior_baselines != updated_baselines:
            fail('BINDING_BASELINES_CHANGED')
        current_release(base, expected)
        if {name: hash_file(units / name) for name in timer_hashes} != timer_hashes:
            fail('TIMER_CHANGED_DURING_ACTIVATION')
        verify_activation_metadata(expected, release, marker['data_hashes'])
        receipt = {'kind': KIND, 'status': 'activated', 'release': str(release), 'previous_release': str(expected),
                   'backup': str(backup), 'registry_sha256': registry_hash, 'ledger_before': before, 'ledger_after': after,
                   'timer_hashes': timer_hashes, 'activated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'publisher_requests': 0, 'model_calls': 0, 'deployment_submitted': False}
        private_json(release / 'COLLECTOR-ACTIVATION.json', receipt)
        next_link = base / ('current.rollout-' + str(os.getpid()))
        next_link.symlink_to(release)
        os.replace(next_link, base / 'current')
        if (base / 'current').resolve() != release:
            fail('ACTIVATION_POINTER_MISMATCH')
        emit(**receipt)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default=str(Path.home() / '.local/share/world-news-audit'))
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--backup-receipt')
    run(parser.parse_args())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        emit(status='failed', error=code if re.fullmatch(r'COLLECTOR_RELEASE_[A-Z_]+', code) else 'COLLECTOR_RELEASE_INSTALL_FAILED')
        sys.exit(1)
