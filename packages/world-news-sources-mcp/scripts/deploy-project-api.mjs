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
  ...['catalog','status','health','http','server','metrics','activity'].map(x=>`dist/${x}.js`),'dist/hosted.mjs',
  'metadata/registry.json','metadata/legacy-health.json','metadata/health.json','metadata/activity.json',
  ...['index.html','support.html','privacy.html','terms.html','styles.css','icon.svg'].map(x=>`public/${x}`),
  'public/.well-known/openai-apps-challenge']);
export const expectedBundlePaths=()=>[...ALLOWED];
export async function collectBundle(directory,allowed=ALLOWED){
  const files=[];
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
      if(!s.isFile()||!allowed.has(file))throw Error('Bundle contains an unapproved file');
      const bytes=await readFile(join(directory,file));
      if(bytes.length>12*1024*1024)throw Error('Bundle file exceeds limit');
      files.push({file,data:bytes.toString('base64'),encoding:'base64'});
    }
  }
  await walk();
  for(const required of ALLOWED)if(!files.some(x=>x.file===required))throw Error('Bundle is incomplete');
  return files;
}
export function createBody(files){
  // Omit env, build.env, projectSettings, alias, domains, git and account fields.
  // Existing project environment and domain configuration remain authoritative.
  const body={name:NAME,project:PROJECT,target:'production',files};
  const serialized=JSON.stringify(body);
  if(Buffer.byteLength(serialized)>24*1024*1024)throw Error('Deployment request exceeds local safety limit');
  return serialized;
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
  const files=await collectBundle(directory);const body=createBody(files);
  const digest=createHash('sha256').update(body).digest('hex');const api=client(token,fetchImpl);
  await preflight(api);
  let state;
  try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Invalid submission state');}
  const save=async(value)=>{await mkdir(resolve(stateFile,'..'),{recursive:true,mode:0o700});await writeFile(`${stateFile}.tmp`,JSON.stringify(value)+'\n',{mode:0o600});await rename(`${stateFile}.tmp`,stateFile);};
  if(state&&state.digest!==digest)throw Error('Payload changed; review and choose a new submission state file');
  if(state&&!state.id)throw Error('Prior submission outcome uncertain; reconcile project deployments before retrying');
  if(!state){
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
      const files=await collectBundle(directory);const body=createBody(files);
      await preflight(client(process.env.VERCEL_TOKEN));console.log(JSON.stringify({project:PROJECT,files:files.length,requestBytes:Buffer.byteLength(body),status:'preflight-passed-no-deployment'}));
    }else if(mode){throw Error('Unknown mode');}
    else console.log(JSON.stringify(await deploy({directory,stateFile,token:process.env.VERCEL_TOKEN})));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
