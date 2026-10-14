// All XML and HTTP responses are synthetic; these tests perform no network I/O.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';

let responses = [], requests = [], answers = [{ address: '8.8.8.8', family: 4 }];
mock.module('node:dns/promises', { namedExports: { lookup: async () => answers } });
function fakeRequest(url, options, callback) {
  requests.push(url.href);
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
const { inspectXml } = await import('../dist/inspect.js');
const { fetchXml, validateXml, checkEndpoint } = await import('../dist/validate.js');
const { auditEndpoint } = await import('../dist/audit-check.js');

const now = Date.parse('2026-10-14T20:00:00Z');
const xml = '<rss version="0.91"><channel><title>Caf\u00e9</title><link>https://example.com</link><description>Test</description>' +
  '<item><title>Test</title><link>https://example.com/caf\u00e9</link><pubDate>Wed, 14 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>';
const latin1 = Buffer.from(xml, 'latin1'), utf8 = Buffer.from(xml);
const parse = (body, contentType) => inspectXml(body, 'rss', now, 2 * 1024 * 1024, true, contentType);
const endpoint = { id: 'ep_' + 'a'.repeat(24), type: 'rss', url: 'https://example.com/feed' };
const decl = name => `<?xml version="1.0" encoding="${name}"?>`;
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16 = (body, littleEndian = true) => {
  const bytes = Buffer.from(body, 'utf16le');
  if (!littleEndian) bytes.swap16();
  return Buffer.concat([Buffer.from(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]), bytes]);
};
const reset = (...fixtures) => { responses = fixtures; requests = []; answers = [{ address: '8.8.8.8', family: 4 }]; };
const response = (contentType, body = latin1) => ({ status: 200, headers: contentType === undefined ? {} : { 'content-type': contentType }, body });

test('explicit XML MIME Latin-1 recovers synthetic legacy RSS metadata without guessing', () => {
  for (const contentType of ['text/xml;charset=ISO-8859-1', 'application/xml; charset="iso-8859-1"', 'application/rss+xml; charset=ISO-8859-1', 'image/example+xml; CHARSET=ISO-8859-1']) {
    assert.deepEqual(parse(latin1, contentType), parse(utf8));
    assert.equal(validateXml(latin1, 'rss', contentType), 'rss');
  }
  assert.throws(() => parse(latin1), /INVALID_XML/);
});

test('MIME Latin-1 preserves exact ISO byte mapping rather than Windows-1252', () => {
  const bytes = Buffer.from(xml.replace('caf\u00e9</link>', '\u0080</link>'), 'latin1');
  assert.deepEqual(parse(bytes, 'text/xml;charset=ISO-8859-1').observedUrls, ['https://example.com/%C2%80']);
});

test('XML MIME without charset retains in-band declarations and the UTF-8 default', () => {
  for (const contentType of [undefined, 'text/xml', 'application/xml; profile="https://example.com/profile;a=1"']) {
    assert.deepEqual(parse(utf8, contentType), parse(utf8));
    assert.throws(() => parse(latin1, contentType), /INVALID_XML/);
    assert.deepEqual(parse(Buffer.from(decl('ISO-8859-1') + xml, 'latin1'), contentType), parse(utf8));
  }
});

test('matching MIME charset and XML declaration are allowed with case-insensitive names', () => {
  assert.deepEqual(parse(Buffer.from(decl('iso-8859-1') + xml, 'latin1'), 'Text/XML; Charset="ISO-8859-1"'), parse(utf8));
  assert.deepEqual(parse(Buffer.from(decl('UTF-8') + xml), 'application/rss+xml; charset=utf-8'), parse(utf8));
});

test('RFC 9110 empty and trailing semicolon parameters retain strict charset selection', () => {
  for (const contentType of ['text/xml;', 'text/xml; ;\t;']) assert.deepEqual(parse(utf8, contentType), parse(utf8));
  for (const contentType of ['text/xml;charset=ISO-8859-1;', 'text/xml; ;charset=ISO-8859-1;\t;']) assert.deepEqual(parse(latin1, contentType), parse(utf8));
  assert.throws(() => parse(utf8, 'text/xml;;charset=UTF-8;;CHARSET=UTF-8;'), /INVALID_XML/);
});

