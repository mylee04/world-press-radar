// One bounded robots policy review for already-validated endpoints. No XML/article fetches or mutations.
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fetchXml} from '../dist/validate.js';
import {createHostGate} from '../dist/host-gate.js';
const batch=JSON.parse(readFileSync(new URL('registry-additions.json',import.meta.url),'utf8'));
const hostGate=createHostGate(2000);let requests=0;const budget=16;
const gate=async(h,d)=>{if(requests>=budget)throw Error('ROBOTS_REVIEW_BUDGET');requests++;return hostGate(h,d);};
import {robotsPolicy as policy} from './robots-policy.mjs';
const results=[];const origins=[...new Set(batch.additions.flatMap(a=>a.endpoints.map(e=>new URL(e.url).origin)))];
for(const origin of origins){const url=origin+'/robots.txt';try{const r=await fetchXml(url,12000,1024*1024,gate);const checked_at=new Date().toISOString();const endpoints=batch.additions.flatMap(a=>a.endpoints).filter(e=>new URL(e.url).origin===origin).map(e=>({endpoint_id:e.endpoint_id,url:e.url,...(r.status===200?policy(r.body.toString(),e.url):{decision:[404,410].includes(r.status)?'allowed_robots_absent':'unknown',matched_rule:null})}));results.push({url,final_url:r.finalUrl,status:r.status,checked_at,sha256:createHash('sha256').update(r.body).digest('hex'),endpoints});}catch(e){results.push({url,status:null,checked_at:new Date().toISOString(),reason:e.code??e.message,endpoints:batch.additions.flatMap(a=>a.endpoints).filter(x=>new URL(x.url).origin===origin).map(x=>({endpoint_id:x.endpoint_id,url:x.url,decision:'unknown'}))});}
 const path=new URL('robots-review.json',import.meta.url),temp=new URL('robots-review.json.tmp',import.meta.url);writeFileSync(temp,JSON.stringify({budget,governed_requests:requests,global_concurrency:1,per_host_concurrency:1,minimum_host_gap_ms:2000,no_registry_mutation:true,no_xml_refetch:true,results},null,2)+'\n');renameSync(temp,path);
 console.log(JSON.stringify({host:new URL(url).hostname,status:results.at(-1).status,decisions:results.at(-1).endpoints.map(e=>e.decision)}));
}
