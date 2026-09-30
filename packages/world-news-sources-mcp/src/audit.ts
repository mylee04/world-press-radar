import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadData } from './config.js';
import { observationSchema, snapshotSchema, type Observation } from './health.js';
import { auditEndpoint, isTransient } from './audit-check.js';
import { createHostGate } from './host-gate.js';

const flags = process.argv.slice(2);
if (flags.length > 1 || (flags[0] && !/^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?$/.test(flags[0]))) throw new Error('Use audit [YYYY-MM-DD[-suffix]]; an existing run resumes');
const runId = flags[0] ?? new Date().toISOString().slice(0, 10);
const base = fileURLToPath(new URL('../audits/', import.meta.url));
const directory = `${base}/${runId}`; mkdirSync(directory, { recursive: true });
const journal = `${directory}/observations.jsonl`; const manifestPath = `${directory}/manifest.json`;
const { catalog } = loadData();
const endpoints = [...catalog.endpoints.values()].sort((a, b) => a.id.localeCompare(b.id));
const registryHash = createHash('sha256').update(JSON.stringify(endpoints)).digest('hex');
const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined;
if (prior && prior.registryHash !== registryHash) throw new Error('Registry changed during this run; choose a new run suffix');
const startedAt = prior?.startedAt ?? new Date().toISOString();
const atomic = (path: string, value: unknown) => { const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, path); };
atomic(manifestPath, { runId, registryHash, startedAt, endpointCount: endpoints.length, globalConcurrency: 8, perHostConcurrency: 1, minimumHostGapMs: 2000, timeoutMs: 8000, maxAttempts: 2, rssMaxBytes: 4194304, sitemapMaxBytes: 8388608, validatorVersion: '2', correction: 'Recheck previously rejected public 192.0.66/78 and ordinary 2001 IPv6 addresses; private/special-use destinations remain blocked.' });
const observations = new Map<string, Observation>();
if (existsSync(journal)) {
  const lines = readFileSync(journal, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    try { const observation = observationSchema.parse(JSON.parse(lines[index])); observations.set(observation.endpointId, observation); }
    catch { if (index < lines.length - 2) throw new Error('Corrupted audit journal'); }
  }
  // Rewrite parsed lines to remove a possible interrupted partial last write before appending.
  writeFileSync(journal, [...observations.values()].map(o => JSON.stringify(o)).join('\n') + (observations.size ? '\n' : ''));
}
const membership = new Map<string, { countries: Set<string>; enabled: boolean; disabled: boolean }>();
for (const source of catalog.sources) for (const endpoint of source.endpoints) {
  const entry = membership.get(endpoint.id) ?? { countries: new Set<string>(), enabled: false, disabled: false };
  entry.countries.add(source.countryCode); entry.enabled ||= source.enabled; entry.disabled ||= !source.enabled; membership.set(endpoint.id, entry);
}
const pending = endpoints.filter(e => !observations.has(e.id) || (isTransient(observations.get(e.id)!) && observations.get(e.id)!.attempts === 1) ||
  (observations.get(e.id)?.reason === 'PRIVATE_ADDRESS' && observations.get(e.id)?.validatorVersion !== '2'));
