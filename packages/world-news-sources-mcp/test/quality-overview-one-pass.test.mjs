import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRegistry} from '../dist/catalog.js';
import {ActivityStore} from '../dist/activity.js';
import {HealthStore} from '../dist/health.js';
import {getCountryQualityOverview,getAllCountryQualityOverview} from '../dist/quality.js';
import {createQualityHandler} from '../dist/quality-http.js';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const now=Date.parse('2026-10-13T12:00:00Z');
test('HTTP overview contains all >50 countries in one evaluation while MCP limit and 60KB paging remain bounded',async()=>{
  const countries=Array.from({length:73},(_,i)=>({code:`C${String(i).padStart(2,'0')}`,name:`Country ${i}`,feeds:[{name:`Publisher ${i}`,url:`https://publisher-${i}.example/rss`}]}));
  const catalog=normalizeRegistry({countries}),activity=new ActivityStore(),health=new HealthStore();
  const all=getAllCountryQualityOverview(catalog,activity,health,{date:'2026-10-12'},now);
  assert.equal(all.items.length,73);assert.equal(all.total,73);assert.equal(all.next_offset,null);assert.equal(all.common_collector_signal.total_catalog_countries,73);
  const paged=[];let offset=0,pages=0;
  do{
    const result=getCountryQualityOverview(catalog,activity,health,{date:'2026-10-12',offset,limit:50},now);pages++;
    assert.ok(result.items.length<=50);assert.ok(Buffer.byteLength(JSON.stringify(result.items))<60002);assert.equal(result.common_collector_signal.total_catalog_countries,73);
    paged.push(...result.items);offset=result.next_offset;
  }while(offset!==null);
  assert.ok(pages>2,'60KB byte budget requires more than the nominal two 50-row pages');assert.deepEqual(paged,all.items);
  assert.throws(()=>getCountryQualityOverview(catalog,activity,health,{limit:73},now));
  assert.throws(()=>getCountryQualityOverview(catalog,activity,health,{all:true},now));
  const single=getCountryQualityOverview(catalog,activity,health,{country:'C00',date:'2026-10-12'},now);assert.equal(single.items.length,1);assert.equal(single.common_collector_signal.total_catalog_countries,73);
  const handler=createQualityHandler(catalog,health,activity,{countries},false,false);
  const response=await handler(new Request('http://127.0.0.1:3400/quality/api/overview?date=2026-10-12'));assert.equal(response.status,200);const body=await response.json();assert.equal(body.items.length,73);assert.equal(new Set(body.items.map(row=>row.country)).size,73);assert.equal(body.next_offset,null);assert.equal(body.common_collector_signal.total_catalog_countries,73);
});

test('actual local daily CLI saves all >50 countries with no MCP/model calls after one-pass overview',async()=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'wns-one-pass-daily-'));
  try{
    const countries=Array.from({length:73},(_,i)=>({code:`C${String(i).padStart(2,'0')}`,name:`Country ${i}`,feeds:[{name:`Publisher ${i}`,url:`https://publisher-${i}.example/rss`}]}));
    const registry=join(directory,'registry.json'),health=join(directory,'health.json'),legacy=join(directory,'legacy.json');
    await writeFile(registry,JSON.stringify({countries}));await writeFile(health,JSON.stringify({version:1,observations:[]}));await writeFile(legacy,JSON.stringify({results:[]}));
    const command=fileURLToPath(new URL('../scripts/quality-daily.mjs',import.meta.url));
    const env={PATH:process.env.PATH,TZ:'UTC',WNS_REGISTRY_PATH:registry,WNS_HEALTH_PATH:health,WNS_LEGACY_HEALTH_PATH:legacy,WNS_ACTIVITY_PATH:join(directory,'missing-activity.json'),WNS_OPENAI_PAID_APPROVED:'0',WNS_JEV_PAID_APPROVED:'0'};
    const {stdout}=await promisify(execFile)(process.execPath,[command,'--local','--date=2026-10-12',`--output=${directory}/reports`,`--history=${directory}/history.sqlite`],{env,timeout:20000});
    const receipt=JSON.parse(stdout.trim()),report=JSON.parse(await readFile(receipt.report_path,'utf8'));
    assert.equal(receipt.status,'completed');assert.equal(receipt.model_calls,0);assert.equal(report.overview.items.length,73);assert.equal(new Set(report.overview.items.map(row=>row.country)).size,73);assert.equal(report.overview.next_offset,null);assert.equal(report.overview.common_collector_signal.total_catalog_countries,73);
  }finally{await rm(directory,{recursive:true,force:true});}
});
