import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { RepairPrincipal } from './repair-workflow.js';
import type { InvestigationRun } from './investigation.js';

const COOKIE = 'wns_quality_admin';
const SESSION_SECONDS = 8 * 60 * 60;
const opaqueToken = /^[A-Za-z0-9_-]{32,256}$/;
function equal(a: string, b: string) {
  const left = createHash('sha256').update(a).digest(), right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
function secretFile(path: string | undefined, required: boolean) {
  if (!path) { if (required) throw Error('QUALITY_GATEWAY_CREDENTIAL_REQUIRED'); return null; }
  try {
    if (!isAbsolute(path)) throw Error();
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (info.mode & 0o077)) throw Error();
    const secret = readFileSync(path, 'utf8').trim();
    if (!opaqueToken.test(secret)) throw Error();
    return secret;
  } catch { throw Error('QUALITY_CLOUD_CREDENTIAL_UNAVAILABLE'); }
}
function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/** The public proxy can forward reads; it cannot authenticate an administrator. */
export class CloudQualityAccess {
  readonly origins: ReadonlySet<string>;
  private readonly gateway: string;
  private readonly admin: string | null;
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly now = () => Date.now()) {
    const values = env.WNS_QUALITY_PUBLIC_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
    if (!values.length) throw Error('QUALITY_PUBLIC_ORIGINS_REQUIRED');
    this.origins = new Set(values.map(value => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value)
          throw Error();
        return url.origin;
      } catch { throw Error('QUALITY_PUBLIC_ORIGIN_INVALID'); }
    }));
    this.gateway = secretFile(env.WNS_QUALITY_GATEWAY_TOKEN_FILE, true)!;
    this.admin = secretFile(env.WNS_QUALITY_ADMIN_TOKEN_FILE, false);
    if (this.admin && equal(this.admin, this.gateway)) throw Error('QUALITY_CLOUD_CREDENTIALS_MUST_DIFFER');
  }
  /** Headers are trusted only after authenticating the server-to-server gateway. */
  publicUrl(request: Request): URL {
    if (!equal(request.headers.get('x-wns-gateway-token') ?? '', this.gateway)) throw Error('QUALITY_GATEWAY_AUTH_REQUIRED');
    const origin = request.headers.get('x-wns-public-origin') ?? '';
    if (!this.origins.has(origin)) throw Error('QUALITY_PUBLIC_ORIGIN_INVALID');
    const internal = new URL(request.url);
    return new URL(`${internal.pathname}${internal.search}`, origin);
  }
  sameOrigin(request: Request, publicUrl: URL) {
    const origin = request.headers.get('origin');
    return (!origin || origin === publicUrl.origin) && request.headers.get('sec-fetch-site') !== 'cross-site';
  }
  adminAvailable() { return Boolean(this.admin); }
  private principal(reference: string): RepairPrincipal {
    return { actor_id: 'cloud_admin', session_id: createHash('sha256').update(`world-news-quality-cloud-session\0${reference}`).digest('base64url') };
  }
  authenticate(request: Request, publicUrl: URL): RepairPrincipal | null {
    if (!this.admin || !this.sameOrigin(request, publicUrl)) return null;
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('authorization') ?? '');
    if (bearer && equal(bearer[1], this.admin)) return this.principal(`bearer:${createHash('sha256').update(this.admin).digest('base64url')}`);
    const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
    if (!cookie) return null;
    const signed = cookie.slice(COOKIE.length + 1).split('.');
    if (signed.length !== 2 || signed.some(value => !/^[A-Za-z0-9_-]+$/.test(value)) || signed[0].length > 1024 || signed[1].length !== 43) return null;
    const signature = createHmac('sha256', this.admin).update(signed[0]).digest('base64url');
    if (!equal(signed[1], signature)) return null;
    try {
      const payload = JSON.parse(Buffer.from(signed[0], 'base64url').toString('utf8'));
      if (payload.origin !== publicUrl.origin || !opaqueToken.test(payload.id) || !Number.isSafeInteger(payload.expires)
        || payload.expires <= this.now() || payload.expires > this.now() + SESSION_SECONDS * 1000) return null;
      return this.principal(payload.id);
    } catch { return null; }
  }
  async sessionResponse(request: Request, publicUrl: URL): Promise<Response> {
    if (!this.sameOrigin(request, publicUrl)) return response({ error: 'QUALITY_ADMIN_AUTH_REQUIRED' }, 403);
    if (request.method === 'GET') return response({ authenticated: Boolean(this.authenticate(request, publicUrl)),
      available: Boolean(this.admin), actor: this.authenticate(request, publicUrl) ? 'cloud_admin' : null, scope: 'cloud_registry' });
    if (request.method === 'DELETE') {
      const result = response({ authenticated: false });
      result.headers.set('set-cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/quality/api/; Max-Age=0`);
      return result;
    }
    if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
    // Only a private administrator credential can mint a browser cookie. A proxy token never can.
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('authorization') ?? '');
    let password = bearer?.[1] ?? '';
    if (!bearer && request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      const reader = request.body?.getReader();
      if (reader) {
        const pieces: Uint8Array[] = []; let total = 0;
        try {
          while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength;
            if (total > 2048) throw Error(); pieces.push(part.value); }
          const value = JSON.parse(Buffer.concat(pieces).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'password' || typeof value.password !== 'string') throw Error();
          password = value.password;
        } catch { password = ''; } finally { await reader.cancel().catch(() => {}); }
      }
    }
    if (!this.admin || !opaqueToken.test(password) || !equal(password, this.admin)) return response({ error: 'QUALITY_ADMIN_AUTH_REQUIRED' }, 403);
    const payload = Buffer.from(JSON.stringify({ origin: publicUrl.origin, id: randomBytes(32).toString('base64url'),
      expires: this.now() + SESSION_SECONDS * 1000 })).toString('base64url');
    const signature = createHmac('sha256', this.admin).update(payload).digest('base64url');
    const result = response({ authenticated: true, actor: 'cloud_admin', scope: 'cloud_registry' });
    result.headers.set('set-cookie', `${COOKIE}=${payload}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/quality/api/; Max-Age=${SESSION_SECONDS}`);
    return result;
  }
}

/** Only stored, terminal evidence is public. Credentials, internal paths and request IDs are omitted. */
export function publicInvestigation(run: InvestigationRun): Record<string, unknown> {
  function safe(value: unknown, depth = 0): unknown {
    if (depth > 12) return '[truncated]';
    if (typeof value === 'string') return value.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/(?:\/Users\/|\/home\/|\/var\/lib\/|\/etc\/)[^\s"<>]*/g, '[internal path]').slice(0, 8000);
    if (Array.isArray(value)) return value.slice(0, 1000).map(item => safe(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 300)
      .filter(([key]) => !/(?:authorization|cookie|api.?key|credential|secret|key.?file|state.?dir|stack|request_id|session_id|actor_id)/i.test(key))
      .map(([key, item]) => [key, safe(item, depth + 1)]));
    return value;
  }
  return safe(run) as Record<string, unknown>;
}
