#!/usr/bin/env python3
"""Report bounded application CPU observations without collecting news or billing data."""
import argparse
from datetime import date, datetime, timedelta, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
USAGE_URL = 'https://world-news-sources-metrics.mylee.workers.dev/v1/daily-report'
MEASUREMENT = 'isolated_process_cpu_v1'
ROUTES = {'mcp', 'web_export', 'source_packs', 'health', 'quality', 'other'}
COUNTS = {'eligible_calls': 10**10, 'overlap_calls': 10**10, 'cpu_us': 10**15, 'wall_ms': 10**15}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def parse_report(data, day):
    if not isinstance(data, dict) or data.get('version') != 1 or data.get('day') != day:
        raise ValueError('invalid_daily_report')
    cpu = data.get('runtime_cpu')
    if not isinstance(cpu, dict) or cpu.get('version') != 1 or cpu.get('measurement') != MEASUREMENT:
        raise ValueError('runtime_cpu_contract_unavailable')
    rows = cpu.get('rows')
    if cpu.get('state') not in ('observed', 'unobserved') or not isinstance(rows, list) or len(rows) > 96:
        raise ValueError('invalid_runtime_cpu_report')
    if (cpu['state'] == 'observed') != bool(rows):
        raise ValueError('inconsistent_runtime_cpu_state')
    cleaned, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('invalid_runtime_cpu_row')
        group = tuple(row.get(key) for key in ('traffic', 'route', 'outcome', 'revision'))
        if (group[0] not in ('inspection', 'unclassified') or group[1] not in ROUTES
                or group[2] not in ('success', 'error') or not isinstance(group[3], str)
                or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', group[3]) or group in seen):
            raise ValueError('invalid_runtime_cpu_group')
        seen.add(group)
        values = {key: row.get(key) for key in COUNTS}
        if any(type(value) is not int or not 0 <= value <= COUNTS[key] for key, value in values.items()):
            raise ValueError('invalid_runtime_cpu_count')
        if not values['eligible_calls'] and (values['cpu_us'] or values['wall_ms']):
            raise ValueError('cpu_without_eligible_calls')
        cleaned.append(dict(zip(('traffic', 'route', 'outcome', 'revision'), group), **values))
    return {'day': day, 'state': cpu['state'], 'measurement': MEASUREMENT, 'rows': cleaned}


def fetch_report(credentials, day, opener=None):
    try:
        token = credentials.get('token')
        if (credentials.get('url') != USAGE_URL or not isinstance(token, str)
                or not 32 <= len(token) <= 256 or any(c.isspace() for c in token)):
            raise ValueError('invalid_report_credentials')
        request = urllib.request.Request(USAGE_URL + '?' + urllib.parse.urlencode({'day': day}),
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json',
                'User-Agent': 'WorldNewsSources-RuntimeCpuSummary/1.0'})
        open_report = opener or urllib.request.build_opener(NoRedirect()).open
        with open_report(request, timeout=12) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError('oversized_runtime_cpu_response')
        return parse_report(json.loads(raw), day)
    except Exception as error:
        return {'day': day, 'state': 'unavailable', 'measurement': MEASUREMENT, 'error_type': type(error).__name__}


def totals(report, traffic):
    rows = [row for row in report.get('rows', []) if row['traffic'] == traffic]
    return {name: sum(row[name] for row in rows) for name in COUNTS}


def comparison(report, previous):
    """Compare matching route/outcome groups using the current day's workload weights."""
    if not previous or report['state'] != 'observed' or previous['state'] != 'observed':
        return None
    if date.fromisoformat(previous['day']) + timedelta(days=1) != date.fromisoformat(report['day']):
        return None
    def groups(value):
        result = {}
        for row in value['rows']:
            if row['traffic'] == 'unclassified':
                group = result.setdefault((row['route'], row['outcome']), {'calls': 0, 'cpu_us': 0})
                group['calls'] += row['eligible_calls']
                group['cpu_us'] += row['cpu_us']
        return result
    current, prior = groups(report), groups(previous)
    common = [key for key in current.keys() & prior.keys() if min(current[key]['calls'], prior[key]['calls']) >= 10]
    calls = sum(current[key]['calls'] for key in common)
    if calls < 30 or sum(prior[key]['calls'] for key in common) < 30:
        return None
    current_ms = sum(current[key]['cpu_us'] for key in common) / calls / 1000
    previous_ms = sum(prior[key]['cpu_us'] / prior[key]['calls'] * current[key]['calls'] for key in common) / calls / 1000
    if not previous_ms:
        return None
    return {'groups': len(common), 'current_calls': calls, 'current_ms': current_ms, 'previous_ms': previous_ms,
        'change_percent': (current_ms / previous_ms - 1) * 100}


