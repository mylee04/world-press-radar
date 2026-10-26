import { readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SaxesParser } from 'saxes';
import { fetchXml, safeUrl } from '../dist/validate.js';
import { inspectXml, SITEMAP_NAMESPACES } from '../dist/inspect.js';
import { createHostGate } from '../dist/host-gate.js';
import { parseRetryAfter } from '../dist/collection-schedule.js';
import { normalizeArticleUrl } from '../dist/article-url.js';
import { robotsPolicy } from '../expansion/robots-policy.mjs';

const MAX_INPUT = 256 * 1024, MAX_BODY = 4 * 1024 * 1024, MAX_ROBOTS_BODY = 128 * 1024;
const sitemapNamespaces = new Set(SITEMAP_NAMESPACES);
const NS = { atom: 'http://www.w3.org/2005/Atom', rss: 'http://purl.org/rss/1.0/', dc: 'http://purl.org/dc/elements/1.1/', sitemap: 'http://www.sitemaps.org/schemas/sitemap/0.9', news: 'http://www.google.com/schemas/sitemap-news/0.9' };
const number = (value, min, max, name) => { const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw Error(`INVALID_${name}`); return n; };
const publicUrl = value => safeUrl(value).href;

export function parsePackInput(raw, includeExcluded = false, selectionGroup = null) {
  if (selectionGroup !== null && (typeof selectionGroup !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(selectionGroup))) throw Error('INVALID_SELECTION_GROUP');
  if (Buffer.byteLength(raw) > MAX_INPUT) throw Error('IMPORT_INPUT_TOO_LARGE');
  let items;
  if (raw.trimStart().startsWith('<')) {
    if (selectionGroup !== null) throw Error('IMPORT_SELECTION_GROUP_REQUIRES_TYPED_JSON');
    items = []; let root = '';
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => { throw Error('DTD_NOT_ALLOWED'); });
    parser.on('error', () => { throw Error('INVALID_OPML'); });
    parser.on('opentag', tag => {
      if (!root) root = tag.local;
      if (tag.local !== 'outline') return;
      const attrs = Object.fromEntries(Object.values(tag.attributes).map(a => [a.local, a.value]));
      if (attrs.xmlUrl && (!attrs.type || attrs.type === 'rss')) items.push({ publisher: attrs.title || attrs.text || '', type: 'rss', url: attrs.xmlUrl });
    });
    parser.write(raw).close();
    if (root !== 'opml') throw Error('INVALID_OPML');
  } else {
    let document;
    try { document = JSON.parse(raw); } catch { throw Error('INVALID_PACK_JSON'); }
    items = document.endpoints ?? document.sources;
    if (!Array.isArray(items)) throw Error('INVALID_PACK_ENDPOINTS');
  }
  if (selectionGroup !== null) {
    items = items.filter(item => item?.selection_group === selectionGroup);
    if (!items.length) throw Error('IMPORT_SELECTION_GROUP_NOT_FOUND');
  }
  if (items.length > 20) throw Error('IMPORT_TOO_MANY_ENDPOINTS');
  const seen = new Set();
  return items.map(item => {
    const type = item.type ?? (item.format === 'news_sitemap' ? 'sitemap' : item.format);
    if (!['rss', 'sitemap'].includes(type) || typeof item.url !== 'string') throw Error('INVALID_PACK_ENDPOINT');
    const url = publicUrl(item.url), id = `${type}:${url}`;
    if (seen.has(id)) return null;
    seen.add(id);
    return { type, url, publisher: String(item.publisher ?? item.name ?? '').slice(0, 512), selection_group: item.selection_group ?? null,
      excluded_by_saved_policy: item.enabled === false || item.default_export_eligible === false,
      skip: !includeExcluded && (item.enabled === false || item.default_export_eligible === false) };
  }).filter(Boolean);
}

