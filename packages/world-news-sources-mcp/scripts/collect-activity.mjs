import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync, chmodSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadData } from '../dist/config.js';
import { ActivityLedger, collectionId } from '../dist/activity-ledger.js';
import { auditEndpoint, isTransient } from '../dist/audit-check.js';
import { createHostGate } from '../dist/host-gate.js';
import { collectionConcurrency, collectionNextDue } from '../dist/collection-schedule.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const pos = args.indexOf(name); return pos < 0 ? fallback : args[pos + 1]; };
const allowed = new Set(['--db','--snapshot','--limit','--daily-budget','--endpoint','--inspection','--export-only','--force','--max-db-mib','--concurrency']);
for (let i=0;i<args.length;i++) { if(!allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}`); if(!['--inspection','--export-only','--force'].includes(args[i])) i++; }
const lane = args.includes('--inspection') ? 'inspection' : 'production';
const dbPath = resolve(option('--db', lane==='production'?(process.env.WNS_ACTIVITY_DB??`activity/${lane}.sqlite`):`activity/${lane}.sqlite`));
const snapshotPath = resolve(option('--snapshot', lane === 'production' ? 'activity/activity-snapshot.json' : 'activity/inspection-snapshot.json'));
const positive = (name, fallback, max) => { const value=Number(option(name,fallback)); if(!Number.isInteger(value)||value<1||value>max) throw new Error(`Invalid ${name}`); return value; };
const limit = positive('--limit', 10000, 10000), dailyBudget = positive('--daily-budget', 12000, 20000), maxDb = positive('--max-db-mib', 8192, 16384)*1024*1024;
const concurrency = collectionConcurrency(option('--concurrency', 6));
mkdirSync(dirname(dbPath),{recursive:true});mkdirSync(dirname(snapshotPath),{recursive:true});
const spool = `${dbPath}.spool`;mkdirSync(spool,{recursive:true});
const ledger = new ActivityLedger(dbPath);chmodSync(dbPath,0o600);
const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
const {catalog} = loadData(); const gate = createHostGate(2000);
// Count every HTTP hop (including redirects and bounded retry) against the same durable request budget.
const requestGate = async (host, deadline) => {
  const release = await gate(host, deadline);
  try { ledger.acquire(owner,new Date().toISOString(),120); ledger.reserveRequest(new Date().toISOString(),dailyBudget); return release; }
  catch (error) { release(); throw error; }
};
const bindings = new Map(); for(const source of catalog.sources.filter(s=>s.enabled)) for(const endpoint of source.endpoints){const list=bindings.get(endpoint.id)??[];list.push(source);bindings.set(endpoint.id,list);}
const atomicJson = (path,value) => { const tmp=`${path}.${process.pid}.tmp`;writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});renameSync(tmp,path); };
let completed=0, failed=0, replayed=0;
let activeCycle = null;
try {
  ledger.acquire(owner,new Date().toISOString(),120);
  const existingLane=ledger.db.prepare("SELECT value FROM metadata WHERE key='lane'").get()?.value;
  if(existingLane && existingLane!==lane)throw new Error('TRAFFIC_LANE_MISMATCH');
  ledger.db.prepare("INSERT INTO metadata VALUES('lane',?) ON CONFLICT DO NOTHING").run(lane);
  ledger.syncRegistry(catalog,new Date().toISOString());
  // An ambiguous DB/write failure leaves this complete URL payload on disk. Replays use the same ID.
  const pending=readdirSync(spool).filter(f=>f.endsWith('.json')).map(f=>({path:join(spool,f),data:JSON.parse(readFileSync(join(spool,f),'utf8'))})).sort((a,b)=>a.data.checked_at.localeCompare(b.data.checked_at));
  for(const item of pending){
    ledger.acquire(owner,new Date().toISOString(),120);
    const alreadyCommitted=ledger.db.prepare('SELECT 1 FROM collections WHERE id=?').get(item.data.id);
    if(!alreadyCommitted&&!Array.isArray(item.data.source_bindings))throw new Error('LEGACY_PENDING_PROVENANCE_UNKNOWN');
    const result=ledger.commit(item.data,item.data.source_bindings??[],owner);replayed+=+result.replayed;unlinkSync(item.path);
  }
  if(!args.includes('--export-only')){
    const explicit=[];for(let i=0;i<args.length;i++)if(args[i]==='--endpoint')explicit.push(args[++i]);
    if(explicit.some(id=>!bindings.has(id)))throw new Error('Unknown or disabled endpoint');
    const now=new Date().toISOString();
    const { eligible, scheduling } = ledger.scheduling(catalog, now, args.includes('--force'), explicit);
    for (const row of ledger.hostCooldowns(now)) gate.defer(row.host,row.until,row.http_status);
    for (const row of scheduling.deferred_endpoints) gate.defer(new URL(catalog.endpoints.get(row.endpoint_id).url).hostname,row.next_due,row.http_status);
    const endpoints=eligible.slice(0,limit);
    activeCycle=randomUUID();ledger.beginCycle(catalog,{id:activeCycle,lane,at:now,scope:explicit.length||args.includes('--force')?'explicit_endpoints':'due_endpoints',eligible_endpoint_ids:eligible,planned_endpoint_ids:endpoints,scheduling});
    const pendingIds = [...endpoints], activeHosts = new Set();
    let exhausted=false, aborted=false, deferredDuringRun=0;
    const workers=await Promise.allSettled(Array.from({length:Math.min(concurrency, endpoints.length)},async()=>{
      try { while(pendingIds.length && !exhausted && !aborted){
        // Avoid filling all workers with the same publisher and consuming the HTTP timeout in a queue.
        const pos = pendingIds.findIndex(id=>!activeHosts.has(new URL(catalog.endpoints.get(id).url).hostname));
        if(pos<0){await new Promise(resolve=>setTimeout(resolve,25));continue;}
        const [id]=pendingIds.splice(pos,1), endpoint=catalog.endpoints.get(id), host=new URL(endpoint.url).hostname;
        activeHosts.add(host);
        try {
        const hostWait=gate.deferred(host);
        if(hostWait){ledger.deferCycleEndpoint(activeCycle,{endpoint_id:id,next_due:hostWait.until,reason:hostWait.httpStatus===429?'rate_limited':'server_retry_after',http_status:hostWait.httpStatus});deferredDuringRun++;continue;}
        const bytes=[dbPath,`${dbPath}-wal`].reduce((n,path)=>n+(existsSync(path)?statSync(path).size:0),0);if(bytes>=maxDb)throw new Error('SQLITE_STORAGE_BUDGET_EXHAUSTED');
        let observation=await auditEndpoint(endpoint,requestGate,true), attempts=1, requestedHops=observation.requestedHops??0;
        if(isTransient(observation)){try{const first=observation,retry=await auditEndpoint(endpoint,requestGate,true);attempts=retry.requestDeferred?1:2;requestedHops+=retry.requestedHops??0;observation=retry.requestDeferred?{...first,checkedAt:retry.checkedAt,serverDeferral:retry.requestDeferred}:retry;}catch(error){if(error.message!=='DAILY_REQUEST_BUDGET_EXHAUSTED')throw error;exhausted=true;observation={...observation,checkedAt:new Date().toISOString()};}}
        if(observation.requestDeferred){ledger.deferCycleEndpoint(activeCycle,{endpoint_id:id,next_due:observation.requestDeferred.until,reason:observation.requestDeferred.httpStatus===429?'rate_limited':'server_retry_after',http_status:observation.requestDeferred.httpStatus});deferredDuringRun++;continue;}
        const nextDue=collectionNextDue(observation.checkedAt,observation.httpStatus,observation.retryAfterAt);
        if(observation.httpStatus===429||observation.retryAfterAt){const until=observation.retryAfterAt??nextDue;gate.defer(host,until,observation.httpStatus);if(observation.finalUrl)gate.defer(new URL(observation.finalUrl).hostname,until,observation.httpStatus);}
        const collection={id:collectionId(id,observation.checkedAt,observation.observedUrls??[]),endpoint,checked_at:observation.checkedAt,status:observation.auditStatus??'network_error',format:observation.format??null,reason:observation.reason??null,urls:observation.observedUrls??[],traffic:lane,cycle_id:activeCycle,
          http_status:observation.httpStatus,retry_after_at:observation.retryAfterAt??null,retry_after_source:observation.retryAfterSource??null,request_host:host,response_host:observation.finalUrl?new URL(observation.finalUrl).hostname:host,attempts,
          requested_hops:requestedHops,...(observation.serverDeferral?{server_deferral:{until:observation.serverDeferral.until,http_status:observation.serverDeferral.httpStatus,...(observation.serverDeferral.hostname?{hostname:observation.serverDeferral.hostname}:{})}}:{}),
          newest_content_at:observation.newestContentAt??null,date_kind:observation.dateKind,source_bindings:bindings.get(id).map(({id,countryCode})=>({id,countryCode}))};
        const path=join(spool,`${collection.id}.json`);atomicJson(path,collection);
        if(aborted)return; // Retain later in-flight payloads, so recovery can commit in chronological order.
        ledger.acquire(owner,new Date().toISOString(),120);ledger.commit(collection,bindings.get(id),owner);unlinkSync(path);completed++;if(!['working_nonempty','valid_empty'].includes(collection.status))failed++;
        if(observation.stopReason)exhausted=true;
        console.log(JSON.stringify({endpoint_id:id,status:collection.status,http_status:collection.http_status,retry_after_at:collection.retry_after_at,checked_at:collection.checked_at,full_urls:collection.urls.length,completed}));
        }catch(error){if(error.message==='DAILY_REQUEST_BUDGET_EXHAUSTED'){exhausted=true;console.log(JSON.stringify({stopped:error.message}));break;}throw error;}
        finally{activeHosts.delete(host);}
      }}catch(error){aborted=true;throw error;}
    }));
    const rejected=workers.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
    ledger.finishCycle(activeCycle,exhausted||completed<eligible.length?'partial':'completed',new Date().toISOString(),exhausted?'DAILY_REQUEST_BUDGET_EXHAUSTED':deferredDuringRun?'SERVER_RETRY_AFTER_DEFERRED':completed<eligible.length?'PLANNED_ENDPOINT_LIMIT':null);activeCycle=null;
  }
  const snapshot=ledger.archive(catalog,join(dirname(snapshotPath),'history'));atomicJson(snapshotPath,snapshot);
  console.log(JSON.stringify({lane,db:dbPath,snapshot:snapshotPath,tracking_start:snapshot.tracking_start,completed,failed,replayed,cadence:'daily_all_active; operator only; no timer created',concurrency,daily_request_budget:dailyBudget}));
}catch(error){if(activeCycle){ledger.finishCycle(activeCycle,'failed',new Date().toISOString(),'COLLECTOR_RUN_FAILED');activeCycle=null;}throw error;}
finally{ledger.release(owner);ledger.close();}
