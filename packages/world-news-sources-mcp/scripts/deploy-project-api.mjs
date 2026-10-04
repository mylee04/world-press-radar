// Narrow project-scoped deployment. Keep submission state to avoid ambiguous POST retries.
import {readdir,readFile,lstat,writeFile,rename,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const PROJECT='prj_BJ4NiHnL2RbmtjojGUogPS2faQJs';
export const TEAM='team_L8qng538xRzhNBoq38X6p8sN';
const NAME='world-news-sources-mcp';
const DOMAINS=['news.bymyleslee.com','world-news-sources-mcp.vercel.app'];
const ALLOWED=new Set(['package.json','package-lock.json','vercel.json',
  'api/mcp.mjs','api/health.mjs',
  ...['catalog','status','health','http','server','metrics','activity','activity-history'].map(x=>`dist/${x}.js`),'dist/hosted.mjs',
  'metadata/registry.json','metadata/legacy-health.json','metadata/health.json','metadata/activity.json',
  ...['index.html','support.html','privacy.html','terms.html','styles.css','icon.svg'].map(x=>`public/${x}`),
  'public/.well-known/openai-apps-challenge']);
export const expectedBundlePaths=()=>[...ALLOWED];
export async function collectBundle(directory,allowed=ALLOWED){
  const files=[];
  const archiveAllowed=new Map();
  let metadata;try{metadata=JSON.parse(await readFile(join(directory,'metadata/activity.json'),'utf8'));}catch{throw Error('Invalid activity metadata');}
  for(const shard of metadata?.history?.shards??[]){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(shard.month)||!/^[a-f0-9]{64}$/.test(shard.sha256)||shard.file!==`${shard.month}-${shard.sha256}.json.gz`||archiveAllowed.has(shard.file)||!Number.isInteger(shard.bytes)||shard.bytes<1||shard.bytes>10*1024*1024)throw Error('Invalid history shard manifest');
    archiveAllowed.set(`metadata/activity-history/${shard.file}`,shard);
  }
  async function walk(relative=''){
    for(const name of (await readdir(join(directory,relative))).sort()){
      const file=relative?`${relative}/${name}`:name;
      // Project link is local-only metadata and is never uploaded.
      if(file==='.vercel'){const s=await lstat(join(directory,file));if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe project link');continue;}
      const s=await lstat(join(directory,file));
      if(file==='.gitignore'){
        if(!s.isFile()||s.isSymbolicLink()||s.size>100||String(await readFile(join(directory,file),'utf8')).trim()!=='.vercel')throw Error('Unexpected local ignore file');
        continue;
      }
      if(s.isSymbolicLink())throw Error('Bundle contains a symlink');
      if(s.isDirectory()){await walk(file);continue;}
      if(!s.isFile()||!allowed.has(file)&&!archiveAllowed.has(file)&&file!=='public/demo/world-news-sources.mp4')throw Error('Bundle contains an unapproved file');
      const bytes=await readFile(join(directory,file));
      const shard=archiveAllowed.get(file);if(shard&&(bytes.length!==shard.bytes||createHash('sha256').update(bytes).digest('hex')!==shard.sha256))throw Error('History shard integrity mismatch');
      if(bytes.length>12*1024*1024)throw Error('Bundle file exceeds limit');
      files.push({file,data:bytes.toString('base64'),encoding:'base64'});
    }
  }
  await walk();
  for(const required of [...ALLOWED,...archiveAllowed.keys()])if(!files.some(x=>x.file===required))throw Error('Bundle is incomplete');
  return files;
}
export function createBody(files){
  // Omit env, build.env, projectSettings, alias, domains, git and account fields.
  // Existing project environment and domain configuration remain authoritative.
  const body={name:NAME,project:PROJECT,target:'production',files};
  const serialized=JSON.stringify(body);
  if(Buffer.byteLength(serialized)>9*1024*1024)throw Error('Deployment request exceeds local safety limit');
  return serialized;
}
export function deploymentPlan(files){
  const sourceBytes=files.reduce((n,f)=>n+Buffer.from(f.data,'base64').length,0);
  if(sourceBytes>80*1024*1024)throw Error('Free source capacity budget reached; retain history and current deployment, review storage before proceeding');
  const uploads=[];
  const references=files.map(f=>{
    if(!f.file.startsWith('metadata/activity-history/')&&f.file!=='public/demo/world-news-sources.mp4'&&Buffer.from(f.data,'base64').length<=256*1024)return f;
    const bytes=Buffer.from(f.data,'base64'),sha=createHash('sha1').update(bytes).digest('hex');uploads.push({file:f.file,bytes,sha});
    return {file:f.file,sha,size:bytes.length};
  });
  return {body:createBody(references),uploads,sourceBytes};
}
export async function uploadArchive({bytes,sha},token,fetchImpl=fetch){
  let response;
  try{response=await fetchImpl(`https://api.vercel.com/v2/files?teamId=${TEAM}`,{method:'POST',body:bytes,
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'x-vercel-digest':sha},
    redirect:'error',signal:AbortSignal.timeout(60000)});}catch{throw Error('Content-addressed archive upload unavailable; no deployment was submitted');}
  if(response.status!==200)throw Error(`Archive upload HTTP ${response.status}; no deployment was submitted`);
  // The documented successful response may have an empty body. Never expose it or credentials.
}
export function client(token,fetchImpl=fetch){
  if(!token||/[\r\n]/.test(token))throw Error('Missing or invalid credential');
  return async(path,{method='GET',body}={})=>{
    let response;
    try{response=await fetchImpl(`https://api.vercel.com${path}`,{method,body,
      headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},
      redirect:'error',signal:AbortSignal.timeout(60000)});}catch{throw Error('Vercel request did not return a response; inspect submission state before retrying');}
    if(!response.ok)throw Error(`Vercel API HTTP ${response.status}`);
    try{return await response.json();}catch{throw Error('Invalid Vercel API response');}
  };
}
export async function preflight(api){
  const p=await api(`/v9/projects/${PROJECT}`);
  if(p.id!==PROJECT||p.accountId!==TEAM||p.name!==NAME)throw Error('Project identity mismatch');
  for(const key of ['METRICS_COLLECTOR_URL','METRICS_WRITE_SECRET'])
    if(!(p.env??[]).some(x=>x.key===key&&(x.target??[]).includes('production')))throw Error('Required production metrics environment key missing');
  const d=await api(`/v9/projects/${PROJECT}/domains`);
  for(const name of DOMAINS)if(!(d.domains??[]).some(x=>x.name===name))throw Error('Expected production domain missing');
}
export async function deploy({directory,stateFile,token,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),polls=120}){
  const files=await collectBundle(directory);const {body,uploads}=deploymentPlan(files);
  const digest=createHash('sha256').update(body).digest('hex');const api=client(token,fetchImpl);
  await preflight(api);
  let state;
  try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Invalid submission state');}
  const save=async(value)=>{await mkdir(resolve(stateFile,'..'),{recursive:true,mode:0o700});await writeFile(`${stateFile}.tmp`,JSON.stringify(value)+'\n',{mode:0o600});await rename(`${stateFile}.tmp`,stateFile);};
  if(state&&state.digest!==digest)throw Error('Payload changed; review and choose a new submission state file');
  if(state&&!state.id)throw Error('Prior submission outcome uncertain; reconcile project deployments before retrying');
  if(!state){
    // Fixed SHA uploads are idempotent. A failure here has not started a deployment;
    // rerunning may upload the same bytes, never broaden credentials or retry deploy POST.
    for(const file of uploads)await uploadArchive(file,token,fetchImpl);
    state={digest,status:'submission-intent',project:PROJECT};await save(state);
    // Intentionally no automatic POST retries after 429, 5xx or network uncertainty.
    const d=await api('/v13/deployments',{method:'POST',body});
    if(typeof d.id!=='string'||!d.id.startsWith('dpl_'))throw Error('Deployment response missing ID; reconcile before retrying');
    state={...state,id:d.id,status:'submitted'};await save(state);
  }
  for(let i=0;i<polls;i++){
    const d=await api(`/v13/deployments/${encodeURIComponent(state.id)}`);
    if(d.projectId!==PROJECT||d.target!=='production')throw Error('Deployment identity or target mismatch');
    if(d.readyState==='READY'){
      if(d.aliasError)throw Error('Production alias assignment failed');
      if(d.aliasAssigned===true&&DOMAINS.every(name=>(d.alias??[]).includes(name))){
        await preflight(api);await save({...state,status:'ready'});
        return {id:state.id,project:PROJECT,status:'READY'};
      }
    }
    if(['ERROR','CANCELED'].includes(d.readyState))throw Error(`Deployment ended ${d.readyState}`);
    await sleep(5000);
  }
  throw Error('Deployment or production aliases not ready before timeout; saved ID can be resumed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [directory,stateFile,mode]=process.argv.slice(2);
  if(!directory||!stateFile){console.error('Use deploy-project-api.mjs BUNDLE STATE_FILE [--preflight]');process.exitCode=2;}
  else try{
    if(mode==='--preflight'){
      const files=await collectBundle(directory);const {body,uploads,sourceBytes}=deploymentPlan(files);
      await preflight(client(process.env.VERCEL_TOKEN));console.log(JSON.stringify({project:PROJECT,files:files.length,archiveFiles:uploads.length,sourceBytes,requestBytes:Buffer.byteLength(body),status:'preflight-passed-no-deployment'}));
    }else if(mode){throw Error('Unknown mode');}
    else console.log(JSON.stringify(await deploy({directory,stateFile,token:process.env.VERCEL_TOKEN})));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
