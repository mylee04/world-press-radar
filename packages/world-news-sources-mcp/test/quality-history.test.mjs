import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { normalizeRegistry } from '../dist/catalog.js';
import { QualityHistoryStore, completedCycleBaseline, empiricalFreshness, validateCollectionCycle, summarizeCollectionCycle } from '../dist/quality-history.js';
import { ActivityLedger, collectionId } from '../dist/activity-ledger.js';
import { ActivityStore } from '../dist/activity.js';
import { encodeHistory, decodeHistory } from '../dist/activity-history.js';
import { getCountryQualityOverview } from '../dist/quality.js';
import { HealthStore } from '../dist/health.js';

const raw = { countries: [{ code: 'US', name: 'United States', feeds: [{ name: 'A', url: 'https://publisher.example/a' }, { name: 'B', url: 'https://publisher.example/b' }] },
  { code: 'KR', name: 'Korea', feeds: [{ name: 'C', url: 'https://publisher.example/c' }] }, { code: 'JP', name: 'Japan', feeds: [{ name: 'D', url: 'https://publisher.example/d' }] }] };
const catalog = normalizeRegistry(raw), ep = catalog.sources[0].endpoints[0];
const at = date => `${date}T03:00:00.000Z`;
function setup(t) { const dir = mkdtempSync(join(tmpdir(), 'quality-history-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return { dir, path: join(dir, 'history.sqlite') }; }
function cycle(date, good = true, patch = {}) { const endpoints = [...catalog.endpoints.keys()]; return { id: `cycle-${date}`, lane: 'production', started_at: at(date), finished_at: `${date}T04:00:00.000Z`, status: 'completed', scope: 'due_endpoints',
  registry_digest: 'a'.repeat(64), country_endpoints: Object.fromEntries(catalog.countries.map(country => [country.code, catalog.sources.filter(source => source.countryCode === country.code).flatMap(source => source.endpoints.map(endpoint => endpoint.id))])),
  eligible_endpoint_ids: endpoints, planned_endpoint_ids: endpoints, attempted_endpoint_ids: endpoints, successful_article_endpoint_ids: good ? endpoints : [], failure_reason: null, ...patch }; }

test('daily all-active policy does not reuse older weekly/backoff-policy baselines', () => {
  const current = cycle('2026-10-12'), previous = [cycle('2026-10-05'), cycle('2026-09-28')];
  assert.equal(completedCycleBaseline([...previous, current], 'US', '2026-10-12').samples, 2);
  current.scheduling = { policy: 'daily_all_active', as_of: '2026-10-12T04:00:00.000Z',
    active_endpoint_ids: current.eligible_endpoint_ids, already_checked_today_endpoint_ids: [], deferred_endpoints: [],
    country_active_endpoints: current.country_endpoints };
  const changed = completedCycleBaseline([...previous, current], 'US', '2026-10-12');
  assert.equal(changed.samples, 0);
  assert.equal(changed.state, 'insufficient_completed_cycle_history');
});

test('remote publisher estimates use only a complete matching registry revision, never a newer or partial listing', t => {
  const { path } = setup(t), store = new QualityHistoryStore(path); t.after(() => store.close());
  const payload = (registryAt, count = 2) => ({ date: '2026-10-12', registry_snapshot_at: registryAt,
    items: [{ country: 'US', inventory: { active_normalized_sources: count, unique_publishers: null } }] });
  const revision = at('2026-10-11');
  assert.equal(store.decorateOverview(payload(revision)).items[0].inventory.unique_publishers, null);
  store.observeCatalog(catalog, at('2026-10-12'), revision);
  const matched = store.decorateOverview(payload(revision)).items[0].inventory;
  assert.equal(matched.unique_publishers, 1);
  assert.equal(matched.publisher_count_state, 'estimated_from_registry_identity');
  assert.equal(matched.publisher_inventory_snapshot_at, revision);
  assert.equal(store.decorateOverview(payload(at('2026-10-10'))).items[0].inventory.unique_publishers, null);
  assert.equal(store.decorateOverview(payload(at('2026-10-13'))).items[0].inventory.unique_publishers, null);
  assert.equal(store.decorateOverview(payload(null)).items[0].inventory.unique_publishers, null);
  assert.equal(store.decorateOverview(payload(revision, 3)).items[0].inventory.unique_publishers, null);
  store.observeRegistry({ observed_at: at('2026-10-13'), registry_snapshot_at: at('2026-10-13'), complete: false, sources: [] });
  assert.equal(store.decorateOverview(payload(at('2026-10-13'))).items[0].inventory.unique_publishers, null);
});

test('global publisher card needs a complete matching registry with matching global endpoint counts', t => {
  const { path } = setup(t), store = new QualityHistoryStore(path); t.after(() => store.close());
  const revision = at('2026-10-11');
  store.observeCatalog(catalog, at('2026-10-12'), revision);
  const payload = { date: '2026-10-12', registry_snapshot_at: revision, items: [],
    global_inventory: { unique_publishers: null, unique_active_rss_endpoints: 4, unique_active_sitemap_endpoints: 0 } };
  const global = store.decorateOverview(payload).global_inventory;
  assert.equal(global.unique_publishers, 1);
  assert.equal(global.publisher_count_state, 'estimated_from_registry_identity');
  assert.equal(store.decorateOverview({ ...payload, registry_snapshot_at: at('2026-10-10') }).global_inventory.unique_publishers, null);
  assert.equal(store.decorateOverview({ ...payload, global_inventory: { ...payload.global_inventory, unique_active_rss_endpoints: 5 } }).global_inventory.unique_publishers, null);
});

test('complete registry first observation is a durable baseline, never an inferred creation batch', t => {
  const { path } = setup(t); let store = new QualityHistoryStore(path);
  assert.equal(store.observeCatalog(catalog, at('2026-10-12'), at('2026-10-11')).state, 'initial_observation_baseline');
  assert.deepEqual(store.summary('2026-10-12').observed_registry_changes, []);
  store.close(); store = new QualityHistoryStore(path); t.after(() => store.close());
  assert.equal(store.summary('2026-10-12').baseline_observed_at, at('2026-10-12'));
  assert.equal(store.summary('2026-10-12').actual_registration_dates_known, false);
  const update = structuredClone(raw); update.countries[0].feeds.push({ name: 'E', url: 'https://publisher.example/e' }); update.countries[0].feeds[0].enabled = false;
  const changed = store.observeCatalog(normalizeRegistry(update), at('2026-10-13'), at('2026-10-13'));
  assert.equal(changed.added, 1); assert.equal(changed.deactivated, 1);
  const events = store.summary('2026-10-13').observed_registry_changes;
  assert.equal(events.length, 2); assert.ok(events.every(row => row.occurred_at === null && row.registration_created_at === null && row.previous_observed_at === at('2026-10-12')));
});

test('partial and stale snapshots cannot create removals; disappearance and reappearance retain their meaning', t => {
  const { path } = setup(t), store = new QualityHistoryStore(path); t.after(() => store.close());
  store.observeCatalog(catalog, at('2026-10-10'), at('2026-10-10'));
  assert.equal(store.observeRegistry({ observed_at: at('2026-10-11'), registry_snapshot_at: at('2026-10-11'), complete: false, sources: [] }).state, 'partial_registry_ignored');
  const removed = structuredClone(raw); removed.countries[0].feeds.shift();
  assert.equal(store.observeCatalog(normalizeRegistry(removed), at('2026-10-12'), at('2026-10-12')).removed, 1);
  const returned = store.observeCatalog(catalog, at('2026-10-13'), at('2026-10-13'));
  assert.equal(returned.added, 0); assert.equal(returned.reappeared, 1);
  assert.equal(store.summary('2026-10-12').observed_registry_changes[0].kind, 'registry_removal_observed');
  assert.equal(store.summary('2026-10-13').observed_registry_changes[0].kind, 'registration_reappearance_observed');
  assert.throws(() => store.observeCatalog(catalog, at('2026-10-14'), at('2026-10-11')), /SNAPSHOT_OUT_OF_ORDER/);
});

test('repeated observations advance the comparison boundary without duplicating events', t => {
  const { path } = setup(t), store = new QualityHistoryStore(path); t.after(() => store.close());
  store.observeCatalog(catalog, at('2026-10-10'), at('2026-10-10')); store.observeCatalog(catalog, at('2026-10-11'), at('2026-10-10'));
  const changed = structuredClone(raw); changed.countries[0].feeds.push({ name: 'New', url: 'https://publisher.example/new' });
  store.observeCatalog(normalizeRegistry(changed), at('2026-10-12'), at('2026-10-12'));
  assert.equal(store.summary('2026-10-12').observed_registry_changes[0].previous_observed_at, at('2026-10-11'));
  store.observeCatalog(normalizeRegistry(changed), at('2026-10-12'), at('2026-10-12'));
  assert.equal(store.summary('2026-10-12').observed_registry_changes.length, 1);
});

test('snapshot history projects only public counts and preserves null rather than manufacturing zero', t => {
  const { path } = setup(t), store = new QualityHistoryStore(path); t.after(() => store.close());
  const row = { country: 'US', period: { date: '2026-10-12', state: 'partial', run_completion: 'not_recorded' }, metrics: { attempt_coverage: { value: null, numerator: null, denominator: 2 }, success_rate: { value: 100, numerator: 1, denominator: 1 } }, inventory: { active_source_registrations: 2 }, api_key: 'must-not-save' };
  const payload = { date: '2026-10-12', snapshot_at: at('2026-10-13'), items: [row], secret: 'must-not-save' };
  store.observeOverview(payload, at('2026-10-13')); store.observeOverview(payload, `${at('2026-10-13').slice(0, 11)}04:00:00.000Z`);
  assert.equal(store.summary('2026-10-12').observations_saved, 1);
  const saved = JSON.parse(store.db.prepare('SELECT payload FROM quality_observations').get().payload);
  assert.equal(saved.attempt_coverage.value, null); assert.equal(saved.freshness.value, null);
  assert.equal(JSON.stringify(saved).includes('must-not-save'), false);
  assert.equal(store.decorateOverview(payload).items[0].completed_cycle_baseline.state, 'completion_not_recorded');
});

test('same-country weekday completed cohorts produce drops; incomplete/new cohorts and repeated same-day runs do not', () => {
  const observations = [cycle('2026-09-21'), cycle('2026-09-28'), cycle('2026-10-05'), cycle('2026-10-12', false)];
  const got = completedCycleBaseline(observations, 'US', '2026-10-12');
  assert.equal(got.state, 'comparable_completed_cycles'); assert.equal(got.samples, 3); assert.equal(got.reasons[0].metric, 'success_rate'); assert.equal(got.reasons[0].current, 0);
  assert.equal(completedCycleBaseline([...observations.slice(0, 3), cycle('2026-10-12', false, { status: 'partial' })], 'US', '2026-10-12').state, 'incomplete_or_explicit_cycle');
  const changed = cycle('2026-10-12', false), excluded = changed.country_endpoints.US.find(id => id !== ep.id); changed.country_endpoints.US = [ep.id];
  changed.eligible_endpoint_ids = changed.eligible_endpoint_ids.filter(id => id !== excluded); changed.planned_endpoint_ids = changed.planned_endpoint_ids.filter(id => id !== excluded); changed.attempted_endpoint_ids = changed.attempted_endpoint_ids.filter(id => id !== excluded);
  assert.equal(completedCycleBaseline([...observations.slice(0, 3), changed], 'US', '2026-10-12').state, 'insufficient_completed_cycle_history');
  const oneDay = [cycle('2026-10-05'), cycle('2026-10-05', true, { id: 'retry', started_at: '2026-10-05T05:00:00.000Z', finished_at: '2026-10-05T06:00:00.000Z' }), cycle('2026-10-12', false)];
  assert.equal(completedCycleBaseline(oneDay, 'US', '2026-10-12').samples, 1);
  assert.throws(() => validateCollectionCycle(cycle('2026-10-12', true, { attempted_endpoint_ids: [ep.id] })), /INVALID_COLLECTION_CYCLE/);
});

test('filtered view still checks actual completed drops across all stored countries', t => {
  const { path } = setup(t), store = new QualityHistoryStore(path); t.after(() => store.close());
  for (const row of [cycle('2026-09-28'), cycle('2026-10-05'), cycle('2026-10-12', false)]) store.observeCycle(row);
  const view = store.decorateOverview({ date: '2026-10-12', items: [{ country: 'KR', period: { date: '2026-10-12' } }] });
  assert.equal(view.items.length, 1); assert.equal(view.completed_cycle_common_signal.state, 'investigate_common_collector_first');
  assert.deepEqual(view.completed_cycle_common_signal.affected_countries.sort(), ['JP', 'KR', 'US']);
  assert.equal(view.completed_cycle_common_signal.cause_confirmed, false);
  assert.throws(() => store.observeCycle(cycle('2026-10-12', true)), /IMMUTABLE/);
});

test('public cycle summaries keep thousands of endpoint identities compact while preserving cohort comparisons', () => {
  const ids = Array.from({ length: 6000 }, (_, i) => `ep_${i.toString(16).padStart(24, '0')}`);
  const countryIds = Object.fromEntries(Array.from({ length: 73 }, (_, i) => [`C${i}`, ids.filter((_, n) => n % 73 === i)]));
  const full = cycle('2026-10-12', true, { country_endpoints: countryIds, eligible_endpoint_ids: ids, planned_endpoint_ids: ids, attempted_endpoint_ids: ids, successful_article_endpoint_ids: ids });
  const summary = summarizeCollectionCycle(full);
  assert.equal(summary.attempted_endpoints, 6000); assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 24000);
  assert.ok(Buffer.byteLength(JSON.stringify(Array.from({ length: 256 }, () => summary))) < 6 * 1024 * 1024);
  assert.equal(JSON.stringify(summary).includes(ids[0]), false);
  const past = date => summarizeCollectionCycle({ ...full, id: date, started_at: at(date), finished_at: `${date}T04:00:00.000Z` });
  const drop = summarizeCollectionCycle({ ...full, successful_article_endpoint_ids: [] });
  assert.equal(completedCycleBaseline([past('2026-09-28'), past('2026-10-05'), drop], 'C0', '2026-10-12').reasons[0].current, 0);
});

test('freshness uses dated content advances, rejects future dates, and never equates zero new URLs with stale content', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ checked_at: at(`2026-10-${String(i + 1).padStart(2, '0')}`), newest_content_at: `2026-10-${String(i + 1).padStart(2, '0')}T02:00:00.000Z`, date_kind: 'feed_item_date', status: 'working_nonempty' }));
  const current = empiricalFreshness(rows, Date.parse('2026-10-05T04:00:00.000Z'));
  assert.equal(current.state, 'within_observed_cadence'); assert.equal(current.value, true); assert.equal(current.typical_update_seconds, 86400);
  assert.equal(empiricalFreshness(rows.slice(0, 3), Date.parse('2026-10-05')).value, null);
  assert.equal(empiricalFreshness(rows, Date.parse('2026-10-12')).state, 'content_observation_too_old');
  const stopped = [...rows, { ...rows.at(-1), checked_at: at('2026-10-12') }];
  assert.equal(empiricalFreshness(stopped, Date.parse('2026-10-12T04:00:00Z')).value, false);
  assert.equal(empiricalFreshness(rows.map(row => ({ ...row, newest_content_at: '2028-01-01T00:00:00Z' })), Date.parse('2026-10-12')).value, null);
});

