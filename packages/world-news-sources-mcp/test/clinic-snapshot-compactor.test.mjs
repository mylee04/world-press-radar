import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const path=fileURLToPath(new URL('../scripts/clinic-snapshot-compactor.py',import.meta.url));
const harness=String.raw`
import fcntl,gzip,hashlib,importlib.util,json,os,pathlib,sys,tempfile,time
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('compactor',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fixture(root):
    data=root/'data';data.mkdir()
    for name in m.FAMILIES:(data/name/'snapshots').mkdir(parents=True)
    (data/'.collection-worker.lock').write_text('original coordination file')
    (data/'original.sqlite3').write_bytes(b'original database sentinel')
    return data
def snapshot(data,body,old=True,family='opening-evidence'):
    path=data/family/'snapshots'/(hashlib.sha256(body).hexdigest()+'.html');path.write_bytes(body)
    if old:os.utime(path,(time.time()-7200,time.time()-7200))
    return path
def compact(path,**kwargs):
    raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=path.stem:raise ValueError('hash mismatch')
    target=path.with_name(path.name+'.gz');target.write_bytes(gzip.compress(raw,mtime=0))
    assert gzip.decompress(target.read_bytes())==raw
    reduction=max(0,path.stat().st_blocks*512-target.stat().st_blocks*512)
    path.unlink()
    return {'compressed':True,'original_sha_verified':True,'raw_bytes':len(raw),'stored_bytes':target.stat().st_size,'allocated_reduction_bytes':reduction}
exec(sys.argv[2])
`;
function run(code){const result=spawnSync('python3',['-c',harness,path,code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}

test('busy original collector lock prevents conversion without replacing the coordination inode',()=>{
  const r=run(String.raw`
with tempfile.TemporaryDirectory() as temporary:
    data=fixture(pathlib.Path(temporary).resolve());p=snapshot(data,b'old source document');lock=data/'.collection-worker.lock';before=lock.stat().st_ino
    with lock.open('r') as held:
        fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
        result=m.batch(data,compact,apply=True,readers_busy=False)
    print(json.dumps({'status':result['status'],'same_inode':lock.stat().st_ino==before,'source':p.read_text(),'database':(data/'original.sqlite3').read_text()}))
`);
  assert.deepEqual(r,{status:'collector_busy',same_inode:true,source:'old source document',database:'original database sentinel'});
});

test('only eligible old single-link hash HTML is converted and original data stays intact',()=>{
  const r=run(String.raw`
with tempfile.TemporaryDirectory() as temporary:
    root=pathlib.Path(temporary).resolve();data=fixture(root)
    source=snapshot(data,b'<html>retained raw source</html>'*30)
    fresh=snapshot(data,b'fresh source',False)
    hard=snapshot(data,b'hardlinked source');os.link(hard,root/'second-link')
    outside=root/'outside.html';outside.write_text('external original');linked=source.parent/('b'*64+'.html');linked.symlink_to(outside)
    huge=source.parent/('c'*64+'.html')
    with huge.open('wb') as f:f.truncate(m.MAX_FILE+1)
    os.utime(huge,(time.time()-7200,time.time()-7200))
    bad=source.parent/('d'*64+'.html');bad.write_text('incorrect hash');os.utime(bad,(time.time()-7200,time.time()-7200))
    unknown=source.parent/'manual-original.html';unknown.write_text('not in hash namespace')
    result=m.batch(data,compact,apply=True,readers_busy=False)
    print(json.dumps({'compressed':result['compressed'],'skipped':result['skipped'],'restored':gzip.decompress(source.with_name(source.name+'.gz').read_bytes()).decode(),'fresh':fresh.exists(),'hard':hard.exists(),'outside':outside.read_text(),'bad':bad.exists(),'unknown':unknown.exists(),'database':(data/'original.sqlite3').read_text()}))
`);
  assert.equal(r.compressed,1);assert.equal(r.skipped.linked_or_nonregular,2);assert.equal(r.skipped.recent,1);assert.equal(r.skipped.oversized,1);assert.equal(r.skipped.verification_or_io_error,1);
  assert.equal(r.restored,'<html>retained raw source</html>'.repeat(30));assert.equal(r.fresh,true);assert.equal(r.hard,true);assert.equal(r.outside,'external original');assert.equal(r.bad,true);assert.equal(r.unknown,true);assert.equal(r.database,'original database sentinel');
});

test('preview and raw-byte budget are bounded; later passes continue and do not recompact gzip',()=>{
  const r=run(String.raw`
with tempfile.TemporaryDirectory() as temporary:
    data=fixture(pathlib.Path(temporary).resolve());a=snapshot(data,b'a'*120);b=snapshot(data,b'b'*120)
    preview=m.batch(data,None,readers_busy=False)
    first=m.batch(data,compact,apply=True,max_raw_bytes=200,readers_busy=False)
    second=m.batch(data,compact,apply=True,max_raw_bytes=200,readers_busy=False)
    third=m.batch(data,compact,apply=True,max_raw_bytes=200,readers_busy=False)
    print(json.dumps({'preview':preview['eligible'],'passes':[first['compressed'],second['compressed'],third['compressed']],'bounded':first['bounded'],'attempted':first['attempted_raw_bytes'],'restored':[gzip.decompress(p.with_name(p.name+'.gz').read_bytes()).decode() for p in (a,b)]}))
`);
  assert.equal(r.preview,2);assert.deepEqual(r.passes,[1,1,0]);assert.equal(r.bounded,true);assert.equal(r.attempted,120);assert.deepEqual(r.restored,['a'.repeat(120),'b'.repeat(120)]);
});

test('linked roots and named legacy readers stop the batch without touching files',()=>{
  const r=run(String.raw`
with tempfile.TemporaryDirectory() as temporary:
    root=pathlib.Path(temporary).resolve();data=fixture(root);source=snapshot(data,b'old retained source')
    busy=m.batch(data,compact,apply=True,readers_busy=True)
    linked=root/'linked-data';linked.symlink_to(data,target_is_directory=True)
    unsafe=m.batch(linked,compact,apply=True,readers_busy=False)
    proc=root/'proc';(proc/'123').mkdir(parents=True);(proc/'123/cmdline').write_bytes(b'python3\0/srv/clinic/scripts/reindex-telegram-candidates.py\0')
    print(json.dumps({'busy':busy['status'],'unsafe':unsafe['status'],'guard':m.readers_running(proc),'source_exists':source.exists()}))
`);
  assert.deepEqual(r,{busy:'reader_busy',unsafe:'unsafe_data_root',guard:true,source_exists:true});
});

test('independent timer accepts only an inactive collector and fails closed on unavailable state',()=>{
  const r=run(String.raw`
import subprocess,types
seen=[]
def runner(state):
    def call(command,**kwargs):
        seen.append({'command':command,'timeout':kwargs['timeout']})
        if state=='unavailable':raise subprocess.TimeoutExpired(command,3)
        return types.SimpleNamespace(stdout=state+'\n')
    return call
print(json.dumps({'states':[m.collector_idle(runner(state)) for state in ['inactive','active','activating','deactivating','failed','unknown','unavailable']],'seen':seen}))
`);
  assert.deepEqual(r.states,[true,false,false,false,false,false,false]);
  assert.ok(r.seen.every(row=>row.timeout===3&&row.command.includes('clinic-signals-ru-monitor.service')));
});

test('after-collection flag bypasses only the unit-state guard and still invokes the locked batch',()=>{
  const r=run(String.raw`
import io
from contextlib import redirect_stdout
from unittest.mock import patch
with tempfile.TemporaryDirectory() as temporary:
    root=pathlib.Path(temporary).resolve();state=root/'state';library=root/'snapshot_store.py';library.write_text('def compact_snapshot(*a,**k):raise AssertionError("not executed")')
    report={'at':'2026-11-02T00:00:00Z','compressed':0,'raw_bytes':0,'stored_bytes':0,'allocated_reduction_bytes':0,'status':'collector_busy'}
    called=[]
    def locked_batch(data,compact,**kwargs):called.append(kwargs);return report
    normal=io.StringIO();hook=io.StringIO()
    with patch.object(m,'STATE',state),patch.object(m,'LIBRARY',library),patch.object(m,'collector_idle',return_value=False),patch.object(m,'batch',side_effect=AssertionError('Busy timer must not acquire batch lock')),patch.object(m.sys,'argv',['compactor','--apply']),redirect_stdout(normal):m.main()
    no_state=not state.exists()
    with patch.object(m,'STATE',state),patch.object(m,'LIBRARY',library),patch.object(m,'collector_idle',side_effect=AssertionError('Stop hook bypasses only unit guard')),patch.object(m,'batch',side_effect=locked_batch),patch.object(m.sys,'argv',['compactor','--apply','--after-collection']),redirect_stdout(hook):m.main()
    print(json.dumps({'normal':json.loads(normal.getvalue())['status'],'no_state':no_state,'called':called,'hook':json.loads(hook.getvalue())['status']}))
`);
  assert.deepEqual(r,{normal:'collector_busy',no_state:true,called:[{apply:true}],hook:'collector_busy'});
});
