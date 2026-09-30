import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { canonicalUrl, type Endpoint, type EndpointType } from './catalog.js';
import type { Observation } from './health.js';

const MAX_BYTES = 2 * 1024 * 1024;
export function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Conservative public IPv6 range. Reject mapped/transition/local/documentation addresses.
  return isIP(address) === 6 && /^[23][a-f0-9]{3}:/i.test(address) && !/^2001:|^2002:|^3fff:/i.test(address);
}
export function safeUrl(raw: string): URL {
  const url = new URL(canonicalUrl(raw));
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new Error('UNSAFE_PORT');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error('PRIVATE_ADDRESS');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicIp(host)) throw new Error('PRIVATE_ADDRESS');
  return url;
}

export function validateXml(buffer: Buffer, type: EndpointType): NonNullable<Observation['format']> {
  if (buffer.length > MAX_BYTES) throw new Error('BODY_TOO_LARGE');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  const fields = new Map<string, string>();
  let root = ''; let namespace = ''; let channel = false; let locations = 0; let capture = ''; let capturing = false;
  let activeField: string | null = null;
  parser.on('doctype', () => { throw new Error('DTD_NOT_ALLOWED'); });
  parser.on('error', () => { throw new Error('INVALID_XML'); });
  parser.on('opentag', tag => {
    stack.push(tag.local);
    if (stack.length === 1) { root = tag.local; namespace = tag.uri; }
    if (stack.join('/') === 'rss/channel' && tag.uri === '') channel = true;
    const rssField = root === 'rss' && stack.length === 3 && stack[1] === 'channel' && tag.uri === '';
    const atomField = root === 'feed' && stack.length === 2 && tag.uri === 'http://www.w3.org/2005/Atom';
    const rdfField = root === 'RDF' && stack.length === 3 && stack[1] === 'channel' && tag.uri === 'http://purl.org/rss/1.0/';
    if (rssField || atomField || rdfField) { activeField = tag.local; fields.set(activeField, ''); }
    if (['urlset/url/loc', 'sitemapindex/sitemap/loc'].includes(stack.join('/')) && tag.uri === 'http://www.sitemaps.org/schemas/sitemap/0.9') { capture = ''; capturing = true; }
  });
  const recordText = (value: string) => {
    if (capturing) capture += value;
    if (activeField) fields.set(activeField, (fields.get(activeField) ?? '') + value);
  };
  parser.on('text', recordText);
  parser.on('cdata', recordText);
  parser.on('closetag', () => {
    if (capturing && stack.at(-1) === 'loc') { canonicalUrl(capture.trim()); locations++; capturing = false; }
    if (stack.at(-1) === activeField) activeField = null;
    stack.pop();
  });
  parser.write(xml).close();
  if (type === 'rss') {
    const has = (keys: string[]) => keys.every(k => fields.get(k)?.trim());
    if (root === 'rss' && namespace === '' && channel && has(['title', 'link', 'description'])) return 'rss';
    if (root === 'feed' && namespace === 'http://www.w3.org/2005/Atom' && has(['title', 'id', 'updated']) && Number.isFinite(Date.parse(fields.get('updated')!))) return 'atom';
    if (root === 'RDF' && namespace === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' && has(['title', 'link', 'description'])) return 'rdf';
  } else if (['urlset', 'sitemapindex'].includes(root) && namespace === 'http://www.sitemaps.org/schemas/sitemap/0.9' && locations > 0) {
    return root as 'urlset' | 'sitemapindex';
  }
  throw new Error('WRONG_ENDPOINT_FORMAT');
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT')), Math.max(1, milliseconds));
  })]); } finally { clearTimeout(timer!); }
}
export async function fetchXml(raw: string, timeoutMs = 8000): Promise<{ status: number; body: Buffer }> {
  const deadline = Date.now() + timeoutMs;
  let current = raw;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (Date.now() >= deadline) throw new Error('TIMEOUT');
    const url = safeUrl(current);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const ips = await bounded(lookup(hostname, { all: true, verbatim: true }), deadline - Date.now());
    if (!ips.length || ips.some(ip => !isPublicIp(ip.address))) throw new Error('PRIVATE_ADDRESS');
    const pinned = ips[0];
    // Pin the validated DNS result to the socket, preventing a second DNS resolution/rebinding.
    const pinnedLookup: LookupFunction = (_host, options, callback) => {
      if (options.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
    };
    const response = await new Promise<{ status: number; body: Buffer; location?: string; encoding?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        lookup: pinnedLookup, agent: false,
        headers: { 'user-agent': 'WorldNewsSourcesMCP/0.1 (bounded metadata validation)', accept: 'application/xml, application/rss+xml, application/atom+xml, text/xml', 'accept-encoding': 'identity' },
      }, response => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          resolve({ status, body: Buffer.alloc(0), location: response.headers.location });
          return;
        }
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_BYTES) request.destroy(new Error('BODY_TOO_LARGE')); else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status, body: Buffer.concat(chunks), encoding: response.headers['content-encoding'] }));
      });
      const timer = setTimeout(() => request.destroy(new Error('TIMEOUT')), Math.max(1, deadline - Date.now()));
      request.on('close', () => clearTimeout(timer));
      request.on('error', reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      if (redirects === 3) throw new Error('TOO_MANY_REDIRECTS');
      current = new URL(response.location, url).href;
      continue;
    }
    let body = response.body;
    if (response.encoding && !['identity', 'gzip'].includes(response.encoding)) throw new Error('UNSUPPORTED_ENCODING');
    if (response.encoding === 'gzip' || (body[0] === 0x1f && body[1] === 0x8b)) body = gunzipSync(body, { maxOutputLength: MAX_BYTES });
    return { status: response.status, body };
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

export async function checkEndpoint(endpoint: Endpoint): Promise<Observation> {
  let httpStatus: number | null = null;
  let format: Observation['format'] = null;
  let reason: string | null = null;
  try {
    const response = await fetchXml(endpoint.url);
    httpStatus = response.status;
    if (httpStatus < 200 || httpStatus >= 300) throw new Error(`HTTP_${httpStatus}`);
    format = validateXml(response.body, endpoint.type);
  } catch (error) {
    // Store only a finite reason code, never arbitrary server body, URL credentials or network error text.
    const message = error instanceof Error ? error.message : '';
    reason = /^(HTTP_\d{3}|TIMEOUT|BODY_TOO_LARGE|PRIVATE_ADDRESS|UNSAFE_PORT|TOO_MANY_REDIRECTS|UNSUPPORTED_ENCODING|DTD_NOT_ALLOWED|INVALID_XML|WRONG_ENDPOINT_FORMAT)$/.test(message) ? message : 'NETWORK_OR_PARSE_ERROR';
  }
  return { endpointId: endpoint.id, type: endpoint.type, url: endpoint.url, checkedAt: new Date().toISOString(),
    outcome: reason ? 'unhealthy' : 'healthy', httpStatus, reason, format };
}
