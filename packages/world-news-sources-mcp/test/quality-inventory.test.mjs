import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRegistry } from '../dist/catalog.js';
import { HealthStore } from '../dist/health.js';
import { getInventoryChanges } from '../dist/quality-inventory.js';
import { updateRegistryStatus } from '../dist/operator-status.js';

const date = '2026-10-12', now = Date.parse('2026-10-13T10:00:00.000Z');
const initialAt = '2026-10-12T01:00:00.000Z', checkedAt = '2026-10-11T23:00:00.000Z', batch = 'official-additions-test';
const initialFeed = () => ({ name: 'Verified Outlet', url: 'https://news.example/rss', sitemapUrl: 'https://news.example/sitemap.xml',
  enabled: true, enabled_changed_at: initialAt, status_transition_count: 0, status_history: [], registry_addition_batch: batch,
  status_reason: `Initial registration from verified official declarations (${batch}).`, source_homepage: 'https://news.example/',
  endpoint_provenance: [{type: 'rss', url: 'https://news.example/rss', kind: 'official_html_feed_link',
    source_url: 'https://news.example/', found_at: '2026-10-11T22:00:00.000Z', page_sha256: 'a'.repeat(64), checked_at: checkedAt,
    format: 'rss', scope_note: 'Latest news', secret: 'must-not-be-exported' }], secret: 'must-not-be-exported' });
const fixture = () => ({ countries: [
  { code: 'US', name: 'United States', feeds: [initialFeed(), { name: 'Existing Outlet', url: 'https://other.example/feed' }] },
  { code: 'JP', name: 'Japan', feeds: [{ name: 'Untracked Outlet', url: 'https://jp.example/rss', enabled: false }] },
] });
const project = (raw, selected = date, store = new HealthStore(), at = now) => getInventoryChanges(normalizeRegistry(raw), raw, selected, store, at);

test('records exact operator initial additions and keeps validation and registration dates separate', () => {
  const raw = fixture(), catalog = normalizeRegistry(raw), ep = catalog.sources.find(source => source.name === 'Verified Outlet').endpoints[0];
  const health = new HealthStore({version: 1, observations: [{ endpointId: ep.id, type: ep.type, url: ep.url,
    checkedAt, outcome: 'healthy', httpStatus: 200, reason: null, format: 'rss', auditStatus: 'working_nonempty' }]});
  const got = getInventoryChanges(catalog, raw, date, health, now);
  assert.equal(got.additions.length, 1);
  const addition = got.additions[0];
  assert.equal(addition.name, 'Verified Outlet'); assert.equal(addition.country, 'US');
  assert.deepEqual(addition.endpoint_types, ['rss', 'sitemap']);
  assert.equal(addition.recorded_at, initialAt); assert.equal(addition.batch_id, batch);
  assert.equal(addition.endpoints[0].latest_validation.checked_at, checkedAt);
  assert.equal(addition.endpoints[0].provenance[0].validation_checked_at, checkedAt);
  assert.equal(addition.endpoints[1].latest_validation.status, 'unknown');
  assert.equal(JSON.stringify(got).includes('must-not-be-exported'), false);
  assert.equal(got.unknown_addition_timestamp_count, 2);
  const us = got.per_country.find(country => country.country === 'US');
  assert.equal(us.additions, 1); assert.equal(us.deletions, null); assert.equal(us.net_change, null);
  assert.equal(us.current_holdings.unique_publishers, null);
  assert.equal(us.history_complete, false);
});

test('enabled transition timestamp is not a creation date; deactivation is not deletion', () => {
  const raw = fixture(), catalog = normalizeRegistry(raw), source = catalog.sources.find(source => source.name === 'Verified Outlet');
  const disabled = updateRegistryStatus(raw, source.id, false, 'Endpoint needs review', new Date('2026-10-12T05:00:00.000Z'));
  const got = project(disabled), us = got.per_country.find(country => country.country === 'US');
  assert.deepEqual(got.additions, []); assert.equal(got.unknown_addition_timestamp_count, 3);
  assert.equal(us.deactivations, 1); assert.equal(us.reactivations, 0);
  assert.equal(us.deletions, null); assert.equal(us.net_change, null);
  assert.equal(got.source_transitions[0].kind, 'deactivation');
  const reenabled = updateRegistryStatus(disabled, source.id, true, 'Recovered', new Date('2026-10-12T06:00:00.000Z'));
  const recovered = project(reenabled).per_country.find(country => country.country === 'US');
  assert.equal(recovered.deactivations, 1); assert.equal(recovered.reactivations, 1);
  assert.equal(recovered.additions, 0); assert.equal(recovered.net_change, null);
});