// Validation below has already checked byte encoding and conflicting declarations.
function decodedValidated(buffer, contentType) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
  const declared = /^\s*<\?xml[^?]*\bencoding\s*=\s*["']([^"']+)/i.exec(buffer.subarray(0, 512).toString('latin1'))?.[1].toLowerCase();
  const external = /;\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType ?? '')?.[1].toLowerCase();
  const xmlMime = /^(?:application|text)\/(?:xml|[^;\s]+\+xml)(?:;|\s|$)/i.test(contentType ?? '');
  return (xmlMime && external || declared) === 'iso-8859-1' ? buffer.toString('latin1') : new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

export function extractArticleMetadata(body, type, contentType, now = Date.now()) {
  const summary = inspectXml(body, type, now, MAX_BODY, false, contentType);
  const parser = new SaxesParser({ xmlns: true }), stack = [];
  const articles = [], children = []; let entry = null, entryDepth = 0, capture = null, unknownUrls = 0, navigationUrls = 0;
  const record = () => {
    if (!entry?.url) return;
    let url;
    try { url = publicUrl(entry.url); } catch { unknownUrls++; return; }
    if (summary.format === 'sitemapindex') { children.push(url); return; }
    if (normalizeArticleUrl(url).kind === 'uncertain') { navigationUrls++; return; }
    if (!entry.title?.trim()) { unknownUrls++; return; }
    const rawDate = entry.published || entry.date || entry.updated || entry.lastmod || null;
    const parsed = rawDate && /\d{4}/.test(rawDate) && (/^\d{4}-\d{2}-\d{2}/.test(rawDate) || /[A-Za-z]{3}/.test(rawDate)) ? Date.parse(rawDate) : NaN;
    const validDate = Number.isFinite(parsed) && parsed <= now + 24 * 3600000;
    articles.push({ title: entry.title.trim().slice(0, 1024), url, date: validDate ? new Date(parsed).toISOString() : null,
      date_kind: entry.published ? type === 'sitemap' ? 'news_publication_date' : 'feed_item_date' : entry.lastmod ? 'sitemap_lastmod' : 'feed_item_date',
      date_status: rawDate ? validDate ? 'recorded' : 'unreliable' : 'missing' });
  };
  parser.on('doctype', () => { throw Error('DTD_NOT_ALLOWED'); });
  parser.on('error', () => { throw Error('INVALID_XML'); });
  parser.on('opentag', tag => {
    stack.push(tag.local); const path = stack.join('/');
    if ((path === 'rss/channel/item' && tag.uri === '') || (path === 'RDF/item' && tag.uri === NS.rss) || (path === 'feed/entry' && tag.uri === NS.atom) || (['urlset/url', 'sitemapindex/sitemap'].includes(path) && sitemapNamespaces.has(tag.uri))) {
      entry = {}; entryDepth = stack.length;
    }
    if (!entry) return;
    const direct = stack.length === entryDepth + 1;
    if (summary.format === 'atom' && direct && tag.local === 'link' && tag.uri === NS.atom) {
      const attrs = Object.fromEntries(Object.values(tag.attributes).map(a => [a.local, a.value]));
      if ((!attrs.rel || attrs.rel === 'alternate') && attrs.href) entry.url ??= attrs.href;
    }
    let field;
    if (direct && type === 'rss') {
      const rssField = ['rss', 'rdf'].includes(summary.format) && (tag.uri === '' || tag.uri === NS.rss);
      if (rssField && ['title', 'link', 'pubDate'].includes(tag.local)) field = { title: 'title', link: 'url', pubDate: 'published' }[tag.local];
      if (tag.uri === NS.dc && tag.local === 'date') field = 'date';
      if (summary.format === 'atom' && tag.uri === NS.atom && ['title', 'published', 'updated'].includes(tag.local)) field = tag.local;
    }
    if (type === 'sitemap' && direct && sitemapNamespaces.has(tag.uri) && ['loc', 'lastmod'].includes(tag.local)) field = tag.local === 'loc' ? 'url' : 'lastmod';
    if (type === 'sitemap' && stack.length === entryDepth + 2 && tag.uri === NS.news && ['title', 'publication_date'].includes(tag.local)) field = tag.local === 'title' ? 'title' : 'published';
    if (field) capture = { field, depth: stack.length, value: '' };
  });
  const text = value => { if (capture && capture.value.length < 8192) capture.value += value.slice(0, 8192 - capture.value.length); };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => {
    if (capture?.depth === stack.length) { if (capture.value.trim()) entry[capture.field] ??= capture.value.trim(); capture = null; }
    if (entry && stack.length === entryDepth) { record(); entry = null; }
    stack.pop();
  });
  parser.write(decodedValidated(body, contentType)).close();
  return { format: summary.format, entries: summary.entryCount, articles, children: [...new Set(children)], unknown_urls: unknownUrls, navigation_urls: navigationUrls };
}

