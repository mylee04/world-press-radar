import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActivityStore } from './activity.js';
import { readHistory, type HistoryShard } from './activity-history.js';
import type { Endpoint, Source } from './catalog.js';
import type { HealthStore } from './health.js';

type Row = Record<string, any>;
type Status = 'usable' | 'valid_empty' | 'index_only' | 'failed' | 'stale' | 'unknown' | 'evidence_unavailable';
type Format = 'rss' | 'atom' | 'rdf' | 'urlset' | 'sitemapindex';
type DateKind = 'feed_item_date' | 'sitemap_lastmod';
type Index = { rows: Map<string, Row[]>; invalid: Map<string, number>; records: number };
type ArchiveIndex = { latest: Map<string, Row>; invalid: Map<string, number>; future: Map<string, number>; from: number; to: number; retained: number };
const formats = new Set<Format>(['rss', 'atom', 'rdf', 'urlset', 'sitemapindex']);
const failures = new Set(['blocked', 'timeout', 'malformed', 'http_error', 'network_error', 'incomplete']);

// Date.parse alone normalizes invalid days (for example February 30). Retained
// observations must have a real, explicit timestamp before they can win ordering.
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return null;
  const at = Date.parse(value); return Number.isFinite(at) ? at : null;
}
function indexRows(rows: ReadonlyArray<Row>): Index {
  const index: Index = { rows: new Map(), invalid: new Map(), records: rows.length };
  for (const row of rows) {
    if (typeof row?.endpoint_id !== 'string') continue;
    if (timestamp(row.checked_at) === null) { index.invalid.set(row.endpoint_id, (index.invalid.get(row.endpoint_id) ?? 0) + 1); continue; }
    const values = index.rows.get(row.endpoint_id) ?? [];
    values.push(row); index.rows.set(row.endpoint_id, values);
  }
  for (const values of index.rows.values()) values.sort((a, b) => timestamp(b.checked_at)! - timestamp(a.checked_at)!);
  return index;
}
// Snapshots are immutable for a loaded ActivityStore. Cache only derived indexes;
// no article URLs, registry writes, or network requests are performed here.
const inlineCache = new WeakMap<ActivityStore, { rows: Row[]; length: number; first?: Row; last?: Row; index: Index }>();
const archiveCache = new Map<string, { signature: string; index: ArchiveIndex }>();
const MAX_CACHED_RECORDS = 200000, MAX_CACHED_SHARDS = 4, MAX_CACHED_ENDPOINTS = 20000;
let cachedRecords = 0;
function removeArchive(key: string) { const old = archiveCache.get(key); if (old) { cachedRecords -= old.index.retained; archiveCache.delete(key); } }
function summarizeArchive(rows: ReadonlyArray<Row>, now: number): ArchiveIndex {
  const index: ArchiveIndex = { latest: new Map(), invalid: new Map(), future: new Map(), from: -Infinity, to: Infinity, retained: 0 };
  for (const row of rows) {
    if (typeof row?.endpoint_id !== 'string') continue;
    const at = timestamp(row.checked_at);
    if (at === null) { index.invalid.set(row.endpoint_id, (index.invalid.get(row.endpoint_id) ?? 0) + 1); continue; }
    if (at > now) {
      index.future.set(row.endpoint_id, (index.future.get(row.endpoint_id) ?? 0) + 1); index.to = Math.min(index.to, at); continue;
    }
    const previous = index.latest.get(row.endpoint_id);
    if (!previous || timestamp(previous.checked_at)! <= at) index.latest.set(row.endpoint_id, row);
    index.from = Math.max(index.from, at);
  }
  index.retained = index.latest.size + index.invalid.size + index.future.size;
  return index;
}
function archiveIndex(directory: string, shard: HistoryShard, now: number): ArchiveIndex {
  const path = resolve(directory, shard.file);
  const key = JSON.stringify([path, shard.sha256, shard.bytes, shard.records]);
  let signature: string;
  try {
    const info = statSync(path, { bigint: true });
    if (!info.isFile() || info.size !== BigInt(shard.bytes)) throw Error();
    signature = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch { removeArchive(key); throw Error('ACTIVITY_HISTORY_READ_FAILURE'); }
  const cached = archiveCache.get(key);
  // Winners and ignored-future counters are unchanged only inside this interval.
  // This permits ordinary request batches to share a compact index, while a
  // historical as_of or an observation becoming eligible forces a fresh scan.
  if (cached?.signature === signature && now >= cached.index.from && now < cached.index.to) { archiveCache.delete(key); archiveCache.set(key, cached); return cached.index; }
  removeArchive(key);
  // readHistory enforces compressed/expanded/record budgets and checks SHA-256.
  // Retain one eligible row per endpoint, not the entire monthly observation
  // history. Even a 500,000-row valid shard can therefore share this cache.
  const index = summarizeArchive(readHistory(directory, shard), now);
  if (index.retained <= MAX_CACHED_RECORDS && new Set([...index.latest.keys(), ...index.invalid.keys(), ...index.future.keys()]).size <= MAX_CACHED_ENDPOINTS) {
    while (archiveCache.size && (archiveCache.size >= MAX_CACHED_SHARDS || cachedRecords + index.retained > MAX_CACHED_RECORDS)) removeArchive(archiveCache.keys().next().value!);
    archiveCache.set(key, { signature, index }); cachedRecords += index.retained;
  }
  return index;
}
function inlineIndex(activity: ActivityStore): Index {
  const rows = activity.snapshot?.collections ?? [];
  const cached = inlineCache.get(activity);
  if (cached?.rows === rows && cached.length === rows.length && cached.first === rows[0] && cached.last === rows.at(-1)) return cached.index;
  const index = indexRows(rows);
  inlineCache.set(activity, { rows, length: rows.length, first: rows[0], last: rows.at(-1), index });
  return index;
}
function newest(index: Index, endpoint: string, now: number) {
  const rows = index.rows.get(endpoint) ?? [];
  let future = 0;
  const row = rows.find(value => { if (timestamp(value.checked_at)! > now) { future++; return false; } return true; }) ?? null;
  return { row, future, invalid: index.invalid.get(endpoint) ?? 0 };
}
function latestCollection(endpoint: Endpoint, activity: ActivityStore, now: number) {
  const inline = newest(inlineIndex(activity), endpoint.id, now);
  let row = inline.row, provenance: 'retained_production_collection_inline' | 'retained_production_collection_archive' = 'retained_production_collection_inline';
  let future = inline.future, invalid = inline.invalid;
  const history = activity.snapshot?.history;
  if (history) {
    if (!activity.historyDirectory) return { row: null, provenance, future, invalid, error: 'ACTIVITY_HISTORY_NOT_CONFIGURED' };
    const month = new Date(now).toISOString().slice(0, 7);
    for (const shard of [...history.shards].reverse()) {
      // A future month cannot contain an eligible observation. An older month
      // cannot supersede a known later collection, so avoid decoding it at all.
      if (shard.month > month || row && shard.month < new Date(timestamp(row.checked_at)!).toISOString().slice(0, 7)) continue;
      try {
        const index = archiveIndex(activity.historyDirectory, shard, now);
        const found = { row: index.latest.get(endpoint.id) ?? null, future: index.future.get(endpoint.id) ?? 0, invalid: index.invalid.get(endpoint.id) ?? 0 };
        future += found.future; invalid += found.invalid;
        if (found.row && (!row || timestamp(found.row.checked_at)! >= timestamp(row.checked_at)!)) { row = found.row; provenance = 'retained_production_collection_archive'; }
      } catch (error) {
        const code = error instanceof Error && /^ACTIVITY_HISTORY_[A-Z_]+$/.test(error.message) ? error.message : 'ACTIVITY_HISTORY_INVALID_RECORDS';
        return { row: null, provenance, future, invalid, error: code };
      }
    }
  }
  return { row, provenance, future, invalid, error: null };
}
function validFormat(value: unknown, endpoint: Endpoint): Format | null {
  return formats.has(value as Format) && (endpoint.type === 'rss' ? ['rss', 'atom', 'rdf'].includes(String(value)) : ['urlset', 'sitemapindex'].includes(String(value))) ? value as Format : null;
}
function classify(status: unknown, format: Format | null, success: boolean, nonempty: boolean, empty: boolean): Exclude<Status, 'stale' | 'evidence_unavailable'> {
  if (failures.has(String(status)) || status === 'unhealthy') return 'failed';
  if (!success || !format) return 'unknown';
  if (format === 'sitemapindex') return 'index_only';
  if (empty) return 'valid_empty';
  return nonempty ? 'usable' : 'unknown';
}
function content(value: unknown, kind: unknown, now: number, freshness?: unknown) {
  const at = timestamp(value), dateKind: DateKind | null = ['feed_item_date', 'sitemap_lastmod'].includes(String(kind)) ? kind as DateKind : null;
  const invalid = value != null && (at === null || at > now);
  const recordedFreshness = ['recent', 'stale', 'missing', 'unreliable'].includes(String(freshness)) ? freshness as 'recent' | 'stale' | 'missing' | 'unreliable' : null;
  const age = !invalid && at !== null ? (now - at) / 1000 : null, threshold = 30 * 24 * 60 * 60;
  return { newest_content_at: !invalid && at !== null ? String(value) : null, date_kind: dateKind,
    freshness: invalid || recordedFreshness === 'unreliable' ? 'unreliable' as const : age === null ? 'missing' as const : age > threshold ? 'stale' as const : 'recent' as const,
    freshness_basis: invalid ? 'invalid_or_future_date' as const : recordedFreshness === 'unreliable' ? 'recorded_unreliable_date' as const : age === null ? 'missing_date' as const : 'retained_content_date_age' as const,
    age_seconds: age, stale_after_seconds: threshold, recorded_audit_freshness: recordedFreshness,
    meaning: dateKind === 'feed_item_date' ? 'Newest retained feed-item date. The 30-day age label is measured as of this response; it does not estimate publisher update cadence, guarantee publication time or establish complete coverage.' : dateKind === 'sitemap_lastmod' ? 'Newest retained sitemap lastmod value: a modification hint. The 30-day age label does not estimate publisher update cadence or guarantee publication time.' : null };
}
const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const describe: Record<Exclude<Status, 'evidence_unavailable'>, string> = {
  usable: 'A valid nonempty article-list document was observed. Reachability and URL availability do not establish publication completeness or content freshness.',
  valid_empty: 'A valid empty article-list document was observed. Empty results and zero new discoveries alone are not a failure.',
  index_only: 'A valid sitemap index was observed. Its child sitemap entries do not prove that article URLs were collected.',
  failed: 'The latest selected retained observation failed. This is a dated observation, not a live check.',
  stale: 'The latest retained observation exceeds the stated evidence-age limit. Its old result does not establish current success or current failure.',
  unknown: 'Retained evidence is absent or insufficient to establish article-list usability.'
};

/** Combine independently retained audit and production evidence without changing
 * either store. This does not fetch publisher URLs or manufacture diagnostics
 * omitted by the compressed aggregate history format. */
export function describeEndpointStatus(endpoint: Endpoint, relevantSources: Source[], healthStore: HealthStore, activityStore: ActivityStore, now = Date.now()) {
  if (!Number.isFinite(now)) throw Error('INVALID_ENDPOINT_STATUS_TIME');
  const sources = relevantSources.filter(source => source.endpoints.some(value => value.id === endpoint.id));
  const audit = healthStore.get(endpoint, sources, now);
  const auditAt = timestamp(audit.checked_at);
  const structuralAudit = auditAt !== null && auditAt <= now ? audit : null;
  const auditFormat = validFormat(structuralAudit?.format, endpoint);
  const auditState = structuralAudit?.validation === 'xml_structure' ? classify(structuralAudit.audit_status ?? structuralAudit.last_outcome, auditFormat,
    structuralAudit.last_outcome === 'healthy', structuralAudit.entries_with_url !== 0 && (structuralAudit.audit_status === 'working_nonempty' || Number(structuralAudit.entries_with_url) > 0),
    structuralAudit.audit_status === 'valid_empty' || structuralAudit.entry_count === 0) : 'unknown';
  const latest = latestCollection(endpoint, activityStore, now), row = latest.row;
  const format = validFormat(row?.format, endpoint);
  const collectionSuccess = ['working_nonempty', 'valid_empty'].includes(row?.status);
  const collectionState = classify(row?.status, format, collectionSuccess, row?.status === 'working_nonempty' && row?.observed_urls !== 0, row?.status === 'valid_empty');
  const collectionContent = content(row?.newest_content_at, row?.date_kind, now);
  const latestRecord = row ? {
    checked_at: String(row.checked_at), status: typeof row.status === 'string' ? row.status : 'unknown', format,
    provenance: latest.provenance, http_status: Number.isInteger(row.http_status) && row.http_status >= 100 && row.http_status <= 599 ? Number(row.http_status) : null,
    reason: typeof row.reason === 'string' ? row.reason.slice(0, 256) : null,
    observed_url_count: count(row.observed_urls), newest_content_at: collectionContent.newest_content_at, date_kind: collectionContent.date_kind,
    source_activity: sources.map(source => {
      const bound = Array.isArray(row.source_ids) && row.source_ids.includes(source.id);
      const baseline = bound && Array.isArray(row.baseline_sources) && row.baseline_sources.includes(source.id);
      return { source_id: source.id, bound, baseline, new_unique_candidate_urls: bound && collectionSuccess && format && format !== 'sitemapindex' && !baseline ? count(row.source_new?.[source.id]) : null };
    }),
    retained_fields: latest.provenance === 'retained_production_collection_archive' ? 'Compressed history retains endpoint outcome, format, scope discovery counts, optional content dates and an observed URL total when recorded. Older archive versions omit the URL total; HTTP status and failure reason are not retained.' : 'Fields are reported only where retained in the production snapshot.'
  } : null;
  const chooseCollection = !!row && (auditAt === null || timestamp(row.checked_at)! >= auditAt);
  const basis = chooseCollection ? 'collection' as const : structuralAudit ? 'structural_audit' as const : null;
  const observedAt = chooseCollection ? latestRecord!.checked_at : structuralAudit?.checked_at ?? null;
  const rawState = chooseCollection ? collectionState : auditState;
  const stale = observedAt !== null && now - timestamp(observedAt)! > healthStore.staleAfterMs;
  const status: Status = latest.error ? 'evidence_unavailable' : stale ? 'stale' : rawState;
  const selectedUrlCount = chooseCollection ? count(row?.observed_urls) : count(structuralAudit?.entries_with_url);
  const selectedNonemptyXml = chooseCollection ? row?.status === 'working_nonempty' && format !== null : structuralAudit?.validation === 'xml_structure'
    && structuralAudit.last_outcome === 'healthy' && auditFormat !== null && (structuralAudit.audit_status === 'working_nonempty' || Number(structuralAudit.entry_count) > 0);
  const usabilityEvidence = latest.error ? 'not_established' as const : rawState === 'usable' ? selectedUrlCount !== null && selectedUrlCount > 0
    ? 'observed_urls_present' as const : 'recorded_nonempty_xml_count_not_retained' as const
    : rawState === 'unknown' && selectedNonemptyXml && selectedUrlCount === 0 ? 'explicit_zero_usable_urls' as const : 'not_established' as const;
  const conflict = !!row && !!structuralAudit && auditState !== 'unknown' && collectionState !== 'unknown' && auditState !== collectionState;
  return { endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url, status,
    usable: status === 'usable' ? true : ['valid_empty', 'index_only', 'failed'].includes(status) ? false : null,
    usability_evidence: usabilityEvidence,
    reason: latest.error ? 'Collection history could not be verified, so the latest endpoint state cannot be certified from the older structural audit.'
      : status === 'unknown' && usabilityEvidence === 'explicit_zero_usable_urls' ? 'Valid nonempty XML had zero usable HTTP(S) entry URLs; article-list usability was not established.'
      : status === 'usable' && usabilityEvidence === 'recorded_nonempty_xml_count_not_retained' ? 'The saved validator recorded valid nonempty XML. Usability is inferred from that saved status because its usable entry-URL count was not retained; first-import success is not certified.'
      : describe[status as Exclude<Status, 'evidence_unavailable'>],
    observed_at: latest.error ? null : observedAt, basis: latest.error ? null : basis, stale_after_seconds: healthStore.staleAfterMs / 1000,
    content: chooseCollection ? collectionContent : content(structuralAudit?.newest_content_at, structuralAudit?.date_kind, now, structuralAudit?.content_freshness),
    structural_audit: structuralAudit, latest_collection: latestRecord,
    collection_history: { state: latest.error ? 'unavailable' as const : row ? 'available' as const : 'not_recorded' as const, error: latest.error,
      ignored_invalid_time_records: latest.invalid, ignored_future_records: latest.future },
    conflict: { present: conflict, explanation: conflict ? `The structural audit recorded ${auditState} at ${structuralAudit!.checked_at}; production collection recorded ${collectionState} at ${latestRecord!.checked_at}. The later dated observation is used${chooseCollection && timestamp(row!.checked_at) === auditAt ? ', with production collection preferred for equal timestamps' : ''}. Both records are preserved.` : null },
    semantics: 'Saved evidence only; no live publisher request. Collection times, feed-item dates and sitemap modification dates have different meanings. Baselines are excluded from new-discovery counts; null means unavailable, excluded or unbound, while recorded zero is a measured zero. Sitemap indexes and valid empty documents are not collection failures. Archive fields are not inferred from another record.' };
}