const activeHosts = new Set<string>(); const nextHostAt = new Map<string, number>(); const limitedHosts = new Set<string>();
for (const observation of observations.values()) if (observation.httpStatus === 429) limitedHosts.add(new URL(observation.url).hostname);
const requestGate = createHostGate();
const skipped = new Map<string, string>(); let stopped = false;
const earlierReport = existsSync(`${directory}/report.json`) ? JSON.parse(readFileSync(`${directory}/report.json`, 'utf8')) : undefined;
const existingFinishedAt: string | null = pending.length === 0 ? earlierReport?.audit?.finishedAt ?? null : null;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
const previousSnapshot = existsSync(`${base}/health-latest.json`) ? snapshotSchema.parse(JSON.parse(readFileSync(`${base}/health-latest.json`, 'utf8'))) : undefined;
let latestFull = previousSnapshot?.audit?.lastCompletedFullAuditAt ?? null;
function checkpoint(finished = false) {
  const all = endpoints.map(e => ({ endpoint_id: e.id, type: e.type, url: e.url,
    countries: [...membership.get(e.id)!.countries].sort(), enabled_scope: membership.get(e.id)!.enabled,
    disabled_scope: membership.get(e.id)!.disabled, observation: observations.get(e.id) ?? null,
    incomplete_reason: skipped.get(e.id) ?? null }));
  const statuses: Record<string, number> = {};
  for (const row of all) { const key = row.observation?.auditStatus ?? 'unknown_incomplete'; statuses[key] = (statuses[key] ?? 0) + 1; }
  const finishedAt = finished ? existingFinishedAt ?? new Date().toISOString() : null;
  if (finished && observations.size === endpoints.length && !skipped.size) latestFull = finishedAt;
  const audit = { runId, startedAt, finishedAt, total: endpoints.length, checked: observations.size, skipped: skipped.size, lastCompletedFullAuditAt: latestFull, statuses };
  const totals: Record<string, Record<string, number>> = {};
  const increment = (key: string, status: string) => { const bucket = totals[key] ??= {}; bucket.total = (bucket.total ?? 0) + 1; bucket[status] = (bucket[status] ?? 0) + 1; };
  for (const row of all) {
    const status = row.observation?.auditStatus ?? 'unknown_incomplete'; increment(row.type, status);
    if (row.enabled_scope) increment(`${row.type}:enabled`, status);
    if (row.disabled_scope) increment(`${row.type}:disabled`, status);
    for (const country of row.countries) increment(`${country}:${row.type}`, status);
    if (row.observation?.contentFreshness) increment(`${row.type}:content_${row.observation.contentFreshness}`, status);
  }
  atomic(`${directory}/report.json`, { audit, registryHash, totals, endpoints: all });
  atomic(`${directory}/snapshot.json`, { version: 1, audit, observations: [...observations.values()] });
  if (finished) atomic(`${base}/health-latest.json`, { version: 1, audit, observations: [...observations.values()] });
  const rows = Object.entries(totals).filter(([key]) => !key.includes(':content_')).map(([key, counts]) => `| ${key} | ${counts.total} | ${counts.working_nonempty ?? 0} | ${counts.valid_empty ?? 0} | ${counts.blocked ?? 0} | ${counts.timeout ?? 0} | ${counts.malformed ?? 0} | ${counts.http_error ?? 0} | ${counts.network_error ?? 0} | ${counts.incomplete ?? 0} | ${counts.unknown_incomplete ?? 0} |`);
  writeFileSync(`${directory}/README.md`, `# Live endpoint audit ${runId}\n\nStarted: ${startedAt}. Finished: ${finishedAt ?? 'in progress'}. Checked: ${observations.size}/${endpoints.length}.\n\nAll configured endpoints, including disabled registrations, are in scope. Shared typed URLs are checked once. Country and enabled/disabled buckets overlap when a shared endpoint belongs to multiple scopes; only overall type totals are additive. A completed full audit means every endpoint received an attempt; it does not mean every endpoint works.\n\n| Scope | Total | Working nonempty | Valid empty | Blocked | Timeout | Malformed | HTTP error | Network error | Incomplete | Not checked |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\nDetails: report.json. Resumable observations: observations.jsonl. Each observation records actual checkedAt, HTTP status, parsed entry count, up to three output URLs, and publication/lastmod date separately. No article bodies retained. Sitemap-index entries refer to child sitemaps; children/article URLs were not fetched. Content older than 30 days is labelled stale; missing or invalid/future dates are not guessed.\n\nEight global workers, one per hostname, two seconds between same-host checks. At most one retry for timeout, temporary DNS/reset or selected 5xx errors after at least 30 seconds; never retry 401/403/429. A 429 pauses all remaining requests to that hostname for this run. XML structure checks are not full XSD validation. Size/encoding/safety limits count as incomplete, not proof of a dead publisher.\n`);
  console.log(JSON.stringify({ ...audit, elapsedSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000) }));
}
checkpoint(); const timer = setInterval(() => checkpoint(), 30000);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function worker() {
  while (!stopped && pending.length) {
    const index = pending.findIndex(e => { const host = new URL(e.url).hostname; return !activeHosts.has(host) && (nextHostAt.get(host) ?? 0) <= Date.now(); });
    if (index < 0) { await sleep(100); continue; }
    const endpoint = pending.splice(index, 1)[0]; const host = new URL(endpoint.url).hostname;
    if (limitedHosts.has(host)) { skipped.set(endpoint.id, 'HOST_RATE_LIMITED'); continue; }
    activeHosts.add(host);
    try {
      const result = await auditEndpoint(endpoint, requestGate); result.attempts = observations.has(endpoint.id) ? 2 : 1;
      observationSchema.parse(result); observations.set(endpoint.id, result); appendFileSync(journal, JSON.stringify(result) + '\n');
      if (result.httpStatus === 429) limitedHosts.add(host);
      if (isTransient(result) && result.attempts === 1) { pending.push(endpoint); nextHostAt.set(host, Date.now() + 30000); }
      else nextHostAt.set(host, Date.now() + 2000);
    } finally { activeHosts.delete(host); }
  }
}
try { await Promise.all(Array.from({ length: 8 }, worker)); }
finally { clearInterval(timer); checkpoint(!stopped); }
if (stopped) { console.error('Stopped safely; run the same audit ID to resume.'); process.exitCode = 130; }
