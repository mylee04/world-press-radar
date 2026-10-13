import type { RequestGate } from './validate.js';
export type HostGate = RequestGate & { defer: (hostname: string, until: string, httpStatus: number | null) => void; deferred: (hostname: string) => { until: string; httpStatus: number | null } | null };
// Shared by all audit workers and invoked at every redirect destination too.
export function createHostGate(gapMs = 2000): HostGate {
  if (!Number.isInteger(gapMs) || gapMs < 0 || gapMs > 60000) throw Error('INVALID_HOST_GAP');
  const active = new Set<string>(); const nextAt = new Map<string, number>();
  const deferred = new Map<string, { until: string; httpStatus: number | null }>();
  const current = (hostname: string) => { const row = deferred.get(hostname); if (row && Date.parse(row.until) > Date.now()) return row; deferred.delete(hostname); return null; };
  const check = (hostname: string) => { const row = current(hostname); if (row) throw Object.assign(new Error('SERVER_RETRY_AFTER_WAIT'), { retryAfterAt: row.until, httpStatus: row.httpStatus, hostname }); };
  const gate: RequestGate = async (hostname, deadline) => {
    check(hostname);
    while (active.has(hostname) || (nextAt.get(hostname) ?? 0) > Date.now()) {
      check(hostname);
      if (Date.now() >= deadline) throw new Error('POLITENESS_WAIT_LIMIT');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    check(hostname);
    if (Date.now() >= deadline) throw new Error('POLITENESS_WAIT_LIMIT');
    active.add(hostname);
    let released = false;
    return () => { if (!released) { released = true; active.delete(hostname); nextAt.set(hostname, Date.now() + gapMs); } };
  };
  return Object.assign(gate, { deferred: current, defer: (hostname: string, until: string, httpStatus: number | null) => {
    if (!Number.isFinite(Date.parse(until))) throw Error('INVALID_RETRY_AFTER_DEADLINE');
    const old = current(hostname); if (Date.parse(until) > Date.now() && (!old || Date.parse(until) > Date.parse(old.until))) deferred.set(hostname, { until, httpStatus });
  } });
}