test('MIME, XML declaration and BOM conflicts are held by collector policy', () => {
  for (const [body, contentType] of [
    [Buffer.from(decl('UTF-8') + xml), 'text/xml; charset=ISO-8859-1'],
    [Buffer.from(decl('ISO-8859-1') + xml, 'latin1'), 'text/xml; charset=UTF-8'],
    [Buffer.concat([utf8Bom, utf8]), 'text/xml; charset=ISO-8859-1'],
    [utf16(xml), 'text/xml; charset=UTF-8'],
    [utf16(decl('ISO-8859-1') + xml), 'text/xml; charset=UTF-16'],
  ]) assert.throws(() => parse(body, contentType), /INVALID_XML/);
});

test('explicit UTF-8 and BOM UTF-16 remain strict', () => {
  assert.deepEqual(parse(Buffer.concat([utf8Bom, utf8]), 'text/xml; charset=UTF-8'), parse(utf8));
  for (const littleEndian of [true, false]) assert.deepEqual(parse(utf16(xml, littleEndian), 'application/xml; charset=UTF-16'), parse(utf8));
  assert.throws(() => parse(utf8, 'text/xml; charset=UTF-16'), /INVALID_XML/);
  assert.throws(() => parse(latin1, 'text/xml; charset=UTF-8'), /INVALID_XML/);
});

test('unsupported charset labels do not invoke decoder aliases or fallbacks', () => {
  for (const name of ['Windows-1252', 'Shift_JIS', 'US-ASCII', 'UTF8', 'latin1', 'UTF-16LE', 'UTF-16BE']) {
    assert.throws(() => parse(utf8, `text/xml; charset=${name}`), /UNSUPPORTED_ENCODING/);
  }
});

test('duplicate charset and other ambiguous Content-Type parameters are rejected', () => {
  for (const contentType of [
    'text/xml;charset=UTF-8;charset=UTF-8',
    'text/xml;charset=ISO-8859-1;CHARSET=UTF-8',
    'text/xml;profile=a;profile=b',
    "text/xml;charset*=utf-8''ISO-8859-1",
  ]) assert.throws(() => parse(utf8, contentType), /INVALID_XML/);
});

test('malformed MIME types, charset values, quoting and folded headers are rejected', () => {
  for (const contentType of [
    '', 'xml', 'text/', 'text /xml;charset=UTF-8', 'text/xmljunk trailing',
    'text/xml;charset=', 'text/xml;charset=""', 'text/xml;charset=" ISO-8859-1"',
    'text/xml;charset="UTF-8', 'text/xml;charset=UTF-8, text/xml;charset=ISO-8859-1',
    'text/xml;charset =UTF-8', 'text/xml;charset= UTF-8', 'text/xml;charset=\tUTF-8',
    'text/xml\r\n;charset=UTF-8', 'text/xml;charset="UTF\u0000-8"',
  ]) assert.throws(() => parse(utf8, contentType), /INVALID_XML/);
});

test('non-XML media types cannot opt into MIME Latin-1 decoding or establish feed validity', () => {
  for (const type of ['text/html', 'application/octet-stream', 'text/plain']) {
    assert.throws(() => parse(latin1, `${type};charset=ISO-8859-1`), /INVALID_XML/);
    assert.equal(parse(utf8, `${type};charset=ISO-8859-1`).format, 'rss');
  }
  assert.throws(() => parse(Buffer.from('<html>Test</html>'), 'text/html;charset=UTF-8'), /WRONG_ENDPOINT_FORMAT/);
});

