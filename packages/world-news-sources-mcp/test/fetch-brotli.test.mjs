// Synthetic transport responses only. No DNS lookup or publisher request occurs.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { brotliCompressSync, gzipSync } from 'node:zlib';

let responses = [], requests = [], answers = [{ address: '8.8.8.8', family: 4 }], pinned;
mock.module('node:dns/promises', { namedExports: { lookup: async () => answers } });
function fakeRequest(url, options, callback) {
  requests.push({ url: url.href, headers: options.headers });
  options.lookup(url.hostname, { all: false }, (_error, address) => { pinned = address; });
  const request = new EventEmitter();
  request.destroy = error => { if (error) request.emit('error', error); request.emit('close'); };
  request.end = () => queueMicrotask(() => {
    const fixture = responses.shift();
    assert.ok(fixture, 'UNEXPECTED_FIXTURE_REQUEST');
    const response = new PassThrough();
    response.statusCode = fixture.status;
    response.headers = fixture.headers ?? {};
    response.rawHeaders = fixture.rawHeaders ?? Object.entries(response.headers).flat();
    response.on('close', () => request.emit('close'));
    callback(response);
    if (!response.destroyed) response.end(fixture.body ?? Buffer.alloc(0));
  });
  return request;
}
mock.module('node:http', { namedExports: { request: fakeRequest } });
mock.module('node:https', { namedExports: { request: fakeRequest } });
const { fetchXml, checkEndpoint, validateXml } = await import('../dist/validate.js');
const { auditEndpoint } = await import('../dist/audit-check.js');
const { inspectXml } = await import('../dist/inspect.js');

const rss = '<rss version="2.0"><channel><title>Caf\u00e9</title><link>https://example.com</link><description>News</description>' +
  '<item><title>One</title><link>https://example.com/news/one</link></item></channel></rss>';
const sitemap = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  '<url><loc>https://example.com/news/one</loc></url><url><loc>https://example.com/news/two</loc></url></urlset>';
const endpoint = { id: 'ep_' + 'a'.repeat(24), type: 'rss', url: 'https://example.com/feed' };
const reset = (...fixtures) => { responses = fixtures; requests = []; answers = [{ address: '8.8.8.8', family: 4 }]; pinned = undefined; };
const br = (body, contentType = 'application/rss+xml; charset=UTF-8') => ({ status: 200,
  headers: { 'content-encoding': 'br', 'content-type': contentType }, body: brotliCompressSync(body) });

test('declared Brotli preserves exact RSS bytes, terminal MIME and the pinned identity request', async () => {
  const original = Buffer.from(rss);
  reset(br(original));
  let releases = 0;
  const response = await fetchXml(endpoint.url, 8000, 4 * 1024 ** 2, async host => {
    assert.equal(host, 'example.com'); return () => { releases++; };
  });
  assert.deepEqual(response.body, original);
  assert.equal(response.contentType, 'application/rss+xml; charset=UTF-8');
  assert.equal(response.finalUrl, endpoint.url); assert.equal(response.requestedHops, 1);
  assert.equal(pinned, '8.8.8.8'); assert.equal(releases, 1);
  assert.equal(requests[0].headers['accept-encoding'], 'identity');
  const parsed = inspectXml(response.body, 'rss', Date.now(), 4 * 1024 ** 2, true, response.contentType);
  assert.equal(parsed.format, 'rss'); assert.deepEqual(parsed.observedUrls, ['https://example.com/news/one']);
});

test('declared Brotli news sitemap still passes the unchanged typed XML inspector', async () => {
  reset(br(Buffer.from(sitemap), 'text/xml; charset=UTF-8'));
  const response = await fetchXml('https://example.com/news-sitemap.xml', 8000, 8 * 1024 ** 2);
  const parsed = inspectXml(response.body, 'sitemap', Date.now(), 8 * 1024 ** 2, true, response.contentType);
  assert.equal(parsed.format, 'urlset'); assert.equal(parsed.entryCount, 2);
  assert.deepEqual(parsed.observedUrls, ['https://example.com/news/one', 'https://example.com/news/two']);
  assert.equal(parsed.newestContentAt, null);
});

test('checker and production audit share Brotli transport and existing explicit MIME charset rules', async () => {
  const latin1 = Buffer.from(rss, 'latin1');
  reset(br(latin1, 'text/xml; charset=ISO-8859-1'));
  assert.equal((await checkEndpoint(endpoint)).outcome, 'healthy');
  reset(br(latin1, 'text/xml; charset=ISO-8859-1'));
  const checked = await auditEndpoint(endpoint, undefined, true);
  assert.equal(checked.auditStatus, 'working_nonempty'); assert.equal(checked.entriesWithUrl, 1);
  assert.deepEqual(checked.observedUrls, ['https://example.com/news/one']);
  reset(br(Buffer.from(rss), 'text/xml; charset=Windows-1251'));
  assert.equal((await auditEndpoint(endpoint)).reason, 'UNSUPPORTED_ENCODING');
});

