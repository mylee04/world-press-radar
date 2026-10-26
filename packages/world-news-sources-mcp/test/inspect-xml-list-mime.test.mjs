import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectXml } from '../dist/inspect.js';
import { validateXml } from '../dist/validate.js';

// Synthetic XML and the observed publisher header only. No network requests.
const header = 'application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4; charset=utf-8';
const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
const rss = '<rss version="2.0"><channel><title>News</title><link>https://publisher.example/</link><description/>' +
  '<item><link>https://publisher.example/뉴스</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>';
const bytes = Buffer.from(declaration + rss);
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const parse = (body = bytes, contentType = header) => inspectXml(body, 'rss', Date.parse('2026-10-26T12:00:00Z'), undefined, true, contentType);

test('exact observed XML list header requires declared UTF-8 and preserves feed observations', () => {
  const expected = parse(bytes, 'application/rss+xml; charset=utf-8');
  for (const contentType of [header, header.toUpperCase(), '\t' + header.replaceAll(', ', ',\t').replaceAll('; ', ';\t') + ' ']) {
    assert.deepEqual(parse(bytes, contentType), expected);
    assert.deepEqual(parse(Buffer.concat([bom, bytes]), contentType), expected);
    assert.equal(validateXml(bytes, 'rss', contentType), 'rss');
  }
  assert.equal(expected.entriesWithUrl, 1);
  assert.equal(expected.newestContentAt, '2026-10-26T10:00:00.000Z');
});

test('XML list compatibility never guesses a declaration or UTF-8 encoding alias', () => {
  for (const body of [
    Buffer.from(rss),
    Buffer.concat([bom, Buffer.from(rss)]),
    Buffer.from('<?xml version="1.0"?>' + rss),
    Buffer.from(declaration.replace('UTF-8', 'UTF8') + rss),
    Buffer.from(declaration.replace('UTF-8', 'ISO-8859-1') + rss),
    Buffer.from(' ' + declaration + rss),
    Buffer.from('<!-- encoding="UTF-8" -->' + rss),
    Buffer.from('<?xml-stylesheet encoding="UTF-8"?>' + rss),
    Buffer.from(declaration + rss, 'utf16le'),
  ]) assert.throws(() => parse(body), /INVALID_XML/);
});

test('XML list compatibility rejects nonexact lists, q values, aliases and extra parameters', () => {
  for (const contentType of [
    header.replace('application/rss+xml', 'text/html'),
    header.replace('application/rdf+xml', 'application/custom+xml'),
    header.replace('application/rdf+xml', 'application/rss+xml'),
    header.replace('application/rss+xml, ', ''),
    header + ', application/xml',
    header.replace('q=0.8', 'q=1.1'),
    header.replace('q=0.8', 'q=.8'),
    header.replace('q=0.8', 'q=0.8000'),
    header.replace('q=0.8', 'q=0.7'),
    header.replace('q=0.8', 'q=0.8;q=0.8'),
    header.replace('q=0.8', 'q =0.8'),
    header.replace('q=0.8', 'q=0.8;profile=test'),
    header.replace('application/rss+xml,', 'application/rss+xml;charset=utf-8,'),
    header.replace('charset=utf-8', 'charset=utf8'),
    header.replace('charset=utf-8', 'charset=iso-8859-1'),
    header.replace('charset=utf-8', 'charset="utf-8"'),
    header.replace('; charset=utf-8', ''),
    header + ';charset=utf-8',
    header + ';charset*=utf-8',
    header + ';unknown=yes',
    header + '\r\n',
  ]) assert.throws(() => parse(bytes, contentType), /INVALID_XML/);
});

test('XML list compatibility retains fatal UTF-8, XML grammar and required metadata checks', () => {
  const invalidUtf8 = Buffer.concat([Buffer.from(declaration + '<rss><channel><title>'), Buffer.from([0xc3, 0x28]), Buffer.from('</title></channel></rss>')]);
  assert.throws(() => parse(invalidUtf8), /INVALID_XML/);
  assert.throws(() => parse(Buffer.concat([bom, bom, bytes])), /INVALID_XML/);
  assert.throws(() => parse(Buffer.from(declaration + '<!DOCTYPE rss>' + rss)), /DTD_NOT_ALLOWED/);
  assert.throws(() => parse(Buffer.from(declaration + rss.replace('</channel>', '</broken>'))), /INVALID_XML/);
  assert.throws(() => parse(Buffer.from(declaration + rss.replace('<description/>', ''))), /WRONG_ENDPOINT_FORMAT/);
  assert.throws(() => parse(Buffer.from(declaration + '<html>not a feed</html>')), /WRONG_ENDPOINT_FORMAT/);
  assert.throws(() => inspectXml(bytes, 'rss', Date.now(), 4, true, header), /BODY_TOO_LARGE/);
  assert.throws(() => parse(bytes, 'application/rss+xml; charset=utf-8; charset=utf-8'), /INVALID_XML/);
  assert.throws(() => parse(bytes, 'application/rss+xml; charset =utf-8'), /INVALID_XML/);
});