test('MIME-supported XML retains DTD, required metadata, URL and byte-size guards', () => {
  const header = 'text/xml;charset=ISO-8859-1';
  assert.throws(() => parse(Buffer.from(decl('ISO-8859-1') + '<!DOCTYPE rss [<!ENTITY x "test">]>' + xml, 'latin1'), header), /DTD_NOT_ALLOWED/);
  assert.throws(() => parse(Buffer.from(xml.replace('<description>Test</description>', ''), 'latin1'), header), /WRONG_ENDPOINT_FORMAT/);
  assert.throws(() => parse(Buffer.from(xml.replace('<link>https://example.com</link>', '<link/>'), 'latin1'), header), /WRONG_ENDPOINT_FORMAT/);
  const unsafe = xml.replace('https://example.com/caf\u00e9', 'file:///tmp/test');
  assert.equal(parse(Buffer.from(unsafe, 'latin1'), header).entriesWithUrl, 0);
  const sitemap = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>file:///tmp/test</loc></url></urlset>';
  assert.throws(() => inspectXml(Buffer.from(sitemap), 'sitemap', now, undefined, true, header), /INVALID_ENTRY_URL/);
  assert.throws(() => inspectXml(latin1, 'rss', now, latin1.length - 1, true, header), /BODY_TOO_LARGE/);
});

test('fetchXml returns only the terminal redirect Content-Type and preserves missing-header defaults', async () => {
  reset({ status: 302, headers: { location: '/final', 'content-type': 'text/html;charset=UTF-8' } }, response('text/xml;charset=ISO-8859-1'));
  const fetched = await fetchXml(endpoint.url);
  assert.equal(fetched.contentType, 'text/xml;charset=ISO-8859-1');
  assert.equal(fetched.finalUrl, 'https://example.com/final');
  assert.equal(validateXml(fetched.body, 'rss', fetched.contentType), 'rss');
  reset({ status: 302, headers: { location: '/final', 'content-type': 'text/xml;charset=ISO-8859-1' } }, response(undefined, utf8));
  const missing = await fetchXml(endpoint.url);
  assert.equal(missing.contentType, undefined);
  assert.equal(validateXml(missing.body, 'rss', missing.contentType), 'rss');
  reset({ status: 302, headers: { location: '/final', 'content-type': 'text/xml;charset=ISO-8859-1' } }, response(undefined));
  const invalid = await fetchXml(endpoint.url);
  assert.throws(() => validateXml(invalid.body, 'rss', invalid.contentType), /INVALID_XML/);
});

test('HTTP field duplicates cannot be hidden by Node normalized headers', async () => {
  reset({ ...response('text/xml;charset=ISO-8859-1'), rawHeaders: ['Content-Type', 'text/xml;charset=ISO-8859-1', 'content-type', 'text/xml;charset=UTF-8'] });
  await assert.rejects(fetchXml(endpoint.url), /INVALID_XML/);
  assert.equal(requests.length, 1);
});

test('checkEndpoint and production audit use the same MIME decoder', async () => {
  reset(response('text/xml;charset=ISO-8859-1'));
  const checked = await checkEndpoint(endpoint);
  assert.equal(checked.outcome, 'healthy'); assert.equal(checked.format, 'rss');
  reset(response('text/xml;charset=ISO-8859-1'));
  const audited = await auditEndpoint(endpoint, undefined, true);
  assert.equal(audited.outcome, 'healthy'); assert.equal(audited.auditStatus, 'working_nonempty');
  assert.equal(audited.entriesWithUrl, 1); assert.deepEqual(audited.observedUrls, ['https://example.com/caf%C3%A9']);
  for (const validate of [checkEndpoint, auditEndpoint]) {
    reset(response('text/xml;charset=UTF-8'));
    const rejected = await validate(endpoint);
    assert.equal(rejected.outcome, 'unhealthy'); assert.equal(rejected.reason, 'INVALID_XML');
  }
});

test('MIME propagation does not bypass SSRF, redirect DNS or gzip limits', async () => {
  reset(response('text/xml;charset=ISO-8859-1')); answers = [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(fetchXml(endpoint.url), /PRIVATE_ADDRESS/); assert.equal(requests.length, 0);
  reset({ status: 302, headers: { location: 'http://169.254.169.254/feed', 'content-type': 'text/xml;charset=ISO-8859-1' } });
  await assert.rejects(fetchXml(endpoint.url), /PRIVATE_ADDRESS/); assert.equal(requests.length, 1);
  reset({ ...response('text/xml;charset=ISO-8859-1', gzipSync(Buffer.alloc(1025))), headers: { 'content-type': 'text/xml;charset=ISO-8859-1', 'content-encoding': 'gzip' } });
  await assert.rejects(fetchXml(endpoint.url, 8000, 1024));
});
