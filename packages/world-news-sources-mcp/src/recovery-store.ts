import {DatabaseSync} from 'node:sqlite';
import type {Catalog,Endpoint} from './catalog.js';
import {observationSchema,type Observation} from './health.js';
import {recoveryPlan,HostCooldownError} from './recovery-policy.js';
import type {RequestGate} from './validate.js';
const normalizeHost=(host:string)=>host.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
export const RECOVERY_SCHEMA=`
CREATE TABLE IF NOT EXISTS endpoint_recovery(endpoint_id TEXT PRIMARY KEY,request_host TEXT NOT NULL,response_host TEXT,failed_checks INTEGER NOT NULL,last_checked_at TEXT NOT NULL,category TEXT NOT NULL,action TEXT NOT NULL,next_eligible_at TEXT NOT NULL,review_required INTEGER NOT NULL,record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recovery_events(event_key TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL,checked_at TEXT NOT NULL,record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS host_cooldowns(host TEXT PRIMARY KEY,until_at TEXT NOT NULL,category TEXT NOT NULL);
`;
export class RecoveryStore {
  readonly db:DatabaseSync;readonly owned:boolean;
  constructor(db:DatabaseSync|string){this.owned=typeof db==='string';this.db=typeof db==='string'?new DatabaseSync(db):db;this.db.exec('PRAGMA busy_timeout=5000');this.db.exec(RECOVERY_SCHEMA);}
  close(){if(this.owned)this.db.close();}
  reserveRequest(now=new Date().toISOString(),limit=12000){const row=this.db.prepare('INSERT INTO request_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1 WHERE requests<? RETURNING requests').get(now.slice(0,10),limit);if(!row)throw new Error('DAILY_REQUEST_BUDGET_EXHAUSTED');}
  state(id:string){const row=this.db.prepare('SELECT record FROM endpoint_recovery WHERE endpoint_id=?').get(id);return row?JSON.parse(String(row.record)):null;}
  hostUntil(host:string){return String(this.db.prepare('SELECT until_at FROM host_cooldowns WHERE host=?').get(normalizeHost(host))?.until_at??'');}
  eligible(endpoint:Endpoint,now=new Date().toISOString(),mode:'activity'|'health'='activity') {const state=this.state(endpoint.id),host=this.hostUntil(new URL(endpoint.url).hostname);const endpointUntil=mode==='health'&&state?.category==='healthy'?'':state?.nextEligibleAt??'';const until=[endpointUntil,host].sort().at(-1)!;return until>now?{eligible:false,until,category:state?.category??'host_cooldown'}:{eligible:true,until:null,category:null};}
  guardHost(host:string,now=new Date().toISOString()){const until=this.hostUntil(host);if(until>now)throw new HostCooldownError(host,until);}
  gate(base:RequestGate):RequestGate{return async(host,deadline)=>{this.guardHost(host);const release=await base(host,deadline);try{this.guardHost(host);return release;}catch(error){release();throw error;}};}
  record(endpoint:Endpoint,o:Observation,eventKey:string,legacyFailures?:number,insideTransaction=false){
    if(insideTransaction)return this.recordAtomic(endpoint,o,eventKey,legacyFailures);
    this.db.exec('BEGIN IMMEDIATE');try{const result=this.recordAtomic(endpoint,o,eventKey,legacyFailures);this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private recordAtomic(endpoint:Endpoint,o:Observation,eventKey:string,legacyFailures?:number){
    observationSchema.parse(o);
    const previous=this.db.prepare('SELECT record FROM recovery_events WHERE event_key=?').get(eventKey);if(previous)return JSON.parse(String(previous.record));
    const old=this.state(endpoint.id),failed=['working_nonempty','valid_empty'].includes(o.auditStatus??'')?0:legacyFailures??((old?.failedChecks??0)+(o.reason==='HOST_COOLDOWN'?0:1));
    const plan=recoveryPlan(o,failed),requestHost=normalizeHost(new URL(endpoint.url).hostname),responseHost=o.diagnostics?.requestHost?normalizeHost(o.diagnostics.requestHost):o.finalUrl?normalizeHost(new URL(o.finalUrl).hostname):null;
    const record={endpoint_id:endpoint.id,checked_at:o.checkedAt,http_status:o.httpStatus,reason:o.reason,status:o.auditStatus,diagnostics:o.diagnostics??null,attempts:o.attempts??null,...plan};
    this.db.prepare('INSERT INTO recovery_events VALUES(?,?,?,?)').run(eventKey,endpoint.id,o.checkedAt,JSON.stringify(record));
    // Historical spool replay never moves the current recovery state backwards.
    if(!old||old.checked_at<=o.checkedAt)this.db.prepare('INSERT INTO endpoint_recovery VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(endpoint_id) DO UPDATE SET request_host=excluded.request_host,response_host=excluded.response_host,failed_checks=excluded.failed_checks,last_checked_at=excluded.last_checked_at,category=excluded.category,action=excluded.action,next_eligible_at=excluded.next_eligible_at,review_required=excluded.review_required,record=excluded.record').run(endpoint.id,requestHost,responseHost,plan.failedChecks,o.checkedAt,plan.category,plan.action,plan.nextEligibleAt,+plan.review,JSON.stringify(record));
    if(plan.category==='rate_limited'||plan.category==='access_restricted'){
      const until=plan.category==='access_restricted'?new Date(Date.parse(o.checkedAt)+86400000).toISOString():plan.nextEligibleAt;
      for(const host of new Set([requestHost,responseHost].filter((h):h is string=>!!h)))this.db.prepare('INSERT INTO host_cooldowns VALUES(?,?,?) ON CONFLICT(host) DO UPDATE SET until_at=MAX(until_at,excluded.until_at),category=CASE WHEN excluded.until_at>=until_at THEN excluded.category ELSE category END').run(host,until,plan.category);
    }
    return record;
  }
  seedFromLedger(catalog:Catalog){
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='collections'").get())return;
    const rows=this.db.prepare('SELECT c.* FROM collections c JOIN (SELECT endpoint_id,MAX(checked_at) at FROM collections GROUP BY endpoint_id) latest ON c.endpoint_id=latest.endpoint_id AND c.checked_at=latest.at WHERE NOT EXISTS(SELECT 1 FROM endpoint_recovery r WHERE r.endpoint_id=c.endpoint_id)').all();
    this.db.exec('BEGIN IMMEDIATE');try{for(const row of rows){const endpoint=catalog.endpoints.get(String(row.endpoint_id));if(!endpoint)continue;const reason=row.reason===null?null:String(row.reason),status=String(row.status) as Observation['auditStatus'];const failures=Number(this.db.prepare('SELECT MAX(failures) n FROM bindings WHERE endpoint_id=?').get(endpoint.id)?.n??1);
      this.record(endpoint,{endpointId:endpoint.id,type:endpoint.type,url:endpoint.url,checkedAt:String(row.checked_at),outcome:['working_nonempty','valid_empty'].includes(status??'')?'healthy':'unhealthy',httpStatus:/^HTTP_\d{3}$/.test(reason??'')?Number(reason!.slice(5)):null,reason,format:row.format as Observation['format'],auditStatus:status},`legacy:${row.id}`,failures,true);
    }this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  report(){return {policyVersion:'cause-aware-1',semantics:'Next eligible is a lower bound, revisited by the existing daily/weekly jobs; review flags never disable sources.',endpoints:this.db.prepare('SELECT record FROM endpoint_recovery ORDER BY endpoint_id').all().map(r=>JSON.parse(String(r.record))),host_cooldowns:this.db.prepare('SELECT * FROM host_cooldowns ORDER BY host').all()};}
}