test('Brotli decoding does not relax required RSS metadata, DTD or sitemap URL checks', async () => {
  for (const [body, type, reason] of [
    [rss.replace('<description>News</description>', ''), 'rss', 'WRONG_ENDPOINT_FORMAT'],
    ['<!DOCTYPE rss [<!ENTITY x "test">]>' + rss, 'rss', 'DTD_NOT_ALLOWED'],
    [sitemap.replace('https://example.com/news/one', 'file:///tmp/private'), 'sitemap', 'INVALID_ENTRY_URL'],
  ]) {
    reset(br(Buffer.from(body)));
    const response = await fetchXml(endpoint.url);
    assert.throws(() => validateXml(response.body, type, response.contentType), new RegExp(reason));
  }
});

test('Brotli wire bytes and expanded bytes are independently capped at the caller limit', async () => {
  reset({ status: 200, headers: { 'content-encoding': 'br' }, body: Buffer.alloc(1025) });
  await assert.rejects(fetchXml(endpoint.url, 8000, 1024), /BODY_TOO_LARGE/);
  reset(br(Buffer.alloc(1025)));
  await assert.rejects(fetchXml(endpoint.url, 8000, 1024), error => error.code === 'ERR_BUFFER_TOO_LARGE');
  reset(br(Buffer.alloc(4 * 1024 ** 2 + 1)));
  const checked = await auditEndpoint(endpoint);
  assert.equal(checked.outcome, 'unhealthy'); assert.equal(checked.auditStatus, 'incomplete');
});

test('corrupt, truncated or mismatched Brotli cannot fall back to another decoder', async () => {
  const encoded = brotliCompressSync(Buffer.from(rss));
  for (const body of [Buffer.from(rss), encoded.subarray(0, encoded.length - 2), gzipSync(Buffer.from(rss))]) {
    reset({ status: 200, headers: { 'content-encoding': 'br' }, body });
    await assert.rejects(fetchXml(endpoint.url), error => error.requestedHops === 1 && error.lastHttpStatus === 200);
    assert.equal(requests.length, 1);
  }
  reset({ status: 200, body: encoded });
  const undeclared = await fetchXml(endpoint.url);
  assert.deepEqual(undeclared.body, encoded);
  assert.throws(() => validateXml(undeclared.body, 'rss'));
});

test('deflate, unknown and stacked content codings remain unsupported', async () => {
  for (const encoding of ['deflate', 'zstd', 'gzip, br', 'br, gzip', 'br, br']) {
    reset({ status: 200, headers: { 'content-encoding': encoding }, body: brotliCompressSync(Buffer.from(rss)) });
    await assert.rejects(fetchXml(endpoint.url), /UNSUPPORTED_ENCODING/);
    assert.equal(requests.length, 1);
  }
});

test('duplicate Content-Encoding fields cannot hide behind normalized Node headers', async () => {
  reset({ ...br(Buffer.from(rss)), rawHeaders: ['Content-Encoding', 'br', 'content-encoding', 'gzip'] });
  await assert.rejects(fetchXml(endpoint.url), /UNSUPPORTED_ENCODING/);
  assert.equal(requests.length, 1);
});

test('redirects decode only the terminal response and preserve terminal MIME', async () => {
  reset({ status: 302, headers: { location: '/final', 'content-encoding': 'zstd', 'content-type': 'text/html' } },
    br(Buffer.from(rss), 'text/xml; charset=UTF-8'));
  const response = await fetchXml(endpoint.url);
  assert.equal(response.finalUrl, 'https://example.com/final'); assert.equal(response.requestedHops, 2);
  assert.equal(response.contentType, 'text/xml; charset=UTF-8'); assert.equal(validateXml(response.body, 'rss', response.contentType), 'rss');
});

test('identity, gzip and existing headerless gzip behavior remain available', async () => {
  const body = Buffer.from(rss);
  for (const fixture of [{ status: 200, body },
    { status: 200, headers: { 'content-encoding': 'identity' }, body },
    { status: 200, headers: { 'content-encoding': 'gzip' }, body: gzipSync(body) },
    { status: 200, body: gzipSync(body) }]) {
    reset(fixture); assert.deepEqual((await fetchXml(endpoint.url)).body, body);
  }
});

test('Brotli support cannot bypass private DNS, redirect boundaries or HTTP block outcomes', async () => {
  reset(br(Buffer.from(rss))); answers = [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(fetchXml(endpoint.url), /PRIVATE_ADDRESS/); assert.equal(requests.length, 0);
  reset({ status: 302, headers: { location: 'http://169.254.169.254/feed' } });
  await assert.rejects(fetchXml(endpoint.url), /PRIVATE_ADDRESS/); assert.equal(requests.length, 1);
  reset({ status: 403, headers: { 'content-encoding': 'br' }, body: brotliCompressSync(Buffer.from(rss)) });
  const checked = await auditEndpoint(endpoint);
  assert.equal(checked.auditStatus, 'blocked'); assert.equal(checked.httpStatus, 403); assert.equal(requests.length, 1);
});
