import { z } from 'zod';

export const statusTransition = z.object({
  old_enabled: z.boolean(), new_enabled: z.boolean(),
  changed_at: z.string().datetime(), reason: z.string().trim().min(1).max(512),
}).strict().refine(t => t.old_enabled !== t.new_enabled, 'A transition must change enabled state');
export const statusFields = {
  enabled_changed_at: z.string().datetime().nullable().optional(),
  status_reason: z.string().trim().min(1).max(512).nullable().optional(),
  status_history: z.array(statusTransition).max(20).optional(),
  status_transition_count: z.number().int().min(0).optional(),
};
export type StatusMetadata = {
  enabled_changed_at: string | null; status_reason: string | null;
  status_history: z.infer<typeof statusTransition>[]; status_transition_count: number | null;
  status_history_consistent: boolean;
};
export function statusMetadata(feed: { enabled?: boolean } & Partial<Omit<StatusMetadata,'status_history_consistent'>>): StatusMetadata {
  const history = feed.status_history ?? [];
  for (let i=1;i<history.length;i++) {
    if (Date.parse(history[i].changed_at) <= Date.parse(history[i-1].changed_at)
      || history[i].old_enabled !== history[i-1].new_enabled) throw new Error('Invalid source status transition sequence');
  }
  const last = history.at(-1);
  if (last && (last.new_enabled !== (feed.enabled !== false)
    || last.changed_at !== feed.enabled_changed_at || last.reason !== feed.status_reason)) throw new Error('Source status metadata must match its last transition');
  const count = feed.status_transition_count ?? (history.length ? history.length : null);
  if (count !== null && count < history.length) throw new Error('Status transition count cannot be smaller than retained history');
  return { enabled_changed_at: feed.enabled_changed_at ?? null, status_reason: feed.status_reason ?? null,
    status_history: history, status_transition_count: count, status_history_consistent: true };
}
export function unknownStatus(): StatusMetadata {
  return { enabled_changed_at:null,status_reason:null,status_history:[],status_transition_count:null,status_history_consistent:false };
}
