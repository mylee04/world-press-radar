import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {PROJECT,TEAM,collectBundle,createBody,deploy,client,preflight,expectedBundlePaths} from '../scripts/deploy-project-api.mjs';
const project={id:PROJECT,name:'world-news-sources-mcp',accountId:TEAM,
  env:['METRICS_WRITE_SECRET','METRICS_COLLECTOR_URL'].map(key=>({key,target:['production']}))};
const domains={domains:['news.bymyleslee.com','world-news-sources-mcp.vercel.app'].map(name=>({name}))};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'wns-api-'));t.after(()=>rm(root,{recursive:true,force:true}));const bundle=join(root,'bundle');for(const p of expectedBundlePaths()){await mkdir(dirname(join(bundle,p)),{recursive:true});await writeFile(join(bundle,p),p==='metadata/activity.json'?'null':'example');}return {directory:bundle,stateFile:join(root,'state/run.json'),token:'test-credential-not-real',sleep:async()=>{}};}
function mock(calls,mutation){return async(url,opts)=>{const path=new URL(url).pathname;calls.push({path,method:opts.method,body:opts.body});let data;if(path===`/v9/projects/${PROJECT}`)data=project;else if(path.endsWith('/domains'))data=domains;else data=await mutation(path,opts);return new Response(JSON.stringify(data),{status:200});};}
test('exact generated whitelist excludes local link and rejects unexpected secret files and symlinks',async t=>{const f=await fixture(t);await mkdir(join(f.directory,'.vercel'));await writeFile(join(f.directory,'.vercel/project.json'),'local-only');assert.equal((await collectBundle(f.directory)).length,expectedBundlePaths().length);await writeFile(join(f.directory,'.env'),'do-not-upload');await assert.rejects(collectBundle(f.directory),/unapproved/);await rm(join(f.directory,'.env'));await symlink('/etc/passwd',join(f.directory,'metadata/leak.json'));await assert.rejects(collectBundle(f.directory),/symlink/);});
test('payload omits environment/settings/domain changes and uses exact project production target',()=>{const d=JSON.parse(createBody([{file:'example',data:'AA==',encoding:'base64'}]));assert.deepEqual(Object.keys(d).sort(),['files','name','project','target']);assert.equal(d.project,PROJECT);assert.equal(d.target,'production');});
test('ready deployment submits once, polls, checks identity and persists resume ID',async t=>{const f=await fixture(t),calls=[];f.fetchImpl=mock(calls,async path=>path==='/v13/deployments'?{id:'dpl_test'}:{id:'dpl_test',projectId:PROJECT,target:'production',readyState:'READY',aliasAssigned:true,alias:domains.domains.map(x=>x.name)});assert.equal((await deploy(f)).status,'READY');assert.equal(calls.filter(x=>x.method==='POST').length,1);await deploy(f);assert.equal(calls.filter(x=>x.method==='POST').length,1);assert.equal(JSON.parse(await readFile(f.stateFile,'utf8')).status,'ready');assert.ok(calls.every(x=>!x.path.includes('/user')));});
test('uncertain POST is durably blocked from blind retries and errors cannot leak token',async t=>{const f=await fixture(t),calls=[];f.fetchImpl=mock(calls,async()=>{throw Error(f.token);});await assert.rejects(deploy(f),e=>!e.message.includes(f.token));await assert.rejects(deploy(f),/uncertain/);assert.equal(calls.filter(x=>x.method==='POST').length,1);});
test('403 never falls back to broader credentials or raw server message',async()=>{const api=client('test-private-value',async()=>new Response('test-private-value',{status:403}));await assert.rejects(api('/v13/deployments'),e=>e.message==='Vercel API HTTP 403');});
test('preflight blocks wrong owner and missing production metrics before mutation',async()=>{await assert.rejects(preflight(async()=>({...project,accountId:'other'})),/identity/);await assert.rejects(preflight(async()=>({...project,env:[]})),/environment/);});
test('failed build and alias failure cannot report successful deployment',async t=>{for(const extra of [{readyState:'ERROR'},{readyState:'READY',aliasError:{code:'error'}}]){const f=await fixture(t);f.fetchImpl=mock([],async path=>path==='/v13/deployments'?{id:'dpl_test'}:{projectId:PROJECT,target:'production',...extra});await assert.rejects(deploy(f),/ended|alias/);}});
test('changed payload on resume requires review and no second POST',async t=>{const f=await fixture(t),calls=[];f.fetchImpl=mock(calls,async path=>path==='/v13/deployments'?{id:'dpl_test'}:{projectId:PROJECT,target:'production',readyState:'READY',aliasAssigned:true,alias:domains.domains.map(x=>x.name)});await deploy(f);await writeFile(join(f.directory,'metadata/health.json'),'changed');await assert.rejects(deploy(f),/Payload changed/);assert.equal(calls.filter(x=>x.method==='POST').length,1);});
test('READY without production aliases cannot report success',async t=>{const f=await fixture(t);f.polls=1;f.fetchImpl=mock([],async path=>path==='/v13/deployments'?{id:'dpl_test'}:{projectId:PROJECT,target:'production',readyState:'READY',aliasAssigned:false,alias:[]});await assert.rejects(deploy(f),/aliases not ready/);});
test('history deployment whitelist follows the exact manifest and verifies every shard; no extra archive or secret is uploaded',async t=>{
  const {createHash}=await import('node:crypto');const f=await fixture(t),bytes=Buffer.from('archive-test-bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
  const shard={month:'2026-10',file:`2026-10-${sha256}.json.gz`,sha256,bytes:bytes.length,records:1};
  await mkdir(join(f.directory,'metadata/activity-history'));await writeFile(join(f.directory,'metadata/activity.json'),JSON.stringify({history:{version:1,complete:true,shards:[shard]}}));const path=join(f.directory,'metadata/activity-history',shard.file);await writeFile(path,bytes);
  const files=await collectBundle(f.directory);assert.equal(files.length,expectedBundlePaths().length+1);assert.ok(files.some(f=>f.file.endsWith(shard.file)));
  await writeFile(join(f.directory,'metadata/activity-history/extra.json.gz'),'extra');await assert.rejects(collectBundle(f.directory),/unapproved/);await rm(join(f.directory,'metadata/activity-history/extra.json.gz'));
  await writeFile(path,'damaged');await assert.rejects(collectBundle(f.directory),/integrity/);await rm(path);await assert.rejects(collectBundle(f.directory),/incomplete/);
  await writeFile(join(f.directory,'metadata/activity.json'),'invalid');await assert.rejects(collectBundle(f.directory),/activity metadata/);
});
async function archivedFixture(t){
  const {createHash}=await import('node:crypto');const f=await fixture(t),bytes=Buffer.from('fixed aggregate-only fixture'),sha256=createHash('sha256').update(bytes).digest('hex'),shard={month:'2026-10',file:`2026-10-${sha256}.json.gz`,sha256,bytes:bytes.length,records:1};
  await mkdir(join(f.directory,'metadata/activity-history'));await writeFile(join(f.directory,'metadata/activity.json'),JSON.stringify({history:{version:1,complete:true,shards:[shard]}}));await writeFile(join(f.directory,'metadata/activity-history',shard.file),bytes);return {...f,bytes};
}
test('archives upload by exact SHA before one project deployment; empty success is supported and resume never reuploads',async t=>{
  const f=await archivedFixture(t),calls=[];
  f.fetchImpl=async(url,opts)=>{const path=new URL(url).pathname;calls.push({path,opts,url});if(path==='/v2/files'){assert.equal(new URL(url).searchParams.get('teamId'),TEAM);assert.equal(opts.headers['Content-Length'],String(f.bytes.length));assert.deepEqual(Buffer.from(opts.body),f.bytes);return new Response(null,{status:200});}return mock([],async p=>p==='/v13/deployments'?{id:'dpl_archive'}:{projectId:PROJECT,target:'production',readyState:'READY',aliasAssigned:true,alias:domains.domains.map(x=>x.name)})(url,opts);};
  assert.equal((await deploy(f)).status,'READY');const d=JSON.parse(calls.find(c=>c.path==='/v13/deployments').opts.body),ref=d.files.find(f=>f.file.includes('activity-history/'));assert.deepEqual(Object.keys(ref).sort(),['file','sha','size']);assert.match(ref.sha,/^[a-f0-9]{40}$/);assert.equal(ref.size,f.bytes.length);
  assert.ok(calls.findIndex(c=>c.path==='/v2/files')<calls.findIndex(c=>c.path==='/v13/deployments'));
  await deploy(f);assert.equal(calls.filter(c=>c.path==='/v2/files').length,1);assert.equal(calls.filter(c=>c.path==='/v13/deployments'&&c.opts.method==='POST').length,1);
});
test('file-upload denial/uncertainty never submits a deployment or falls back to broader credentials',async t=>{
  const f=await archivedFixture(t),calls=[];
  f.fetchImpl=async(url,opts)=>{const path=new URL(url).pathname;calls.push(path);if(path==='/v2/files')return new Response(f.token,{status:403});return mock([],async()=>({}))(url,opts);};
  await assert.rejects(deploy(f),e=>e.message.includes('Archive upload HTTP 403')&&!e.message.includes(f.token));assert.ok(!calls.includes('/v13/deployments'));
  f.fetchImpl=async(url,opts)=>{if(new URL(url).pathname==='/v2/files')throw Error(f.token);return mock([],async()=>({}))(url,opts);};await assert.rejects(deploy(f),e=>e.message.includes('no deployment was submitted')&&!e.message.includes(f.token));
  // SHA writes can be retried explicitly; there is no ambiguous deployment intent to bypass.
  f.fetchImpl=async(url,opts)=>new URL(url).pathname==='/v2/files'?new Response(null,{status:200}):mock([],async p=>p==='/v13/deployments'?{id:'dpl_retry_file'}:{projectId:PROJECT,target:'production',readyState:'READY',aliasAssigned:true,alias:domains.domains.map(x=>x.name)})(url,opts);
  assert.equal((await deploy(f)).status,'READY');
});
