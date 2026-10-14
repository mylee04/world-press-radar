import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { canonicalUrl, normalizeRegistry } from '../../dist/catalog.js';
import { readHistory } from '../../dist/activity-history.js';

// Read-only evidence join. It never calls a publisher, writes a registry or opens the ledger.
const packageRoot = resolve(import.meta.dirname, '../..');
const snapshotRoot = join(packageRoot, 'output/news-quality/language-en-ko-20261014/production-metadata-after-activation');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const registryBytes = readFileSync(join(snapshotRoot, 'registry.json'));
const registry = JSON.parse(registryBytes), catalog = normalizeRegistry(registry);
const snapshot = read(join(snapshotRoot, 'activity-snapshot.json'));
const latest = new Map();
let records = 0;
for (const shard of snapshot.history.shards) {
  for (const record of readHistory(join(snapshotRoot, 'history'), shard)) {
    records++;
    const previous = latest.get(record.endpoint_id);
    if (!previous || Date.parse(record.checked_at) > Date.parse(previous.checked_at)) latest.set(record.endpoint_id, record);
  }
}
assert.equal(records, 58803);
const files = ['asia-pacific.json', 'europe.json', 'americas-africa-middle-east.json'];
const rows = files.flatMap(file => {
  const data = read(join(import.meta.dirname, file));
  const items = Array.isArray(data) ? data : data.items ?? data.anchors ?? data.publishers;
  assert.ok(Array.isArray(items), `Missing items array in ${file}`);
  return items.map(item => ({ ...item, audit_file: file }));
});
const countries = new Map(registry.countries.map(country => [country.code, country]));
assert.equal(new Set(rows.map(item => item.country)).size, countries.size);
assert.equal(new Set(rows.map(item => `${item.country}:${item.name}`)).size, rows.length, 'Duplicate selected anchors');
const sourceKey = (country, name, endpoints) => JSON.stringify([country, name.normalize('NFKC').trim().toLowerCase(), endpoints.map(endpoint => [endpoint.type, endpoint.url]).sort()]);
const sourcesByRow = new Map();
for (const source of catalog.sources) {
  const key = sourceKey(source.countryCode, source.name, source.endpoints);
  const list = sourcesByRow.get(key) ?? []; list.push(source); sourcesByRow.set(key, list);
}
function recordedOutcome(record) {
  if (!record) return 'unavailable';
  if (!['working_nonempty', 'valid_empty'].includes(record.status)) return 'failed_or_non_article_response';
  if (record.format === 'sitemapindex') return 'index_only';
  return ['rss', 'atom', 'rdf', 'urlset'].includes(record.format) ? 'successful_saved_xml' : 'recorded_format_unknown';
}
const enriched = rows.map(item => {
  assert.ok(countries.has(item.country), `Unknown country ${item.country}`);
  assert.ok(item.name && item.presence_status && Array.isArray(item.matched_rows), `Invalid anchor ${item.name}`);
  assert.ok(Array.isArray(item.references), `Invalid research references: ${item.name}`);
  if (item.presence_status !== 'registered_active') assert.ok(item.references.length, `Missing gap research references: ${item.name}`);
  const matched = new Map();
  for (const row of item.matched_rows) {
    const endpoints = [['rss', row.url], ['sitemap', row.sitemapUrl]].filter(([, url]) => url).map(([type, url]) => ({ type, url: canonicalUrl(url) }));
    const matches = sourcesByRow.get(sourceKey(row.country, row.name, endpoints)) ?? [];
    assert.ok(matches.length, `Matched row not in saved registry: ${item.name} / ${row.name}`);
    for (const source of matches) matched.set(source.id, source);
  }
  const sourceEvidence = [...matched.values()].map(source => ({
    source_id: source.id, country: source.countryCode, name: source.name, enabled: source.enabled,
    endpoints: source.endpoints.map(endpoint => {
      const record = latest.get(endpoint.id);
      return { endpoint_id: endpoint.id, type: endpoint.type, url: endpoint.url,
        last_recorded_check_at: record?.checked_at ?? null, last_recorded_status: record?.status ?? null,
        last_recorded_format: record?.format ?? null, outcome: recordedOutcome(record),
        live_state_verified_by_this_audit: false };
    }),
  }));
  if (item.presence_status === 'missing') assert.equal(sourceEvidence.length, 0, `Missing anchor has matched sources: ${item.name}`);
  const localActive = sourceEvidence.filter(source => source.country === item.country && source.enabled);
  const localEndpoints = localActive.flatMap(source => source.endpoints);
  const outcomes = [...new Set(localEndpoints.map(endpoint => endpoint.outcome))];
  const collectionCoverage = !localActive.length ? 'no_local_active_registration'
    : outcomes.includes('successful_saved_xml') ? 'at_least_one_successful_saved_xml'
    : outcomes.length === 1 && outcomes[0] === 'index_only' ? 'index_only_gap'
    : outcomes.some(outcome => outcome === 'failed_or_non_article_response') ? 'no_successful_saved_xml_in_active_matches'
    : 'saved_evidence_unavailable';
  return { ...item, matched_source_evidence: sourceEvidence, recorded_collection_coverage: collectionCoverage };
});
const count = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
const report = {
  version: 1, researched_at_utc: new Date().toISOString(), scope: 'Selected national publisher anchors in the existing registry countries; not an exhaustive ranking or publisher census.',
  registry_sha256: createHash('sha256').update(registryBytes).digest('hex'), registry_rows: catalog.configuredRows,
  registry_snapshot_observed_at: '2026-10-14T05:03:49.263191Z', source_activity_snapshot_at: snapshot.generated_at,
  historical_records_read: records, countries: countries.size, selected_anchors: enriched.length,
  presence_counts: count(enriched.map(item => item.presence_status)), recorded_collection_counts: count(enriched.map(item => item.recorded_collection_coverage)),
  registered_active_collection_counts: count(enriched.filter(item => item.presence_status === 'registered_active').map(item => item.recorded_collection_coverage)),
  needs_review_collection_counts: count(enriched.filter(item => item.presence_status === 'needs_review').map(item => item.recorded_collection_coverage)),
  definitions: {
    presence: 'Registration is matched by audited aliases/domains and the exact recorded row. Active registration does not establish a working endpoint.',
    endpoints: 'Officially declared candidate addresses need current robots/XML and Oracle validation before adoption. No candidate was installed or initialized.',
    recorded_health: 'Most recent checksum-verified collection evidence through the saved snapshot. recorded_collection_counts summarize matched addresses including pending attribution-review cases, not confirmed publisher coverage. registered_active_collection_counts exclude needs_review anchors. Successful XML can contain zero new URLs. Indexes are not article URL streams; no live check or outage adjudication was made.',
    coverage: 'The denominator is the selected anchor list, not all major publishers. Country placement can reflect editorial coverage rather than company headquarters and requires review before changes.',
  },
  country_summary: [...countries.values()].map(country => {
    const items = enriched.filter(item => item.country === country.code);
    return { country: country.code, name: country.name, registrations: country.feeds.length,
      active_registrations: country.feeds.filter(feed => feed.enabled !== false).length,
      selected_anchors: items.length, presence_counts: count(items.map(item => item.presence_status)),
      gaps: items.filter(item => item.presence_status !== 'registered_active' || item.recorded_collection_coverage !== 'at_least_one_successful_saved_xml')
        .map(item => ({ name: item.name, presence_status: item.presence_status, recorded_collection_coverage: item.recorded_collection_coverage })) };
  }),
  items: enriched, operations: { registry_changed: false, scheduled_jobs_started: false, publisher_xml_requests: 0, paid_model_calls: 0 },
};
writeFileSync(join(import.meta.dirname, 'audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ countries: report.countries, selected_anchors: report.selected_anchors, presence_counts: report.presence_counts, recorded_collection_counts: report.recorded_collection_counts }, null, 2));
