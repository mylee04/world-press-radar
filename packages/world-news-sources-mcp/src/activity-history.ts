import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {join,resolve} from 'node:path';
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
    e.baseline_sources.map((s:string)=>index('source',s)),Object.entries(e.source_new).map(([s,n])=>[index('source',s),n]),Object.entries(e.country_new).map(([c,n])=>[index('country',c),n]),
    typeof e.newest_content_at==='string'&&Number.isFinite(Date.parse(e.newest_content_at))?Date.parse(e.newest_content_at):null,['feed_item_date','sitemap_lastmod'].includes(e.date_kind)?e.date_kind:null]);
  const json=Buffer.from(JSON.stringify({version:2,dictionaries,rows}));if(json.length>MAX_EXPANDED)throw Error('HISTORY_MONTH_EXPANDED_BUDGET');
  const bytes=gzipSync(json,{level:9});if(bytes.length>MAX_COMPRESSED)throw Error('HISTORY_MONTH_COMPRESSED_BUDGET');return bytes;
}
type HistoryFilter = {kind:'source'|'country';scope:string;from:number;to:number};
export function decodeHistory(bytes:Buffer, descriptor:HistoryShard,filter?:HistoryFilter):Array<Record<string,any>> {
  if(!Number.isInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>MAX_COMPRESSED||bytes.length!==descriptor.bytes||createHash('sha256').update(bytes).digest('hex')!==descriptor.sha256)throw Error('ACTIVITY_HISTORY_INTEGRITY');
  const data=JSON.parse(gunzipSync(bytes,{maxOutputLength:MAX_EXPANDED}).toString('utf8'));
  if(![1,2].includes(data.version)||!Array.isArray(data.rows)||data.rows.length!==descriptor.records||data.rows.length>MAX_RECORDS)throw Error('ACTIVITY_HISTORY_SCHEMA');
  const d=data.dictionaries;
  const get=(kind:string,i:any) => {const a=d?.[kind];if(!Array.isArray(a)||!Number.isInteger(i)||i<0||i>=a.length)throw Error('ACTIVITY_HISTORY_SCHEMA');return a[i];};
  const count=(n:any)=>{if(!Number.isSafeInteger(n)||n<0)throw Error('ACTIVITY_HISTORY_SCHEMA');return n;};
  return data.rows.flatMap((r:any[])=>{
    if(!Array.isArray(r)||r.length!==(data.version===1?8:10)||!Number.isSafeInteger(r[0])||!Array.isArray(r[5])||!Array.isArray(r[6])||!Array.isArray(r[7]))throw Error('ACTIVITY_HISTORY_SCHEMA');
    if(data.version===2&&((r[8]!==null&&!Number.isSafeInteger(r[8]))||(r[9]!==null&&!['feed_item_date','sitemap_lastmod'].includes(r[9]))))throw Error('ACTIVITY_HISTORY_SCHEMA');
    const checked_at=new Date(r[0]).toISOString();if(checked_at.slice(0,7)!==descriptor.month)throw Error('ACTIVITY_HISTORY_MONTH');
    if(filter&&(r[0]<filter.from||r[0]>=filter.to||!(filter.kind==='source'?r[6]:r[7]).some((p:any[])=>get(filter.kind,p[0])===filter.scope)))return [];
    const pairs=(kind:string,a:any[])=>Object.fromEntries(a.map(p=>{if(!Array.isArray(p)||p.length!==2)throw Error('ACTIVITY_HISTORY_SCHEMA');return [get(kind,p[0]),count(p[1])];}));
    const source_new=pairs('source',r[6]),country_new=pairs('country',r[7]);
    return [{checked_at,endpoint_id:get('endpoint',r[1]),status:get('status',r[2]),format:get('format',r[3]),uncertain_urls:count(r[4]),baseline_sources:r[5].map(i=>get('source',i)),source_ids:Object.keys(source_new),countries:Object.keys(country_new),source_new,country_new,
      ...(data.version===2?{newest_content_at:r[8]===null?null:new Date(r[8]).toISOString(),date_kind:r[9]}:{})}];
  });
}
export function readHistory(directory:string, descriptor:HistoryShard,filter?:HistoryFilter) {
  return historyCache.read(directory,descriptor,filter);
}