export async function importSourcePack(endpoints, options = {}, dependencies = {}) {
  const maxDocuments = number(options.maxDocuments ?? 10, 1, 20, 'DOCUMENT_LIMIT');
  const maxDepth = number(options.maxDepth ?? 1, 0, 2, 'DEPTH_LIMIT');
  const maxItems = number(options.maxItems ?? 1000, 1, 5000, 'ITEM_LIMIT');
  const transport = dependencies.fetchXml ?? fetchXml, clock = dependencies.now ?? Date.now;
  const deadline = clock() + 90000, gate = dependencies.gate ?? createHostGate(2000);
  const robots = new Map(), seen = new Set(), scheduled = new Set(), queue = [], documents = [], articles = new Map(), holds = [], holdSummary = {};
  let requests = 0, attemptedDocuments = 0, fetchedDocuments = 0, partial = false;
  const hold = item => { holdSummary[item.reason] = (holdSummary[item.reason] ?? 0) + (item.omitted_children ?? 1); if (holds.length < 40) holds.push(item); partial = true; };
  const maxRequests = 2 * maxDocuments + 20;
  for (const endpoint of endpoints) {
    if (endpoint.skip) hold({ url: endpoint.url, reason: 'saved_policy_excluded' });
    else if (!scheduled.has(endpoint.url)) { scheduled.add(endpoint.url); queue.push({ ...endpoint, depth: 0, root_url: endpoint.url }); }
  }
  async function get(url, maxBytes) {
    if (clock() >= deadline) throw Error('IMPORT_TIME_LIMIT');
    let hops = 0;
    const restrictedGate = async (hostname, requestDeadline) => {
      if (hops++) throw Error('IMPORT_REDIRECT_REQUIRES_REVIEW');
      if (requests >= maxRequests) throw Error('IMPORT_REQUEST_LIMIT');
      const release = await gate(hostname, Math.min(requestDeadline, deadline)); requests++; return release;
    };
    const response = await transport(url, Math.min(12000, Math.max(1, deadline - clock())), maxBytes, restrictedGate);
    const final = response.finalUrl ?? url;
    if (final !== url) throw Error('IMPORT_REDIRECT_REQUIRES_REVIEW');
    if (response.status === 429 || response.status >= 500) {
      const retry = parseRetryAfter(response.retryAfter, clock());
      gate.defer?.(new URL(url).hostname, retry?.at ?? new Date(clock() + 3600000).toISOString(), response.status);
    }
    return response;
  }
  async function permission(url, row) {
    const target = new URL(url), key = target.origin;
    if (!robots.has(key)) {
      try {
        const response = await get(new URL('/robots.txt', target).href, MAX_ROBOTS_BODY);
        // RFC 9309 section 2.3.1.3 permits resource access when robots is unavailable.
        // Retain that absence of policy evidence; actual endpoint authorization still applies.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) robots.set(key, { state: 'unavailable_4xx', status: response.status, text: '' });
        else if (response.status === 200) robots.set(key, { state: 'available', status: 200, text: new TextDecoder('utf-8', { fatal: true }).decode(response.body) });
        else robots.set(key, { state: 'hold', status: response.status, retry_after: parseRetryAfter(response.retryAfter, clock())?.at ?? null });
      } catch (error) { robots.set(key, { state: 'hold', status: null, reason: error?.message === 'IMPORT_REDIRECT_REQUIRES_REVIEW' ? error.message : 'ROBOTS_UNAVAILABLE' }); }
    }
    const policy = robots.get(key);
    Object.assign(row, { robots: policy.state, robots_http_status: policy.status ?? null, robots_retry_after: policy.retry_after ?? null });
    if (policy.state === 'hold') throw Error(policy.reason ?? 'ROBOTS_UNAVAILABLE');
    if (robotsPolicy(policy.text, url).decision === 'disallowed') throw Error('ROBOTS_DISALLOWED');
    return policy.state;
  }
  while (queue.length) {
    const item = queue.shift();
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    if (attemptedDocuments >= maxDocuments || clock() >= deadline || articles.size >= maxItems) {
      hold({ url: item.url, reason: clock() >= deadline ? 'IMPORT_TIME_LIMIT' : articles.size >= maxItems ? 'IMPORT_ITEM_LIMIT' : 'IMPORT_DOCUMENT_LIMIT' }); continue;
    }
    const row = { url: item.url, root_url: item.root_url, publisher: item.publisher, type: item.type, depth: item.depth, checked_at: new Date(clock()).toISOString(), excluded_by_saved_policy: !!item.excluded_by_saved_policy };
    try {
      row.robots = await permission(item.url, row);
      attemptedDocuments++;
      const response = await get(item.url, MAX_BODY); fetchedDocuments++;
      row.http_status = response.status;
      row.retry_after = parseRetryAfter(response.retryAfter, clock())?.at ?? null;
      if (response.status !== 200) { row.state = response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'blocked' : 'http_error'; partial = true; }
      else {
        const parsed = extractArticleMetadata(response.body, item.type, response.contentType, clock());
        Object.assign(row, { format: parsed.format, entries: parsed.entries, article_candidates: parsed.articles.length, dated_candidates: parsed.articles.filter(a => a.date !== null).length, unknown_urls: parsed.unknown_urls, navigation_urls: parsed.navigation_urls });
        if (parsed.format === 'sitemapindex') {
          row.state = 'index_only';
          for (const child of parsed.children) {
            if (seen.has(child) || scheduled.has(child)) continue;
            if (new URL(child).origin !== new URL(item.root_url).origin) hold({ url: child, parent: item.url, reason: 'CROSS_ORIGIN_CHILD' });
            else if (item.depth >= maxDepth) hold({ url: child, parent: item.url, reason: 'IMPORT_DEPTH_LIMIT' });
            else if (attemptedDocuments + queue.length >= maxDocuments) hold({ url: child, parent: item.url, reason: 'IMPORT_DOCUMENT_LIMIT' });
            else { scheduled.add(child); queue.push({ ...item, url: child, depth: item.depth + 1 }); }
          }
        } else {
          row.state = parsed.articles.length ? 'article_metadata' : parsed.entries ? 'no_article_metadata' : 'valid_empty';
          if (parsed.entries && !parsed.articles.length) partial = true;
          for (const article of parsed.articles) {
            if (articles.has(article.url)) continue;
            if (articles.size >= maxItems) { partial = true; row.item_limit_reached = true; break; }
            articles.set(article.url, { ...article, publisher: item.publisher, endpoint_url: item.url });
          }
        }
      }
    } catch (error) {
      const reason = error?.message ?? '';
      row.state = reason.startsWith('ROBOTS_') ? 'policy_hold' : reason === 'SERVER_RETRY_AFTER_WAIT' ? 'deferred' : 'unavailable';
      row.reason = /^(?:ROBOTS_[A-Z_]+|IMPORT_[A-Z_]+|HTTP_\d{3}|TIMEOUT|POLITENESS_WAIT_LIMIT|PRIVATE_ADDRESS|UNSAFE_PORT|TOO_MANY_REDIRECTS|BODY_TOO_LARGE|UNSUPPORTED_ENCODING|DTD_NOT_ALLOWED|INVALID_XML|WRONG_ENDPOINT_FORMAT|SERVER_RETRY_AFTER_WAIT)$/.test(reason) ? reason : 'FETCH_OR_PARSE_ERROR';
      partial = true;
    }
    documents.push(row);
  }
  return { version: 1, observed_at: new Date(clock()).toISOString(), selection_group: options.selectionGroup ?? null, state: partial ? 'partial' : articles.size ? 'complete' : 'no_articles',
    semantics: 'Bounded article-candidate metadata from XML only. Dates retain their declared feed/news/lastmod meaning. No article body or production collection record is fetched or written; counts do not establish publication completeness.',
    limits: { max_documents: maxDocuments, max_depth: maxDepth, max_items: maxItems, same_host_gap_ms: 2000, max_run_seconds: 90, max_xml_bytes: MAX_BODY, max_robots_bytes: MAX_ROBOTS_BODY, robots_size_limit_behavior: 'Oversized robots documents are held without parsing a truncated policy; this bounded importer does not claim full RFC 9309 conformance.' },
    requested_hops: requests, attempted_documents: attemptedDocuments, fetched_documents: fetchedDocuments, article_candidates: articles.size,
    dated_candidates: [...articles.values()].filter(a => a.date !== null).length, documents, holds, hold_summary: holdSummary, articles: [...articles.values()] };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const opts = {}, allowed = new Set(['--input', '--output', '--max-documents', '--max-depth', '--max-items', '--selection-group']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-excluded' && !opts.includeExcluded) { opts.includeExcluded = true; continue; }
    if (!allowed.has(args[i]) || args[i + 1] === undefined || args[i + 1].startsWith('--') || args[i] in opts) throw Error('Usage: import-source-pack.mjs --input FILE --output FILE [--max-documents 10] [--max-depth 1] [--max-items 1000] [--selection-group national_major] [--include-excluded]');
    opts[args[i]] = args[++i];
  }
  if (!opts['--input'] || !opts['--output']) throw Error('IMPORT_INPUT_AND_OUTPUT_REQUIRED');
  const info = await (dependencies.stat ?? stat)(opts['--input']);
  if (!info.isFile() || info.size > MAX_INPUT) throw Error('IMPORT_INPUT_TOO_LARGE');
  const endpoints = parsePackInput(await (dependencies.readFile ?? readFile)(opts['--input'], 'utf8'), opts.includeExcluded, opts['--selection-group'] ?? null);
  const result = await importSourcePack(endpoints, { maxDocuments: opts['--max-documents'], maxDepth: opts['--max-depth'], maxItems: opts['--max-items'], selectionGroup: opts['--selection-group'] ?? null }, dependencies);
  const content = JSON.stringify(result, null, 2) + '\n';
  if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw Error('IMPORT_OUTPUT_TOO_LARGE');
  await (dependencies.writeFile ?? writeFile)(opts['--output'], content, { flag: 'wx', mode: 0o600 });
  (dependencies.print ?? console.log)(JSON.stringify({ state: result.state, selection_group: result.selection_group, article_candidates: result.article_candidates, dated_candidates: result.dated_candidates, fetched_documents: result.fetched_documents, requested_hops: result.requested_hops, output: opts['--output'] }));
  return result.state === 'complete' || result.state === 'no_articles' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(code => { process.exitCode = code; }).catch(() => { console.error('SOURCE_PACK_IMPORT_FAILED'); process.exitCode = 1; });
