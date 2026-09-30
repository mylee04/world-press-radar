import { z } from 'zod';
import { canonicalUrl, stableId, type Endpoint, type Source } from './catalog.js';

export const observationSchema = z.object({
  endpointId: z.string().regex(/^ep_[a-f0-9]{24}$/), type: z.enum(['rss', 'sitemap']), url: z.string().max(2048),
  checkedAt: z.string().datetime({ offset: true }), outcome: z.enum(['healthy', 'unhealthy']),
  httpStatus: z.number().int().min(100).max(599).nullable(), reason: z.string().max(256).nullable(),
  format: z.enum(['rss', 'atom', 'rdf', 'urlset', 'sitemapindex']).nullable(),
}).strict();
export type Observation = z.infer<typeof observationSchema>;
export const snapshotSchema = z.object({ version: z.literal(1), observations: z.array(observationSchema).max(10000) }).strict();
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
  constructor(snapshot?: unknown, legacy?: unknown, readonly staleAfterMs = 7 * 24 * 60 * 60 * 1000) {
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
    };
  }
}
