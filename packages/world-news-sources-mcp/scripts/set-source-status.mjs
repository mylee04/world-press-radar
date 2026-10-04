import { openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { updateRegistryStatus } from '../dist/operator-status.js';

const [sourceId,state,...reasonParts]=process.argv.slice(2);
if(!sourceId || !['enabled','disabled'].includes(state) || !reasonParts.length) throw new Error('Usage: npm run source:status -- SOURCE_ID enabled|disabled "reason"');
const path=process.env.WNS_REGISTRY_PATH ?? fileURLToPath(new URL('../../../data/rss-atlas.json',import.meta.url));
const lock=path+'.status.lock';const temp=path+'.status.tmp';
const fd=openSync(lock,'wx',0o600);
let createdTemp=false;
try {
  const before=readFileSync(path,'utf8');
  const after=updateRegistryStatus(JSON.parse(before),sourceId,state==='enabled',reasonParts.join(' '));
  writeFileSync(temp,JSON.stringify(after,null,2)+'\n',{flag:'wx'});
  createdTemp=true;
  if(readFileSync(path,'utf8')!==before) throw new Error('Registry changed during edit; original preserved');
  renameSync(temp,path);
  console.log(JSON.stringify({source_id:sourceId,enabled:state==='enabled',registry:path}));
} finally { closeSync(fd);unlinkSync(lock);if(createdTemp&&existsSync(temp))unlinkSync(temp); }
