import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {ActivityLedger} from '../dist/activity-ledger.js';
import {ActivityStore} from '../dist/activity.js';
import {normalizeRegistry} from '../dist/catalog.js';
const catalog=normalizeRegistry({countries:[{code:'US',name:'United States',feeds:[{name:'Example',url:'https://publisher.example/feed'}]}]});
const source=catalog.sources[0],endpoint=source.endpoints[0];
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'wns-history-')),ledger=new ActivityLedger(join(dir,'ledger.sqlite'));ledger.syncRegistry(catalog,'2025-01-01T00:00:00.000Z');t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});return{dir,ledger};}
function add(ledger,id,at,{status='working_nonempty',format='rss',n=1,baseline=false}={}){const details={source_ids:[source.id],countries:['US'],source_new:{[source.id]:n*3},country_new:{US:n},baseline_sources:baseline?[source.id]:[],observed_urls:10,uncertain_urls:2,index_children_excluded:format==='sitemapindex'};ledger.db.prepare('INSERT INTO collections VALUES(?,?,?,?,?,?,?)').run(String(id),endpoint.id,at,status,format,'not exported https://publisher.example/private-path',JSON.stringify(details));}
function track(ledger,at){ledger.db.prepare("INSERT INTO metadata VALUES('tracking_start',?)").run(at);}
function query(store,start,end=start,zone='UTC',kind='country',now='2026-10-01T12:00:00Z'){return store.query(catalog,kind,{...(kind==='country'?{country:'US'}:{source_id:source.id}),start_date:start,end_date:end,timezone:zone},Date.parse(now));}

test('all stored historical dates remain queryable beyond 25000 checks and 180 days, with bounded response and scope counts',t=>{
  const {dir,ledger}=fixture(t);track(ledger,'2025-01-01T00:00:00.000Z');ledger.db.exec('BEGIN');
  for(let i=0;i<27000;i++)add(ledger,i,new Date(Date.parse('2025-01-01T00:00:00Z')+i*600000).toISOString());
  add(ledger,'latest','2026-10-01T10:00:00.000Z');ledger.db.exec('COMMIT');
  const archive=ledger.archive(catalog,dir,'2026-10-01T12:00:00.000Z'),store=new ActivityStore(archive,dir);
  assert.equal(archive.collections.length,0);assert.equal(archive.snapshot_coverage.exported_collections,27001);assert.equal(archive.snapshot_coverage.complete_stored_window,true);
  const answer=query(store,'2025-01-01');assert.equal(answer.items[0].new_unique_candidate_urls,144);assert.equal(answer.items[0].state,'complete');assert.equal(answer.latest_collection,'2026-10-01T10:00:00.000Z');
  assert.equal(query(store,'2025-01-01','2025-01-01','UTC','source').items[0].new_unique_candidate_urls,432);
  assert.equal(query(store,'2025-08-01').items[0].state,'not_collected');assert.equal(query(store,'2024-12-01').items[0].state,'not_tracked');
  assert.throws(()=>query(store,'2025-01-01','2025-02-01'),/31 days/);assert.ok(JSON.stringify(answer).length<5000);
  const json=gunzipSync(readFileSync(join(dir,archive.history.shards[0].file))).toString();assert.ok(!json.includes('https://'));assert.ok(!json.includes('private-path'));assert.ok(!json.includes('observed_urls'));
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM collections').get().n,27001);
});
test('monthly archives preserve local IANA/DST instants, fractional midnight, rolling24h and select only requested months',t=>{
  const {dir,ledger}=fixture(t);track(ledger,'2025-01-01T00:00:00.000Z');
  add(ledger,'old','2025-01-01T00:00:00.000Z');
  for(const [id,at] of [['prior','2026-03-08T04:30:00.000Z'],['start','2026-03-08T05:30:00.000Z'],['after-jump','2026-03-08T07:30:00.000Z'],['next','2026-03-09T04:30:00.000Z'],['k-before','2026-04-30T18:14:59.999Z'],['k-start','2026-04-30T18:15:00.000Z'],['k-next','2026-05-01T18:15:00.000Z']])add(ledger,id,at);
  const snapshot=ledger.archive(catalog,dir,'2026-10-01T12:00:00.000Z'),store=new ActivityStore(snapshot,dir);
  // An unrelated old shard can be unavailable; a current bounded request does not read it.
  unlinkSync(join(dir,snapshot.history.shards.find(s=>s.month==='2025-01').file));
  const dst=query(store,'2026-03-08','2026-03-08','America/New_York');assert.equal(dst.items[0].new_unique_candidate_urls,2);assert.equal(Date.parse(dst.items[0].to_exclusive)-Date.parse(dst.items[0].from),23*3600000);
  const fractional=query(store,'2026-05-01','2026-05-01','Asia/Kathmandu');assert.equal(fractional.items[0].new_unique_candidate_urls,1);assert.equal(fractional.items[0].from,'2026-04-30T18:15:00.000Z');
  const rolling=store.query(catalog,'country',{country:'US',mode:'rolling_24h'},Date.parse('2026-05-01T18:15:00Z'));assert.equal(rolling.items[0].new_unique_candidate_urls,1);
  assert.throws(()=>query(store,'2025-01-01'),/ACTIVITY_HISTORY_READ_FAILURE/);
});
test('archive separates baseline valid zero, failures, sitemap indexes and pretracking nulls',t=>{
  const {dir,ledger}=fixture(t);track(ledger,'2025-01-01T00:00:00.000Z');
  add(ledger,'baseline','2025-01-01T12:00:00.000Z',{n:0,baseline:true});add(ledger,'failed','2025-01-02T12:00:00.000Z',{status:'timeout',n:0});add(ledger,'index','2025-01-03T12:00:00.000Z',{format:'sitemapindex',n:0});add(ledger,'empty','2025-01-04T12:00:00.000Z',{status:'valid_empty',n:0});
  const store=new ActivityStore(ledger.archive(catalog,dir,'2026-10-01T00:00:00.000Z'),dir);
  assert.equal(query(store,'2025-01-01').items[0].baseline_checks,1);assert.equal(query(store,'2025-01-01').items[0].new_unique_candidate_urls,0);
  assert.equal(query(store,'2025-01-02').items[0].new_unique_candidate_urls,null);assert.equal(query(store,'2025-01-02').items[0].failed_checks,1);
  assert.equal(query(store,'2025-01-03').items[0].new_unique_candidate_urls,null);assert.equal(query(store,'2025-01-03').items[0].index_only_checks,1);
  assert.equal(query(store,'2025-01-04').items[0].new_unique_candidate_urls,0);assert.equal(query(store,'2024-12-31').items[0].state,'not_tracked');
});
test('immutable shards, corruption/missing/configuration errors cannot silently become zero or not_tracked',t=>{
  const {dir,ledger}=fixture(t);track(ledger,'2025-01-01T00:00:00.000Z');add(ledger,'first','2025-01-01T12:00:00.000Z');
  const old=ledger.archive(catalog,dir,'2026-10-01T00:00:00.000Z');add(ledger,'second','2025-01-02T12:00:00.000Z');const current=ledger.archive(catalog,dir,'2026-10-01T00:00:00.000Z');
  assert.notEqual(old.history.shards[0].file,current.history.shards[0].file);assert.equal(query(new ActivityStore(old,dir),'2025-01-01').items[0].new_unique_candidate_urls,1);
  assert.throws(()=>query(new ActivityStore(current),'2025-01-01'),/ACTIVITY_HISTORY_NOT_CONFIGURED/);
  const path=join(dir,current.history.shards[0].file),bytes=readFileSync(path);bytes[bytes.length-2]^=1;writeFileSync(path,bytes);
  assert.throws(()=>query(new ActivityStore(current,dir),'2025-01-01'),/ACTIVITY_HISTORY_INTEGRITY/);
  assert.throws(()=>new ActivityStore({...current,history:{...current.history,shards:[{...current.history.shards[0],file:'../../secret'}]}},dir),/ACTIVITY_HISTORY_MANIFEST/);
});

