import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { inspectXml } from './inspect.js';
import { canonicalUrl, type Endpoint, type EndpointType } from './catalog.js';
import type { Observation } from './health.js';

const MAX_BYTES = 2 * 1024 * 1024;
export function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // IANA special-purpose ranges; keep conservative protocol/transition exclusions.
  if (isIP(address) !== 6 || !/^[23][a-f0-9]{3}:/i.test(address) || /^2002:|^3fff:/i.test(address)) return false;
  const parts = address.toLowerCase().split(':'); const second = parseInt(parts[1] || '0', 16);
  return parts[0] !== '2001' || (second >= 0x200 && second !== 0xdb8);
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
  return inspectXml(buffer, type).format;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT')), Math.max(1, milliseconds));
  })]); } finally { clearTimeout(timer!); }
}
export type RequestGate = (hostname: string, deadline: number) => Promise<() => void>;
export async function fetchXml(raw: string, timeoutMs = 8000, maxBytes = MAX_BYTES, gate?: RequestGate): Promise<{ status: number; body: Buffer; finalUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  let current = raw;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (Date.now() >= deadline) throw new Error('TIMEOUT');
    const url = safeUrl(current);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const release = gate ? await gate(hostname, deadline) : () => {};
    try {
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
          if (length > maxBytes) request.destroy(new Error('BODY_TOO_LARGE')); else chunks.push(chunk);
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
    if (response.encoding === 'gzip' || (body[0] === 0x1f && body[1] === 0x8b)) body = gunzipSync(body, { maxOutputLength: maxBytes });
    return { status: response.status, body, finalUrl: url.href };
    } finally { release(); }
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
