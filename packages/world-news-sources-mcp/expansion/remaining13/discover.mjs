// One checkpointed pass: 13 remaining registered countries + two outstanding US candidates.
// Declaration-based public metadata only. No registry/health/ledger/deployment changes.
import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SaxesParser} from 'saxes';
import {normalizeRegistry,canonicalUrl,stableId} from '../../dist/catalog.js';
import {prepareRegistryAdditions} from '../../dist/operator-additions.js';
import {fetchXml,safeUrl} from '../../dist/validate.js';
import {createHostGate} from '../../dist/host-gate.js';
import {auditEndpoint} from '../../dist/audit-check.js';
import {inspectXml} from '../../dist/inspect.js';
import {normalizeArticleUrl} from '../../dist/article-url.js';
import {robotsPolicy} from '../robots-policy.mjs';
const before=JSON.parse(readFileSync(new URL('../second-pass-live-before.json',import.meta.url),'utf8'));
const text=readFileSync(new URL('../../../../data/rss-atlas.json',import.meta.url),'utf8');
const first=JSON.parse(readFileSync(new URL('../registry-additions.json',import.meta.url),'utf8'));
const reconstructed=prepareRegistryAdditions(text,first,new Date(before.first_batch_source.enabled_changed_at)).registry;
const catalog=normalizeRegistry(reconstructed),registryText=JSON.stringify(reconstructed,null,2)+'\n';
const seeds=[
 {country:'CN',name:'Sixth Tone',home:'https://www.sixthtone.com/',language:'en'},
 {country:'IN',name:'The Wire',home:'https://thewire.in/',language:'en'},
 {country:'IN',name:'Newslaundry',home:'https://www.newslaundry.com/',language:'en'},
 {country:'BR',name:'Brasil de Fato',home:'https://www.brasildefato.com.br/',language:'pt'},
 {country:'AU',name:'Michael West Media',home:'https://michaelwest.com.au/',language:'en'},
 {country:'KR',name:'Korea Pro',home:'https://koreapro.org/',language:'en'},
 {country:'MX',name:'Pie de Página',home:'https://piedepagina.mx/',language:'es'},
 {country:'ID',name:'Project Multatuli',home:'https://projectmultatuli.org/',language:'id'},
 {country:'TR',name:'Medyascope',home:'https://medyascope.tv/',language:'tr'},
 {country:'RU',name:'Mediazona',home:'https://zona.media/',language:'ru'},
 {country:'SA',name:'Saudi Gazette',home:'https://saudigazette.com.sa/',language:'en'},
 {country:'ZA',name:'GroundUp',home:'https://groundup.org.za/',language:'en'},
 {country:'AR',name:'elDiarioAR',home:'https://www.eldiarioar.com/',language:'es'},
 {country:'ES',name:'El Salto',home:'https://www.elsaltodiario.com/',language:'es'},
 {country:'IN',name:'The News Minute',home:'https://www.thenewsminute.com/',language:'en'},
 {country:'KR',name:'Newstapa',home:'https://newstapa.org/',language:'ko'},
 {country:'ES',name:'El Confidencial',home:'https://www.elconfidencial.com/',language:'es'},
 {country:'US',name:'Grist',home:'https://grist.org/',language:'en'},
 {country:'US',name:'War on the Rocks',home:'https://warontherocks.com/',language:'en'},
];
const path=new URL('checkpoints.json',import.meta.url),previous=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const results=previous.results??[],prior=previous.lifetime_governed_attempts??0;
const hostGate=createHostGate(2000);let requests=0;const budget=144;
const gate=async(h,d)=>{if(prior+requests>=budget)throw Error('DISCOVERY_BUDGET_EXHAUSTED');requests++;return hostGate(h,d);};
const save=()=>{const temp=new URL(path.href+'.tmp');writeFileSync(temp,JSON.stringify({phase:'registered-major20 remaining13 + outstanding US',no_registry_mutation:true,registry_sha256_before:createHash('sha256').update(registryText).digest('hex'),registry_reconstruction:'First approved additive batch, exact live enabled_changed_at; operator must verify against authoritative registry.',request_budget_per_invocation:budget,requests_this_invocation:requests,lifetime_governed_attempts:prior+requests,global_concurrency:2,per_host_concurrency:1,minimum_host_gap_ms:2000,results},null,2)+'\n');renameSync(temp,path);};
const policyCache=new Map();
async function resource(url,max=2*1024*1024){try{const r=await fetchXml(url,12000,max,gate);return{url,final_url:r.finalUrl,status:r.status,checked_at:new Date().toISOString(),sha256:createHash('sha256').update(r.body).digest('hex'),body:r.body};}catch(e){return{url,status:null,checked_at:new Date().toISOString(),reason:/^[A-Z_0-9]+$/.test(e.message)?e.message:e.code??'NETWORK_ERROR',body:Buffer.alloc(0)};}}
async function access(url){const origin=new URL(url).origin;if(!policyCache.has(origin))policyCache.set(origin,resource(origin+'/robots.txt',1024*1024));const r=await policyCache.get(origin);const decision=r.status===200?robotsPolicy(r.body.toString(),url):{decision:[404,410].includes(r.status)?'allowed_robots_absent':'unknown',matched_rule:null};return{robots_url:origin+'/robots.txt',http_status:r.status,checked_at:r.checked_at,...decision};}
const decode=v=>v.replace(/&amp;|&#38;|&#x26;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'");
function feeds(body,base){const out=[];for(const tag of body.match(/<(?:link|a)\b[^>]*>/gi)??[]){const attrs=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(['"])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),decode(m[3])]));if(!attrs.href||/comments/i.test(attrs.href+' '+(attrs.title??'')))continue;const declared=/application\/(rss|atom|rdf)\+xml/i.test(attrs.type??'')||/^<a/i.test(tag)&&/\brss\b|\batom\b|\bfeed\b/i.test(attrs.title??'');if(!declared)continue;try{const url=canonicalUrl(new URL(attrs.href,base).href);safeUrl(url);if(!out.some(e=>e.url===url))out.push({url,type:'rss',kind:'official_html_feed_link',source_url:base,tag:tag.slice(0,512)});}catch{}}return out.slice(0,2);}
function children(body){const rows=[];let entry=null,active=null;const p=new SaxesParser({xmlns:true});p.on('opentag',t=>{if(t.local==='sitemap')entry={};if(entry&&['loc','lastmod'].includes(t.local))active={name:t.local,text:''};});const add=v=>{if(active)active.text+=v;};p.on('text',add);p.on('cdata',add);p.on('closetag',t=>{if(active&&t.local===active.name){entry[active.name]=active.text.trim();active=null;}if(t.local==='sitemap'&&entry){if(entry.loc)rows.push(entry);entry=null;}});p.write(body.toString()).close();return rows;}
function rank(c){return[/google.?news|\/news(?:[._/]|$)|\/latest(?:[?/]|$)/i.test(c.loc)?5:/post|article/i.test(c.loc)?3:0,Date.parse(c.lastmod??'')||0,c.loc];}
async function check(item){const review=await access(item.url);if(!['allowed','allowed_robots_absent'].includes(review.decision))return{...item,access_review:review,skipped:'ROBOTS_'+review.decision.toUpperCase()};const endpoint={id:stableId('ep',[item.type,item.url]),type:item.type,url:item.url};const raw=await auditEndpoint(endpoint,gate,true),{observedUrls,...observation}=raw;const unique=[...new Set((observedUrls??[]).map(u=>normalizeArticleUrl(u)).filter(u=>u.kind==='candidate').map(u=>u.url))].sort();return{...item,access_review:review,endpoint_id:endpoint.id,already_cataloged:catalog.endpoints.has(endpoint.id)||[...catalog.endpoints.values()].some(e=>e.type===item.type&&e.url===observation.finalUrl),observation,parsed_unique_candidate_urls:unique.length,uncertain_url_count:(observedUrls??[]).length-unique.length,url_set_sha256:createHash('sha256').update(JSON.stringify(unique)).digest('hex')};}
async function discover(seed){const checked=[],resources=[];const homeAccess=await access(seed.home),robot=await policyCache.get(new URL(seed.home).origin);resources.push(robot);if(!['allowed','allowed_robots_absent'].includes(homeAccess.decision))return{...seed,home_access:homeAccess,resources:resources.map(({body,...r})=>r),checked,scope_result:'HOMEPAGE_POLICY_UNAVAILABLE_OR_DISALLOWED'};
 const home=await resource(seed.home);resources.push(home);if(home.status!==200)return{...seed,home_access:homeAccess,resources:resources.map(({body,...r})=>r),checked,scope_result:'HOMEPAGE_HTTP_OR_NETWORK_FAILURE'};
 const candidates=feeds(home.body.toString(),home.final_url??seed.home).map(e=>({...e,found_at:home.checked_at,page_sha256:home.sha256}));
 const maps=robot.body.toString().split(/\r?\n/).filter(l=>/^\s*sitemap:/i.test(l)).sort((a,b)=>+(/news/i.test(b))-+(/news/i.test(a))).slice(0,2);
 for(const line of maps){try{const url=canonicalUrl(line.replace(/^\s*sitemap:\s*/i,''));safeUrl(url);candidates.push({type:'sitemap',url,kind:'official_robots_sitemap',source_url:robot.final_url??robot.url,found_at:robot.checked_at,page_sha256:robot.sha256,declaration:line.slice(0,512)});}catch{}}
 for(const item of candidates){const result=await check(item);checked.push(result);if(result.observation?.format==='sitemapindex'&&result.observation.auditStatus==='working_nonempty'){const permission=await access(item.url);if(!['allowed','allowed_robots_absent'].includes(permission.decision))continue;const page=await resource(item.url);resources.push(page);try{if(page.status!==200||inspectXml(page.body,'sitemap',Date.now(),2*1024*1024).format!=='sitemapindex')continue;const row=children(page.body).sort((a,b)=>{const ar=rank(a),br=rank(b);return br[0]-ar[0]||br[1]-ar[1]||br[2].localeCompare(ar[2]);})[0];if(row){safeUrl(row.loc);checked.push(await check({type:'sitemap',url:canonicalUrl(row.loc),kind:'official_sitemap_index_enumerated_child',source_url:item.url,found_at:page.checked_at,page_sha256:page.sha256,declared_lastmod:row.lastmod??null}));}}catch(e){resources.push({url:item.url,error:e.code??e.message});}}}
 return{...seed,home_access:homeAccess,resources:resources.map(({body,...r})=>r),checked,scope_result:checked.length?'OFFICIAL_CANDIDATES_CHECKED':'NO_DECLARED_ENDPOINT_IN_BOUNDED_SCOPE'};
}
let cursor=0;await Promise.all([0,1].map(async()=>{while(cursor<seeds.length){const seed=seeds[cursor++];if(results.some(r=>r.country===seed.country&&r.name===seed.name))continue;const result=await discover(seed);results.push(result);save();console.log(JSON.stringify({country:seed.country,name:seed.name,result:result.scope_result,checked:result.checked.length,new_nonempty:result.checked.filter(c=>!c.already_cataloged&&c.observation?.auditStatus==='working_nonempty'&&c.observation?.format!=='sitemapindex').length,requests}));}}));save();
