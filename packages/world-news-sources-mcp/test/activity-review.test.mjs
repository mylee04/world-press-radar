import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ActivityLedger} from '../dist/activity-ledger.js';
import {ActivityStore} from '../dist/activity.js';
import {normalizeRegistry} from '../dist/catalog.js';

const raw={countries:[{code:'US',name:'United States',feeds:[{name:'Original',url:'https://publisher.example/feed'}]}]};
const catalog=normalizeRegistry(raw), source=catalog.sources[0], endpoint=source.endpoints[0];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'activity-semantic-review-'));const path=join(dir,'inspection.sqlite');const ledger=new ActivityLedger(path);ledger.syncRegistry(catalog,'2026-10-01T00:00:00.000Z');return{dir,path,ledger,close(){ledger.close();rmSync(dir,{recursive:true,force:true});}};}
const details=at=>({source_ids:[source.id],countries:['US'],source_new:{[source.id]:1},country_new:{US:1},baseline_sources:[],observed_urls:1,uncertain_urls:0,index_children_excluded:false});
function add(ledger,id,at,extra=''){ledger.db.prepare('INSERT INTO collections VALUES(?,?,?,?,?,?,?)').run(id,endpoint.id,at,'working_nonempty','rss',extra||null,JSON.stringify(details(at)));}

