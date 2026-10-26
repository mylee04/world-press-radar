import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectXml } from '../dist/inspect.js';

const urlset = namespace => Buffer.from(`<urlset xmlns="${namespace}" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>https://publisher.example/articles/one</loc><news:news><news:title>Headline</news:title><news:publication_date>2026-10-26T01:00:00Z</news:publication_date></news:news><lastmod>2026-10-26T01:00:00Z</lastmod></url></urlset>`);
test('recognizes the exact legacy Google sitemap namespace without accepting arbitrary lookalikes', () => {
  const now = Date.parse('2026-10-26T02:00:00Z');
  for (const namespace of ['http://www.sitemaps.org/schemas/sitemap/0.9', 'http://www.google.com/schemas/sitemap/0.84']) {
    const result = inspectXml(urlset(namespace), 'sitemap', now, undefined, true);
    assert.equal(result.format, 'urlset');
    assert.equal(result.entriesWithUrl, 1);
    assert.deepEqual(result.observedUrls, ['https://publisher.example/articles/one']);
    assert.equal(result.newestContentAt, '2026-10-26T01:00:00.000Z');
  }
  for (const namespace of ['urn:unknown', 'http://www.google.com/schemas/sitemap/0.85', 'https://untrusted.example/sitemap/0.84']) {
    assert.throws(() => inspectXml(urlset(namespace), 'sitemap', now), /WRONG_ENDPOINT_FORMAT/);
  }
  assert.throws(() => inspectXml(Buffer.from('<!DOCTYPE urlset>' + urlset('http://www.google.com/schemas/sitemap/0.84')), 'sitemap', now), /DTD_NOT_ALLOWED/);
});
