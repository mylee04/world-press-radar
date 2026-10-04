import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyRecovery,recoveryPlan,parseRetryAfter} from '../dist/recovery-policy.js';
import {RecoveryStore} from '../dist/recovery-store.js';
import {ActivityLedger} from '../dist/activity-ledger.js';
import {normalizeRegistry} from '../dist/catalog.js';
const at='2026-10-10T03:00:00.000Z';
const catalog=normalizeRegistry({countries:[{code:'US',name:'USA',feeds:[{name:'A',url:'https://publisher.example/feed',sitemapUrl:'https://publisher.example/map'},{name:'B',url:'https://other.example/feed'}]}]});
const source=catalog.sources.find(x=>x.name==='A'),endpoint=source.endpoints[0];
const observation=(status,reason,auditStatus='http_error',extra={})=>({endpointId:endpoint.id,type:endpoint.type,url:endpoint.url,checkedAt:at,outcome:'unhealthy',httpStatus:status,reason,format:null,auditStatus,attempts:1,...extra});
function setup(t){const dir=mkdtempSync(join(tmpdir(),'recovery-fixture-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'ledger.sqlite');}
test('recorded HTTP and network diagnostics imply different actions; unknown errors do not become invented causes',()=>{
 for(const status of [401,403,402,451])assert.equal(classifyRecovery(observation(status,`HTTP_${status}`)).action,'review_official_alternative');
 for(const status of [404,410])assert.equal(classifyRecovery(observation(status,`HTTP_${status}`)).action,'review_relocation_or_removal');
 for(const status of [500,503,530])assert.equal(classifyRecovery(observation(status,`HTTP_${status}`)).action,'bounded_backoff');
 for(const reason of ['TIMEOUT','ECONNRESET','EAI_AGAIN'])assert.equal(classifyRecovery(observation(null,reason)).action,'bounded_backoff');
 assert.equal(classifyRecovery(observation(null,'ERR_TLS_CERT_ALTNAME_INVALID')).action,'review_dns_or_tls');
 assert.equal(classifyRecovery(observation(null,'NETWORK_OR_PARSE_ERROR','malformed')).category,'unresolved');
 assert.equal(classifyRecovery(observation(null,'WRONG_ENDPOINT_FORMAT','malformed')).category,'wrong_endpoint_format');
 assert.equal(classifyRecovery(observation(null,'INVALID_XML','malformed')).category,'document_validation');
 assert.equal(classifyRecovery(observation(null,'PARSER_STAGE_ERROR','malformed')).action,'investigate_parser_without_claiming_defect');
 const diagnostics={phase:'inspect',bodyKind:'html',contentType:'text/html',retryAfterAt:null};assert.equal(classifyRecovery(observation(200,'DTD_NOT_ALLOWED','malformed',{diagnostics})).category,'html_response');
});
test('Retry-After seconds and dates are validated; long valid waits are never shortened',()=>{
 const now=Date.parse(at);assert.equal(parseRetryAfter('120',now),'2026-10-10T03:02:00.000Z');
 assert.equal(parseRetryAfter('Sat, 10 Oct 2026 04:00:00 GMT',now),'2026-10-10T04:00:00.000Z');
 for(const v of ['secret-token','-10','Infinity','1e5','2026-10-11',[],null])assert.equal(parseRetryAfter(v,now),null);
 const diagnostics={phase:'fetch',bodyKind:'not_received',contentType:null,retryAfterAt:'2027-01-01T00:00:00.000Z'};
 assert.equal(recoveryPlan(observation(429,'HTTP_429','blocked',{diagnostics}),1).nextEligibleAt,diagnostics.retryAfterAt);
 assert.equal(recoveryPlan(observation(429,'HTTP_429','blocked'),1).nextEligibleAt,'2026-10-10T09:00:00.000Z');
});
test('transient attempts have exponential backoff capped at seven days; review pauses differ from healthy cadence',()=>{
 const o=observation(null,'TIMEOUT','timeout');assert.equal(recoveryPlan(o,1).nextEligibleAt,'2026-10-10T05:00:00.000Z');assert.equal(recoveryPlan(o,2).nextEligibleAt,'2026-10-10T07:00:00.000Z');assert.equal(recoveryPlan(o,999).nextEligibleAt,'2026-10-17T03:00:00.000Z');
 assert.equal(recoveryPlan(observation(403,'HTTP_403','blocked'),1).nextEligibleAt,'2026-10-17T03:00:00.000Z');
 assert.equal(recoveryPlan(observation(200,null,'working_nonempty',{format:'rss'}),9).nextEligibleAt,'2026-10-11T00:00:00.000Z');
 assert.equal(recoveryPlan(observation(200,null,'working_nonempty',{format:'sitemapindex'}),9).nextEligibleAt,'2026-10-17T00:00:00.000Z');
});
test('429 cooldown is durable across jobs, covers original and redirect hosts, and idempotent events preserve counts',t=>{
 const path=setup(t);let s=new RecoveryStore(path);const diagnostics={phase:'fetch',bodyKind:'not_received',contentType:null,retryAfterAt:'2026-10-10T04:00:00.000Z',requestHost:'cdn.example'};
 const o=observation(429,'HTTP_429','blocked',{diagnostics,finalUrl:'https://cdn.example/feed'});const result=s.record(endpoint,o,'event-1');assert.equal(result.failedChecks,1);assert.deepEqual(s.record(endpoint,o,'event-1'),result);s.close();s=new RecoveryStore(path);
 assert.equal(s.state(endpoint.id).failedChecks,1);assert.equal(s.state(endpoint.id).attempts,1);
 for(const host of ['publisher.example','cdn.example'])assert.throws(()=>s.guardHost(host,at),/HOST_COOLDOWN/);
 assert.equal(s.eligible(source.endpoints[1],at).eligible,false);assert.equal(s.eligible(catalog.sources.find(x=>x.name==='B').endpoints[0],at).eligible,true);s.close();
});
test('governor checks cooldown again after acquiring host slot and releases it on a race',async t=>{
 const s=new RecoveryStore(setup(t));let released=0;const gate=s.gate(async host=>{s.db.prepare('INSERT INTO host_cooldowns VALUES(?,?,?)').run(host,'2099-01-01T00:00:00.000Z','rate_limited');return()=>released++;});await assert.rejects(gate('publisher.example',Date.now()+1000),/HOST_COOLDOWN/);assert.equal(released,1);s.close();
});
test('recovery state and URL baseline commit atomically; replay never counts new URLs or resets recovery',t=>{
 const ledger=new ActivityLedger(setup(t));ledger.acquire('writer',at,3600);ledger.syncRegistry(catalog,at);const collection={id:'first',endpoint,checked_at:at,status:'working_nonempty',format:'rss',reason:null,traffic:'production',urls:['https://publisher.example/article/old'],http_status:200,attempts:1};
 const first=ledger.commit(collection,[source],'writer',at);assert.equal(first.source_new[source.id],0);assert.equal(first.recovery.category,'healthy');assert.equal(ledger.db.prepare('select count(*) n from recovery_events').get().n,1);assert.equal(ledger.commit(collection,[source],'writer',at).replayed,true);assert.equal(ledger.db.prepare('select count(*) n from recovery_events').get().n,1);
 const failure={...collection,id:'restricted',checked_at:'2026-10-10T03:01:00.000Z',status:'blocked',reason:'HTTP_403',http_status:403,urls:[]};ledger.commit(failure,[source],'writer',at);assert.equal(ledger.db.prepare('select baseline_at from bindings where source_id=? and endpoint_id=?').get(source.id,endpoint.id).baseline_at,at);assert.equal(ledger.db.prepare('select enabled from registry where source_id=? and endpoint_id=?').get(source.id,endpoint.id).enabled,1);assert.equal(ledger.recovery.state(endpoint.id).review,true);
 ledger.db.exec("CREATE TRIGGER reject_collection BEFORE INSERT ON collections WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");assert.throws(()=>ledger.commit({...failure,id:'rollback',checked_at:'2026-10-10T03:02:00.000Z'},[source],'writer',at),/fixture failure/);assert.equal(ledger.db.prepare('select count(*) n from recovery_events').get().n,2);ledger.close();
});
test('legacy seeding is additive, preserves unknown retry/header details, and never fabricates a new check',t=>{
 const l=new ActivityLedger(setup(t));l.syncRegistry(catalog,at);l.db.prepare('INSERT INTO collections VALUES(?,?,?,?,?,?,?)').run('legacy',endpoint.id,at,'blocked',null,'HTTP_429',JSON.stringify({source_ids:[source.id],source_new:{[source.id]:0}}));const old=l.db.prepare('select * from collections').all();l.recovery.seedFromLedger(catalog);l.recovery.seedFromLedger(catalog);assert.deepEqual(l.db.prepare('select * from collections').all(),old);assert.equal(l.db.prepare('select count(*) n from recovery_events').get().n,1);assert.equal(l.recovery.state(endpoint.id).http_status,429);assert.equal(l.recovery.state(endpoint.id).diagnostics,null);assert.equal(l.recovery.state(endpoint.id).attempts,null);assert.equal(l.db.prepare('select baseline_at from bindings where source_id=? and endpoint_id=?').get(source.id,endpoint.id).baseline_at,null);l.close();
});
test('weekly health ignores normal activity cadence but respects recovery and host pauses',t=>{
 const s=new RecoveryStore(setup(t));s.record(endpoint,observation(200,null,'working_nonempty',{format:'rss'}),'healthy');assert.equal(s.eligible(endpoint,at).eligible,false);assert.equal(s.eligible(endpoint,at,'health').eligible,true);
 s.record(endpoint,observation(404,'HTTP_404'),'missing');assert.equal(s.eligible(endpoint,at,'health').eligible,false);s.close();
});
test('weekly attempts share the durable daily request budget and cannot exceed it',t=>{
 const l=new ActivityLedger(setup(t));l.reserveRequest(at,2);l.recovery.reserveRequest(at,2);assert.throws(()=>l.recovery.reserveRequest(at,2),/DAILY_REQUEST_BUDGET_EXHAUSTED/);assert.equal(l.db.prepare('select requests from request_budget').get().requests,2);l.close();
});
test('host cooldown matches literal IPv6 gate keys and trailing-dot DNS aliases',t=>{
 const s=new RecoveryStore(setup(t)),e={...endpoint,url:'https://[2606:4700:4700::1111]/rss'};s.record(e,observation(429,'HTTP_429','blocked'),'ipv6');assert.throws(()=>s.guardHost('2606:4700:4700::1111',at),/HOST_COOLDOWN/);s.record({...endpoint,url:'https://publisher.example./rss'},observation(403,'HTTP_403','blocked'),'dot');assert.throws(()=>s.guardHost('publisher.example',at),/HOST_COOLDOWN/);s.close();
});
