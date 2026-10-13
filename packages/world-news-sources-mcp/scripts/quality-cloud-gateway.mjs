// The hosted dashboard talks only to this same-origin gateway. The backend URL
// and gateway credential are deployment settings and never browser parameters.
const ADMIN_COOKIE = 'wns_quality_admin';
const COOKIE_VALUE = '(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{1,1024}\\.[A-Za-z0-9_-]{43})';
const MAX_BODY = 8192;
const MAX_RESPONSE = 8 * 1024 * 1024;
const uuid = '[a-f0-9-]{36}';
const routes = [
  [/^\/(overview|country|source)$/, ['GET']],
  [/^\/investigations$/, ['GET', 'POST']],
  [new RegExp(`^/investigations/(?:requests/)?${uuid}$`), ['GET']],
  [/^\/admin\/session$/, ['GET', 'POST', 'DELETE']],
  [/^\/proposals$/, ['GET', 'POST']],
  [new RegExp(`^/proposals/${uuid}$`), ['GET']],
  [new RegExp(`^/proposals/${uuid}/(?:approve|apply|verify|rollback)$`), ['POST']],
];
const json = (error, status) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

function origin(value, allowHttp = false) {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
function backendOrigin(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*\/?$/.test(url.pathname)) return null;
  const host = url.hostname.toLowerCase();
  // Deployment configuration is trusted, but reject accidental internal targets.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) return null;
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}
function adminCookie(value) {
  const cookie = value?.split(';').map(part => part.trim()).find(part => part.startsWith(`${ADMIN_COOKIE}=`));
  return cookie && new RegExp(`^${ADMIN_COOKIE}=${COOKIE_VALUE}$`).test(cookie) ? cookie : null;
}
function responseCookie(value) {
  if (!value) return null;
  const match = new RegExp(`^${ADMIN_COOKIE}=(${COOKIE_VALUE}|);`, 'i').exec(value);
  const age = /(?:^|;)\s*Max-Age=(\d+)(?:;|$)/i.exec(value);
  if (!match || !age || Number(age[1]) > 28800) return null;
  // Host-only cookie: the upstream Domain attribute must not follow the proxy.
  return `${ADMIN_COOKIE}=${match[1]}; HttpOnly; SameSite=Strict; Secure; Path=/quality/api/; Max-Age=${age[1]}`;
}
async function bytes(stream, maximum, signal) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(); const parts = []; let length = 0;
  const cancel = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw Error('GATEWAY_TIMEOUT');
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) throw Error('GATEWAY_BODY_LIMIT');
      parts.push(chunk.value);
    }
    if (signal?.aborted) throw Error('GATEWAY_TIMEOUT');
    const result = new Uint8Array(length); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result;
  } finally { signal?.removeEventListener('abort', cancel); await cancel(); }
}

export function normalizeQualityRequest(request) {
  const url = new URL(request.url);
  if (url.pathname.length > 4096 || (url.searchParams.get('path')?.length ?? 0) > 2048) return null;
  // Vercel can preserve the original public pathname after a rewrite. In that
  // case it is authoritative; replacing it with an absent query capture would
  // accidentally return dashboard HTML for a script or API request.
  if (url.pathname === '/api/quality' || url.pathname === '/api/quality/') {
    url.pathname = `/quality/${url.searchParams.get('path') ?? ''}`;
  } else if (url.pathname !== '/quality' && !url.pathname.startsWith('/quality/')) {
    return null;
  }
  url.searchParams.delete('path');
  return new Request(url, request);
}

export function createQualityCloudGateway({ backendUrl, gatewayToken, publicOrigins = [], fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  const target = backendOrigin(backendUrl);
  const origins = new Set(publicOrigins.map(value => origin(value)).filter(Boolean));
  const configured = Boolean(target && typeof gatewayToken === 'string' && gatewayToken.length >= 32 && origins.size);
  return async function gateway(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/quality/api/')) return null;
    if (!configured) return json('QUALITY_CLOUD_UNAVAILABLE', 503);
    const route = url.pathname.slice('/quality/api'.length);
    const supported = routes.find(([pattern]) => pattern.test(route));
    if (!supported) return json('QUALITY_ROUTE_NOT_FOUND', 404);
    if (!supported[1].includes(request.method)) return json('QUALITY_METHOD_NOT_ALLOWED', 405);
    if (!origins.has(url.origin)) return json('QUALITY_ORIGIN_DENIED', 403);
    const mutation = request.method !== 'GET';
    const suppliedOrigin = request.headers.get('origin');
    const crossSite = request.headers.get('sec-fetch-site') === 'cross-site';
    if (mutation && (suppliedOrigin !== url.origin || crossSite)) return json('QUALITY_ORIGIN_DENIED', 403);
    const cookie = !crossSite && (!suppliedOrigin || suppliedOrigin === url.origin) ? adminCookie(request.headers.get('cookie')) : null;
    const suppliedAuthorization = request.headers.get('authorization');
    const authorization = !crossSite && (!suppliedOrigin || suppliedOrigin === url.origin)
      && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(suppliedAuthorization ?? '') && /^\/(admin|investigations|proposals)(?:\/|$)/.test(route) ? suppliedAuthorization : null;
    if (mutation && route !== '/admin/session' && !cookie && !authorization) return json('WORKFLOW_AUTH_REQUIRED', 403);
    const allowedQuery = /^\/(overview|country|source)$/.test(route) ? new Set(['date', ...(route === '/country' ? ['country'] : route === '/source' ? ['source_id'] : [])]) : new Set();
    if ([...url.searchParams.keys()].some(key => !allowedQuery.has(key))) return json('QUALITY_INVALID_QUERY', 400);
    const upstream = new URL(`${target}${url.pathname}`); upstream.search = url.search;
    const headers = new Headers({ accept: 'application/json', 'x-wns-gateway-token': gatewayToken, 'x-wns-public-origin': url.origin });
    if (cookie) headers.set('cookie', cookie);
    if (authorization) headers.set('authorization', authorization);
    if (mutation) headers.set('origin', suppliedOrigin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let body;
      if (mutation && request.method !== 'DELETE') {
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json('JSON_CONTENT_TYPE_REQUIRED', 400);
        body = await bytes(request.body, MAX_BODY, controller.signal);
        headers.set('content-type', 'application/json');
      }
      const response = await fetchImpl(upstream, { method: request.method, headers, body, signal: controller.signal, redirect: 'error' });
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json('QUALITY_CLOUD_RESPONSE_INVALID', 502);
      const payload = await bytes(response.body, MAX_RESPONSE, controller.signal);
      try { JSON.parse(new TextDecoder().decode(payload)); } catch { return json('QUALITY_CLOUD_RESPONSE_INVALID', 502); }
      const responseHeaders = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const setCookie = route === '/admin/session' ? responseCookie(response.headers.get('set-cookie')) : null;
      if (setCookie) responseHeaders.set('set-cookie', setCookie);
      return new Response(payload, { status: response.status, headers: responseHeaders });
    } catch (error) {
      if (controller.signal.aborted) return json('QUALITY_CLOUD_TIMEOUT', 504);
      return json(error?.message === 'GATEWAY_BODY_LIMIT' ? 'REQUEST_TOO_LARGE' : 'QUALITY_CLOUD_UNAVAILABLE', error?.message === 'GATEWAY_BODY_LIMIT' ? 413 : 503);
    } finally { clearTimeout(timer); }
  };
}
