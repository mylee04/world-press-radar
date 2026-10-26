import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectXml } from '../dist/inspect.js';

const httpsNamespace = 'https://www.sitemaps.org/schemas/sitemap/0.9';
const standardNamespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const now = Date.parse('2026-10-26T12:00:00Z');
const inspect = xml => inspectXml(Buffer.from(xml), 'sitemap', now, undefined, true);
const urlset = namespace => `<urlset xmlns="${namespace}"><url><loc>https://publisher.example/article</loc><lastmod>2026-10-26T10:00:00Z</lastmod></url></urlset>`;

test('accepts the exact HTTPS sitemap namespace and retains URL and date extraction', () => {
  const summary = inspect(urlset(httpsNamespace));
  assert.equal(summary.format, 'urlset');
  assert.equal(summary.entryCount, 1);
  assert.equal(summary.entriesWithUrl, 1);
  assert.deepEqual(summary.observedUrls, ['https://publisher.example/article']);
  assert.equal(summary.newestContentAt, '2026-10-26T10:00:00.000Z');
  assert.equal(summary.contentFreshness, 'recent');
});

test('HTTPS sitemap indexes retain child-only semantics and valid empty urlsets', () => {
  const summary = inspect(`<sitemapindex xmlns="${httpsNamespace}"><sitemap><loc>https://publisher.example/child.xml</loc></sitemap></sitemapindex>`);
  assert.equal(summary.format, 'sitemapindex');
  assert.equal(summary.entryCount, 1);
  assert.equal(summary.entriesWithUrl, 1);
  assert.deepEqual(summary.sampleUrls, ['https://publisher.example/child.xml']);
  assert.deepEqual(summary.observedUrls, []);
  assert.equal(inspect(`<urlset xmlns="${httpsNamespace}"/>`).entryCount, 0);
});

test('HTTPS sitemap compatibility does not match other namespaces or mixed child fields', () => {
  for (const namespace of [
    'https://sitemaps.org/schemas/sitemap/0.9',
    'https://www.sitemaps.org/schemas/sitemap/0.9/',
    'https://www.sitemaps.org/schemas/sitemap/0.90',
    'https://www.sitemaps.org.example/schemas/sitemap/0.9',
    'https://www.google.com/schemas/sitemap/0.84',
    'urn:unknown',
  ]) assert.throws(() => inspect(urlset(namespace)), /WRONG_ENDPOINT_FORMAT/);
  for (const [root, child] of [[httpsNamespace, standardNamespace], [standardNamespace, httpsNamespace]]) {
    const mismatchedEntry = inspect(`<urlset xmlns="${root}"><url xmlns="${child}"><loc>https://publisher.example/article</loc></url></urlset>`);
    assert.equal(mismatchedEntry.entryCount, 0);
    assert.deepEqual(mismatchedEntry.observedUrls, []);
    assert.throws(() => inspect(`<urlset xmlns="${root}"><url><loc xmlns="${child}">https://publisher.example/article</loc></url></urlset>`), /INVALID_ENTRY_URL/);
  }
});

test('HTTPS sitemap compatibility retains DTD, XML grammar, unsafe URL and size guards', () => {
  const xml = urlset(httpsNamespace);
  assert.throws(() => inspect('<!DOCTYPE urlset>' + xml), /DTD_NOT_ALLOWED/);
  assert.throws(() => inspect(xml.replace('</url>', '</broken>')), /INVALID_XML/);
  assert.throws(() => inspect(xml.replace('https://publisher.example/article', 'file:///tmp/article')), /INVALID_ENTRY_URL/);
  assert.throws(() => inspectXml(Buffer.from(xml), 'sitemap', now, 4), /BODY_TOO_LARGE/);
});
