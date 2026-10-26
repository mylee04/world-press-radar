import { SaxesParser } from 'saxes';
import { canonicalUrl, type EndpointType } from './catalog.js';

export const SITEMAP_NAMESPACES = ['http://www.sitemaps.org/schemas/sitemap/0.9', 'http://www.google.com/schemas/sitemap/0.84'] as const;

export type XmlSummary = {
  format: 'rss' | 'atom' | 'rdf' | 'urlset' | 'sitemapindex';
  entryCount: number; entriesWithUrl: number; sampleUrls: string[];
  newestContentAt: string | null;
  contentFreshness: 'recent' | 'stale' | 'missing' | 'unreliable';
  dateKind: 'feed_item_date' | 'sitemap_lastmod';
  observedUrls?: string[];
};

function declaredEncoding(xml: string): string | undefined {
  // Only the initial XML declaration determines the encoding. Saxes still
  // validates its grammar; comments, other PIs and body attributes cannot opt in.
  if (!/^<\?xml[ \t\r\n]/.test(xml)) return;
  const end = xml.indexOf('?>');
  if (end < 0) return;
  return /[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(xml.slice(0, end))?.[2].toLowerCase();
}

function decodeStrict(buffer: Buffer, encoding: 'utf-8' | 'utf-16le' | 'utf-16be'): string {
  try {
    // Remove the one detected signature explicitly, preserving all other U+FEFFs.
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch { throw new Error('INVALID_XML'); }
}

function requireEncoding(declared: string | undefined, expected: 'utf-8' | 'utf-16'): void {
  if (!declared || declared === expected) return;
  if (['utf-8', 'utf-16', 'iso-8859-1'].includes(declared)) throw new Error('INVALID_XML');
  throw new Error('UNSUPPORTED_ENCODING');
}

function xmlMimeEncoding(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return;
  if (typeof contentType !== 'string' || /[^\t\x20-\x7e]/.test(contentType)) throw new Error('INVALID_XML');
  const media = /^[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)/.exec(contentType);
  if (!media) throw new Error('INVALID_XML');
  const type = `${media[1]}/${media[2]}`.toLowerCase();
  const isXml = type === 'application/xml' || type === 'text/xml' || media[2].toLowerCase().endsWith('+xml');
  // RFC 9110 permits empty semicolon parameters, but no whitespace around '='.
  const parameter = /[ \t]*;[ \t]*(?:([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[^"\\\r\n]|\\[\t\x20-\x7e])*"))?/y;
  const names = new Set<string>(); let index = media[0].length; let charset: string | undefined;
  while (contentType.slice(index).trim()) {
    parameter.lastIndex = index;
    const part = parameter.exec(contentType);
    if (!part) throw new Error('INVALID_XML');
    index = parameter.lastIndex;
    const name = part[1]?.toLowerCase();
    if (!name) continue;
    if (names.has(name) || name === 'charset*') throw new Error('INVALID_XML');
    names.add(name);
    const value = part[2].startsWith('"') ? part[2].slice(1, -1).replace(/\\([\t\x20-\x7e])/g, '$1') : part[2];
    if (name === 'charset') {
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) throw new Error('INVALID_XML');
      charset = value.toLowerCase();
    }
  }
  // Only XML media types can provide an external XML character encoding.
  if (!isXml) return;
  if (charset && !['utf-8', 'utf-16', 'iso-8859-1'].includes(charset)) throw new Error('UNSUPPORTED_ENCODING');
  return charset;
}

function decodeXml(buffer: Buffer, contentType?: string): string {
  const external = xmlMimeEncoding(contentType);
  const starts = (...bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);
  // Recognize unsupported UCS-4 signatures before their UTF-16 prefixes.
  if (starts(0, 0, 0xfe, 0xff) || starts(0xff, 0xfe, 0, 0) ||
      starts(0, 0, 0xff, 0xfe) || starts(0xfe, 0xff, 0, 0)) throw new Error('UNSUPPORTED_ENCODING');
  if (starts(0xff, 0xfe) || starts(0xfe, 0xff)) {
    const xml = decodeStrict(buffer.subarray(2), buffer[0] === 0xff ? 'utf-16le' : 'utf-16be');
    if (xml.startsWith('\uFEFF')) throw new Error('INVALID_XML');
    requireEncoding(declaredEncoding(xml), 'utf-16');
    requireEncoding(external, 'utf-16');
    return xml;
  }
  const utf8Bom = starts(0xef, 0xbb, 0xbf);
  const body = utf8Bom ? buffer.subarray(3) : buffer;
  // The declaration of an ASCII-compatible encoding is itself ASCII. Read
  // only that prolog before choosing the strict decoder for the entire body.
  const end = body.indexOf('?>');
  const declared = end < 0 ? undefined : declaredEncoding(body.subarray(0, end + 2).toString('latin1'));
  if (declared && !['utf-8', 'utf-16', 'iso-8859-1'].includes(declared)) throw new Error('UNSUPPORTED_ENCODING');
  // RFC 7303 defines MIME charset as authoritative without a BOM. This
  // collector deliberately holds conflicting signals instead of overriding one.
  if (external && declared && external !== declared) throw new Error('INVALID_XML');
  const encoding = external ?? declared ?? 'utf-8';
  if (utf8Bom) { requireEncoding(declared, 'utf-8'); requireEncoding(external, 'utf-8'); }
  else if (encoding === 'iso-8859-1') {
    // WHATWG TextDecoder maps this label to Windows-1252. Buffer's latin1
    // conversion instead preserves the exact ISO-8859-1 byte-to-codepoint map.
    return body.toString('latin1');
  } else if (encoding === 'utf-16') throw new Error('INVALID_XML'); // UTF-16 needs a BOM.
  const xml = decodeStrict(body, 'utf-8');
  if (xml.startsWith('\uFEFF')) throw new Error('INVALID_XML');
  return xml;
}

// Extract counts, a few URLs and dates only. No article text is retained.
export function inspectXml(buffer: Buffer, type: EndpointType, now = Date.now(), maxBytes = 2 * 1024 * 1024, fullUrls = false, contentType?: string): XmlSummary {
  if (buffer.length > maxBytes) throw new Error('BODY_TOO_LARGE');
  const xml = decodeXml(buffer, contentType);
  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = []; const fields = new Map<string, string>();
  let root = ''; let namespace = ''; let channel = false;
  let entryCount = 0; let entriesWithUrl = 0; let inEntry = false; let entryDepth = 0; let entryUrl = false;
  let active: { name: string; depth: number; value: string; kind: 'field' | 'url' | 'date' } | null = null;
  let newest = 0; let badDate = false; const sampleUrls: string[] = [];
  const observedUrls = new Set<string>();
  const atomNs = 'http://www.w3.org/2005/Atom'; const rssNs = 'http://purl.org/rss/1.0/';
  const sitemapNamespaces = new Set<string>(SITEMAP_NAMESPACES);
  const sitemapNamespace = (uri: string) => sitemapNamespaces.has(namespace) && uri === namespace;
  const recordUrl = (value: string, required = false) => {
    try { const url = canonicalUrl(value.trim()); entryUrl = true; if (fullUrls && root !== 'sitemapindex') observedUrls.add(url); if (sampleUrls.length < 3 && !sampleUrls.includes(url)) sampleUrls.push(url); }
    catch { if (required) throw new Error('INVALID_ENTRY_URL'); }
  };
  const recordDate = (value: string) => {
    if (!value.trim()) return;
    // RFC822 RSS dates and ISO Atom/sitemap dates; numeric/locale ambiguous dates are unreliable.
    if (!/\d{4}/.test(value) || (!/^\d{4}-\d{2}-\d{2}/.test(value) && !/[A-Za-z]{3}/.test(value))) { badDate = true; return; }
    const date = Date.parse(value.trim());
    if (!Number.isFinite(date) || date > now + 24 * 60 * 60 * 1000) { badDate = true; return; }
    newest = Math.max(newest, date);
  };
  parser.on('doctype', () => { throw new Error('DTD_NOT_ALLOWED'); });
  parser.on('error', () => { throw new Error('INVALID_XML'); });
  parser.on('opentag', tag => {
    stack.push(tag.local); const path = stack.join('/');
    if (stack.length === 1) { root = tag.local; namespace = tag.uri; }
    if (path === 'rss/channel' && tag.uri === '') channel = true;
    const rssField = root === 'rss' && stack.length === 3 && stack[1] === 'channel' && tag.uri === '';
    const atomField = root === 'feed' && stack.length === 2 && tag.uri === atomNs;
    const rdfField = root === 'RDF' && stack.length === 3 && stack[1] === 'channel' && tag.uri === rssNs;
    if ((rssField || atomField || rdfField) && ['title', 'link', 'description', 'id', 'updated'].includes(tag.local)) {
      active = { name: tag.local, depth: stack.length, value: '', kind: 'field' };
    }
    if ((path === 'rss/channel/item' && tag.uri === '') || (path === 'feed/entry' && tag.uri === atomNs) ||
      (path === 'RDF/item' && tag.uri === rssNs) || (['urlset/url', 'sitemapindex/sitemap'].includes(path) && sitemapNamespace(tag.uri))) {
      inEntry = true; entryDepth = stack.length; entryUrl = false; entryCount++;
    }
    if (inEntry && stack.length === entryDepth + 1) {
      if (root === 'feed' && tag.local === 'link' && tag.uri === atomNs) {
        const attributes = Object.values(tag.attributes); const href = attributes.find(a => a.local === 'href')?.value;
        const rel = attributes.find(a => a.local === 'rel')?.value;
        if (href && (!rel || rel === 'alternate')) recordUrl(href);
      }
      const isLoc = ['urlset', 'sitemapindex'].includes(root) && tag.local === 'loc' && sitemapNamespace(tag.uri);
      const isLink = ['rss', 'RDF'].includes(root) && tag.local === 'link' && tag.uri === (root === 'RDF' ? rssNs : '');
      const isDate = (root === 'feed' && ['updated', 'published'].includes(tag.local) && tag.uri === atomNs) ||
        (['rss', 'RDF'].includes(root) && ((tag.local === 'pubDate' && tag.uri === '') || (tag.local === 'date' && tag.uri === 'http://purl.org/dc/elements/1.1/'))) ||
        (['urlset', 'sitemapindex'].includes(root) && tag.local === 'lastmod' && sitemapNamespace(tag.uri));
      if (isLoc || isLink || isDate) active = { name: tag.local, depth: stack.length, value: '', kind: isDate ? 'date' : 'url' };
    }
  });
  const text = (value: string) => { if (active) active.value += value; };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => {
    if (active?.depth === stack.length) {
      // A blank duplicate (for example an unnamespaced self-link) must not
      // erase usable channel metadata that appeared earlier in the feed.
      if (active.kind === 'field' && (!fields.has(active.name) || active.value.trim())) fields.set(active.name, active.value);
      if (active.kind === 'url') recordUrl(active.value, ['urlset', 'sitemapindex'].includes(root));
      if (active.kind === 'date') recordDate(active.value);
      active = null;
    }
    if (inEntry && stack.length === entryDepth) {
      if (['urlset', 'sitemapindex'].includes(root) && !entryUrl) throw new Error('INVALID_ENTRY_URL');
      if (entryUrl) entriesWithUrl++; inEntry = false;
    }
    stack.pop();
  });
  parser.write(xml).close();
  const has = (keys: string[]) => keys.every(k => fields.get(k)?.trim());
  let format: XmlSummary['format'] | null = null;
  if (type === 'rss') {
    // RSS requires the description element. Its text may be empty; this is
    // format recognition, while title/link still need usable text.
    if (root === 'rss' && namespace === '' && channel && has(['title', 'link']) && fields.has('description')) format = 'rss';
    if (root === 'feed' && namespace === atomNs && has(['title', 'id', 'updated']) && Number.isFinite(Date.parse(fields.get('updated')!))) format = 'atom';
    if (root === 'RDF' && namespace === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' && has(['title', 'link']) && fields.has('description')) format = 'rdf';
  } else if (['urlset', 'sitemapindex'].includes(root) && sitemapNamespaces.has(namespace)) format = root as XmlSummary['format'];
  if (!format) throw new Error('WRONG_ENDPOINT_FORMAT');
  return { format, entryCount, entriesWithUrl, sampleUrls, newestContentAt: newest ? new Date(newest).toISOString() : null,
    contentFreshness: badDate ? 'unreliable' : !newest ? 'missing' : now - newest > 30 * 24 * 60 * 60 * 1000 ? 'stale' : 'recent',
    dateKind: type === 'rss' ? 'feed_item_date' : 'sitemap_lastmod', ...(fullUrls ? { observedUrls: [...observedUrls] } : {}) };
}
