#!/usr/bin/env python3
"""Send one saved daily collection summary per result stage, without collecting."""
from collections import Counter
from datetime import datetime, timedelta, timezone
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
from zoneinfo import ZoneInfo

CHICAGO = ZoneInfo('America/Chicago')
COUNTRIES = {'KR': '한국', 'DE': '독일', 'TW': '대만', 'GB': '영국', 'IN': '인도', 'US': '미국', 'CN': '중국', 'JP': '일본', 'FR': '프랑스', 'CA': '캐나다', 'BR': '브라질', 'AU': '호주', 'RU': '러시아'}
CAUSES = {'access_restricted': '접근 제한', 'document_validation': '문서 형식', 'missing_endpoint': '주소 없음', 'transient_transport': '일시적 통신', 'rate_limited': '요청 제한', 'server_error_retry_candidate': '서버 오류', 'unresolved': '미분류'}


def at(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def expected_run(now):
    day = (now - timedelta(hours=3)).date()
    return datetime(day.year, day.month, day.day, 3, tzinfo=timezone.utc)


def stage(service, expected, parse_start):
    started = parse_start(service)
    if not started or started < expected:
        return 'missing'
    if service.get('ActiveState') in ('activating', 'active', 'deactivating'):
        return 'running'
    return 'complete' if service.get('Result') == 'success' and service.get('ExecMainStatus') == '0' else 'failed'


def rows_for_cycle(connection, cycle):
    start = at(cycle['started_at']).replace(hour=0, minute=0, second=0, microsecond=0)
    end = max(start + timedelta(days=1), at(cycle.get('finished_at') or cycle['started_at']).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1))
    rows = connection.execute("SELECT endpoint_id,status,format,json_extract(details,'$.cycle_id') cycle_id,json_extract(details,'$.country_new') country_new,json_extract(details,'$.recovery.category') category FROM collections INDEXED BY collection_time WHERE checked_at>=? AND checked_at<? ORDER BY checked_at LIMIT 10001", (start.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), end.isoformat(timespec='milliseconds').replace('+00:00', 'Z'))).fetchall()
    if len(rows) > 10000:
        raise ValueError('daily_observation_bound_exceeded')
    return [dict(row) for row in rows if row['cycle_id'] == cycle['id']]


def metrics(cycle, rows):
    attempted = {row['endpoint_id'] for row in rows}
    if len(attempted) != len(rows):
        raise ValueError('repeated_cycle_endpoint')
    if cycle.get('status') != 'running' and 'attempted_endpoint_ids' in cycle and attempted != set(cycle['attempted_endpoint_ids']):
        raise ValueError('cycle_observations_incomplete')
    successful = [r for r in rows if r['status'] in ('working_nonempty', 'valid_empty')]
    articles = [r for r in successful if r['format'] != 'sitemapindex']
    failures = [r for r in rows if r['status'] not in ('working_nonempty', 'valid_empty')]
    countries = Counter()
    for row in articles:
        values = json.loads(row['country_new']) if row['country_new'] else None
        if not isinstance(values, dict) or not values or any(type(value) is not int or value < 0 for value in values.values()):
            raise ValueError('invalid_new_url_count')
        countries.update(values)
    schedule = cycle.get('scheduling', {})
    deferred = {r['endpoint_id'] for r in schedule.get('deferred_endpoints', [])}
    already = set(schedule.get('already_checked_today_endpoint_ids', []))
    return {'attempted': len(rows), 'article_success': len(articles), 'index_only': len(successful) - len(articles),
        'failed': len(failures), 'unattempted_deferred': len(deferred - attempted - already),
        'active': len(set(schedule.get('active_endpoint_ids', cycle['eligible_endpoint_ids']))),
        'already_checked': len(already), 'top_countries': countries.most_common(5) if articles else None,
        'causes': Counter(r['category'] or 'unresolved' for r in failures).most_common(3)}


