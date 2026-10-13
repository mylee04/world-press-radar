/** Daily collection policy. Server cooldowns are exceptions, never synthetic checks. */
const DAY = 86400000;
export type RetryAfterSource = 'delta_seconds' | 'http_date';
export type DeferredEndpoint = { endpoint_id: string; next_due: string; reason: 'rate_limited' | 'server_retry_after'; http_status: number | null };
export type CollectionScheduling = {
  policy: 'daily_all_active'; as_of: string; active_endpoint_ids: string[];
  already_checked_today_endpoint_ids: string[]; deferred_endpoints: DeferredEndpoint[];
  country_active_endpoints: Record<string, string[]>;
  force_recheck?: boolean;
};
export type SchedulingState = { endpoint_id: string; last_attempt_at?: string | null; next_due?: string | null;
  http_status?: number | null; reason?: string | null; retry_after_at?: string | null; defer_reason?: DeferredEndpoint['reason'] | null };

export function parseRetryAfter(raw: string | undefined, now = Date.now()): { at: string; source: RetryAfterSource } | null {
  if (!raw || !Number.isFinite(now)) return null;
  const value = raw.trim(); let deadline: number; let source: RetryAfterSource;
  if (/^\d{1,12}$/.test(value)) { deadline = now + Number(value) * 1000; source = 'delta_seconds'; }
  else {
    const imf = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(value);
    const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(value);
    const asctime = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(value);
    if (!imf && !rfc850 && !asctime) return null;
    const parts = imf ?? rfc850;
    const year = rfc850 ? (() => { const currentYear = new Date(now).getUTCFullYear(); let result = Math.floor(currentYear / 100) * 100 + Number(rfc850[4]); if (result > currentYear + 50) result -= 100; return String(result); })() : imf?.[4] ?? asctime![5];
    const canonical = parts ? `${parts[1].slice(0, 3)}, ${parts[2]} ${parts[3]} ${year} ${parts[5]} GMT` : `${asctime![1]}, ${asctime![3].padStart(2, '0')} ${asctime![2]} ${year} ${asctime![4]} GMT`;
    deadline = Date.parse(canonical); source = 'http_date';
    if (Number.isFinite(deadline) && new Date(deadline).toUTCString() !== canonical) return null;
  }
  if (!Number.isFinite(deadline) || deadline < now || deadline >= Date.UTC(10000, 0, 1)) return null;
  return { at: new Date(deadline).toISOString(), source };
}
export function nextDailyCheck(at: string): string {
  const time = Date.parse(at); if (!Number.isFinite(time)) throw Error('INVALID_CHECK_TIME');
  return new Date(Math.floor(time / DAY) * DAY + DAY).toISOString();
}
export function collectionNextDue(at: string, httpStatus: number | null, retryAfterAt?: string | null): string {
  const daily = nextDailyCheck(at), deadline = retryAfterAt ? Date.parse(retryAfterAt) : NaN;
  return Number.isFinite(deadline) && httpStatus !== null && httpStatus >= 400 && deadline > Date.parse(daily) ? new Date(deadline).toISOString() : daily;
}
export function endpointDue(state: SchedulingState | undefined, now: string, force = false): { eligible: boolean; checked_today: boolean; deferred: DeferredEndpoint | null } {
  const time = Date.parse(now); if (!Number.isFinite(time)) throw Error('INVALID_SCHEDULE_TIME');
  const checkedToday = !!state?.last_attempt_at && Date.parse(state.last_attempt_at) <= time && state.last_attempt_at.slice(0, 10) === now.slice(0, 10);
  const status = state?.http_status ?? (state?.reason === 'HTTP_429' ? 429 : null);
  // Old generic week-long next_due values are ignored, except a recorded 429 proves a server limitation.
  const serverDeadline = state?.retry_after_at ?? (status === 429 ? state?.next_due : null);
  const deadline = serverDeadline ? Date.parse(serverDeadline) : NaN;
  if (Number.isFinite(deadline) && deadline > time && (status === 429 || state?.defer_reason === 'server_retry_after' || state?.retry_after_at)) {
    return { eligible: false, checked_today: checkedToday, deferred: { endpoint_id: state!.endpoint_id, next_due: new Date(deadline).toISOString(), reason: status === 429 ? 'rate_limited' : 'server_retry_after', http_status: status } };
  }
  return { eligible: force || !checkedToday, checked_today: checkedToday, deferred: null };
}
export function collectionConcurrency(value: unknown = 6): number {
  const count = Number(value); if (!Number.isInteger(count) || count < 1 || count > 16) throw Error('Invalid --concurrency'); return count;
}
