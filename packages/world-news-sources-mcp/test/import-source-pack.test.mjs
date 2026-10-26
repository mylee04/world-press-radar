import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticleMetadata, importSourcePack, parsePackInput, main } from '../scripts/import-source-pack.mjs';

const S='http://www.sitemaps.org/schemas/sitemap/0.9', N='http://www.google.com/schemas/sitemap-news/0.9';
const index=urls=>`<sitemapindex xmlns="${S}">${urls.map(url=>`<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`;
const news=(url='https://publisher.example/articles/one', title='記事の見出し', date='2026-10-25T12:00:00Z')=>`<urlset xmlns="${S}" xmlns:news="${N}"><url><loc>${url}</loc><news:news><news:title>${title}</news:title>${date?`<news:publication_date>${date}</news:publication_date>`:''}</news:news></url></urlset>`;
const rdf=`<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="https://publisher.example/"><title>毎日新聞</title><link>https://publisher.example/</link><description>速報</description></channel><item rdf:about="https://publisher.example/articles/one"><title>ニュース</title><link>https://publisher.example/articles/one</link><dc:date>2026-10-25T12:00:00+09:00</dc:date></item></rdf:RDF>`;
const rss=`<rss version="2.0"><channel><title>News</title><link>https://publisher.example/</link><description>Headlines</description><item><title>Headline</title><link>https://publisher.example/articles/one</link><pubDate>Sun, 25 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
const now=Date.parse('2026-10-26T00:00:00Z');
const endpoint=url=>({type:'sitemap',url,publisher:'Publisher'});
function fixture(entries){
 const calls=[],deferrals=[];
 const gate=Object.assign(async()=>()=>{}, {defer:(...args)=>deferrals.push(args)});
 return {calls,deferrals,gate,now:()=>now,fetchXml:async(url,_timeout,_bound,requestGate)=>{
   assert.ok(entries[url],`Unexpected network request ${url}`);
   calls.push(url);const release=await requestGate(new URL(url).hostname,now+10000);release();
   const value=entries[url];
   return {status:value.status??200,body:Buffer.from(value.body??''),finalUrl:value.finalUrl??url,contentType:value.contentType??'application/xml',retryAfter:value.retryAfter,requestedHops:1};
 }};
}

test('accepts typed JSON and OPML, deduplicates and preserves diagnostic exclusions without accepting private URLs',()=>{
 const json=JSON.stringify({endpoints:[{type:'sitemap',url:'https://publisher.example/news.xml',publisher:'Publisher',default_export_eligible:false}]});
 assert.equal(parsePackInput(json)[0].skip,true);
 assert.equal(parsePackInput(json,true)[0].skip,false);
 assert.deepEqual(parsePackInput('<opml version="2.0"><body><outline type="rss" text="News" xmlUrl="https://publisher.example/feed"/><outline type="rss" xmlUrl="https://publisher.example/feed"/></body></opml>').map(x=>x.url),['https://publisher.example/feed']);
 for(const url of ['http://127.0.0.1/x','https://user:pass@publisher.example/x','https://publisher.example:8888/feed','file:///tmp/news'])assert.throws(()=>parsePackInput(JSON.stringify({endpoints:[{type:'rss',url}]})));
 assert.throws(()=>parsePackInput('<!DOCTYPE opml [<!ENTITY x "bad">]><opml/>'),/DTD_NOT_ALLOWED/);
 assert.throws(()=>parsePackInput(JSON.stringify({endpoints:Array.from({length:21},(_,i)=>({type:'rss',url:`https://publisher.example/${i}`}))})),/TOO_MANY_ENDPOINTS/);
});

test('extracts Mainichi-style RDF and RSS dates, and Google news sitemap title and publication date',()=>{
 const daily=extractArticleMetadata(Buffer.from(rdf),'rss','text/html; charset=UTF-8',now);
 assert.equal(daily.format,'rdf');assert.equal(daily.articles[0].title,'ニュース');assert.equal(daily.articles[0].date,'2026-10-25T03:00:00.000Z');
 const feed=extractArticleMetadata(Buffer.from(rss),'rss','application/rss+xml',now);
 assert.equal(feed.articles[0].date,'2026-10-25T12:00:00.000Z');
 const site=extractArticleMetadata(Buffer.from(news()),'sitemap','text/xml',now);
 assert.equal(site.articles[0].title,'記事の見出し');assert.equal(site.articles[0].date_kind,'news_publication_date');
 const undated=extractArticleMetadata(Buffer.from(news(undefined,'Undated',null)),'sitemap','text/xml',now);
 assert.equal(undated.articles[0].date,null);assert.equal(undated.articles[0].date_status,'missing');
 const unreliable=extractArticleMetadata(Buffer.from(news(undefined,'Invalid','2027-01-01T00:00:00Z')),'sitemap','text/xml',now);
 assert.equal(unreliable.articles[0].date_status,'unreliable');
 assert.throws(()=>extractArticleMetadata(Buffer.from('<!DOCTYPE rss><rss/>'),'rss','application/xml',now),/DTD_NOT_ALLOWED/);
});