type HistoryRow=Record<string,any>;
type CachedHistory={signature:string;rows:ReadonlyArray<HistoryRow>;byCountry:Map<string,HistoryRow[]>;bySource:Map<string,HistoryRow[]>;bytes:number};
/** Cache only checksum-verified immutable archive records. Every hit still stats
 * the file: deletion, same-size corruption and atomic replacement invalidate it.
 * Both retained serialized bytes and record/entry counts have explicit bounds.
 * This is process-local derived data; no durable observations or URL ledger. */
export class HistoryArchiveCache {
  private readonly entries=new Map<string,CachedHistory>();
  private bytes=0;private records=0;
  constructor(private readonly limits={maxBytes:64*1024*1024,maxRecords:200000,maxEntries:4}) {}
  stats(){return{entries:this.entries.size,serialized_bytes:this.bytes,records:this.records};}
  private remove(key:string){const entry=this.entries.get(key);if(entry){this.bytes-=entry.bytes;this.records-=entry.rows.length;this.entries.delete(key);}}
  read(directory:string,descriptor:HistoryShard,filter?:HistoryFilter):HistoryRow[]{
    validateHistory({version:1,complete:true,shards:[descriptor]});
    const path=resolve(directory,descriptor.file),key=JSON.stringify([path,descriptor.month,descriptor.sha256,descriptor.bytes,descriptor.records]);
    const fingerprint=()=>{
      try{const info=statSync(path,{bigint:true});if(!info.isFile()||info.size>BigInt(MAX_COMPRESSED))throw Error();return[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');}
      catch{this.remove(key);throw Error('ACTIVITY_HISTORY_READ_FAILURE');}
    };
    const signature=fingerprint();let entry=this.entries.get(key);
    if(entry?.signature!==signature){this.remove(key);entry=undefined;}
    if(!entry){
      let bytes:Buffer;try{bytes=readFileSync(path);}catch{throw Error('ACTIVITY_HISTORY_READ_FAILURE');}
      // An archive replaced during the read is never installed as a valid hit.
      if(fingerprint()!==signature)throw Error('ACTIVITY_HISTORY_READ_FAILURE');
      const rows=decodeHistory(bytes,descriptor),byCountry=new Map<string,HistoryRow[]>(),bySource=new Map<string,HistoryRow[]>();
      const add=(index:Map<string,HistoryRow[]>,scopes:string[],row:HistoryRow)=>{for(const scope of scopes){const values=index.get(scope)??[];values.push(row);index.set(scope,values);}};
      for(const row of rows){
        Object.freeze(row.baseline_sources);Object.freeze(row.source_ids);Object.freeze(row.countries);Object.freeze(row.source_new);Object.freeze(row.country_new);Object.freeze(row);
        add(byCountry,row.countries,row);add(bySource,row.source_ids,row);
      }
      const serializedBytes=Buffer.byteLength(JSON.stringify(rows));
      entry={signature,rows:Object.freeze(rows),byCountry,bySource,bytes:serializedBytes};
      if(serializedBytes<=this.limits.maxBytes&&rows.length<=this.limits.maxRecords&&this.limits.maxEntries>0){
        while(this.entries.size&&(this.entries.size>=this.limits.maxEntries||this.bytes+serializedBytes>this.limits.maxBytes||this.records+rows.length>this.limits.maxRecords))this.remove(this.entries.keys().next().value!);
        this.entries.set(key,entry);this.bytes+=serializedBytes;this.records+=rows.length;
      }
    }else{this.entries.delete(key);this.entries.set(key,entry);}
    const rows=filter?(filter.kind==='country'?entry.byCountry:entry.bySource).get(filter.scope)??[]:entry.rows;
    return filter?rows.filter(row=>{const at=Date.parse(row.checked_at);return at>=filter.from&&at<filter.to;}):[...rows];
  }
}
const historyCache=new HistoryArchiveCache();
export function historyMonths(from:number,to:number) {
  const result:string[]=[];let month=new Date(from).toISOString().slice(0,7),last=new Date(to-1).toISOString().slice(0,7);
  while(month<=last){result.push(month);const date=new Date(`${month}-01T00:00:00Z`);date.setUTCMonth(date.getUTCMonth()+1);month=date.toISOString().slice(0,7);if(result.length>3)throw Error('ACTIVITY_HISTORY_RANGE_BUDGET');}return result;
}
