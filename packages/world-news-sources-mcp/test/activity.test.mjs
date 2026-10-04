import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLedger, collectionId } from '../dist/activity-ledger.js';
import { ActivityStore, countryInventory, dayBoundary, sourceActivitySchema } from '../dist/activity.js';
import { normalizeArticleUrl } from '../dist/article-url.js';
import { normalizeRegistry } from '../dist/catalog.js';
import { inspectXml } from '../dist/inspect.js';
import { createHttpHandler } from '../dist/http.js';
import { HealthStore } from '../dist/health.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Worker } from 'node:worker_threads';

const catalog = normalizeRegistry({countries:[{code:'US',name:'USA',feeds:[{name:'A',url:'https://a.example/rss',sitemapUrl:'https://a.example/sitemap'},{name:'B',url:'https://b.example/rss'}]},{code:'CA',name:'Canada',feeds:[{name:'C',url:'https://c.example/rss'}]}]});
const source = name => catalog.sources.find(s => s.name === name);
const now = '2026-10-10T00:00:00.000Z';
function setup() { const dir=mkdtempSync(join(tmpdir(),'article-ledger-'));const path=join(dir,'activity.sqlite');const ledger=new ActivityLedger(path);ledger.acquire('writer',now,3600);ledger.syncRegistry(catalog,now);return{ledger,path,cleanup(){ledger.close();rmSync(dir,{recursive:true,force:true});}}; }
let sequence=0;
function visit(ledger,name,index,urls,status='working_nonempty',format=null,id=null) {
  const s=source(name), endpoint=s.endpoints[index]; const at=new Date(Date.parse('2026-10-01T12:00:00Z')+(sequence++)*3600000).toISOString();
  const value={id:id??collectionId(endpoint.id,at,urls),endpoint,checked_at:at,status,format:format??(endpoint.type==='rss'?'rss':'urlset'),reason:null,urls,traffic:'production'};
  return {value,result:ledger.commit(value,[s],'writer',now)};
}
test('binding baselines, RSS+sitemap source dedup and country cross-source dedup; country discovery is independent of global',()=>{
  sequence=0;const {ledger,path,cleanup}=setup();
  try{
    const old='https://publisher.example/article/old',fresh='https://publisher.example/article/new';
    assert.equal(visit(ledger,'A',0,[old]).result.country_new.US,0);
    assert.equal(visit(ledger,'A',1,[old,'https://publisher.example/article/archive']).result.source_new[source('A').id],0);
    visit(ledger,'B',0,[old]);visit(ledger,'C',0,[old]);
    assert.equal(visit(ledger,'A',0,[old,fresh,fresh+'?utm_source=x#heading']).result.source_new[source('A').id],1);
    assert.equal(visit(ledger,'A',1,[fresh]).result.source_new[source('A').id],0);
    const b=visit(ledger,'B',0,[fresh]);assert.equal(b.result.source_new[source('B').id],1);assert.equal(b.result.country_new.US,0);
    const c=visit(ledger,'C',0,[fresh]);assert.equal(c.result.country_new.CA,1);
    const global=ledger.db.prepare('SELECT * FROM urls WHERE url=?').get(fresh);
    const country=ledger.db.prepare("SELECT * FROM scope_urls WHERE scope_kind='country' AND scope_id='CA' AND url=?").get(fresh);
    assert.ok(country.first_seen>global.first_seen);assert.equal(country.last_seen,c.value.checked_at);
    const store=new ActivityStore(ledger.snapshot(catalog,now));
    const us=store.query(catalog,'country',{country:'US',start_date:'2026-10-01',end_date:'2026-10-01'},Date.parse(now));
    assert.equal(us.items[0].new_unique_candidate_urls,1);assert.equal(us.items[0].state,'complete');
    assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM endpoint_urls WHERE url=?').get(fresh).n,4);
    const archiveDir=`${path}.history`,archived=new ActivityStore(ledger.archive(catalog,archiveDir,now),archiveDir);
    const query=(kind,scope)=>archived.query(catalog,kind,{...(kind==='country'?{country:scope}:{source_id:scope}),start_date:'2026-10-01',end_date:'2026-10-01'},Date.parse(now)).items[0];
    assert.equal(query('country','US').new_unique_candidate_urls,1);assert.equal(query('country','CA').new_unique_candidate_urls,1);
    assert.equal(query('source',source('A').id).new_unique_candidate_urls,1);assert.equal(query('source',source('B').id).new_unique_candidate_urls,1);assert.equal(query('country','US').baseline_checks,3);
  }finally{cleanup();}
});
test('a later binding baseline does not turn an old archive into source or country NEW',()=>{
  sequence=0;const {ledger,cleanup}=setup();try{
    visit(ledger,'A',0,[],'valid_empty');
    const archive='https://x.example/archive/old';const value=visit(ledger,'A',1,[archive]);
    assert.equal(value.result.source_new[source('A').id],0);assert.equal(value.result.country_new.US,0);
    assert.equal(visit(ledger,'A',0,[archive]).result.source_new[source('A').id],0);
  }finally{cleanup();}
});
test('idempotent replay, durable reopen, lease exclusion/fencing and transaction failure rollback',()=>{
  sequence=0;const {ledger,path,cleanup}=setup();try{
    const first=visit(ledger,'A',0,['https://x.example/article/old']);
    assert.equal(ledger.commit(first.value,[source('A')],'writer',now).replayed,true);
    assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM collections').get().n,1);
    const other=new ActivityLedger(path);try{assert.throws(()=>other.acquire('other',now),/ALREADY_RUNNING/);assert.throws(()=>other.commit(first.value,[source('A')],'other',now),/LEASE_LOST/);}finally{other.close();}
    ledger.db.exec("CREATE TRIGGER failure BEFORE INSERT ON collections WHEN NEW.id='fail' BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;");
    assert.throws(()=>visit(ledger,'A',0,['https://x.example/article/rollback'],'working_nonempty',null,'fail'),/storage failure/);
    assert.equal(ledger.db.prepare('SELECT 1 FROM urls WHERE url=?').get('https://x.example/article/rollback'),undefined);
    const reopened=new ActivityLedger(path);assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM collections').get().n,1);reopened.close();
    assert.throws(()=>ledger.commit({...first.value,id:'another',checked_at:'2026-09-01T00:00:00Z'},[source('A')],'writer',now),/OUT_OF_ORDER/);
    assert.throws(()=>ledger.commit({...first.value,id:'inspection',traffic:'inspection'},[source('A')],'writer',now),/LANE/);
  }finally{cleanup();}
});
test('valid zero differs from failed/untracked; no historical count backfill; index children excluded and not initialized',()=>{
  sequence=0;const {ledger,cleanup}=setup();try{
    const untracked=new ActivityStore().query(catalog,'source',{source_id:source('A').id,start_date:'2026-09-30',end_date:'2026-09-30'},Date.parse(now));assert.equal(untracked.items[0].new_unique_candidate_urls,null);
    visit(ledger,'A',0,[],'valid_empty');visit(ledger,'B',0,[],'timeout');visit(ledger,'A',1,['https://a.example/child.xml'],'working_nonempty','sitemapindex');
    const store=new ActivityStore(ledger.snapshot(catalog,now));
    const query=name=>store.query(catalog,'source',{source_id:source(name).id,start_date:'2026-10-01',end_date:'2026-10-01'},Date.parse(now));
    assert.equal(query('A').items[0].new_unique_candidate_urls,0);assert.equal(query('A').initialized_bindings,1);
    assert.equal(query('B').items[0].new_unique_candidate_urls,null);assert.equal(query('B').items[0].state,'failed_or_index_only');
    assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM urls').get().n,0);
    assert.equal(store.query(catalog,'country',{country:'US',start_date:'2026-09-30',end_date:'2026-09-30'},Date.parse(now)).items[0].state,'not_tracked');
  }finally{cleanup();}
});
test('actual independent concurrent SQLite collectors select one writer and never double-count',async()=>{
  const {ledger,path,cleanup}=setup();ledger.release('writer');
  let ready=0;const shared=new SharedArrayBuffer(4);const barrier=new Int32Array(shared);const endpoint=source('A').endpoints[0];
  const value={id:'concurrent-check',endpoint,checked_at:'2026-10-02T12:00:00.000Z',status:'working_nonempty',format:'rss',reason:null,urls:['https://a.example/article/concurrent'],traffic:'production'};
  try{
    const results=await Promise.all(Array.from({length:4},(_,i)=>new Promise((resolve,reject)=>{
      const worker=new Worker(`const {workerData,parentPort}=require('node:worker_threads');(async()=>{const {ActivityLedger}=await import(workerData.module);const db=new ActivityLedger(workerData.path);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.shared),0,0);let outcome;try{db.acquire(workerData.owner,workerData.now,3600);db.commit(workerData.value,[workerData.source],workerData.owner,workerData.now);outcome='committed';}catch(error){outcome=error.message;}finally{db.close();}parentPort.postMessage(outcome);})();`,{eval:true,workerData:{module:new URL('../dist/activity-ledger.js',import.meta.url).href,path,shared,value,source:source('A'),owner:`worker-${i}`,now}});
      worker.on('message',message=>{if(message==='ready'){if(Atomics.add(barrier,0,0)===0){ready++;if(ready===4){Atomics.store(barrier,0,1);Atomics.notify(barrier,0,4);}}}else resolve(message);});worker.on('error',reject);
    })));
    assert.equal(results.filter(x=>x==='committed').length,1);assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM collections').get().n,1);
  }finally{cleanup();}
});
test('timezone boundaries account for DST, fractional offsets; rolling 24h is separate; ranges/inputs bounded',()=>{
  assert.equal(dayBoundary('2026-03-09','America/New_York')-dayBoundary('2026-03-08','America/New_York'),23*3600000);
  assert.equal(dayBoundary('2026-11-02','America/New_York')-dayBoundary('2026-11-01','America/New_York'),25*3600000);
  assert.equal(new Date(dayBoundary('2026-10-01','Asia/Kathmandu')).toISOString(),'2026-09-30T18:15:00.000Z');
  const store=new ActivityStore();const q={source_id:source('A').id};
  assert.throws(()=>store.query(catalog,'source',{...q,start_date:'2026-02-30'},Date.parse(now)));
  assert.throws(()=>sourceActivitySchema.parse({...q,timezone:'Fake/Zone'}));
  assert.throws(()=>store.query(catalog,'source',{...q,start_date:'2026-08-01',end_date:'2026-10-01'},Date.parse(now)),/31/);
  assert.throws(()=>store.query(catalog,'source',{...q,mode:'rolling_24h',start_date:'2026-10-01'},Date.parse(now)));
  assert.equal(Date.parse(store.query(catalog,'source',{...q,mode:'rolling_24h'},Date.parse(now)).items[0].to_exclusive)-Date.parse(store.query(catalog,'source',{...q,mode:'rolling_24h'},Date.parse(now)).items[0].from),86400000);
});
test('daily full-pass cadence uses calendar due dates; retries share a durable bounded request budget',()=>{
  sequence=0;const {ledger,cleanup}=setup();try{
    visit(ledger,'A',0,[],'valid_empty');
    assert.equal(ledger.db.prepare('SELECT next_due FROM bindings WHERE source_id=? AND endpoint_id=?').get(source('A').id,source('A').endpoints[0].id).next_due,'2026-10-02T00:00:00.000Z');
    ledger.reserveRequest(now,2);ledger.reserveRequest(now,2);assert.throws(()=>ledger.reserveRequest(now,2),/BUDGET_EXHAUSTED/);
    ledger.reserveRequest('2026-10-11T00:00:00.000Z',2);
    assert.equal(ledger.db.prepare('SELECT requests FROM request_budget WHERE day=?').get('2026-10-10').requests,2);
  }finally{cleanup();}
});
test('URL normalization retains identity queries, order, path case/escapes and separates uncertain paths',()=>{
  assert.equal(normalizeArticleUrl('https://Example.com/News/ABC?id=5&q=a%20b&utm_source=x#part').url,'https://example.com/News/ABC?id=5&q=a%20b');
  assert.notEqual(normalizeArticleUrl('https://a.example/Story?id=1').url,normalizeArticleUrl('https://a.example/story?id=2').url);
  assert.equal(normalizeArticleUrl('https://a.example/forum').kind,'uncertain');assert.equal(normalizeArticleUrl('https://a.example/').kind,'uncertain');
  assert.throws(()=>normalizeArticleUrl('https://user:pass@a.example/article'));
});
test('full extraction stores more than health samples, excludes sitemap indexes, rejects malformed XML',()=>{
  const xml=`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({length:5},(_,i)=>`<url><loc>https://a.example/article/${i}</loc></url>`).join('')}</urlset>`;
  const result=inspectXml(Buffer.from(xml),'sitemap',Date.now(),1024*1024,true);assert.equal(result.observedUrls.length,5);assert.equal(result.sampleUrls.length,3);
  const index=inspectXml(Buffer.from('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://a.example/child.xml</loc></sitemap></sitemapindex>'),'sitemap',Date.now(),1024*1024,true);assert.equal(index.entryCount,1);assert.deepEqual(index.observedUrls,[]);
  assert.throws(()=>inspectXml(Buffer.from(xml.slice(0,-4)),'sitemap',Date.now(),1024*1024,true));
});
test('inventory is recomputed from actual registry, counts mixed duplicates honestly and pages',()=>{
  const raw=JSON.parse(readFileSync(new URL('../../../data/rss-atlas.json',import.meta.url),'utf8')),real=normalizeRegistry(raw);const rows=countryInventory(real,{limit:50}).items.concat(countryInventory(real,{offset:50,limit:50}).items);
  const active=raw.countries.flatMap(c=>c.feeds.filter(f=>f.enabled!==false));
  const rawTyped=new Set(active.flatMap(f=>[['rss',f.url],['sitemap',f.sitemapUrl]].filter(([,url])=>url).map(([type,url])=>{const u=new URL(url);u.hash='';return JSON.stringify([type,u.href]);})));
  assert.equal(rows.reduce((n,r)=>n+r.active_source_registrations,0),active.length);assert.equal(rows.filter(r=>r.active_source_registrations).length,new Set(raw.countries.filter(c=>c.feeds.some(f=>f.enabled!==false)).map(c=>c.code.toUpperCase())).size);
  assert.equal(new Set(real.sources.filter(s=>s.enabled).flatMap(s=>s.endpoints.map(e=>e.id))).size,rawTyped.size);
  const dup=normalizeRegistry({countries:[{code:'US',name:'US',feeds:[{name:'A',url:'https://x.example/rss',enabled:true},{name:'A',url:'https://x.example/rss',enabled:false}]}]});
  const row=countryInventory(dup,{include_disabled:true}).items[0];assert.equal(row.active_source_registrations,1);assert.equal(row.disabled_source_registrations,1);assert.equal(row.unique_active_rss_endpoints,1);
});
test('all original tools plus activity and inventory work through actual MCP transport',async()=>{
  const {ledger,cleanup}=setup();visit(ledger,'A',0,[],'valid_empty');const handler=createHttpHandler(catalog,new HealthStore(),['example.com'],undefined,new ActivityStore(ledger.snapshot(catalog,now)));const client=new Client({name:'activity-test',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL('https://example.com/mcp'),{fetch:(input,init)=>handler.fetch(new Request(input,init))}));assert.equal((await client.listTools()).tools.length,7);
    const calls=[['search_sources',{limit:1}],['get_source',{source_id:source('A').id}],['list_countries',{limit:1}],['get_endpoint_health',{endpoint_ids:[source('A').endpoints[0].id]}],['get_country_source_inventory',{country:'US'}],['get_source_article_activity',{source_id:source('A').id,start_date:'2026-10-01',end_date:'2026-10-01'}],['get_country_article_activity',{country:'US',start_date:'2026-10-01',end_date:'2026-10-01'}]];
    for(const [name,args] of calls){const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,name);assert.ok(result.structuredContent,name);}
    assert.equal((await client.callTool({name:'get_source_article_activity',arguments:{source_id:source('A').id,timezone:'invalid'}})).isError,true);
  }finally{await client.close();await handler.close();cleanup();}
});
