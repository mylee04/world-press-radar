import {openSync,closeSync,readFileSync,writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {prepareRegistryAdditions} from '../dist/operator-additions.js';

const args=process.argv.slice(2);
if(args.length<1||args.length>2||args.length===2&&args[1]!=='--apply')throw new Error('Usage: node scripts/add-registry-sources.mjs BATCH.json [--apply]; defaults to a local dry run');
const batch=JSON.parse(readFileSync(resolve(args[0]),'utf8'));
const path=process.env.WNS_REGISTRY_PATH??fileURLToPath(new URL('../../../data/rss-atlas.json',import.meta.url));
const applying=args.includes('--apply'), lock=path+'.status.lock',temp=path+'.additions.tmp';
let fd=null,createdTemp=false;
try{
  if(applying)fd=openSync(lock,'wx',0o600);
  const before=readFileSync(path,'utf8');
  const result=prepareRegistryAdditions(before,batch);
  if(applying&&result.changed){
    writeFileSync(temp,JSON.stringify(result.registry,null,2)+'\n',{flag:'wx'});createdTemp=true;
    if(readFileSync(path,'utf8')!==before)throw new Error('Concurrent registry change; original preserved');
    renameSync(temp,path);
  }
  console.log(JSON.stringify({batch_id:result.batch_id,mode:applying?'local_apply':'dry_run',changed:applying&&result.changed,
    proposed_registrations:result.sources.length,endpoint_ids:result.endpoint_ids,
    new_sources:result.sources.map(({id,name,countryCode,enabled_changed_at})=>({id,name,country:countryCode,
      initial_enabled_at:applying?enabled_changed_at:null})),
    activity:'No ledger changes. The authoritative collector must initialize each new binding as an excluded baseline.'},null,2));
}finally{
  if(fd!==null){closeSync(fd);unlinkSync(lock);}
  if(createdTemp&&existsSync(temp))unlinkSync(temp);
}