test('all seven tools serve the archived history through real HTTP MCP, and missing shards are tool errors',async t=>{
  const {Client,StreamableHTTPClientTransport}=await import('@modelcontextprotocol/client');
  const {createHttpHandler}=await import('../dist/http.js'),{HealthStore}=await import('../dist/health.js');
  const {dir,ledger}=fixture(t);track(ledger,'2025-01-01T00:00:00.000Z');add(ledger,'first','2025-01-01T12:00:00.000Z');
  const snapshot=ledger.archive(catalog,dir),store=new ActivityStore(snapshot,dir),handler=createHttpHandler(catalog,new HealthStore(),['example.com'],undefined,store),client=new Client({name:'archive-inspection-fixture',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL('https://example.com/mcp'),{fetch:(input,init)=>handler.fetch(new Request(input,init))}));assert.equal((await client.listTools()).tools.length,7);
    const calls=[['search_sources',{limit:1}],['get_source',{source_id:source.id}],['list_countries',{limit:1}],['get_endpoint_health',{endpoint_ids:[endpoint.id]}],['get_country_source_inventory',{country:'US'}],['get_source_article_activity',{source_id:source.id,start_date:'2025-01-01',end_date:'2025-01-01'}],['get_country_article_activity',{country:'US',start_date:'2025-01-01',end_date:'2025-01-01'}]];
    for(const [name,args]of calls){const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,name);if(name.endsWith('_article_activity'))assert.ok(result.structuredContent.items[0].new_unique_candidate_urls>0);}
    unlinkSync(join(dir,snapshot.history.shards[0].file));const result=await client.callTool({name:'get_country_article_activity',arguments:{country:'US',start_date:'2025-01-01',end_date:'2025-01-01'}});assert.equal(result.isError,true);assert.match(result.content[0].text,/ACTIVITY_HISTORY_READ_FAILURE/);
  }finally{await client.close();await handler.close();}
});