test('snapshot record limit does not invent truncation when exactly full; timestamp cohorts are indivisible',()=>{
  const f=fixture();try{
    add(f.ledger,'1','2026-10-01T00:00:00.000Z');add(f.ledger,'2','2026-10-02T00:00:00.000Z');
    const complete=f.ledger.snapshot(catalog,'2026-10-03T00:00:00.000Z',180,{maxRecords:2,maxBytes:100000});assert.equal(complete.snapshot_coverage.complete_stored_window,true);
    add(f.ledger,'3','2026-10-02T00:00:00.000Z');add(f.ledger,'4','2026-10-02T00:00:00.000Z');
    const truncated=f.ledger.snapshot(catalog,'2026-10-03T00:00:00.000Z',180,{maxRecords:2,maxBytes:100000});assert.equal(truncated.snapshot_coverage.complete_stored_window,false);assert.deepEqual(truncated.collections,[]);
    assert.equal(f.ledger.db.prepare('SELECT COUNT(*) n FROM collections').get().n,4);
  }finally{f.close();}
});
test('byte-bounded snapshot keeps latest complete timestamps and retained durable history; old tracked periods are unavailable, not zero',()=>{
  const f=fixture();try{
    f.ledger.db.prepare("INSERT INTO metadata VALUES('tracking_start','2026-10-01T00:00:00.000Z')").run();
    for(let i=0;i<100;i++)add(f.ledger,String(i),new Date(Date.parse('2026-10-01T00:00:00Z')+i*3600000).toISOString(),'X'.repeat(200));
    const snapshot=f.ledger.snapshot(catalog,'2026-10-06T00:00:00.000Z',180,{maxRecords:100,maxBytes:5000});assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=5000);assert.ok(snapshot.collections.length>0&&snapshot.collections.length<100);
    assert.equal(snapshot.collections.at(-1).id,'99');assert.equal(snapshot.snapshot_coverage.complete_stored_window,false);
    const answer=new ActivityStore(snapshot).query(catalog,'country',{country:'US',start_date:'2026-10-01',end_date:'2026-10-01'},Date.parse('2026-10-06T12:00:00Z'));
    assert.equal(answer.items[0].state,'history_not_in_snapshot');assert.equal(answer.items[0].new_unique_candidate_urls,null);assert.equal(f.ledger.db.prepare('SELECT COUNT(*) n FROM collections').get().n,100);
  }finally{f.close();}
});
test('spool reprocessing preserves source/country as observed despite registry deactivation and reassignment',()=>{
  const f=fixture();try{
    f.ledger.db.prepare("INSERT INTO metadata VALUES('lane','inspection')").run();f.ledger.close();
    const current={countries:[{code:'US',name:'United States',feeds:[{name:'Original',url:endpoint.url,enabled:false}]},{code:'GB',name:'United Kingdom',feeds:[{name:'New registration',url:endpoint.url}]}]};
    const registry=join(f.dir,'registry.json');writeFileSync(registry,JSON.stringify(current));mkdirSync(`${f.path}.spool`);
    const pending={id:'pending-provenance',endpoint,checked_at:'2026-10-01T00:00:00.000Z',status:'working_nonempty',format:'rss',reason:null,urls:['https://publisher.example/article/old'],traffic:'inspection',source_bindings:[{id:source.id,countryCode:'US'}]};
    writeFileSync(join(`${f.path}.spool`,'pending.json'),JSON.stringify(pending));
    const run=spawnSync(process.execPath,['scripts/collect-activity.mjs','--inspection','--export-only','--db',f.path,'--snapshot',join(f.dir,'snapshot.json')],{cwd:new URL('../',import.meta.url),env:{...process.env,WNS_REGISTRY_PATH:registry},encoding:'utf8'});assert.equal(run.status,0,run.stderr);
    const reopened=new ActivityLedger(f.path);const stored=JSON.parse(reopened.db.prepare('SELECT details FROM collections').get().details);
    assert.deepEqual(stored.source_ids,[source.id]);assert.deepEqual(stored.countries,['US']);assert.equal(reopened.db.prepare("SELECT COUNT(*) n FROM scope_urls WHERE scope_id='GB'").get().n,0);reopened.close();
    // close() below needs a live object; no persistent test data leaves this fixture.
    f.ledger=new ActivityLedger(f.path);
  }finally{try{f.ledger.close();}catch{}rmSync(f.dir,{recursive:true,force:true});}
});
test('uncommitted legacy spool without provenance stops for review instead of guessing new scope',()=>{
  const f=fixture();try{
    f.ledger.db.prepare("INSERT INTO metadata VALUES('lane','inspection')").run();f.ledger.close();mkdirSync(`${f.path}.spool`);
    writeFileSync(join(`${f.path}.spool`,'pending.json'),JSON.stringify({id:'legacy',endpoint,checked_at:'2026-10-01T00:00:00.000Z',status:'valid_empty',format:'rss',urls:[],reason:null,traffic:'inspection'}));
    const run=spawnSync(process.execPath,['scripts/collect-activity.mjs','--inspection','--export-only','--db',f.path,'--snapshot',join(f.dir,'snapshot.json')],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.notEqual(run.status,0);assert.match(run.stderr,/LEGACY_PENDING_PROVENANCE_UNKNOWN/);
    const reopened=new ActivityLedger(f.path);assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM collections').get().n,0);reopened.close();assert.ok(readFileSync(join(`${f.path}.spool`,'pending.json')).length);
  }finally{try{f.ledger.close();}catch{}rmSync(f.dir,{recursive:true,force:true});}
});
test('scope-local midnight and DST counts use event instants rather than UTC-day totals',()=>{
  const f=fixture();try{
    f.ledger.db.prepare("INSERT INTO metadata VALUES('tracking_start','2026-03-07T00:00:00.000Z')").run();
    for(const [id,at] of [['prior','2026-03-08T04:30:00.000Z'],['start','2026-03-08T05:30:00.000Z'],['after-jump','2026-03-08T07:30:00.000Z'],['next-day','2026-03-09T04:30:00.000Z']])add(f.ledger,id,at);
    const store=new ActivityStore(f.ledger.snapshot(catalog,'2026-03-10T00:00:00.000Z'));
    const answer=store.query(catalog,'country',{country:'US',start_date:'2026-03-08',end_date:'2026-03-08',timezone:'America/New_York'},Date.parse('2026-03-10T00:00:00Z'));
    assert.equal(answer.items[0].new_unique_candidate_urls,2);assert.equal(Date.parse(answer.items[0].to_exclusive)-Date.parse(answer.items[0].from),23*3600000);
  }finally{f.close();}
});
test('already committed legacy spool replays even without provenance and never recounts',()=>{
  const f=fixture();try{
    const now=new Date().toISOString();f.ledger.acquire('fixture',now,120);
    const value={id:'already-committed',endpoint,checked_at:'2026-10-01T00:00:00.000Z',status:'working_nonempty',format:'rss',reason:null,urls:['https://publisher.example/article/old'],traffic:'inspection'};
    f.ledger.commit(value,[source],'fixture',now);f.ledger.release('fixture');f.ledger.close();mkdirSync(`${f.path}.spool`);writeFileSync(join(`${f.path}.spool`,'old.json'),JSON.stringify(value));
    const run=spawnSync(process.execPath,['scripts/collect-activity.mjs','--inspection','--export-only','--db',f.path,'--snapshot',join(f.dir,'snapshot.json')],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.equal(run.status,0,run.stderr);
    const reopened=new ActivityLedger(f.path);assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM collections').get().n,1);assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM urls').get().n,1);reopened.close();assert.match(run.stdout,/"replayed":1/);
  }finally{try{f.ledger.close();}catch{}rmSync(f.dir,{recursive:true,force:true});}
});
test('oversized metadata refuses export clearly without deleting history',()=>{
  const f=fixture();try{add(f.ledger,'keep','2026-10-01T00:00:00.000Z');assert.throws(()=>f.ledger.snapshot(catalog,'2026-10-02T00:00:00.000Z',180,{maxBytes:100}),/SNAPSHOT_METADATA_SIZE_LIMIT/);assert.equal(f.ledger.db.prepare('SELECT COUNT(*) n FROM collections').get().n,1);}finally{f.close();}
});
