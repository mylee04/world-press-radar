import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadData } from './config.js';
import { observationSchema, snapshotSchema, type Observation } from './health.js';
import { auditEndpoint } from './audit-check.js';
import { createHostGate } from './host-gate.js';
import {RecoveryStore} from './recovery-store.js';

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
atomic(manifestPath, { runId, registryHash, startedAt, endpointCount: endpoints.length, globalConcurrency: 8, perHostConcurrency: 1, minimumHostGapMs: 2000, timeoutMs: 8000, maxAttempts: 1, rssMaxBytes: 4194304, sitemapMaxBytes: 8388608, validatorVersion: '3', correction: 'Recheck previously rejected public 192.0.66/78 and ordinary 2001 IPv6 addresses; private/special-use destinations remain blocked.' });
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
const recovery=process.env.WNS_ACTIVITY_DB?new RecoveryStore(process.env.WNS_ACTIVITY_DB):null;
recovery?.seedFromLedger(catalog);
for(const o of observations.values()){const endpoint=catalog.endpoints.get(o.endpointId);if(endpoint)recovery?.record(endpoint,o,`audit:${runId}:${o.endpointId}:${o.checkedAt}`);}
const pending=endpoints.filter(e=>!observations.has(e.id));
const activeHosts=new Set<string>();const nextHostAt=new Map<string,number>();
const requestGate=recovery?recovery.gate(createHostGate()):createHostGate();
const skipped = new Map<string, string>(); let stopped = false;let budgetExhausted=false;
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
  if (finished) {
    // A recovery pause preserves the last known observation, never invents a fresh check.
    const published=new Map((previousSnapshot?.observations??[]).map(o=>[o.endpointId,o]));
    for(const o of observations.values())published.set(o.endpointId,o);
    atomic(`${base}/health-latest.json`,{version:1,audit,observations:[...published.values()]});
    if(recovery)atomic(`${directory}/recovery-report.json`,recovery.report());
  }
  const rows = Object.entries(totals).filter(([key]) => !key.includes(':content_')).map(([key, counts]) => `| ${key} | ${counts.total} | ${counts.working_nonempty ?? 0} | ${counts.valid_empty ?? 0} | ${counts.blocked ?? 0} | ${counts.timeout ?? 0} | ${counts.malformed ?? 0} | ${counts.http_error ?? 0} | ${counts.network_error ?? 0} | ${counts.incomplete ?? 0} | ${counts.unknown_incomplete ?? 0} |`);
  writeFileSync(`${directory}/README.md`, `# Live endpoint audit ${runId}\n\nStarted: ${startedAt}. Finished: ${finishedAt ?? 'in progress'}. Checked: ${observations.size}/${endpoints.length}.\n\nAll configured endpoints, including disabled registrations, are in scope. Shared typed URLs are checked once. Country and enabled/disabled buckets overlap when a shared endpoint belongs to multiple scopes; only overall type totals are additive. A completed full audit means every endpoint received an attempt; it does not mean every endpoint works.\n\n| Scope | Total | Working nonempty | Valid empty | Blocked | Timeout | Malformed | HTTP error | Network error | Incomplete | Not checked |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\nDetails: report.json. Resumable observations: observations.jsonl. Each observation records actual checkedAt, HTTP status, parsed entry count, up to three output URLs, and publication/lastmod date separately. No article bodies retained. Sitemap-index entries refer to child sitemaps; children/article URLs were not fetched. Content older than 30 days is labelled stale; missing or invalid/future dates are not guessed.\n\nEight global workers, one per hostname, two seconds between same-host checks. No inline retry: transient failures receive persistent bounded backoff for the existing next eligible job. 429 honors Retry-After and durable host cooldown; access restrictions pause pressure and flag official alternatives. Paused endpoints are explicitly skipped; their previous observations remain cached and lastCompletedFullAuditAt does not advance. XML structure checks are not full XSD validation. Size/encoding/safety limits count as incomplete, not proof of a dead publisher.\n`);
  console.log(JSON.stringify({ ...audit, elapsedSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000) }));
}
checkpoint(); const timer = setInterval(() => checkpoint(), 30000);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function worker() {
  while (!stopped && pending.length) {
    const index = pending.findIndex(e => { const host = new URL(e.url).hostname; return !activeHosts.has(host) && (nextHostAt.get(host) ?? 0) <= Date.now(); });
    if (index < 0) { await sleep(100); continue; }
    const endpoint = pending.splice(index, 1)[0]; const host = new URL(endpoint.url).hostname;
    const eligibility=recovery?.eligible(endpoint,undefined,'health');
    if(eligibility&&!eligibility.eligible){skipped.set(endpoint.id,`RECOVERY_PAUSED:${eligibility.category}:${eligibility.until}`);continue;}
    if(budgetExhausted){skipped.set(endpoint.id,'DAILY_REQUEST_BUDGET_EXHAUSTED');continue;}
    try{recovery?.reserveRequest();}catch(error){if((error as Error).message!=='DAILY_REQUEST_BUDGET_EXHAUSTED')throw error;budgetExhausted=true;skipped.set(endpoint.id,'DAILY_REQUEST_BUDGET_EXHAUSTED');continue;}
    activeHosts.add(host);
    try {
      const result = await auditEndpoint(endpoint, requestGate); result.attempts = 1;
      observationSchema.parse(result); observations.set(endpoint.id, result); appendFileSync(journal, JSON.stringify(result) + '\n');
      recovery?.record(endpoint,result,`audit:${runId}:${endpoint.id}:${result.checkedAt}`);
      nextHostAt.set(host,Date.now()+2000);
    } finally { activeHosts.delete(host); }
  }
}
let failed=false;
try {const results=await Promise.allSettled(Array.from({length:8},async()=>{try{await worker();}catch(error){stopped=true;throw error;}}));const rejected=results.find(r=>r.status==='rejected');if(rejected?.status==='rejected')throw rejected.reason;}
catch(error){failed=true;throw error;}
finally { clearInterval(timer);checkpoint(!stopped&&!failed);recovery?.close(); }
if (stopped) { console.error('Stopped safely; run the same audit ID to resume.'); process.exitCode = 130; }
