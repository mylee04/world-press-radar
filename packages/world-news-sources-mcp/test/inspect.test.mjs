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
