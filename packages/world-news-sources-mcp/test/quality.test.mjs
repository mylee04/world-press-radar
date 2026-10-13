import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry } from '../dist/catalog.js';
import { ActivityStore } from '../dist/activity.js';
import { HealthStore } from '../dist/health.js';
import { getCountryQualityOverview, getSourceQualityDetail } from '../dist/quality.js';

const now = Date.parse('2026-10-13T12:00:00Z');
const catalog = normalizeRegistry({ countries: [
  { code: 'US', name: 'United States', feeds: [{ name: 'Texas Tribune', url: 'https://texas.example/rss' }, { name: 'NYT Tech', url: 'https://nyt.example/rss' }] },
  { code: 'KR', name: 'Korea', feeds: [{ name: 'Donga National', url: 'https://donga.example/national' }, { name: 'Donga Science', url: 'https://donga.example/science' }, { name: 'Daily NK', url: 'https://nk.example/rss' }] },
  { code: 'JP', name: 'Japan', feeds: [{ name: 'NHK legacy', url: 'https://nhk.example/legacy' }, { name: 'Yomiuri', sitemapUrl: 'https://yomiuri.example/sitemap' }] },
] });
const source = name => catalog.sources.find(s => s.name === name);
const endpoint = name => source(name).endpoints[0];
function event(name, date, status = 'working_nonempty', count = 0, format = null) {
  const s = source(name), e = endpoint(name);
  return { endpoint_id: e.id, checked_at: `${date}T03:00:00.000Z`, status, format: format ?? (e.type === 'rss' ? 'rss' : 'urlset'),
    reason: status === 'timeout' ? 'request timeout' : null, source_ids: [s.id], countries: [s.countryCode],
    source_new: { [s.id]: count }, country_new: { [s.countryCode]: count }, baseline_sources: [], uncertain_urls: 0 };
}
function store(records, options = {}) {
  const first = records[0]?.checked_at ?? null;
  const beginnings = kind => Object.fromEntries(records.map(e => kind === 'source' ? e.source_ids : e.countries).flat().map(id => [id, records.find(e => (kind === 'source' ? e.source_ids : e.countries).includes(id)).checked_at]));
  const latest = kind => Object.fromEntries(records.map(e => kind === 'source' ? e.source_ids : e.countries).flat().map(id => [id, records.filter(e => (kind === 'source' ? e.source_ids : e.countries).includes(id)).at(-1).checked_at]));
  return new ActivityStore({ version: 1, lane: 'production', generated_at: '2026-10-13T04:00:00.000Z', tracking_start: first,
    available_since: '2026-08-01T00:00:00.000Z', registry_at: '2026-10-01T00:00:00.000Z', semantics: 'First discoveries, not publications',
    collections: records, scope_starts: { source: beginnings('source'), country: beginnings('country') },
    scope_latest: { source: latest('source'), country: latest('country') },
    bindings: catalog.sources.flatMap(s => s.endpoints.map(e => ({ source_id: s.id, endpoint_id: e.id,
      baseline_at: records.some(r => r.endpoint_id === e.id && ['working_nonempty', 'valid_empty'].includes(r.status) && r.format !== 'sitemapindex') ? first : null }))), ...options });
}
function healthRecord(name, content = {}) {
  const e = endpoint(name);
  return { endpointId: e.id, type: e.type, url: e.url, checkedAt: '2026-10-12T03:00:00.000Z', outcome: 'healthy',
    httpStatus: 200, reason: null, format: e.type === 'rss' ? 'rss' : 'urlset', auditStatus: 'working_nonempty', ...content };
}
const records = [
  event('Donga National', '2026-10-06', 'working_nonempty', 12),
  event('Donga Science', '2026-10-06', 'working_nonempty', 7),
  event('Texas Tribune', '2026-10-10', 'working_nonempty', 9),
  event('Donga National', '2026-10-11', 'timeout'), event('Donga Science', '2026-10-11', 'timeout'),
  event('Texas Tribune', '2026-10-11', 'valid_empty'),
  event('Donga National', '2026-10-12', 'timeout'), event('Donga Science', '2026-10-12', 'working_nonempty', 21),
  event('Texas Tribune', '2026-10-12', 'working_nonempty'), event('NHK legacy', '2026-10-12', 'working_nonempty'),
  event('Yomiuri', '2026-10-12', 'blocked'),
  event('Texas Tribune', '2026-10-13', 'working_nonempty', 3),
];
const activity = store(records);
const health = new HealthStore({ version: 1, observations: [healthRecord('NHK legacy', {
  newestContentAt: '2026-08-08T12:00:00.000Z', contentFreshness: 'stale', dateKind: 'feed_item_date' }),
  { ...healthRecord('Donga Science'), outcome: 'unhealthy', checkedAt: '2026-10-11T03:00:00.000Z', auditStatus: 'timeout', reason: 'Timeout' }] });
