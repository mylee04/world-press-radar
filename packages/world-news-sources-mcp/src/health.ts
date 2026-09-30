import { z } from 'zod';
import { canonicalUrl, stableId, type Endpoint, type Source } from './catalog.js';

export const observationSchema = z.object({
  endpointId: z.string().regex(/^ep_[a-f0-9]{24}$/), type: z.enum(['rss', 'sitemap']), url: z.string().max(2048),
  checkedAt: z.string().datetime({ offset: true }), outcome: z.enum(['healthy', 'unhealthy']),
  httpStatus: z.number().int().min(100).max(599).nullable(), reason: z.string().max(256).nullable(),
  format: z.enum(['rss', 'atom', 'rdf', 'urlset', 'sitemapindex']).nullable(),
  auditStatus: z.enum(['working_nonempty', 'valid_empty', 'blocked', 'timeout', 'malformed', 'http_error', 'network_error', 'incomplete']).optional(),
  entryCount: z.number().int().nonnegative().optional(), entriesWithUrl: z.number().int().nonnegative().optional(),
  sampleUrls: z.array(z.string().max(2048)).max(3).optional(),
  newestContentAt: z.string().datetime({ offset: true }).nullable().optional(),
  contentFreshness: z.enum(['recent', 'stale', 'missing', 'unreliable']).optional(),
  dateKind: z.enum(['feed_item_date', 'sitemap_lastmod']).optional(),
  finalUrl: z.string().max(2048).optional(), attempts: z.number().int().min(1).max(2).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  validatorVersion: z.string().max(32).optional(),
}).strict();
export type Observation = z.infer<typeof observationSchema>;
export const auditMetaSchema = z.object({
  runId: z.string().max(64), startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  total: z.number().int().nonnegative(), checked: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  lastCompletedFullAuditAt: z.string().datetime().nullable(),
  statuses: z.record(z.string(), z.number().int().nonnegative()),
}).strict();
export const snapshotSchema = z.object({ version: z.literal(1), observations: z.array(observationSchema).max(10000), audit: auditMetaSchema.optional() }).strict();
type Legacy = { checkedAt: string; valid: boolean; httpStatus: number | null };
const legacySchema = z.object({
  results: z.array(z.object({ countryCode: z.string(), outlet: z.string(), url: z.string(),
    checkedAt: z.string(), valid: z.boolean(), httpCode: z.number().nullable(),
  })).optional(),
});
const legacyKey = (country: string, name: string, url: string) => JSON.stringify([country, name, url]);

export class HealthStore {
  private observations = new Map<string, Observation>();
  private legacy = new Map<string, Legacy>();
  private audit: z.infer<typeof auditMetaSchema> | undefined;
  constructor(snapshot?: unknown, legacy?: unknown, readonly staleAfterMs = 7 * 24 * 60 * 60 * 1000) {
    if (snapshot !== undefined) this.audit = snapshotSchema.parse(snapshot).audit;
    if (snapshot !== undefined) for (const observation of snapshotSchema.parse(snapshot).observations) {
      const url = canonicalUrl(observation.url);
      if (stableId('ep', [observation.type, url]) !== observation.endpointId) throw new Error('Health endpoint identity mismatch');
      const old = this.observations.get(observation.endpointId);
      if (!old || Date.parse(old.checkedAt) < Date.parse(observation.checkedAt)) this.observations.set(observation.endpointId, observation);
    }
    if (legacy !== undefined) for (const result of legacySchema.parse(legacy).results ?? []) {
      try {
        const key = legacyKey(result.countryCode, result.outlet, canonicalUrl(result.url));
        const old = this.legacy.get(key);
        if (!old || Date.parse(old.checkedAt) < Date.parse(result.checkedAt)) {
          this.legacy.set(key, { checkedAt: result.checkedAt, valid: result.valid, httpStatus: result.httpCode });
        }
      } catch { /* Ignore malformed old audit URLs; do not infer a check. */ }
    }
  }
  summary() {
    const byType: Record<string, { checked: number; statuses: Record<string, number>; content_freshness: Record<string, number> }> = {};
    for (const observation of this.observations.values()) {
      const bucket = byType[observation.type] ??= { checked: 0, statuses: {}, content_freshness: {} };
      bucket.checked++;
      const status = observation.auditStatus ?? observation.outcome; bucket.statuses[status] = (bucket.statuses[status] ?? 0) + 1;
      if (observation.contentFreshness) bucket.content_freshness[observation.contentFreshness] = (bucket.content_freshness[observation.contentFreshness] ?? 0) + 1;
    }
    return { last_completed_full_audit_at: this.audit?.lastCompletedFullAuditAt ?? null,
      current_audit_finished_at: this.audit?.finishedAt ?? null, endpoints_total: this.audit?.total ?? null,
      endpoints_checked: this.audit?.checked ?? this.observations.size, endpoints_skipped: this.audit?.skipped ?? 0,
      statuses: this.audit?.statuses ?? {}, by_endpoint_type: byType, live_feed_checks: this.observations.size > 0 };
  }
  get(endpoint: Endpoint, sources: Source[], now = Date.now()) {
    const observation = this.observations.get(endpoint.id);
    const legacy = endpoint.type === 'rss' ? sources.map(s =>
      this.legacy.get(legacyKey(s.countryCode, s.name, endpoint.url))).find(Boolean) : undefined;
    const record = observation ?? legacy;
    const timestamp = record ? Date.parse(record.checkedAt) : NaN;
    const knownTime = Number.isFinite(timestamp) && timestamp <= now;
    const stale = knownTime && now - timestamp > this.staleAfterMs;
    const status = !knownTime ? 'unknown' : stale ? 'stale' : observation?.outcome ?? 'unknown';
    return {
      endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url, status,
      checked_at: knownTime ? record!.checkedAt : null,
      stale_after_seconds: this.staleAfterMs / 1000,
      last_outcome: observation?.outcome ?? (legacy ? legacy.valid ? 'reported_valid' : 'reported_invalid' : null),
      validation: observation ? 'xml_structure' : legacy ? 'legacy_xml_markers' : null,
      http_status: observation?.httpStatus ?? legacy?.httpStatus ?? null,
      reason: observation?.reason ?? (legacy ? 'Historical marker check; full XML/feed validity was not established' : null),
      format: observation?.format ?? null,
      audit_status: observation?.auditStatus ?? null,
      entry_count: observation?.entryCount ?? null, entries_with_url: observation?.entriesWithUrl ?? null,
      sample_urls: observation?.sampleUrls ?? [],
      newest_content_at: observation?.newestContentAt ?? null,
      content_freshness: observation?.contentFreshness ?? 'missing', date_kind: observation?.dateKind ?? null,
    };
  }
}
