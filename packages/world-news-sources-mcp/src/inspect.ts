import { SaxesParser } from 'saxes';
import { canonicalUrl, type EndpointType } from './catalog.js';

export type XmlSummary = {
  format: 'rss' | 'atom' | 'rdf' | 'urlset' | 'sitemapindex';
  entryCount: number; entriesWithUrl: number; sampleUrls: string[];
  newestContentAt: string | null;
  contentFreshness: 'recent' | 'stale' | 'missing' | 'unreliable';
  dateKind: 'feed_item_date' | 'sitemap_lastmod';
  observedUrls?: string[];
};

// Extract counts, a few URLs and dates only. No article text is retained.
export function inspectXml(buffer: Buffer, type: EndpointType, now = Date.now(), maxBytes = 2 * 1024 * 1024, fullUrls = false): XmlSummary {
  if (buffer.length > maxBytes) throw new Error('BODY_TOO_LARGE');
  let xml:string;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{throw new Error('INVALID_UTF8');}
  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = []; const fields = new Map<string, string>();
  let root = ''; let namespace = ''; let channel = false;
  let entryCount = 0; let entriesWithUrl = 0; let inEntry = false; let entryDepth = 0; let entryUrl = false;
  let active: { name: string; depth: number; value: string; kind: 'field' | 'url' | 'date' } | null = null;
  let newest = 0; let badDate = false; const sampleUrls: string[] = [];
  const observedUrls = new Set<string>();
  const atomNs = 'http://www.w3.org/2005/Atom'; const rssNs = 'http://purl.org/rss/1.0/';
  const sitemapNs = 'http://www.sitemaps.org/schemas/sitemap/0.9';
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
      (path === 'RDF/item' && tag.uri === rssNs) || (['urlset/url', 'sitemapindex/sitemap'].includes(path) && tag.uri === sitemapNs)) {
      inEntry = true; entryDepth = stack.length; entryUrl = false; entryCount++;
    }
    if (inEntry && stack.length === entryDepth + 1) {
      if (root === 'feed' && tag.local === 'link' && tag.uri === atomNs) {
        const attributes = Object.values(tag.attributes); const href = attributes.find(a => a.local === 'href')?.value;
        const rel = attributes.find(a => a.local === 'rel')?.value;
        if (href && (!rel || rel === 'alternate')) recordUrl(href);
      }
      const isLoc = ['urlset', 'sitemapindex'].includes(root) && tag.local === 'loc' && tag.uri === sitemapNs;
      const isLink = ['rss', 'RDF'].includes(root) && tag.local === 'link' && tag.uri === (root === 'RDF' ? rssNs : '');
      const isDate = (root === 'feed' && ['updated', 'published'].includes(tag.local) && tag.uri === atomNs) ||
        (['rss', 'RDF'].includes(root) && ((tag.local === 'pubDate' && tag.uri === '') || (tag.local === 'date' && tag.uri === 'http://purl.org/dc/elements/1.1/'))) ||
        (['urlset', 'sitemapindex'].includes(root) && tag.local === 'lastmod' && tag.uri === sitemapNs);
      if (isLoc || isLink || isDate) active = { name: tag.local, depth: stack.length, value: '', kind: isDate ? 'date' : 'url' };
    }
  });
  const text = (value: string) => { if (active) active.value += value; };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => {
    if (active?.depth === stack.length) {
      if (active.kind === 'field') fields.set(active.name, active.value);
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
    if (root === 'rss' && namespace === '' && channel && has(['title', 'link', 'description'])) format = 'rss';
    if (root === 'feed' && namespace === atomNs && has(['title', 'id', 'updated']) && Number.isFinite(Date.parse(fields.get('updated')!))) format = 'atom';
    if (root === 'RDF' && namespace === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' && has(['title', 'link', 'description'])) format = 'rdf';
  } else if (['urlset', 'sitemapindex'].includes(root) && namespace === sitemapNs) format = root as XmlSummary['format'];
  if (!format) throw new Error('WRONG_ENDPOINT_FORMAT');
  return { format, entryCount, entriesWithUrl, sampleUrls, newestContentAt: newest ? new Date(newest).toISOString() : null,
    contentFreshness: badDate ? 'unreliable' : !newest ? 'missing' : now - newest > 30 * 24 * 60 * 60 * 1000 ? 'stale' : 'recent',
    dateKind: type === 'rss' ? 'feed_item_date' : 'sitemap_lastmod', ...(fullUrls ? { observedUrls: [...observedUrls] } : {}) };
}