test('follows one same-origin child to article metadata, shares robots, deduplicates, and never fetches article URLs',async()=>{
 const root='https://publisher.example/sitemap.xml',child='https://publisher.example/national.xml';
 const dep=fixture({'https://publisher.example/robots.txt':{body:'User-agent: *\nAllow: /'},[root]:{body:index([child,child])},[child]:{body:news()}});
 const result=await importSourcePack([endpoint(root)],{},dep);
 assert.equal(result.state,'complete');assert.equal(result.article_candidates,1);assert.equal(result.dated_candidates,1);
 assert.deepEqual(dep.calls,['https://publisher.example/robots.txt',root,child]);
 assert.equal(result.documents[0].state,'index_only');assert.equal(result.documents[1].state,'article_metadata');
 assert.equal(result.requested_hops,3);assert.equal(result.fetched_documents,2);
});

test('does not count sitemap children, homepages, sections or undated URL-only records as collected articles',()=>{
 const result=extractArticleMetadata(Buffer.from(`<urlset xmlns="${S}"><url><loc>https://publisher.example/</loc><lastmod>2026-10-25T12:00:00Z</lastmod></url><url><loc>https://publisher.example/business/</loc></url><url><loc>https://publisher.example/articles/no-title</loc></url></urlset>`),'sitemap','application/xml',now);
 assert.equal(result.articles.length,0);assert.equal(result.navigation_urls,2);assert.equal(result.unknown_urls,1);
 const children=extractArticleMetadata(Buffer.from(index(['https://publisher.example/child.xml'])),'sitemap','application/xml',now);
 assert.equal(children.articles.length,0);assert.deepEqual(children.children,['https://publisher.example/child.xml']);
});

test('holds cross-origin children and depth/document limits with partial output rather than a false completion',async()=>{
 const root='https://publisher.example/sitemap.xml',child='https://publisher.example/child.xml';
 const dep=fixture({'https://publisher.example/robots.txt':{body:'User-agent: *\nAllow: /'},[root]:{body:index([child,'https://other.example/news.xml'])},[child]:{body:news()}});
 const depth=await importSourcePack([endpoint(root)],{maxDepth:0},dep);
 assert.equal(depth.state,'partial');assert.equal(depth.article_candidates,0);assert.deepEqual(new Set(depth.holds.map(h=>h.reason)),new Set(['IMPORT_DEPTH_LIMIT','CROSS_ORIGIN_CHILD']));
 const documents=await importSourcePack([endpoint(root)],{maxDocuments:1},dep);
 assert.equal(documents.state,'partial');assert.equal(documents.fetched_documents,1);assert.ok(documents.holds.some(h=>h.reason==='IMPORT_DOCUMENT_LIMIT'));
 assert.ok(!dep.calls.includes('https://other.example/news.xml'));
});

test('respects robots denial, 429 cooldown, redirects and saved exclusions without retries',async()=>{
 const url='https://publisher.example/news.xml';
 const denied=fixture({'https://publisher.example/robots.txt':{body:'User-agent: *\nDisallow: /news.xml'}});
 const blocked=await importSourcePack([endpoint(url)],{},denied);
 assert.equal(blocked.state,'partial');assert.equal(blocked.documents[0].reason,'ROBOTS_DISALLOWED');assert.equal(denied.calls.length,1);
 const dep=fixture({'https://publisher.example/robots.txt':{body:'User-agent: *\nAllow: /'},[url]:{status:429,retryAfter:'120'}});
 const limited=await importSourcePack([endpoint(url)],{},dep);
 assert.equal(limited.documents[0].state,'rate_limited');assert.equal(limited.documents[0].retry_after,'2026-10-26T00:02:00.000Z');assert.equal(dep.calls.length,2);assert.equal(dep.deferrals.length,1);
 const redirect=fixture({'https://publisher.example/robots.txt':{body:'User-agent: *\nAllow: /'},[url]:{body:news(),finalUrl:'https://other.example/feed'}});
 const moved=await importSourcePack([endpoint(url)],{},redirect);
 assert.equal(moved.documents[0].reason,'IMPORT_REDIRECT_REQUIRES_REVIEW');assert.equal(moved.article_candidates,0);
 const skipped=await importSourcePack([{...endpoint(url),skip:true}],{},fixture({}));
 assert.equal(skipped.fetched_documents,0);assert.equal(skipped.holds[0].reason,'saved_policy_excluded');
});

test('CLI writes a private new result file and refuses invalid options or limits before network',async()=>{
 let saved,printed;
 const dep=fixture({'https://publisher.example/robots.txt':{body:'User-agent: *\nAllow: /'},'https://publisher.example/feed':{body:rss}});
 const status=await main(['--input','/tmp/in.json','--output','/tmp/out.json'],{...dep,stat:async()=>({isFile:()=>true,size:100}),readFile:async()=>JSON.stringify({endpoints:[{type:'rss',url:'https://publisher.example/feed'}]}),writeFile:async(...args)=>{saved=args;},print:value=>{printed=JSON.parse(value);}});
 assert.equal(status,0);assert.equal(printed.article_candidates,1);assert.deepEqual(saved[2],{flag:'wx',mode:0o600});assert.equal(JSON.parse(saved[1]).articles.length,1);
 await assert.rejects(main(['--input','x','--output','y','--url','https://example.com']),/Usage/);
 await assert.rejects(importSourcePack([],{maxDocuments:21},fixture({})),/INVALID_DOCUMENT_LIMIT/);
});

