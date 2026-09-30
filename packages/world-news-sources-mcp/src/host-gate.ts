import type { RequestGate } from './validate.js';
// Shared by all audit workers and invoked at every redirect destination too.
export function createHostGate(gapMs = 2000): RequestGate {
  const active = new Set<string>(); const nextAt = new Map<string, number>();
  return async (hostname, deadline) => {
    while (active.has(hostname) || (nextAt.get(hostname) ?? 0) > Date.now()) {
      if (Date.now() >= deadline) throw new Error('POLITENESS_WAIT_LIMIT');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    if (Date.now() >= deadline) throw new Error('POLITENESS_WAIT_LIMIT');
    active.add(hostname);
    return () => { active.delete(hostname); nextAt.set(hostname, Date.now() + gapMs); };
  };
}