test('collector records planned/attempted completion and content dates; old databases and recovery remain compatible', t => {
  const { dir } = setup(t), ledger = new ActivityLedger(join(dir, 'activity.sqlite')); t.after(() => ledger.close());
  ledger.acquire('writer', at('2026-10-12'), 3600); ledger.syncRegistry(catalog, at('2026-10-12'));
  const eligible = [...catalog.endpoints.keys()]; ledger.beginCycle(catalog, { id: 'limited', lane: 'production', at: at('2026-10-12'), eligible_endpoint_ids: eligible, planned_endpoint_ids: [ep.id], scope: 'due_endpoints' });
  const value = { id: collectionId(ep.id, '2026-10-12T03:01:00.000Z', []), endpoint: ep, checked_at: '2026-10-12T03:01:00.000Z', status: 'valid_empty', format: 'rss', reason: null, urls: [], traffic: 'production', cycle_id: 'limited', newest_content_at: '2026-10-12T02:00:00.000Z', date_kind: 'feed_item_date' };
  ledger.commit(value, [catalog.sources[0]], 'writer', at('2026-10-12'));
  assert.throws(() => ledger.finishCycle('limited', 'completed', '2026-10-12T03:02:00.000Z'), /INVALID_COLLECTION_CYCLE/);
  ledger.finishCycle('limited', 'partial', '2026-10-12T03:02:00.000Z', 'PLANNED_ENDPOINT_LIMIT');
  const snapshot = ledger.snapshot(catalog, '2026-10-13T00:00:00.000Z');
  assert.equal(snapshot.collection_cycles[0].status, 'partial'); assert.equal(snapshot.collections[0].newest_content_at, value.newest_content_at);
  assert.equal(new ActivityStore(snapshot).snapshot.collection_cycles[0].attempted_endpoints, 1);
  const archive = ledger.archive(catalog, join(dir, 'archives'), '2026-10-13T00:00:00.000Z');
  const restored = decodeHistory(readFileSync(join(dir, 'archives', archive.history.shards[0].file)), archive.history.shards[0]);
  assert.equal(restored[0].newest_content_at, value.newest_content_at);
});