const detail = name => getSourceQualityDetail(catalog, activity, health, { source_id: source(name).id, date: '2026-10-12' }, now);

test('successful zero, regression, recovery, stale content and unknown tracking remain distinct', () => {
  const texas = detail('Texas Tribune');
  assert.equal(texas.endpoints[0].classification, 'successful_no_new_discoveries');
  assert.equal(texas.article_activity.daily.new_unique_candidate_urls, 0);
  assert.equal(detail('Donga National').endpoints[0].classification, 'failure_after_prior_success');
  assert.equal(detail('Donga National').article_activity.daily.new_unique_candidate_urls, null);
  assert.equal(detail('Donga Science').endpoints[0].classification, 'recovered_after_failure');
  assert.equal(detail('Donga Science').article_activity.daily.new_unique_candidate_urls, 21);
  assert.equal(detail('NHK legacy').endpoints[0].classification, 'stale_content_evidence');
  assert.equal(detail('NHK legacy').endpoints[0].health.newest_content_at, '2026-08-08T12:00:00.000Z');
  assert.equal(detail('Yomiuri').endpoints[0].classification, 'access_failure_without_normal_baseline');
  assert.equal(detail('Daily NK').initialization, 'not_initialized');
  assert.equal(detail('Daily NK').article_activity.daily.new_unique_candidate_urls, null);
  assert.equal(detail('Daily NK').endpoints[0].daily.attributed_source_new_urls, null);
});

test('attempt coverage and success have separate denominators; freshness and publisher identity are unavailable', () => {
  const result = getCountryQualityOverview(catalog, activity, health, { date: '2026-10-12', limit: 50 }, now);
  const kr = result.items.find(row => row.country === 'KR'), us = result.items.find(row => row.country === 'US');
  assert.equal(kr.metrics.attempt_coverage.numerator, 2);
  assert.equal(kr.metrics.attempt_coverage.denominator, 3);
  assert.equal(kr.metrics.success_rate.numerator, 1);
  assert.equal(kr.metrics.success_rate.denominator, 2);
  assert.equal(kr.metrics.success_rate.value, 50);
  assert.equal(us.metrics.attempt_coverage.value, 50);
  assert.equal(us.metrics.success_rate.value, 100);
  assert.equal(us.metrics.freshness.value, null);
  assert.equal(us.metrics.freshness.denominator, 0);
  assert.equal(us.inventory.unique_publishers, null);
  assert.equal(kr.anomaly.operational_failure_confirmed, false);
  assert.equal(kr.investigation_candidates[0].reason, 'failure_after_prior_success');
});

test('current snapshot date is partial and after-watermark dates never become measured zero', () => {
  const truncated = store(records.filter(e => e.checked_at < '2026-10-13'));
  const day = getCountryQualityOverview(catalog, truncated, health, { date: '2026-10-12' }, now);
  assert.equal(day.items[0].period.state, 'partial_snapshot_window');
  assert.equal(day.items[0].anomaly.state, 'partial_window');
  const after = getCountryQualityOverview(catalog, truncated, health, { country: 'US', date: '2026-10-13' }, now).items[0];
  assert.equal(after.period.state, 'after_latest_collection');
  assert.equal(after.metrics.attempt_coverage.value, null);
  assert.equal(after.metrics.attempt_coverage.numerator, null);
  assert.throws(() => getCountryQualityOverview(catalog, activity, health, { date: '2026-02-30' }, now));
  assert.throws(() => getCountryQualityOverview(catalog, activity, health, { date: '2026-10-14' }, now));
});

