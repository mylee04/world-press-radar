import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectXml } from '../dist/inspect.js';
import { validateXml } from '../dist/validate.js';

// Synthetic metadata only; no publisher feeds or article bodies are fixtures.
const now = Date.parse('2026-10-14T19:00:00Z');
const rss = (path = 'entry') => '<rss version="2.0"><channel><title>Test</title><link>https://example.com</link><description/>' +
  `<item><link>https://example.com/${path}</link><pubDate>Wed, 14 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
const declaration = encoding => `<?xml version="1.0" encoding="${encoding}"?>`;
const parse = (body, type = 'rss', maxBytes = 2 * 1024 * 1024) => inspectXml(body, type, now, maxBytes, true);
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16 = (xml, littleEndian = true, bom = true) => {
  const body = Buffer.from(xml, 'utf16le');
  if (!littleEndian) body.swap16();
  return bom ? Buffer.concat([Buffer.from(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]), body]) : body;
};

test('UTF-8 remains the strict default and preserves URL/count/date summaries', () => {
  const expected = parse(Buffer.from(rss('café/한글/😀')));
  assert.equal(expected.format, 'rss');
  assert.equal(expected.entryCount, 1);
  assert.equal(expected.entriesWithUrl, 1);
  assert.deepEqual(expected.observedUrls, ['https://example.com/caf%C3%A9/%ED%95%9C%EA%B8%80/%F0%9F%98%80']);
  assert.equal(expected.newestContentAt, '2026-10-14T12:00:00.000Z');
  assert.equal(expected.contentFreshness, 'recent');
  for (const name of ['UTF-8', 'utf-8', 'UtF-8']) assert.deepEqual(parse(Buffer.from(declaration(name) + rss('café/한글/😀'))), expected);
});

test('UTF-8 BOM is accepted with either no declaration or a matching declaration', () => {
  const expected = parse(Buffer.from(rss('café')));
  for (const prefix of ['', declaration('UTF-8')]) assert.deepEqual(parse(Buffer.concat([utf8Bom, Buffer.from(prefix + rss('café'))])), expected);
});

test('declared ISO-8859-1 decodes exact Latin-1 bytes and keeps collection metadata', () => {
  const expected = parse(Buffer.from(rss('café')));
  for (const name of ['ISO-8859-1', 'iso-8859-1', 'IsO-8859-1']) {
    const bytes = Buffer.from(declaration(name) + rss('café'), 'latin1');
    assert.deepEqual(parse(bytes), expected);
    assert.equal(validateXml(bytes, 'rss'), 'rss');
  }
});

test('ISO-8859-1 byte 0x80 is U+0080 rather than the Windows-1252 euro sign', () => {
  const result = parse(Buffer.from(declaration('ISO-8859-1') + rss('\u0080'), 'latin1'));
  assert.deepEqual(result.observedUrls, ['https://example.com/%C2%80']);
  assert.notDeepEqual(result.observedUrls, ['https://example.com/%E2%82%AC']);
});

test('XML declaration whitespace and single quotes use the same strict encoding', () => {
  const xml = "<?xml\nversion='1.0'\tencoding \r\n= 'ISO-8859-1' standalone='yes'?>" + rss('café');
  assert.deepEqual(parse(Buffer.from(xml, 'latin1')), parse(Buffer.from(rss('café'))));
});

test('explicit Latin-1 declarations determine decoding even when bytes are also valid UTF-8', () => {
  const result = parse(Buffer.from(declaration('ISO-8859-1') + rss('é'), 'utf8'));
  assert.deepEqual(result.observedUrls, ['https://example.com/%C3%83%C2%A9']);
});

test('missing declarations never cause a Latin-1 fallback', () => {
  for (const prefix of ['', '<?xml version="1.0"?>', declaration('UTF-8')]) {
    assert.throws(() => parse(Buffer.from(prefix + rss('café'), 'latin1')), /INVALID_XML/);
  }
});

test('invalid UTF-8 is rejected rather than replaced', () => {
  for (const invalid of [[0xc3], [0xc3, 0x28], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    const bytes = Buffer.concat([Buffer.from('<rss><channel><title>'), Buffer.from(invalid), Buffer.from('</title></channel></rss>')]);
    assert.throws(() => parse(bytes), /INVALID_XML/);
  }
  // An actually encoded replacement character is valid XML, unlike a decoder substitution.
  assert.deepEqual(parse(Buffer.from(rss('\uFFFD'))).observedUrls, ['https://example.com/%EF%BF%BD']);
});

test('UTF-8 BOM conflicts and repeated BOMs are rejected', () => {
  for (const name of ['ISO-8859-1', 'UTF-16']) assert.throws(() => parse(Buffer.concat([utf8Bom, Buffer.from(declaration(name) + rss())])), /INVALID_XML/);
  assert.throws(() => parse(Buffer.concat([utf8Bom, utf8Bom, Buffer.from(rss())])), /INVALID_XML/);
});

test('unsupported declarations are held instead of using decoder aliases or guesses', () => {
  for (const name of ['Windows-1252', 'Shift_JIS', 'ISO-8859-2', 'latin1', 'UTF8', 'UTF-16LE', 'UTF-16BE']) {
    assert.throws(() => parse(Buffer.from(declaration(name) + rss())), /UNSUPPORTED_ENCODING/);
  }
});

test('encoding attributes in comments or other processing instructions cannot select Latin-1', () => {
  for (const prefix of ['<!-- encoding="ISO-8859-1" -->', '<?xml-stylesheet encoding="ISO-8859-1"?>']) {
    assert.throws(() => parse(Buffer.from(prefix + rss('café'), 'latin1')), /INVALID_XML/);
    assert.equal(parse(Buffer.from(prefix + rss('café'))).format, 'rss');
  }
});

test('misplaced or malformed XML declarations remain invalid', () => {
  for (const prefix of [
    ' ' + declaration('ISO-8859-1'),
    '<!-- test -->' + declaration('ISO-8859-1'),
    '<?xml encoding="ISO-8859-1" version="1.0"?>',
    '<?xml version="1.0" encoding="ISO-8859-1" encoding="UTF-8"?>',
    '<?xml version="1.0" encoding="ISO-8859-1"',
    '<?xml version="1.0" encoding=" ISO-8859-1"?>',
  ]) assert.throws(() => parse(Buffer.from(prefix + rss(), 'latin1')), /INVALID_XML/);
});

test('UTF-16 BOM selects either byte order and supports non-ASCII and surrogate pairs', () => {
  const expected = parse(Buffer.from(rss('café/한글/😀')));
  for (const littleEndian of [true, false]) {
    const bytes = utf16(declaration('UTF-16') + rss('café/한글/😀'), littleEndian);
    assert.deepEqual(parse(bytes), expected);
    assert.equal(validateXml(bytes, 'rss'), 'rss');
  }
});

test('UTF-16 with a BOM also works without an XML declaration', () => {
  const expected = parse(Buffer.from(rss('café')));
  for (const littleEndian of [true, false]) assert.deepEqual(parse(utf16(rss('café'), littleEndian)), expected);
});

test('UTF-16 requires a BOM and matching encoding declaration', () => {
  assert.throws(() => parse(Buffer.from(declaration('UTF-16') + rss())), /INVALID_XML/);
  for (const littleEndian of [true, false]) {
    assert.throws(() => parse(utf16(declaration('UTF-16') + rss(), littleEndian, false)), /INVALID_XML/);
    for (const name of ['UTF-8', 'ISO-8859-1']) assert.throws(() => parse(utf16(declaration(name) + rss(), littleEndian)), /INVALID_XML/);
    for (const name of ['UTF-16LE', 'UTF-16BE']) assert.throws(() => parse(utf16(declaration(name) + rss(), littleEndian)), /UNSUPPORTED_ENCODING/);
  }
});

test('UTF-16 odd byte counts, lone surrogates and swapped signatures fail strictly', () => {
  for (const littleEndian of [true, false]) {
    const bytes = utf16(rss(), littleEndian);
    assert.throws(() => parse(bytes.subarray(0, bytes.length - 1)), /INVALID_XML/);
    assert.throws(() => parse(utf16(rss('\uD800'), littleEndian)), /INVALID_XML/);
    assert.throws(() => parse(utf16(rss('\uDC00'), littleEndian)), /INVALID_XML/);
    const swapped = Buffer.from(bytes); swapped[0] = bytes[1]; swapped[1] = bytes[0];
    assert.throws(() => parse(swapped), /INVALID_XML/);
    assert.throws(() => parse(utf16('\uFEFF' + rss(), littleEndian)), /INVALID_XML/);
  }
});

test('UCS-4 BOM variants are unsupported rather than misread as UTF-16', () => {
  for (const signature of [[0, 0, 0xfe, 0xff], [0xff, 0xfe, 0, 0], [0, 0, 0xff, 0xfe], [0xfe, 0xff, 0, 0]]) {
    assert.throws(() => parse(Buffer.concat([Buffer.from(signature), Buffer.from(rss())])), /UNSUPPORTED_ENCODING/);
  }
});

test('supported encodings retain XML grammar, DTD, HTML and required metadata guards', () => {
  const bodies = [
    ['<!DOCTYPE rss [<!ENTITY x "test">]>' + rss(), /DTD_NOT_ALLOWED/],
    ['<html><body>test</body></html>', /WRONG_ENDPOINT_FORMAT/],
    [rss().replace('<description/>', ''), /WRONG_ENDPOINT_FORMAT/],
    [rss().replace('<description/>', '<description xmlns="urn:wrong"/>'), /WRONG_ENDPOINT_FORMAT/],
    [rss().replace('<title>Test</title>', '<title>\u0000</title>'), /INVALID_XML/],
    [rss().replace('</channel>', '</broken>'), /INVALID_XML/],
  ];
  for (const [xml, error] of bodies) {
    assert.throws(() => parse(Buffer.from(declaration('ISO-8859-1') + xml, 'latin1')), error);
    assert.throws(() => parse(utf16(declaration('UTF-16') + xml)), error);
  }
});

test('raw byte size limit is checked before any encoding support', () => {
  for (const bytes of [Buffer.from(declaration('ISO-8859-1') + rss('café'), 'latin1'), utf16(rss())]) {
    assert.throws(() => parse(bytes, 'rss', bytes.length - 1), /BODY_TOO_LARGE/);
    assert.equal(parse(bytes, 'rss', bytes.length).format, 'rss');
  }
});

test('ISO-8859-1 and UTF-16 sitemaps retain namespace and unsafe URL rejection', () => {
  const sitemap = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/café</loc><lastmod>2026-10-14T12:00:00Z</lastmod></url></urlset>';
  const encode = [xml => Buffer.from(declaration('ISO-8859-1') + xml, 'latin1'), xml => utf16(declaration('UTF-16') + xml, false)];
  for (const bytes of encode) {
    const result = parse(bytes(sitemap), 'sitemap');
    assert.equal(result.format, 'urlset');
    assert.equal(result.dateKind, 'sitemap_lastmod');
    assert.deepEqual(result.observedUrls, ['https://example.com/caf%C3%A9']);
    assert.throws(() => parse(bytes(sitemap.replace('https://example.com/café', 'file:///tmp/test')), 'sitemap'), /INVALID_ENTRY_URL/);
    assert.throws(() => parse(bytes(sitemap.replace('http://www.sitemaps.org/schemas/sitemap/0.9', 'urn:wrong')), 'sitemap'), /WRONG_ENDPOINT_FORMAT/);
  }
});