def message(report, previous=None):
    lines = ['World Press Radar 앱 CPU 보조 계측', f"관측: UTC {report['day']} 하루", 'Vercel 청구용 Active CPU와 별도 지표입니다.']
    if report['state'] == 'unavailable':
        lines.append('계측 보고서 조회 실패: CPU와 절감 여부 미확인')
    elif report['state'] == 'unobserved':
        lines.append('저장된 계측 관측 없음. CPU 사용량 0 또는 절감으로 해석하지 않습니다.')
    else:
        for traffic, label in [('unclassified', '주체 미확인'), ('inspection', '점검 표시')]:
            rows = [row for row in report['rows'] if row['traffic'] == traffic]
            if not rows:
                lines.append(label + ': 관측 없음')
                continue
            count = totals(report, traffic)
            average = f"{count['cpu_us'] / count['eligible_calls'] / 1000:.2f} ms/건" if count['eligible_calls'] else '미확인'
            lines.append(f"{label}: 단독 측정 {count['eligible_calls']:,}건, 동시 실행 제외 {count['overlap_calls']:,}건")
            if count['eligible_calls']:
                lines.append(f"  관측 CPU 합계 {count['cpu_us'] / 1_000_000:.3f}초, 평균 {average}")
            else:
                lines.append('  평균 CPU 미확인')
        change = comparison(report, previous)
        if change:
            lines.append(f"주체 미확인 전일 추이: 동일 경로·HTTP 응답 상태별 보정 {change['previous_ms']:.2f} → {change['current_ms']:.2f} ms/건 ({change['change_percent']:+.1f}%, 공통 {change['groups']}그룹·오늘 {change['current_calls']:,}건)")
            lines.append('버전·입력·호출 구성의 차이가 있어 최적화의 인과 효과로 확정하지 않습니다.')
        else:
            lines.append('비교 기준 또는 표본 부족: CPU 절감 여부 미확인')
        revisions = sorted({row['revision'] for row in report['rows']})
        lines.append('관측 코드: ' + ', '.join(revisions[:4]) + (' 외' if len(revisions) > 4 else ''))
    lines.extend(['응답 분류는 HTTP 상태 기준이며 MCP 도구 결과 성공률과 다릅니다.',
        '동시 실행 구간, 초기 모듈 로딩, 응답 스트리밍과 계측 전송 CPU는 제외됩니다. 활성화 이전이나 전송 실패로 누락된 호출도 있어 전체 함수 사용량보다 작은 관측입니다.',
        'CPU는 네트워크 대기 포함 처리 시간과 다릅니다. 주체 미확인에는 자체·자동 호출도 섞일 수 있습니다.'])
    return '\n'.join(lines)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--credentials', type=Path, required=True)
    parser.add_argument('--usage-credentials', type=Path, required=True)
    parser.add_argument('--day', help='A completed UTC day within the retained 30-day range')
    parser.add_argument('--not-before', help='First UTC observation day to report (YYYY-MM-DD)')
    parser.add_argument('--dry-run', action='store_true', help='Read and format without saving or sending')
    args = parser.parse_args()
    today = datetime.now(timezone.utc).date()
    cutoff = (today - timedelta(days=30)).isoformat()
    day = date.fromisoformat(args.day) if args.day else today - timedelta(days=1)
    if not today - timedelta(days=30) <= day < today:
        raise ValueError('closed_utc_day_required')
    if args.not_before:
        activation = date.fromisoformat(args.not_before)
        if day < activation:
            print(json.dumps({'runtime_cpu_summary': 'skipped_before_activation', 'day': day.isoformat(), 'not_before': activation.isoformat()}))
            return
    spec = importlib.util.spec_from_file_location('private_sender', args.base / 'bin/first-v2-collection-monitor.py')
    notify = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notify)
    credentials = notify.load(args.credentials)
    if credentials.get('chat_type') != 'private' or not str(credentials.get('chat_id', '')).isdigit() or int(credentials['chat_id']) <= 0:
        raise ValueError('private_notification_target_required')
    directory = args.base / 'state/runtime-cpu-summary'
    if directory.is_symlink():
        raise ValueError('linked_runtime_cpu_directory')
    if args.dry_run:
        report = fetch_report(notify.load(args.usage_credentials), day.isoformat())
        print(json.dumps({'report': report, 'message': message(report)}, ensure_ascii=False))
        return
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = directory / 'deliveries.json'
        state = notify.load(state_path) if state_path.exists() else {'days': {}}
        if day.isoformat() in state['days']:
            print(json.dumps({'runtime_cpu_summary': 'already_attempted', 'day': day.isoformat()}))
            return
        history_path = directory / 'history.json'
        history = notify.load(history_path) if history_path.exists() else {'days': {}}
        report = fetch_report(notify.load(args.usage_credentials), day.isoformat())
        previous = history['days'].get((day - timedelta(days=1)).isoformat())
        text = message(report, previous)
        if len(text) > 3900:
            raise ValueError('runtime_cpu_message_too_long')
        if report['state'] != 'unavailable':
            history['days'][day.isoformat()] = report
        history['days'] = {key: value for key, value in sorted(history['days'].items()) if cutoff <= key < today.isoformat()}
        notify.save(history_path, history)
        notify.save(directory / 'latest.json', report)
        # Save intent before sending. An ambiguous timeout must not send a second copy.
        state['days'][day.isoformat()] = {'status': 'delivery_intent', 'at': datetime.now(timezone.utc).isoformat(),
            'message_sha256': hashlib.sha256(text.encode()).hexdigest()}
        state['days'] = {key: value for key, value in sorted(state['days'].items()) if cutoff <= key < today.isoformat()}
        notify.save(state_path, state)
        sent = notify.telegram(credentials, 'sendMessage', {'chat_id': credentials['chat_id'], 'text': text,
            'link_preview_options': {'is_disabled': True}})
        state['days'][day.isoformat()].update({'status': 'delivered', 'message_id': sent['message_id']})
        notify.save(state_path, state)
        print(json.dumps({'runtime_cpu_summary': 'delivered', 'day': day.isoformat(), 'state': report['state'], 'message_id': sent['message_id']}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'runtime_cpu_summary': 'error', 'error_type': type(error).__name__}))
        raise SystemExit(1)
