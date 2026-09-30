import { normalizeRegistry } from './catalog.js';

// Operator-only utility; never registered as an MCP tool or invoked by health audits.
export function updateRegistryStatus(input: unknown, sourceId: string, enabled: boolean, reason: string, now = new Date()): unknown {
  if (typeof enabled !== 'boolean' || !reason.trim() || reason.trim().length > 512 || !Number.isFinite(now.getTime())) throw new Error('Valid enabled state, reason and current time required');
  const catalog = normalizeRegistry(input);
  const source = catalog.sources.find(s => s.id === sourceId);
  if (!source) throw new Error('Unknown source_id');
  if (!source.status_history_consistent) throw new Error('Duplicate status metadata conflicts; reconcile registrations before recording a transition');
  if (source.enabled === enabled) throw new Error('Enabled state unchanged; no transition recorded');
  const changed_at = now.toISOString();
  if (source.enabled_changed_at && Date.parse(changed_at) <= Date.parse(source.enabled_changed_at)) throw new Error('Transition time must follow previous recorded change');
  const transition = {old_enabled:source.enabled,new_enabled:enabled,changed_at,reason:reason.trim()};
  const output = structuredClone(input) as {countries:{code:string;name:string;feeds:Record<string,unknown>[]}[]};
  for (const country of output.countries) for (const feed of country.feeds) {
    const single = normalizeRegistry({countries:[{...country,feeds:[feed]}]}).sources[0];
    if (single.id !== sourceId) continue;
    Object.assign(feed, {enabled,enabled_changed_at:changed_at,status_reason:transition.reason,
      status_history:[...source.status_history,transition].slice(-20),status_transition_count:(source.status_transition_count ?? 0)+1});
  }
  normalizeRegistry(output);
  return output;
}
