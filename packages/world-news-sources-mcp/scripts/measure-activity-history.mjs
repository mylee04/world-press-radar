// Compression/capacity estimate only: no network, ledger writes or production activity.
import {readFileSync} from 'node:fs';
import {normalizeRegistry} from '../dist/catalog.js';
import {encodeHistory,decodeHistory} from '../dist/activity-history.js';
import {createHash} from 'node:crypto';
const catalog=normalizeRegistry(JSON.parse(readFileSync(new URL('../../../data/rss-atlas.json',import.meta.url),'utf8'))),bindings=new Map();
for(const s of catalog.sources.filter(s=>s.enabled))for(const ep of s.endpoints){const a=bindings.get(ep.id)??[];a.push(s);bindings.set(ep.id,a);}
const records=[];let ordinal=0;
for(let day=0;day<31;day++)for(const [endpoint_id,sources]of bindings){const i=ordinal++;
  records.push({endpoint_id,checked_at:new Date(Date.parse('2026-01-01T00:00:00Z')+day*86400000+(i%bindings.size)*1600+(i*997)%20000).toISOString(),status:i%13===0?'timeout':'working_nonempty',format:catalog.endpoints.get(endpoint_id).type==='rss'?'rss':i%17===0?'sitemapindex':'sitemap',uncertain_urls:i%3,
    baseline_sources:day===0?sources.map(s=>s.id):[],source_new:Object.fromEntries(sources.map((s,k)=>[s.id,day===0?0:(i*7+k)%41])),country_new:Object.fromEntries([...new Set(sources.map(s=>s.countryCode))].map(c=>[c,day===0?0:(i*11)%31]))});
}
const start=performance.now(),bytes=encodeHistory(records),encoded=performance.now();
const descriptor={month:'2026-01',file:'',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,records:records.length};
const filtered=decodeHistory(bytes,descriptor,{kind:'country',scope:'US',from:Date.parse('2026-01-01'),to:Date.parse('2026-02-01')});
console.log(JSON.stringify({kind:'synthetic_compression_estimate_not_production_activity',configured_endpoints:bindings.size,monthly_checks:records.length,compressed_month_bytes:bytes.length,projected_365_day_bytes:Math.ceil(bytes.length*365/31),encode_ms:Math.round(encoded-start),decode_filter_us_ms:Math.round(performance.now()-encoded),filtered_us_checks:filtered.length,source_capacity_budget_bytes:80*1024*1024,scope:'Count/coverage tuples only; no article URLs, traffic records or current health assertions'}));