test('content archives read old v1 shards and new v2 dated evidence without leaking URLs', () => {
  const old = { version: 1, dictionaries: { endpoint: [ep.id], source: [catalog.sources[0].id], country: ['US'], status: ['valid_empty'], format: ['rss'] }, rows: [[Date.parse(at('2026-10-12')), 0, 0, 0, 0, [], [[0, 0]], [[0, 0]]]] };
  const decode = bytes => decodeHistory(bytes, { month: '2026-10', file: '', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, records: 1 });
  const legacy = decode(gzipSync(JSON.stringify(old)))[0]; assert.equal(legacy.country_new.US, 0); assert.equal(legacy.newest_content_at, undefined);
  const modern = decode(encodeHistory([{ ...legacy, newest_content_at: '2026-10-12T02:00:00Z', date_kind: 'feed_item_date' }]))[0];
  assert.equal(modern.newest_content_at, '2026-10-12T02:00:00.000Z'); assert.equal(modern.date_kind, 'feed_item_date');
  assert.equal(JSON.stringify(modern).includes('https://'), false);
});

test('quality overview evaluates actual cadence only when retained evidence is sufficient', () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ endpoint_id: ep.id, checked_at: at(`2026-10-${String(i + 1).padStart(2, '0')}`), status: 'working_nonempty', format: 'rss', source_ids: [catalog.sources[0].id], countries: ['US'], source_new: { [catalog.sources[0].id]: 0 }, country_new: { US: 0 }, baseline_sources: [], uncertain_urls: 0, newest_content_at: `2026-10-${String(i + 1).padStart(2, '0')}T02:00:00.000Z`, date_kind: 'feed_item_date' }));
  const activity = new ActivityStore({ version: 1, lane: 'production', generated_at: at('2026-10-06'), tracking_start: at('2026-10-01'), available_since: '2026-10-01T00:00:00.000Z', registry_at: null, semantics: 'first discoveries', bindings: [], collections: records });
  const got = getCountryQualityOverview(catalog, activity, new HealthStore(), { country: 'US', date: '2026-10-05' }, Date.parse(at('2026-10-06'))).items[0];
  assert.equal(got.metrics.freshness.value, 100); assert.equal(got.metrics.freshness.denominator, 1); assert.equal(got.operational_anomaly.state, 'completion_not_recorded');
});

