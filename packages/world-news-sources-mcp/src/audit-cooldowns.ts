import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import type { AuditObservation } from './audit-check.js';
import { collectionNextDue } from './collection-schedule.js';
import { createHostGate, type HostGate } from './host-gate.js';

export type AuditHostCooldown = { host: string; until: string; httpStatus: 429 | null };

const hostname = (url: string) => new URL(url).hostname.replace(/^\[|\]$/g, '');
const rateLimitDeadline = () => collectionNextDue(new Date(Date.now()).toISOString(), 429);

// A 429 stops this audit's remaining requests to both hosts, including redirected hops.
// The set outlives UTC-day boundaries; its default deadline is local policy, not a server header.
export function createAuditHostGate(limitedHosts: ReadonlySet<string>, gapMs = 2000): HostGate {
  const underlying = createHostGate(gapMs);
  const check = (host: string) => {
    if (limitedHosts.has(host)) throw Object.assign(Error('SERVER_RETRY_AFTER_WAIT'), { retryAfterAt: rateLimitDeadline(), httpStatus: 429, hostname: host });
  };
  const gate: HostGate = Object.assign(async (host: string, deadline: number) => {
    check(host);
    const release = await underlying(host, deadline);
    try { check(host); return release; } catch (error) { release(); throw error; }
  }, {
    defer: underlying.defer,
    deferred: (host: string) => limitedHosts.has(host) ? { until: rateLimitDeadline(), httpStatus: 429 } : underlying.deferred(host),
  });
  return gate;
}

export function observeAuditHostCooldowns(result: AuditObservation, gate: HostGate, limitedHosts: Set<string>): void {
  const hosts = new Set([hostname(result.url), ...(result.finalUrl ? [hostname(result.finalUrl)] : [])]);
  if (result.serverDeferral && limitedHosts.has(result.serverDeferral.hostname?.replace(/^\[|\]$/g, '') ?? hostname(result.url))) {
    result.reason = 'REDIRECT_HOST_RATE_LIMITED';
    delete result.serverDeferral;
  } else if (result.serverDeferral) gate.defer(result.serverDeferral.hostname ?? hostname(result.url), result.serverDeferral.until, result.serverDeferral.httpStatus);
  if (result.retryAfterAt) for (const host of hosts) gate.defer(host, result.retryAfterAt, result.httpStatus);
  if (result.httpStatus === 429) for (const host of hosts) limitedHosts.add(host);
}

// Read the collector's durable server instructions without creating or changing its database.
export function loadAuditHostCooldowns(path: string | undefined, now = Date.now()): AuditHostCooldown[] {
  if (path === undefined) return [];
  if (!path.trim() || !isAbsolute(path) || !Number.isFinite(now)) throw Error('AUDIT_COOLDOWN_DB_INVALID');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=100; PRAGMA query_only=ON');
    if (db.prepare("SELECT value FROM metadata WHERE key='lane'").get()?.value !== 'production') throw Error('AUDIT_COOLDOWN_DB_UNTRUSTED');
    const rows = db.prepare('SELECT host,until_at,category FROM host_cooldowns LIMIT 10001').all();
    if (rows.length > 10000) throw Error('AUDIT_COOLDOWN_ROWS_EXCEEDED');
    const holds: AuditHostCooldown[] = [];
    for (const row of rows) {
      if (!['rate_limited', 'server_retry_after'].includes(String(row.category))) continue;
      if (typeof row.host !== 'string' || typeof row.until_at !== 'string') throw Error('AUDIT_COOLDOWN_ROW_INVALID');
      const rawHost = isIP(row.host) === 6 ? `[${row.host}]` : row.host;
      const target = new URL(`https://${rawHost}/`), timestamp = Date.parse(row.until_at);
      if (target.hostname !== rawHost || target.username || target.password || target.port || target.pathname !== '/' || target.search || target.hash ||
          !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== row.until_at) throw Error('AUDIT_COOLDOWN_ROW_INVALID');
      if (timestamp > now) holds.push({ host: target.hostname.replace(/^\[|\]$/g, ''), until: row.until_at, httpStatus: row.category === 'rate_limited' ? 429 : null });
    }
    return holds;
  } catch (cause) {
    throw new Error('AUDIT_COOLDOWN_DB_UNAVAILABLE', { cause });
  } finally { db?.close(); }
}