def build_report(base, expected, service, status, parse_start, now):
    result = {'day': expected.date().isoformat(), 'state': status, 'service_result': service.get('Result'),
        'service_started_at': parse_start(service).isoformat() if parse_start(service) else None}
    db = base / 'state/activity.sqlite'
    with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=5) as connection:
        connection.execute('PRAGMA query_only=ON')
        connection.row_factory = sqlite3.Row
        cycles = [json.loads(r[0]) for r in connection.execute("SELECT payload FROM collection_cycles WHERE json_extract(payload,'$.lane')='production' AND json_extract(payload,'$.scope')='due_endpoints' ORDER BY json_extract(payload,'$.started_at') DESC LIMIT 3")]
        service_start = parse_start(service)
        candidates = [c for c in cycles if service_start and expected <= service_start <= at(c['started_at']) < expected + timedelta(days=1)]
        current = candidates[0] if candidates else None
        if current:
            result.update(metrics(current, rows_for_cycle(connection, current)))
            result.update({'cycle_id': current['id'], 'cycle_status': current['status'], 'finished_at': current['finished_at']})
            previous = next((c for c in cycles if at(c['started_at']) < at(current['started_at'])), None)
            if previous:
                prior = metrics(previous, rows_for_cycle(connection, previous))
                result['success_delta'] = result['article_success'] - prior['article_success']
                result['failure_delta'] = result['failed'] - prior['failed']
                result['registry_changed'] = previous['registry_digest'] != current['registry_digest']
            result['countries'] = connection.execute('SELECT COUNT(DISTINCT country) FROM registry WHERE enabled=1').fetchone()[0]
            result['sources'] = connection.execute('SELECT COUNT(DISTINCT source_id) FROM registry WHERE enabled=1').fetchone()[0]
    wal = Path(str(db) + '-wal')
    result['ledger_bytes'] = db.stat().st_size + (wal.stat().st_size if wal.exists() else 0)
    fs = os.statvfs(base)
    result['free_bytes'] = fs.f_bavail * fs.f_frsize
    return result


def matched_growth(base, result, load):
    paths = [base / 'state/storage-budget' / ('activity-' + phase + '-latest.json') for phase in ('before', 'after')]
    if not result.get('finished_at') or not all(p.exists() for p in paths):
        return None
    first, last = [load(p) for p in paths]
    if (first.get('phase') == 'before' and last.get('phase') == 'after'
            and first.get('mode') == last.get('mode') == 'activity'
            and first.get('ledger_identity') == last.get('ledger_identity')
            and at(result['service_started_at']) <= at(first['observed_at']) <= at(result['finished_at']) <= at(last['observed_at'])
            and (at(last['observed_at']) - at(first['observed_at'])).total_seconds() <= 8 * 3600):
        return last['ledger_bytes'] - first['ledger_bytes']
    return None


def public_status(result):
    import urllib.request
    try:
        with urllib.request.urlopen('https://news.bymyleslee.com/health', timeout=15) as response:
            data = json.loads(response.read(65537))
        snapshot = data.get('article_activity', {}).get('snapshot_at')
        return '반영 확인' if result.get('finished_at') and snapshot and at(snapshot) >= at(result['finished_at']) else '이전 결과 또는 반영 대기'
    except Exception:
        return '공개 상태 조회 실패'