test('a large sitemap index stays within the request/document budget and bounds detailed holds',async()=>{
 const root='https://publisher.example/sitemap.xml';
 const children=Array.from({length:200},(_,i)=>`https://publisher.example/${i}.xml`);
 const dep=fixture({'https://publisher.example/robots.txt':{body:'User-agent: *\nAllow: /'},[root]:{body:index(children)},[children[0]]:{body:news()}});
 const result=await importSourcePack([endpoint(root)],{maxDocuments:2},dep);
 assert.equal(result.state,'partial');assert.equal(result.fetched_documents,2);assert.equal(result.attempted_documents,2);
 assert.equal(result.article_candidates,1);assert.equal(dep.calls.length,3);assert.equal(result.hold_summary.IMPORT_DOCUMENT_LIMIT,199);assert.ok(result.holds.length<=40);
});

test('robots 4xx is unavailable policy evidence, while resource authorization and robots rate limits remain distinct',async()=>{
 const url='https://publisher.example/feed';
 const allowed=fixture({'https://publisher.example/robots.txt':{status:403},[url]:{body:rss}});
 const imported=await importSourcePack([{type:'rss',url}],{},allowed);
 assert.equal(imported.state,'complete');assert.equal(imported.article_candidates,1);
 assert.equal(imported.documents[0].robots,'unavailable_4xx');assert.equal(imported.documents[0].robots_http_status,403);
 assert.equal(imported.documents[0].http_status,200);assert.equal(allowed.calls.length,2);
 const refused=fixture({'https://publisher.example/robots.txt':{status:403},[url]:{status:403}});
 const blocked=await importSourcePack([{type:'rss',url}],{},refused);
 assert.equal(blocked.state,'partial');assert.equal(blocked.documents[0].state,'blocked');
 assert.equal(blocked.documents[0].robots_http_status,403);assert.equal(blocked.documents[0].http_status,403);assert.equal(blocked.article_candidates,0);
 const limited=fixture({'https://publisher.example/robots.txt':{status:429,retryAfter:'120'}});
 const held=await importSourcePack([{type:'rss',url}],{},limited);
 assert.equal(held.state,'partial');assert.equal(held.documents[0].state,'policy_hold');assert.equal(held.documents[0].robots_http_status,429);
 assert.equal(held.documents[0].robots_retry_after,'2026-10-26T00:02:00.000Z');assert.equal(limited.calls.length,1);
 assert.equal(held.limits.max_robots_bytes,128*1024);
});

test('selection-group chooses only matching typed endpoints and rejects unavailable groups or OPML before requests',async()=>{
 const document=JSON.stringify({endpoints:Array.from({length:10},(_,i)=>({type:'rss',url:`https://publisher.example/${i}`,selection_group:i<5?'national_major':'regional_supplement'}))});
 const selected=parsePackInput(document,false,'national_major');
 assert.equal(selected.length,5);assert.ok(selected.every(item=>item.selection_group==='national_major'));
 assert.deepEqual(selected.map(item=>item.url),Array.from({length:5},(_,i)=>`https://publisher.example/${i}`));
 assert.equal(parsePackInput(document).length,10);
 assert.throws(()=>parsePackInput(document,false,'missing_group'),/IMPORT_SELECTION_GROUP_NOT_FOUND/);
 assert.throws(()=>parsePackInput('<opml><body/></opml>',false,'national_major'),/IMPORT_SELECTION_GROUP_REQUIRES_TYPED_JSON/);
 let fetched=0;
 await assert.rejects(main(['--input','/tmp/in.json','--output','/tmp/out.json','--selection-group','missing_group'],{stat:async()=>({isFile:()=>true,size:100}),readFile:async()=>document,fetchXml:async()=>{fetched++;}}),/IMPORT_SELECTION_GROUP_NOT_FOUND/);
 assert.equal(fetched,0);
});

test('accepts only the declared legacy 0.84 sitemap namespace alongside modern news metadata',()=>{
 const legacy=news().replace(`xmlns="${S}"`,'xmlns="http://www.google.com/schemas/sitemap/0.84"');
 const parsed=extractArticleMetadata(Buffer.from(legacy),'sitemap','application/xml',now);
 assert.equal(parsed.articles.length,1);assert.equal(parsed.articles[0].title,'記事の見出し');
 assert.equal(parsed.articles[0].date_kind,'news_publication_date');assert.equal(parsed.articles[0].date,'2026-10-25T12:00:00.000Z');
 assert.throws(()=>extractArticleMetadata(Buffer.from(news().replace(`xmlns="${S}"`,'xmlns="https://unknown.example/sitemap"')),'sitemap','application/xml',now),/WRONG_ENDPOINT_FORMAT/);
});
