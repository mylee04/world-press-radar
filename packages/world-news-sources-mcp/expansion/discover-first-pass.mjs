// Bounded operator discovery only; does not change registry, health snapshots or deploy.
import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeRegistry,canonicalUrl,stableId} from '../dist/catalog.js';
import {fetchXml,safeUrl} from '../dist/validate.js';
import {createHostGate} from '../dist/host-gate.js';
import {auditEndpoint} from '../dist/audit-check.js';
const seeds=[
 {country:'US',name:'Grist',home:'https://grist.org/',language:'en',kind:'new_publisher'},
 {country:'GB',name:'The Bureau of Investigative Journalism',home:'https://www.thebureauinvestigates.com/',language:'en',kind:'new_publisher'},
 {country:'CA',name:'The Narwhal',home:'https://thenarwhal.ca/',language:'en',kind:'new_publisher'},
 {country:'FR',name:'Reporterre',home:'https://reporterre.net/',language:'fr',kind:'new_publisher'},
 {country:'DE',name:'CORRECTIV',home:'https://correctiv.org/',language:'de',kind:'new_publisher'},
 {country:'IT',name:'Il Post',home:'https://www.ilpost.it/',language:'it',kind:'new_publisher'},
 {country:'JP',name:'Nippon.com - Japanese',home:'https://www.nippon.com/ja/',language:'ja',kind:'additional_language'},
 {country:'US',name:'War on the Rocks',home:'https://warontherocks.com/',language:'en',kind:'failed_endpoint_alternative'},
 {country:'GB',name:'Halifax Courier',home:'https://www.halifaxcourier.co.uk/',language:'en',kind:'failed_endpoint_alternative'},
 {country:'CA',name:'The Georgia Straight',home:'https://www.straight.com/',language:'en',kind:'failed_endpoint_alternative'},
 {country:'FR',name:'Capital',home:'https://www.capital.fr/',language:'fr',kind:'failed_endpoint_alternative'},
 {country:'DE',name:'Kölner Stadt-Anzeiger',home:'https://www.ksta.de/',language:'de',kind:'failed_endpoint_alternative'},
 {country:'IT',name:'Il Giornale',home:'https://www.ilgiornale.it/',language:'it',kind:'failed_endpoint_alternative'},
 {country:'JP',name:'The Mainichi - Official RSS guide',home:'https://mainichi.jp/english/rss/',language:'en',kind:'failed_endpoint_alternative'},
];
const catalog=normalizeRegistry(JSON.parse(readFileSync(new URL('../../../data/rss-atlas.json',import.meta.url),'utf8'))),gate=createHostGate(2000);
let requests=0;const budget=96;
const governed=async(host,deadline)=>{if(requests>=budget)throw Error('DISCOVERY_BUDGET_EXHAUSTED');requests++;return gate(host,deadline);};
const path=new URL('first-pass-checkpoints.json',import.meta.url);let results=existsSync(path)?JSON.parse(readFileSync(path,'utf8')).results:[];
const previous=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{},priorRequests=previous.lifetime_governed_attempts??previous.requests_this_invocation??0;
const save=()=>{const temp=new URL(path.href+'.tmp');writeFileSync(temp,JSON.stringify({scope:'G7 first bounded pass in approved registered-major20 countries',no_registry_mutation:true,request_budget_per_invocation:budget,requests_this_invocation:requests,lifetime_governed_attempts:priorRequests+requests,global_concurrency:2,per_host_concurrency:1,host_gap_ms:2000,results},null,2)+'\n');renameSync(temp,path);};
const decode=v=>v.replace(/&amp;|&#38;|&#x26;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'");
function links(body,base){
 const out=[];
 for(const tag of body.match(/<(?:link|a)\b[^>]*>/gi)??[]){
  const attrs=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(['"])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),decode(m[3])]));
  if(!attrs.href||/comments/i.test(attrs.href+' '+(attrs.title??'')))continue;
  const isFeed=/application\/(?:rss|atom|rdf)\+xml/i.test(attrs.type??'')||(/\brss\b|\bfeed\b/i.test(attrs.title??'')&&/^<a/i.test(tag));
  if(!isFeed)continue;
  try{const url=canonicalUrl(new URL(attrs.href,base).href);safeUrl(url);if(!out.some(x=>x.url===url))out.push({url,kind:'official_html_feed_link',source_url:base,tag:tag.slice(0,512)});}catch{}
 }
 return out.slice(0,3);
}
function robots(text){
 const groups=[];let agents=[],rules=[],hasRules=false;
 for(const raw of text.split(/\r?\n/)){const line=raw.replace(/#.*$/,'').trim(),m=line.match(/^([^:]+):\s*(.*)$/);if(!m)continue;const key=m[1].toLowerCase(),value=m[2].trim();
  if(key==='user-agent'){if(hasRules){groups.push({agents,rules});agents=[];rules=[];hasRules=false;}agents.push(value.toLowerCase());}
  else if(['allow','disallow'].includes(key)&&agents.length){rules.push({allow:key==='allow',path:value});hasRules=true;}
 }
 if(agents.length)groups.push({agents,rules});const specific=groups.filter(g=>g.agents.some(a=>a!=='*'&&'worldnewssourcesmcp'.startsWith(a)));return(specific.length?specific:groups.filter(g=>g.agents.includes('*'))).flatMap(g=>g.rules);
}
function permitted(url,rules){const path=new URL(url).pathname+new URL(url).search;const applicable=rules.filter(r=>r.path&&path.startsWith(r.path.replace(/\$$/,''))).sort((a,b)=>b.path.length-a.path.length||+b.allow-+a.allow);return !applicable.length||applicable[0].allow;}
async function resource(url){try{const r=await fetchXml(url,12000,2*1024*1024,governed);return{url,final_url:r.finalUrl,status:r.status,checked_at:new Date().toISOString(),sha256:createHash('sha256').update(r.body).digest('hex'),text:r.body.toString('utf8')};}catch(e){return{url,status:null,checked_at:new Date().toISOString(),reason:/^[A-Z_0-9]+$/.test(e.message)?e.message:e.code??'NETWORK_OR_PARSE_ERROR',text:''};}}
async function discover(seed){
 const home=await resource(seed.home),robotUrl=new URL('/robots.txt',home.final_url??seed.home).href,robot=await resource(robotUrl),rules=robots(robot.text);
 const candidates=links(home.text,home.final_url??seed.home).map(x=>({...x,type:'rss',found_at:home.checked_at,page_sha256:home.sha256}));
 const sitemapLines=robot.text.split(/\r?\n/).filter(x=>/^\s*sitemap:/i.test(x)).slice(0,2);
 for(const line of sitemapLines){try{const url=canonicalUrl(line.replace(/^\s*sitemap:\s*/i,''));safeUrl(url);candidates.push({url,type:'sitemap',kind:'official_robots_sitemap',source_url:robot.final_url??robotUrl,found_at:robot.checked_at,page_sha256:robot.sha256,declaration:line.slice(0,512)});}catch{}}
 const checked=[];
 for(const item of candidates){
  if(!permitted(item.url,rules)&&new URL(item.url).host===new URL(robotUrl).host){checked.push({...item,skipped:'ROBOTS_DISALLOWED'});continue;}
  const endpoint={id:stableId('ep',[item.type,item.url]),type:item.type,url:item.url},observation=await auditEndpoint(endpoint,governed);
  checked.push({...item,endpoint_id:endpoint.id,already_cataloged:catalog.endpoints.has(endpoint.id),observation});
  // Follow at most one explicitly enumerated index child, never an article URL or guessed path.
  if(item.type==='sitemap'&&observation.format==='sitemapindex'&&observation.auditStatus==='working_nonempty'){
   const child=[...(observation.sampleUrls??[])].sort((a,b)=>+(/news|post|article/i.test(b)) - +(/news|post|article/i.test(a)))[0];
   if(child){const e={id:stableId('ep',['sitemap',child]),type:'sitemap',url:child};const o=await auditEndpoint(e,governed);checked.push({type:'sitemap',url:child,kind:'official_sitemap_index_child',source_url:item.url,found_at:observation.checkedAt,endpoint_id:e.id,already_cataloged:catalog.endpoints.has(e.id),observation:o});}
  }
 }
 const clean=r=>{const {text,...metadata}=r;return metadata;};return{...seed,home:clean(home),robots:clean(robot),declared_candidates:candidates.length,checked};
}
let next=0;
await Promise.all([0,1].map(async()=>{while(next<seeds.length){const seed=seeds[next++];if(results.some(r=>r.country===seed.country&&r.name===seed.name))continue;const result=await discover(seed);results.push(result);save();console.log(JSON.stringify({country:seed.country,name:seed.name,candidates:result.checked.length,valid_nonempty:result.checked.filter(c=>c.observation?.auditStatus==='working_nonempty'&&c.observation.format!=='sitemapindex').length,new_endpoints:result.checked.filter(c=>!c.already_cataloged&&c.observation?.auditStatus==='working_nonempty'&&c.observation.format!=='sitemapindex').length,requests}));}}));save();