def message(result):
    labels = {'complete': '수집·후속 작업 정상 종료', 'failed': '수집 또는 후속 작업 실패, 확인 필요', 'running': '정기 작업 진행 중', 'missing': '이번 정기 작업 시작 기록 없음', 'report_error': '요약 데이터 확인 필요'}
    started = at(result['service_started_at']).astimezone(CHICAGO).strftime('%m/%d %H:%M') if result.get('service_started_at') else None
    lines = ['World Press Radar 일일 요약', f"수집 회차: UTC {result['day']}" + (f' (시카고 시작 {started})' if started else ''), labels[result['state']]]
    if 'attempted' in result:
        cycle_labels = {'completed': '완료', 'partial': '부분 완료', 'running': '진행 중', 'failed': '실패'}
        lines += ['회차 상태: ' + cycle_labels.get(result.get('cycle_status'), '미확인'),
            f"활성 주소 {result['active']:,}개 중 {result['attempted']:,}개 시도",
            f"기사 후보 수집 성공 {result['article_success']:,}개 / 검사 실패 {result['failed']:,}개",
            f"사이트맵 인덱스만 확인 {result['index_only']:,}개 / 미검사 보류 {result['unattempted_deferred']:,}개"]
        if 'success_delta' in result:
            lines += [f"전 회차 대비: 기사 수집 성공 {result['success_delta']:+,}개, 실패 {result['failure_delta']:+,}개",
                '일시적인 응답 변화가 포함되며, 수정·복구 완료 건수는 아닙니다.']
        if result['causes']:
            lines += ['주요 실패 원인: ' + ', '.join(f'{CAUSES.get(c, c)} {n:,}' for c, n in result['causes'])]
        lines += [f"등록 {result['sources']:,}개 소스 · {result['countries']}개국",
            '등록 구성: ' + ('변경 감지, 상세 확인 필요' if result.get('registry_changed') else '전 회차와 동일' if 'registry_changed' in result else '비교 기록 없음')]
        if result['top_countries'] is None:
            lines += ['신규 URL: 성공 관측이 없어 미확인']
        elif result['top_countries']:
            lines += ['이번 회차 국가별 신규 URL 상위: ' + ', '.join(f'{COUNTRIES.get(c, c)} {n:,}' for c, n in result['top_countries'])]
        else:
            lines += ['이번 회차 신규 URL: 확인된 0개']
        lines += ['최초 수집분 제외, 국가별 중복 제거된 발견 URL입니다. 발행 기사 수나 전 세계 고유 합계가 아닙니다.']
    if 'ledger_bytes' in result:
        growth = result.get('growth_bytes')
        lines += [f"원장 {result['ledger_bytes'] / 1024**3:.2f} GiB" + (f" / 이번 회차 {growth / 1024**2:+.1f} MiB" if growth is not None else ' / 회차 증가량 미확인'),
            f"공용 디스크 여유 {result['free_bytes'] / 1024**3:.1f} GiB", '공개 데이터: ' + result.get('public_status', '미확인')]
    lines += ['https://news.bymyleslee.com/quality/']
    return '\n'.join(lines)


def main():
    os.umask(0o077)
    sys.dont_write_bytecode = True
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--credentials', type=Path, required=True)
    args = parser.parse_args()
    directory = args.base / 'state/daily-summary'
    if directory.is_symlink():
        raise ValueError('linked_summary_directory')
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        spec = importlib.util.spec_from_file_location('private_sender', args.base / 'bin/first-v2-collection-monitor.py')
        notify = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(notify)
        credentials = notify.load(args.credentials)
        if credentials.get('chat_type') != 'private' or not str(credentials.get('chat_id', '')).isdigit() or int(credentials['chat_id']) <= 0:
            raise ValueError('private_notification_target_required')
        state_path = directory / 'deliveries.json'
        state = notify.load(state_path) if state_path.exists() else {'sent': {}}
        now = datetime.now(timezone.utc)
        expected = expected_run(now)
        service = notify.service_state()
        status = stage(service, expected, notify.started_at)
        try:
            result = build_report(args.base, expected, service, status, notify.started_at, now)
            result['growth_bytes'] = matched_growth(args.base, result, notify.load)
            result['public_status'] = public_status(result)
        except Exception as error:
            result = {'day': expected.date().isoformat(), 'state': 'report_error', 'error_type': type(error).__name__}
        key = ':'.join([result['day'], result['state'], result.get('cycle_id', 'no-cycle')])
        if key in state['sent']:
            print(json.dumps({'daily_summary': 'already_delivered', 'day': result['day'], 'state': result['state']}))
            return
        notify.save(directory / 'latest.json', result)
        sent = notify.telegram(credentials, 'sendMessage', {'chat_id': credentials['chat_id'], 'text': message(result), 'link_preview_options': {'is_disabled': True}})
        state['sent'][key] = {'at': now.isoformat(), 'message_id': sent['message_id']}
        state['sent'] = dict(list(state['sent'].items())[-64:])
        notify.save(state_path, state)
        print(json.dumps({'daily_summary': 'delivered', 'day': result['day'], 'state': result['state'], 'message_id': sent['message_id']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'daily_summary': 'error', 'error_type': type(error).__name__}))
        raise SystemExit(1)