test('interrupted cycle spool replay remains possible without promoting the failed cycle to completed', t => {
  const { dir } = setup(t), ledger = new ActivityLedger(join(dir, 'activity.sqlite')); t.after(() => ledger.close());
  ledger.acquire('writer', at('2026-10-12'), 3600); ledger.syncRegistry(catalog, at('2026-10-12'));
  ledger.beginCycle(catalog, { id: 'interrupted', lane: 'production', at: at('2026-10-12'), eligible_endpoint_ids: [ep.id], planned_endpoint_ids: [ep.id], scope: 'explicit_endpoints' });
  ledger.finishCycle('interrupted', 'failed', '2026-10-12T03:02:00.000Z', 'COLLECTOR_RUN_FAILED');
  const pending = { id: collectionId(ep.id, '2026-10-12T03:01:00.000Z', []), endpoint: ep, checked_at: '2026-10-12T03:01:00.000Z', status: 'valid_empty', format: 'rss', reason: null, urls: [], traffic: 'production', cycle_id: 'interrupted' };
  assert.equal(ledger.commit(pending, [catalog.sources[0]], 'writer', at('2026-10-12')).replayed, false);
  assert.equal(ledger.snapshot(catalog, '2026-10-13T00:00:00.000Z').collection_cycles[0].status, 'failed');
  assert.equal(ledger.commit(pending, [catalog.sources[0]], 'writer', at('2026-10-12')).replayed, true);
});
