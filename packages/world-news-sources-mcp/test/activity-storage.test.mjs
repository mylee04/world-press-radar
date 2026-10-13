import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLedger, collectionId } from '../dist/activity-ledger.js';
import { normalizeRegistry } from '../dist/catalog.js';

const at = '2026-10-13T00:00:00.000Z';
const next = '2026-10-13T00:01:00.000Z';
const later = '2026-10-13T00:02:00.000Z';
const article = 'https://publisher.invalid/news/article-1';
const tables = ['urls', 'scope_urls', 'endpoint_urls', 'binding_urls', 'bindings', 'collections', 'endpoint_recovery', 'recovery_events', 'host_cooldowns', 'metadata'];
function snapshot(ledger) {
  return Object.fromEntries(tables.map(table => [table, ledger.db.prepare(`SELECT * FROM ${table}`).all()
    .map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}
function fixture(t, shared = false) {
  const url = name => `https://${shared ? 'shared' : name}.invalid/rss`;
  const catalog = normalizeRegistry({ countries: [
    { code: 'US', name: 'United States', feeds: [{ name: 'A', url: url('a') }, { name: 'B', url: url('b') }] },
    { code: 'CA', name: 'Canada', feeds: [{ name: 'C', url: url('c') }] }
  ] });
  const directory = mkdtempSync(join(tmpdir(), 'wns-storage-semantics-'));
  const ledger = new ActivityLedger(join(directory, 'activity.sqlite'));
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  ledger.acquire('writer', at, 3600); ledger.syncRegistry(catalog, at);
  const source = name => catalog.sources.find(value => value.name === name);
  const visit = (names, checked_at, urls, id) => {
    const sources = names.map(source), endpoint = sources[0].endpoints[0];
    const collection = { id: id ?? collectionId(endpoint.id, checked_at, urls), endpoint, checked_at,
      status: urls.length ? 'working_nonempty' : 'valid_empty', format: 'rss', reason: null,
      urls, traffic: 'production', http_status: 200 };
    return { collection, sources, result: ledger.commit(collection, sources, 'writer', at) };
  };
  return { ledger, source, visit };
}

test('same-time observations deduplicate countries without suppressing each source discovery', t => {
  const { ledger, source, visit } = fixture(t);
  for (const name of ['A', 'B', 'C']) visit([name], at, []);
  const a = visit(['A'], next, [article, `${article}?utm_source=duplicate`]);
  const b = visit(['B'], next, [article]);
  const c = visit(['C'], next, [article]);
  assert.equal(a.result.source_new[source('A').id], 1);
  assert.equal(b.result.source_new[source('B').id], 1);
  assert.equal(c.result.source_new[source('C').id], 1);
  assert.equal(a.result.country_new.US, 1);
  assert.equal(b.result.country_new.US, 0);
  assert.equal(c.result.country_new.CA, 1);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM urls').get().n, 1);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM endpoint_urls').get().n, 3);
  for (const name of ['A', 'B', 'C']) {
    const repeated = visit([name], later, [article]);
    assert.equal(repeated.result.source_new[source(name).id], 0);
    assert.equal(repeated.result.country_new[source(name).countryCode], 0);
  }
  for (const table of ['urls', 'scope_urls', 'endpoint_urls', 'binding_urls'])
    for (const row of ledger.db.prepare(`SELECT first_seen,last_seen FROM ${table}`).all()) {
      assert.equal(row.first_seen, next); assert.equal(row.last_seen, later);
    }
});

test('mixed initialization on a shared endpoint excludes the new US binding baseline but counts Canada', t => {
  const { ledger, source, visit } = fixture(t, true);
  visit(['A', 'C'], at, []);
  const observation = visit(['A', 'B', 'C'], next, [article]);
  assert.deepEqual(observation.result.baseline_sources, [source('B').id]);
  assert.equal(observation.result.source_new[source('A').id], 1);
  assert.equal(observation.result.source_new[source('B').id], 0);
  assert.equal(observation.result.source_new[source('C').id], 1);
  assert.equal(observation.result.country_new.US, 0);
  assert.equal(observation.result.country_new.CA, 1);
  const scope = (kind, id) => ledger.db.prepare('SELECT * FROM scope_urls WHERE scope_kind=? AND scope_id=? AND url=?').get(kind, id, article);
  assert.equal(scope('country', 'US').baseline, 1);
  assert.equal(scope('country', 'CA').baseline, 0);
  assert.equal(scope('source', source('A').id).baseline, 0);
  assert.equal(scope('source', source('B').id).baseline, 1);
  const repeated = visit(['A', 'B', 'C'], later, [article]);
  assert.deepEqual(Object.values(repeated.result.source_new), [0, 0, 0]);
  assert.deepEqual(Object.values(repeated.result.country_new), [0, 0]);
  assert.equal(scope('country', 'US').baseline, 1);
  assert.equal(scope('country', 'US').first_seen, next);
  assert.equal(scope('country', 'US').last_seen, later);
});

test('replay and failed collection leave all URL relationships, scopes and recovery records unchanged', t => {
  const { ledger, visit } = fixture(t, true);
  visit(['A', 'B', 'C'], at, []);
  const observation = visit(['A', 'B', 'C'], next, [article]);
  const before = snapshot(ledger);
  assert.equal(ledger.commit(observation.collection, observation.sources, 'writer', at).replayed, true);
  assert.deepEqual(snapshot(ledger), before);
  ledger.db.exec("CREATE TRIGGER storage_failure BEFORE INSERT ON collections WHEN NEW.id='failed-storage' BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;");
  assert.throws(() => visit(['A', 'B', 'C'], later, ['https://publisher.invalid/news/rollback'], 'failed-storage'), /storage failure/);
  assert.deepEqual(snapshot(ledger), before);
});