test('current registrations, normalized sources and typed endpoints have distinct scopes', () => {
  const raw = fixture(); raw.countries[0].feeds.push(structuredClone(raw.countries[0].feeds[0]));
  raw.countries[0].feeds.push({ name: 'Same endpoint, other label', url: 'https://news.example/rss', sitemapUrl: 'https://news.example/rss' });
  const got = project(raw), us = got.per_country.find(country => country.country === 'US');
  assert.equal(us.additions, 1); assert.equal(got.additions[0].registration_count, 2);
  assert.equal(us.current_holdings.active_source_registrations, 4);
  assert.equal(us.current_holdings.active_normalized_sources, 3);
  assert.equal(us.current_holdings.unique_active_rss_endpoints, 2);
  assert.equal(us.current_holdings.unique_active_sitemap_endpoints, 2);
  const earlier = project(raw, '2026-10-11');
  assert.equal(earlier.additions.length, 0);
  assert.deepEqual(earlier.per_country.find(country => country.country === 'US').current_holdings, us.current_holdings);
});

test('missing, conflicting, future and altered initial metadata remain unknown', () => {
  const mutations = [
    feed => delete feed.registry_addition_batch,
    feed => delete feed.status_transition_count,
    feed => delete feed.status_history,
    feed => feed.enabled_changed_at = '2026-10-14T00:00:00.000Z',
    feed => feed.status_reason = 'First seen during audit',
  ];
  for (const mutate of mutations) {
    const raw = fixture(); mutate(raw.countries[0].feeds[0]);
    const got = project(raw); assert.equal(got.additions.length, 0); assert.equal(got.unknown_addition_timestamp_count, 3);
  }
  const raw = fixture(), duplicate = structuredClone(raw.countries[0].feeds[0]);
  duplicate.enabled_changed_at = '2026-10-12T02:00:00.000Z'; raw.countries[0].feeds.push(duplicate);
  assert.equal(project(raw).additions.length, 0);
  const catalog = normalizeRegistry(fixture());
  assert.equal(getInventoryChanges(catalog, null, date, new HealthStore(), now).unknown_addition_timestamp_count, catalog.sources.length);
});

test('only selected UTC date events at or before observation time are counted', () => {
  const raw = fixture(), catalog = normalizeRegistry(raw), source = catalog.sources.find(source => source.name === 'Verified Outlet');
  const disabled = updateRegistryStatus(raw, source.id, false, 'Future record', new Date('2026-10-13T11:00:00.000Z'));
  assert.equal(project(disabled, '2026-10-13').source_transitions.length, 0);
  assert.equal(project(raw, date, new HealthStore(), Date.parse('2026-10-12T00:30:00.000Z')).additions.length, 0);
  for (const invalid of ['2026-02-30', '2026-10-14', '2026-1-01', 'bad']) assert.throws(() => project(raw, invalid), /valid past\/present UTC date/);
});

test('retained status history counts recorded events without claiming complete historical changes', () => {
  const raw = fixture(), feed = raw.countries[0].feeds[0];
  const transition = { old_enabled: true, new_enabled: false, changed_at: '2026-10-12T05:00:00.000Z', reason: 'Retained change' };
  Object.assign(feed, { enabled: false, enabled_changed_at: transition.changed_at, status_reason: transition.reason,
    status_history: [transition], status_transition_count: 25 });
  const got = project(raw), us = got.per_country.find(country => country.country === 'US');
  assert.equal(us.deactivations, 1); assert.equal(us.reactivations, 0); assert.equal(us.additions, 0);
  assert.equal(us.history_complete, false); assert.equal(got.recorded_events_only, true);
  assert.equal(us.net_change, null);
});

test('authoritative registry without an addition ledger has current holdings but unknown historical creation dates', () => {
  const raw = JSON.parse(readFileSync(new URL('../../../data/rss-atlas.json', import.meta.url), 'utf8'));
  const got = project(raw), catalog = normalizeRegistry(raw);
  assert.equal(got.unknown_addition_timestamp_count + got.known_addition_timestamp_count, catalog.sources.length);
  assert.equal(got.per_country.reduce((count, country) => count + country.current_holdings.configured_source_registrations, 0), catalog.configuredRows);
  assert.ok(got.per_country.every(country => country.unique_publishers === undefined && country.current_holdings.unique_publishers === null
    && country.deletions === null && country.net_change === null && !country.history_complete));
  // Today's raw file has no batch evidence. A future explicitly recorded addition
  // may legitimately make known_addition_timestamp_count nonzero.
  if (!raw.countries.some(country => country.feeds.some(feed => feed.registry_addition_batch))) {
    assert.equal(got.additions.length, 0); assert.equal(got.known_addition_timestamp_count, 0);
  }
});
