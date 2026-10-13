import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync,utimesSync,unlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {encodeHistory,decodeHistory,HistoryArchiveCache} from '../dist/activity-history.js';

const events=(month='2026-10')=>[
  {endpoint_id:'a',checked_at:`${month}-01T00:00:00.000Z`,status:'working_nonempty',format:'rss',uncertain_urls:0,baseline_sources:['s1'],source_new:{s1:0},country_new:{US:0}},
  {endpoint_id:'a',checked_at:`${month}-02T00:00:00.000Z`,status:'working_nonempty',format:'rss',uncertain_urls:0,baseline_sources:[],source_new:{s1:3,s2:2},country_new:{US:3,CA:2}},
  {endpoint_id:'b',checked_at:`${month}-03T00:00:00.000Z`,status:'timeout',format:null,uncertain_urls:0,baseline_sources:[],source_new:{s3:0},country_new:{JP:0}},
];
function fixture(t,months=['2026-10']){
  const directory=mkdtempSync(join(tmpdir(),'wns-history-cache-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const shards=months.map(month=>{const bytes=encodeHistory(events(month)),sha256=createHash('sha256').update(bytes).digest('hex'),descriptor={month,file:`${month}-${sha256}.json.gz`,sha256,bytes:bytes.length,records:3},path=join(directory,descriptor.file);writeFileSync(path,bytes);return{descriptor,path,bytes};});
  return{directory,shards};
}
test('cache cold/warm rows and scope/time filters exactly match verified decoder; returned archive rows immutable',t=>{
  const {directory,shards:[shard]}=fixture(t),cache=new HistoryArchiveCache();
  const expected=decodeHistory(shard.bytes,shard.descriptor),cold=cache.read(directory,shard.descriptor),warm=cache.read(directory,shard.descriptor);
  assert.deepEqual(cold,expected);assert.deepEqual(warm,expected);assert.equal(cold[0],warm[0]);assert.notEqual(cold,warm);
  for(const filter of [{kind:'country',scope:'US',from:Date.parse('2026-10-02'),to:Date.parse('2026-10-03')},{kind:'source',scope:'s2',from:Date.parse('2026-10-01'),to:Date.parse('2026-10-04')},{kind:'country',scope:'missing',from:0,to:Date.now()}])assert.deepEqual(cache.read(directory,shard.descriptor,filter),decodeHistory(shard.bytes,shard.descriptor,filter));
  assert.throws(()=>{warm[1].country_new.US=999;},TypeError);assert.throws(()=>warm[1].countries.push('KR'),TypeError);assert.equal(cache.read(directory,shard.descriptor)[1].country_new.US,3);assert.deepEqual(cache.stats().records,3);
});
test('warm hit never hides same-size corruption even when original mtime is restored',t=>{
  const {directory,shards:[shard]}=fixture(t),cache=new HistoryArchiveCache();cache.read(directory,shard.descriptor);
  const original=statSync(shard.path),bad=Buffer.from(shard.bytes);bad[bad.length-2]^=1;writeFileSync(shard.path,bad);utimesSync(shard.path,original.atime,original.mtime);
  assert.throws(()=>cache.read(directory,shard.descriptor),/ACTIVITY_HISTORY_INTEGRITY/);assert.equal(cache.stats().entries,0);
});
test('warm hit detects atomic replacement and missing archives; restoring correct bytes revalidates',t=>{
  const {directory,shards:[shard]}=fixture(t),cache=new HistoryArchiveCache();cache.read(directory,shard.descriptor);
  const bad=Buffer.from(shard.bytes);bad[0]^=1;writeFileSync(`${shard.path}.tmp`,bad);renameSync(`${shard.path}.tmp`,shard.path);
  assert.throws(()=>cache.read(directory,shard.descriptor),/ACTIVITY_HISTORY_INTEGRITY/);
  writeFileSync(shard.path,shard.bytes);assert.equal(cache.read(directory,shard.descriptor).length,3);
  unlinkSync(shard.path);assert.throws(()=>cache.read(directory,shard.descriptor),/ACTIVITY_HISTORY_READ_FAILURE/);
});
test('cached checksum cannot bypass changed descriptor counts, byte length or month/path validation',t=>{
  const {directory,shards:[shard]}=fixture(t),cache=new HistoryArchiveCache();cache.read(directory,shard.descriptor);
  assert.throws(()=>cache.read(directory,{...shard.descriptor,records:2}),/ACTIVITY_HISTORY_SCHEMA/);
  assert.throws(()=>cache.read(directory,{...shard.descriptor,bytes:shard.descriptor.bytes+1}),/ACTIVITY_HISTORY_INTEGRITY/);
  assert.throws(()=>cache.read(directory,{...shard.descriptor,file:'../../anything'}),/ACTIVITY_HISTORY_MANIFEST/);
});
test('cache LRU and record/serialized-byte budgets bound retention without making valid records disappear',t=>{
  const {directory,shards}=fixture(t,['2026-08','2026-09','2026-10']),cache=new HistoryArchiveCache({maxEntries:2,maxRecords:6,maxBytes:1000000});
  for(const shard of shards)assert.equal(cache.read(directory,shard.descriptor).length,3);
  assert.deepEqual({entries:cache.stats().entries,records:cache.stats().records},{entries:2,records:6});
  for(const limits of [{maxEntries:0,maxRecords:100,maxBytes:1000000},{maxEntries:3,maxRecords:2,maxBytes:1000000},{maxEntries:3,maxRecords:100,maxBytes:1}]){
    const bounded=new HistoryArchiveCache(limits);assert.equal(bounded.read(directory,shards[0].descriptor).length,3);assert.equal(bounded.stats().entries,0);
  }
});
