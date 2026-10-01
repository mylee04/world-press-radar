// One bounded robots policy review for already-validated endpoints. No XML/article fetches or mutations.
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fetchXml} from '../dist/validate.js';
import {createHostGate} from '../dist/host-gate.js';
const batch=JSON.parse(readFileSync(new URL('registry-additions.json',import.meta.url),'utf8'));
const hostGate=createHostGate(2000);let requests=0;const budget=16;
const gate=async(h,d)=>{if(requests>=budget)throw Error('ROBOTS_REVIEW_BUDGET');requests++;return hostGate(h,d);};
const normalize=v=>encodeURI(v).replace(/%25([a-f0-9]{2})/gi,'%$1').replace(/%([a-f0-9]{2})/gi,(m,h)=>/[A-Za-z0-9._~-]/.test(String.fromCharCode(parseInt(h,16)))?String.fromCharCode(parseInt(h,16)):m.toUpperCase());
function policy(text,url){
 const groups=[];let group={agents:[],rules:[]};
 for(const raw of text.split(/\r?\n/)){const m=raw.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!m)continue;const key=m[1].trim().toLowerCase(),value=m[2].trim();if(key==='user-agent'){if(group.rules.length){groups.push(group);group={agents:[],rules:[]};}group.agents.push(value.toLowerCase());}else if(['allow','disallow'].includes(key)&&group.agents.length&&value)group.rules.push({allow:key==='allow',pattern:value});}groups.push(group);
 const specific=groups.filter(g=>g.agents.some(a=>a!=='*'&&a&&'worldnewssourcesmcp'.includes(a))),applicable=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
 const target=normalize(new URL(url).pathname+new URL(url).search);
 const matches=applicable.flatMap(g=>g.rules).filter(r=>{const pattern=normalize(r.pattern),end=pattern.endsWith('$'),body=end?pattern.slice(0,-1):pattern;return new RegExp('^'+body.split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+(end?'$':'')).test(target);}).sort((a,b)=>normalize(b.pattern).replace(/[*$]/g,'').length-normalize(a.pattern).replace(/[*$]/g,'').length||+b.allow-+a.allow);
 return{decision:matches[0]?.allow===false?'disallowed':'allowed',matched_rule:matches[0]??null};
}
const results=[];const origins=[...new Set(batch.additions.flatMap(a=>a.endpoints.map(e=>new URL(e.url).origin)))];
for(const origin of origins){const url=origin+'/robots.txt';try{const r=await fetchXml(url,12000,1024*1024,gate);const checked_at=new Date().toISOString();const endpoints=batch.additions.flatMap(a=>a.endpoints).filter(e=>new URL(e.url).origin===origin).map(e=>({endpoint_id:e.endpoint_id,url:e.url,...(r.status===200?policy(r.body.toString(),e.url):{decision:[404,410].includes(r.status)?'allowed_robots_absent':'unknown',matched_rule:null})}));results.push({url,final_url:r.finalUrl,status:r.status,checked_at,sha256:createHash('sha256').update(r.body).digest('hex'),endpoints});}catch(e){results.push({url,status:null,checked_at:new Date().toISOString(),reason:e.code??e.message,endpoints:batch.additions.flatMap(a=>a.endpoints).filter(x=>new URL(x.url).origin===origin).map(x=>({endpoint_id:x.endpoint_id,url:x.url,decision:'unknown'}))});}
 const path=new URL('robots-review.json',import.meta.url),temp=new URL('robots-review.json.tmp',import.meta.url);writeFileSync(temp,JSON.stringify({budget,governed_requests:requests,global_concurrency:1,per_host_concurrency:1,minimum_host_gap_ms:2000,no_registry_mutation:true,no_xml_refetch:true,results},null,2)+'\n');renameSync(temp,path);
 console.log(JSON.stringify({host:new URL(url).hostname,status:results.at(-1).status,decisions:results.at(-1).endpoints.map(e=>e.decision)}));
}
