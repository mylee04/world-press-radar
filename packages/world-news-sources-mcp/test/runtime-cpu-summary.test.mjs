import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const path=fileURLToPath(new URL('../scripts/runtime-cpu-summary.py',import.meta.url));
const harness=String.raw`
import copy, importlib.util, io, json, pathlib, sys, tempfile, urllib.request
from contextlib import redirect_stdout
from unittest.mock import patch
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('runtime_cpu',sys.argv[1])
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
def row(traffic='unclassified',route='mcp',outcome='success',revision='runtime-cpu-v1',eligible_calls=40,overlap_calls=2,cpu_us=40000,wall_ms=200):
    return dict(traffic=traffic,route=route,outcome=outcome,revision=revision,eligible_calls=eligible_calls,overlap_calls=overlap_calls,cpu_us=cpu_us,wall_ms=wall_ms)
def document(rows=None,day='2026-11-02',state='observed'):
    return dict(version=1,day=day,runtime_cpu=dict(version=1,measurement=helper.MEASUREMENT,state=state,rows=rows if rows is not None else [row(),row(traffic='inspection',cpu_us=800000)]))
with patch.object(urllib.request,'urlopen',side_effect=AssertionError('Live requests forbidden')):
    exec(sys.argv[2])
`;
function run(code){const result=spawnSync('python3',['-c',harness,path,code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}

test('CPU report separates inspection and unknown actors without claiming billing CPU or users',()=>{
  const result=run(String.raw`r=helper.parse_report(document(),'2026-11-02');print(json.dumps({'report':r,'message':helper.message(r)}))`);
  assert.match(result.message,/주체 미확인: 단독 측정 40건, 동시 실행 제외 2건/);
  assert.match(result.message,/관측 CPU 합계 0\.040초, 평균 1\.00 ms\/건/);
  assert.match(result.message,/점검 표시: 단독 측정 40건/);
  assert.match(result.message,/평균 20\.00 ms\/건/);
  assert.match(result.message,/Vercel 청구용 Active CPU와 별도 지표/);
  assert.match(result.message,/비교 기준 또는 표본 부족: CPU 절감 여부 미확인/);
  assert.match(result.message,/초기 모듈 로딩, 응답 스트리밍과 계측 전송 CPU는 제외/);
  assert.match(result.message,/자체·자동 호출도 섞일/);
  assert.ok(!result.message.includes(String.fromCodePoint(0x2014)));
});

test('unobserved, zero measured CPU and all-overlap observations remain distinct',()=>{
  const result=run(String.raw`
unknown=helper.parse_report(document([],state='unobserved'),'2026-11-02')
zero=helper.parse_report(document([row(cpu_us=0)]),'2026-11-02')
overlap=helper.parse_report(document([row(eligible_calls=0,cpu_us=0,wall_ms=0,overlap_calls=15)]),'2026-11-02')
print(json.dumps({k:helper.message(v) for k,v in [('unknown',unknown),('zero',zero),('overlap',overlap)]}))
`);
  assert.match(result.unknown,/저장된 계측 관측 없음/);
  assert.doesNotMatch(result.unknown,/합계 0\.000초/);
  assert.match(result.zero,/합계 0\.000초, 평균 0\.00 ms\/건/);
  assert.match(result.overlap,/단독 측정 0건, 동시 실행 제외 15건/);
  assert.match(result.overlap,/평균 CPU 미확인/);
});

test('daily comparison normalizes matching route and outcome mix and requires sufficient prior-day samples',()=>{
  const result=run(String.raw`
prior=helper.parse_report(document([row(eligible_calls=100,cpu_us=1000000),row(route='health',eligible_calls=900,cpu_us=900000)],day='2026-11-01'),'2026-11-01')
current=helper.parse_report(document([row(eligible_calls=900,cpu_us=4500000),row(route='health',eligible_calls=100,cpu_us=50000)]),'2026-11-02')
few=copy.deepcopy(current);few['rows']=[row(eligible_calls=29,cpu_us=29000)]
old=copy.deepcopy(prior);old['day']='2026-10-31'
print(json.dumps({'comparison':helper.comparison(current,prior),'few':helper.comparison(few,prior),'old':helper.comparison(current,old),'message':helper.message(current,prior)}))
`);
  assert.equal(result.comparison.change_percent,-50);
  assert.equal(result.comparison.previous_ms,9.1);
  assert.equal(result.comparison.current_ms,4.55);
  assert.equal(result.comparison.current_calls,1000);
  assert.equal(result.few,null);
  assert.equal(result.old,null);
  assert.match(result.message,/HTTP 응답 상태별 보정 9\.10 → 4\.55 ms\/건 \(-50\.0%/);
  assert.match(result.message,/최적화의 인과 효과로 확정하지 않습니다/);
});

test('report fetch is bounded, authenticated, read-only and masks malformed or missing CPU observations',()=>{
  const result=run(String.raw`
token='test-read-scope-secret-12345678901234567890';credentials={'url':helper.USAGE_URL,'token':token};seen={}
def fake(request,timeout):
    seen.update(url=request.full_url,method=request.get_method(),timeout=timeout,auth_ok=request.get_header('Authorization')=='Bearer '+token)
    return io.BytesIO(json.dumps(document()).encode())
valid=helper.fetch_report(credentials,'2026-11-02',opener=fake)
reports=[]
for modify in [lambda d:d.pop('runtime_cpu'),lambda d:d['runtime_cpu']['rows'][0].update(cpu_us=True),lambda d:d['runtime_cpu']['rows'].append(copy.deepcopy(d['runtime_cpu']['rows'][0])),lambda d:d['runtime_cpu']['rows'][0].update(eligible_calls=0),lambda d:d['runtime_cpu'].update(rows=[row()]*97),lambda d:d['runtime_cpu']['rows'][0].update(route='/private-path')]:
    value=document();modify(value)
    reports.append(helper.fetch_report(credentials,'2026-11-02',opener=lambda *a,**k:io.BytesIO(json.dumps(value).encode())))
reports.append(helper.fetch_report(credentials,'2026-11-02',opener=lambda *a,**k:io.BytesIO(b' '*65537)))
outside=[];reports.append(helper.fetch_report({'url':'https://other.example/','token':token},'2026-11-02',opener=lambda *a,**k:outside.append(1)))
print(json.dumps({'seen':seen,'valid':valid,'states':[r['state'] for r in reports],'leaks_secret':token in json.dumps(reports),'outside':outside,'redirect':helper.NoRedirect().redirect_request(None,None,302,'',{},'https://other.example/')}))
`);
  assert.equal(result.seen.method,'GET');
  assert.equal(result.seen.url,'https://world-news-sources-metrics.mylee.workers.dev/v1/daily-report?day=2026-11-02');
  assert.equal(result.seen.auth_ok,true);
  assert.equal(result.seen.timeout,12);
  assert.equal(result.valid.state,'observed');
  assert.deepEqual(result.states,Array(8).fill('unavailable'));
  assert.equal(result.leaks_secret,false);
  assert.deepEqual(result.outside,[]);
  assert.equal(result.redirect,null);
});

test('delivery intent avoids duplicate Telegram sends after success or ambiguous timeout and history is bounded',()=>{
  const result=run(String.raw`
sender=r'''import json
from pathlib import Path
def load(p):return json.loads(p.read_text())
def save(p,v):p.write_text(json.dumps(v))
def telegram(c,m,b):
    p=Path(c['counter']);n=int(p.read_text()) if p.exists() else 0;p.write_text(str(n+1))
    if c.get('fail'):raise RuntimeError('ambiguous timeout')
    return {'message_id':99}
'''
out=[]
for fail in [False,True]:
    with tempfile.TemporaryDirectory() as temporary:
        base=pathlib.Path(temporary);(base/'bin').mkdir();(base/'bin/first-v2-collection-monitor.py').write_text(sender)
        cred=base/'telegram.json';cred.write_text(json.dumps({'chat_type':'private','chat_id':'123','counter':str(base/'counter'),'fail':fail}))
        usage=base/'usage.json';usage.write_text('{}')
        day=(helper.datetime.now(helper.timezone.utc).date()-helper.timedelta(days=1)).isoformat()
        observed=helper.parse_report(document(day=day),day)
        directory=base/'state/runtime-cpu-summary';directory.mkdir(parents=True)
        old_days={(helper.date.fromisoformat(day)-helper.timedelta(days=i)).isoformat():{'state':'unobserved','day':(helper.date.fromisoformat(day)-helper.timedelta(days=i)).isoformat(),'rows':[]} for i in list(range(1,15))+list(range(60,76))}
        (directory/'history.json').write_text(json.dumps({'days':old_days}))
        with patch.object(helper.sys,'argv',['summary','--base',str(base),'--credentials',str(cred),'--usage-credentials',str(usage)]),patch.object(helper,'fetch_report',return_value=observed),redirect_stdout(io.StringIO()):
            try:helper.main()
            except RuntimeError:pass
            helper.main()
        delivery=json.loads((directory/'deliveries.json').read_text())['days'][day]
        out.append({'sends':int((base/'counter').read_text()),'delivery':delivery['status'],'history_days':len(json.loads((directory/'history.json').read_text())['days'])})
print(json.dumps(out))
`);
  assert.deepEqual(result,[{sends:1,delivery:'delivered',history_days:15},{sends:1,delivery:'delivery_intent',history_days:15}]);
});

test('activation guard skips earlier closed days before reading credentials, state or network',()=>{
  const result=run(String.raw`
with tempfile.TemporaryDirectory() as temporary:
    parent=pathlib.Path(temporary);base=parent/'not-created'
    today=helper.datetime.now(helper.timezone.utc).date()
    output=io.StringIO()
    arguments=['summary','--base',str(base),'--credentials',str(parent/'absent-private-credentials'),'--usage-credentials',str(parent/'absent-usage-credentials'),'--not-before',today.isoformat()]
    with patch.object(helper.sys,'argv',arguments),patch.object(helper,'fetch_report',side_effect=AssertionError('No network before activation')),redirect_stdout(output):
        helper.main()
    print(json.dumps({'result':json.loads(output.getvalue()),'files':list(parent.iterdir()),'expected_day':(today-helper.timedelta(days=1)).isoformat()}))
`);
  assert.equal(result.result.runtime_cpu_summary,'skipped_before_activation');
  assert.equal(result.result.day,result.expected_day);
  assert.deepEqual(result.files,[]);
});
