import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync, chmodSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadData } from '../dist/config.js';
import { ActivityLedger, collectionId } from '../dist/activity-ledger.js';
import { auditEndpoint } from '../dist/audit-check.js';
import { createHostGate } from '../dist/host-gate.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const pos = args.indexOf(name); return pos < 0 ? fallback : args[pos + 1]; };
const allowed = new Set(['--db','--snapshot','--limit','--daily-budget','--endpoint','--inspection','--export-only','--force','--max-db-mib']);
for (let i=0;i<args.length;i++) { if(!allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}`); if(!['--inspection','--export-only','--force'].includes(args[i])) i++; }
const lane = args.includes('--inspection') ? 'inspection' : 'production';
const dbPath = resolve(option('--db', lane==='production'?(process.env.WNS_ACTIVITY_DB??`activity/${lane}.sqlite`):`activity/${lane}.sqlite`));
const snapshotPath = resolve(option('--snapshot', lane === 'production' ? 'activity/activity-snapshot.json' : 'activity/inspection-snapshot.json'));
const positive = (name, fallback, max) => { const value=Number(option(name,fallback)); if(!Number.isInteger(value)||value<1||value>max) throw new Error(`Invalid ${name}`); return value; };
const limit = positive('--limit', 10000, 10000), dailyBudget = positive('--daily-budget', 12000, 20000), maxDb = positive('--max-db-mib', 8192, 16384)*1024*1024;
mkdirSync(dirname(dbPath),{recursive:true});mkdirSync(dirname(snapshotPath),{recursive:true});
const spool = `${dbPath}.spool`;mkdirSync(spool,{recursive:true});
const ledger = new ActivityLedger(dbPath);chmodSync(dbPath,0o600);
const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
const {catalog} = loadData(); const gate = ledger.recovery.gate(createHostGate(2000));
const bindings = new Map(); for(const source of catalog.sources.filter(s=>s.enabled)) for(const endpoint of source.endpoints){const list=bindings.get(endpoint.id)??[];list.push(source);bindings.set(endpoint.id,list);}
const atomicJson = (path,value) => { const tmp=`${path}.${process.pid}.tmp`;writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});renameSync(tmp,path); };
let completed=0, failed=0, replayed=0,deferredCount=0;
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
  ledger.recovery.seedFromLedger(catalog);
  if(!args.includes('--export-only')){
    const explicit=[];for(let i=0;i<args.length;i++)if(args[i]==='--endpoint')explicit.push(args[++i]);
    if(explicit.some(id=>!bindings.has(id)))throw new Error('Unknown or disabled endpoint');
    const now=new Date().toISOString();
    const state=ledger.db.prepare('SELECT endpoint_id,MIN(baseline_at) baseline_at,MAX(next_due) next_due,MIN(last_attempt_at) last_attempt_at FROM bindings GROUP BY endpoint_id').all();
    const states=new Map(state.map(row=>[row.endpoint_id,row]));
    const endpoints=[...bindings.keys()].filter(id=>!explicit.length||explicit.includes(id)).filter(id=>args.includes('--force')||!states.get(id)?.next_due||states.get(id).next_due<=now)
      .sort((a,b)=>String(states.get(a)?.last_attempt_at??'').localeCompare(String(states.get(b)?.last_attempt_at??''))||a.localeCompare(b)).slice(0,limit);
    let cursor=0, exhausted=false, aborted=false; const deferred=[];
    const workers=await Promise.allSettled(Array.from({length:2},async()=>{
      try { while(cursor<endpoints.length && !exhausted && !aborted){
        const id=endpoints[cursor++], endpoint=catalog.endpoints.get(id);
        const eligibility=ledger.recovery.eligible(endpoint,undefined,args.includes('--force')?'health':'activity');if(!eligibility.eligible){deferred.push({endpoint_id:id,...eligibility});deferredCount++;continue;}
        const bytes=[dbPath,`${dbPath}-wal`].reduce((n,path)=>n+(existsSync(path)?statSync(path).size:0),0);if(bytes>=maxDb)throw new Error('SQLITE_STORAGE_BUDGET_EXHAUSTED');
        ledger.acquire(owner,new Date().toISOString(),120);try{ledger.reserveRequest(new Date().toISOString(),dailyBudget);}catch(error){if(error.message==='DAILY_REQUEST_BUDGET_EXHAUSTED'){exhausted=true;console.log(JSON.stringify({stopped:error.message}));break;}throw error;}
        const observation=await auditEndpoint(endpoint,gate,true);

        const collection={id:collectionId(id,observation.checkedAt,observation.observedUrls??[]),endpoint,checked_at:observation.checkedAt,status:observation.auditStatus??'network_error',format:observation.format??null,reason:observation.reason??null,urls:observation.observedUrls??[],traffic:lane,http_status:observation.httpStatus,attempts:observation.attempts,diagnostics:observation.diagnostics,source_bindings:bindings.get(id).map(({id,countryCode})=>({id,countryCode}))};
        const path=join(spool,`${collection.id}.json`);atomicJson(path,collection);
        if(aborted)return; // Retain later in-flight payloads, so recovery can commit in chronological order.
        ledger.acquire(owner,new Date().toISOString(),120);ledger.commit(collection,bindings.get(id),owner);unlinkSync(path);completed++;if(!['working_nonempty','valid_empty'].includes(collection.status))failed++;
        console.log(JSON.stringify({endpoint_id:id,status:collection.status,checked_at:collection.checked_at,full_urls:collection.urls.length,completed}));
      }}catch(error){aborted=true;throw error;}
    }));
    atomicJson(join(dirname(snapshotPath),'recovery-deferred.json'),{deferred});
    const rejected=workers.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
  }
  atomicJson(join(dirname(snapshotPath),'recovery-latest.json'),ledger.recovery.report());
  const snapshot=ledger.archive(catalog,join(dirname(snapshotPath),'history'));atomicJson(snapshotPath,snapshot);
  console.log(JSON.stringify({lane,db:dbPath,snapshot:snapshotPath,tracking_start:snapshot.tracking_start,completed,failed,replayed,deferred:deferredCount,inline_retries:0,recovery_policy:'cause-aware-1',cadence:'operator only; no timer created',daily_request_budget:dailyBudget}));
}finally{ledger.release(owner);ledger.close();}
