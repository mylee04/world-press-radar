import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectXml } from '../dist/inspect.js';
import { createHostGate } from '../dist/host-gate.js';
import { rss, atom } from './fixtures.mjs';
const parse=(xml,type='rss')=>inspectXml(Buffer.from(xml),type,Date.parse('2026-09-30T12:00:00Z'));
test('audit counts RSS/Atom outputs and keeps publication date separate from checked time',()=>{
  const result=parse(rss.replace('</channel>','<item><link>https://example.com/article</link><pubDate>Tue, 29 Sep 2026 12:00:00 GMT</pubDate></item></channel>'));
  assert.equal(result.entryCount,2);assert.equal(result.entriesWithUrl,1);assert.equal(result.contentFreshness,'recent');assert.equal(result.newestContentAt,'2026-09-29T12:00:00.000Z');
  assert.deepEqual(result.sampleUrls,['https://example.com/article']);
  const stale=parse(atom.replace('</feed>','<entry><link href="https://example.com/old"/><updated>2024-01-01T00:00:00Z</updated></entry></feed>'));
  assert.equal(stale.entryCount,1);assert.equal(stale.contentFreshness,'stale');
  assert.equal(parse(rss).contentFreshness,'missing');
});
test('RSS and RDF with present but empty channel descriptions retain article URLs and dates',()=>{
  const rdf='<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="https://example.com/feed"><title>News</title><link>https://example.com</link><description/><items><rdf:Seq><rdf:li rdf:resource="https://example.com/article"/></rdf:Seq></items></channel><item rdf:about="https://example.com/article"><title>Article</title><link>https://example.com/article</link><dc:date>2026-09-29T12:00:00Z</dc:date></item></rdf:RDF>';
  for(const [body,format] of [
    [rss.replace('<description>News feed</description>','<description/>').replace('</channel>','<item><link>https://example.com/article</link><pubDate>Tue, 29 Sep 2026 12:00:00 GMT</pubDate></item></channel>'),'rss'],
    [rdf,'rdf'],
    [rdf.replace('<description/>','<description> \n </description>'),'rdf'],
  ]) {
    const result=inspectXml(Buffer.from(body),'rss',Date.parse('2026-09-30T12:00:00Z'),2*1024*1024,true);
    assert.equal(result.format,format);assert.equal(result.entriesWithUrl,1);
    assert.deepEqual(result.observedUrls,['https://example.com/article']);
    assert.equal(result.newestContentAt,'2026-09-29T12:00:00.000Z');assert.equal(result.contentFreshness,'recent');
  }
  for(const body of [rdf.replace('<description/>',''),rdf.replace('<description/>','<description xmlns="urn:wrong"/>'),rdf.replace('<title>News</title>','<title/>'),rdf.replace('http://www.w3.org/1999/02/22-rdf-syntax-ns#','urn:wrong')]) assert.throws(()=>parse(body),/WRONG_ENDPOINT_FORMAT/);
});
test('blank duplicate channel links do not wipe the usable link or substitute href for missing text',()=>{
  const duplicate='<link href="https://example.com/feed" rel="self"/><link> \n </link>';
  assert.equal(parse(rss.replace('<link>https://example.com</link>','<link>https://example.com</link>'+duplicate)).format,'rss');
  assert.equal(parse(rss.replace('<link>https://example.com</link>',duplicate+'<link>https://example.com</link>')).format,'rss');
  assert.throws(()=>parse(rss.replace('<link>https://example.com</link>',duplicate)),/WRONG_ENDPOINT_FORMAT/);
});
test('RSS description presence remains namespace-specific and does not permit missing metadata or HTML',()=>{
  for(const body of [
    rss.replace('<description>News feed</description>',''),
    rss.replace('<description>News feed</description>','<description xmlns="urn:wrong"/>'),
    rss.replace('<title>News</title>','<title/>'),
    rss.replace('<link>https://example.com</link>','<link/>'),
    '<html><body>'+rss+'</body></html>',
  ]) assert.throws(()=>parse(body),/WRONG_ENDPOINT_FORMAT/);
  const empty=rss.replace('<description>News feed</description>','<description/>');
  assert.throws(()=>parse('<!DOCTYPE rss [<!ENTITY x "external">]>'+empty),/DTD_NOT_ALLOWED/);
  assert.throws(()=>inspectXml(Buffer.from(empty),'rss',Date.now(),4),/BODY_TOO_LARGE/);
  const unsafe=parse(empty.replace('</channel>','<item><link>file:///tmp/article</link></item></channel>'));
  assert.equal(unsafe.entriesWithUrl,0);assert.deepEqual(unsafe.sampleUrls,[]);
});
test('empty sitemap is valid, index counts only child sitemap entries and dates can be unreliable',()=>{
  assert.equal(parse('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>','sitemap').entryCount,0);
  const index=parse('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/child.xml</loc><lastmod>2099-01-01</lastmod></sitemap></sitemapindex>','sitemap');
  assert.equal(index.entryCount,1);assert.equal(index.format,'sitemapindex');assert.equal(index.contentFreshness,'unreliable');assert.equal(index.newestContentAt,null);
  assert.throws(()=>parse('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url/></urlset>','sitemap'),/INVALID_ENTRY_URL/);
});
test('per-host governor serializes hosts and bounds politeness wait',async()=>{
  const gate=createHostGate(0);const release=await gate('example.com',Date.now()+1000);
  const other=await gate('other.example',Date.now()+1000);other();
  await assert.rejects(gate('example.com',Date.now()+10),/POLITENESS_WAIT_LIMIT/);
  release();(await gate('example.com',Date.now()+1000))();
});
