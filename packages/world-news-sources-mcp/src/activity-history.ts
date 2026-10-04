import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';

export type HistoryShard = {month:string; file:string; sha256:string; bytes:number; records:number};
export type HistoryManifest = {version:1; complete:true; shards:HistoryShard[]};
const MAX_COMPRESSED = 10 * 1024 * 1024, MAX_EXPANDED = 64 * 1024 * 1024, MAX_RECORDS = 500000;
export function validateHistory(history:HistoryManifest) {
  if(history.version!==1||history.complete!==true||!Array.isArray(history.shards))throw Error('ACTIVITY_HISTORY_MANIFEST');
  const seen=new Set();let previous='';
  for(const shard of history.shards){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(shard.month)||!/^[a-f0-9]{64}$/.test(shard.sha256)||shard.file!==`${shard.month}-${shard.sha256}.json.gz`||seen.has(shard.month)||shard.month<previous||!Number.isInteger(shard.bytes)||shard.bytes<1||shard.bytes>MAX_COMPRESSED||!Number.isInteger(shard.records)||shard.records<1||shard.records>MAX_RECORDS)throw Error('ACTIVITY_HISTORY_MANIFEST');
    seen.add(shard.month);previous=shard.month;
  }
}
// Only scope counts and collection coverage are exported. No article URLs, queries or bodies.
export function encodeHistory(records:Array<Record<string,any>>) {
  const dictionaries = {endpoint:[] as string[],source:[] as string[],country:[] as string[],status:[] as string[],format:[] as (string|null)[]};
  const indexes=new Map<string,Map<any,number>>();
  const index = (kind:keyof typeof dictionaries,value:any) => {const values=dictionaries[kind] as any[],map=indexes.get(kind)??new Map();indexes.set(kind,map);let i=map.get(value);if(i===undefined){i=values.length;values.push(value);map.set(value,i);}return i;};
  if(records.length>MAX_RECORDS)throw Error('HISTORY_MONTH_RECORD_BUDGET');
  const rows=records.map(e=>[Date.parse(e.checked_at),index('endpoint',e.endpoint_id),index('status',e.status),index('format',e.format),e.uncertain_urls,
    e.baseline_sources.map((s:string)=>index('source',s)),Object.entries(e.source_new).map(([s,n])=>[index('source',s),n]),Object.entries(e.country_new).map(([c,n])=>[index('country',c),n])]);
  const json=Buffer.from(JSON.stringify({version:1,dictionaries,rows}));if(json.length>MAX_EXPANDED)throw Error('HISTORY_MONTH_EXPANDED_BUDGET');
  const bytes=gzipSync(json,{level:9});if(bytes.length>MAX_COMPRESSED)throw Error('HISTORY_MONTH_COMPRESSED_BUDGET');return bytes;
}
type HistoryFilter = {kind:'source'|'country';scope:string;from:number;to:number};
export function decodeHistory(bytes:Buffer, descriptor:HistoryShard,filter?:HistoryFilter):Array<Record<string,any>> {
  if(!Number.isInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>MAX_COMPRESSED||bytes.length!==descriptor.bytes||createHash('sha256').update(bytes).digest('hex')!==descriptor.sha256)throw Error('ACTIVITY_HISTORY_INTEGRITY');
  const data=JSON.parse(gunzipSync(bytes,{maxOutputLength:MAX_EXPANDED}).toString('utf8'));
  if(data.version!==1||!Array.isArray(data.rows)||data.rows.length!==descriptor.records||data.rows.length>MAX_RECORDS)throw Error('ACTIVITY_HISTORY_SCHEMA');
  const d=data.dictionaries;
  const get=(kind:string,i:any) => {const a=d?.[kind];if(!Array.isArray(a)||!Number.isInteger(i)||i<0||i>=a.length)throw Error('ACTIVITY_HISTORY_SCHEMA');return a[i];};
  const count=(n:any)=>{if(!Number.isSafeInteger(n)||n<0)throw Error('ACTIVITY_HISTORY_SCHEMA');return n;};
  return data.rows.flatMap((r:any[])=>{
    if(!Array.isArray(r)||r.length!==8||!Number.isSafeInteger(r[0])||!Array.isArray(r[5])||!Array.isArray(r[6])||!Array.isArray(r[7]))throw Error('ACTIVITY_HISTORY_SCHEMA');
    const checked_at=new Date(r[0]).toISOString();if(checked_at.slice(0,7)!==descriptor.month)throw Error('ACTIVITY_HISTORY_MONTH');
    if(filter&&(r[0]<filter.from||r[0]>=filter.to||!(filter.kind==='source'?r[6]:r[7]).some((p:any[])=>get(filter.kind,p[0])===filter.scope)))return [];
    const pairs=(kind:string,a:any[])=>Object.fromEntries(a.map(p=>{if(!Array.isArray(p)||p.length!==2)throw Error('ACTIVITY_HISTORY_SCHEMA');return [get(kind,p[0]),count(p[1])];}));
    const source_new=pairs('source',r[6]),country_new=pairs('country',r[7]);
    return [{checked_at,endpoint_id:get('endpoint',r[1]),status:get('status',r[2]),format:get('format',r[3]),uncertain_urls:count(r[4]),baseline_sources:r[5].map(i=>get('source',i)),source_ids:Object.keys(source_new),countries:Object.keys(country_new),source_new,country_new}];
  });
}
export function readHistory(directory:string, descriptor:HistoryShard,filter?:HistoryFilter) {
  validateHistory({version:1,complete:true,shards:[descriptor]});
  let bytes:Buffer;
  try {const path=join(directory,descriptor.file);if(statSync(path).size>MAX_COMPRESSED)throw Error();bytes=readFileSync(path);}catch{throw Error('ACTIVITY_HISTORY_READ_FAILURE');}
  return decodeHistory(bytes,descriptor,filter);
}
export function historyMonths(from:number,to:number) {
  const result:string[]=[];let month=new Date(from).toISOString().slice(0,7),last=new Date(to-1).toISOString().slice(0,7);
  while(month<=last){result.push(month);const date=new Date(`${month}-01T00:00:00Z`);date.setUTCMonth(date.getUTCMonth()+1);month=date.toISOString().slice(0,7);if(result.length>3)throw Error('ACTIVITY_HISTORY_RANGE_BUDGET');}return result;
}