test('source counts exclude baseline and endpoint allocations cannot masquerade as independent endpoint counts', () => {
  const s = source('Texas Tribune'), ep = endpoint('Texas Tribune');
  const baseline = { ...event(s.name, '2026-10-06'), baseline_sources: [s.id] };
  const observations = store([baseline, event(s.name, '2026-10-12', 'working_nonempty', 4), event(s.name, '2026-10-13')]);
  const result = getSourceQualityDetail(catalog, observations, new HealthStore(), { source_id: s.id, date: '2026-10-12' }, now);
  assert.equal(result.article_activity.weekly.new_unique_candidate_urls, 4);
  assert.equal(result.article_activity.weekly.baseline_checks, 1);
  assert.equal(result.endpoints[0].id, ep.id);
  assert.equal(result.endpoints[0].weekly.attributed_source_new_urls, 4);
  assert.equal(result.endpoints[0].weekly.new_unique_candidate_urls, null);
  assert.equal(result.endpoints[0].weekly.unique_count_state, 'independent_endpoint_discovery_counts_not_exported');
});

test('same-country weekday baseline emits bounded review signals only for closed saved windows', () => {
  const s = source('Texas Tribune'), rows = [];
  for (let day = Date.parse('2026-09-07'); day <= Date.parse('2026-10-13'); day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    rows.push(event('Texas Tribune', date, date === '2026-10-12' ? 'timeout' : 'working_nonempty', 0));
    rows.push(event('NYT Tech', date, date === '2026-10-12' ? 'timeout' : 'working_nonempty', 0));
  }
  const result = getCountryQualityOverview(catalog, store(rows), new HealthStore(), { country: 'US', date: '2026-10-12', baseline_days: 28 }, now).items[0];
  assert.equal(result.baseline.state, 'comparable_closed_calendar_windows');
  assert.ok(result.baseline.samples >= 2);
  assert.equal(result.baseline.comparable_endpoints, 2);
  assert.equal(result.anomaly.state, 'review_needed');
  assert.equal(result.anomaly.reasons[0].metric, 'success_rate');
  assert.equal(result.anomaly.reasons[0].current, 0);
  assert.equal(result.anomaly.operational_failure_confirmed, false);
  assert.ok(result.baseline.sample_dates.every(date => new Date(date).getUTCDay() === 1));
  assert.equal(s.countryCode, 'US');
});

test('sitemap index checks count as attempts but cannot initialize article success or supply article counts', () => {
  const observations = store([event('Yomiuri', '2026-10-12', 'working_nonempty', 0, 'sitemapindex'), event('Texas Tribune', '2026-10-13')]);
  const result = getCountryQualityOverview(catalog, observations, new HealthStore(), { country: 'JP', date: '2026-10-12' }, now).items[0];
  assert.equal(result.metrics.attempt_coverage.numerator, 1);
  assert.equal(result.metrics.success_rate.numerator, 0);
  assert.equal(result.metrics.success_rate.denominator, 1);
  assert.equal(result.collection.index_only_endpoints, 1);
  const address = getSourceQualityDetail(catalog, observations, new HealthStore(), { source_id: source('Yomiuri').id, date: '2026-10-12' }, now).endpoints[0];
  assert.equal(address.classification, 'index_only');
  assert.equal(address.daily.attributed_source_new_urls, null);
});

test('a country-filtered overview still checks shared declines across every country first', () => {
  const rows = [];
  for (let day = Date.parse('2026-09-07'); day <= Date.parse('2026-10-13'); day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    for (const s of catalog.sources) rows.push(event(s.name, date, date === '2026-10-12' ? 'timeout' : 'working_nonempty'));
  }
  const result = getCountryQualityOverview(catalog, store(rows), new HealthStore(), { country: 'KR', date: '2026-10-12' }, now);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].country, 'KR');
  assert.equal(result.common_collector_signal.state, 'investigate_common_collector_first');
  assert.deepEqual(result.common_collector_signal.affected_countries.sort(), ['JP', 'KR', 'US']);
  assert.equal(result.common_collector_signal.eligible_baseline_countries, 3);
  assert.equal(result.common_collector_signal.assessment_scope, 'all_catalog_countries');
});

test('real binding baseline proves prior success outside the bounded history window without inventing its date', () => {
  const s = source('Donga National'), rows = [event(s.name, '2026-10-12', 'timeout'), event('Texas Tribune', '2026-10-13')];
  const observations = store(rows, { bindings: [{ source_id: s.id, endpoint_id: endpoint(s.name).id, baseline_at: '2026-07-01T01:00:00.000Z' }] });
  const result = getSourceQualityDetail(catalog, observations, new HealthStore(), { source_id: s.id, date: '2026-10-12' }, now).endpoints[0];
  assert.equal(result.classification, 'failure_after_prior_success');
  assert.equal(result.prior_success_at, '2026-07-01T01:00:00.000Z');
});
