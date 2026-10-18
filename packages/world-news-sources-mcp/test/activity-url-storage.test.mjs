import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLedger, collectionId } from '../dist/activity-ledger.js';
import { LEGACY_URL_SCHEMA, urlStorageVersion, migrateActivityUrlStorage } from '../dist/activity-url-storage.js';
import { normalizeRegistry } from '../dist/catalog.js';

const at = '2026-10-13T00:00:00.000Z';
const leaseAt = '2026-10-13T23:00:00.000Z';
const exportAt = '2026-10-14T00:00:00.000Z';
const old = 'https://publisher.invalid/News/Old?articleId=17&edition=US';
const archive = 'https://publisher.invalid/news/archive';
const fresh = 'https://publisher.invalid/news/fresh';
const urlTables = ['urls', 'scope_urls', 'endpoint_urls', 'binding_urls'];
const preservedTables = ['metadata', 'registry', 'bindings', 'collections', 'writer_lock', 'request_budget', 'collection_cycles', 'endpoint_recovery', 'recovery_events', 'host_cooldowns'];
const catalog = normalizeRegistry({ countries: [
  { code: 'US', name: 'United States', feeds: [
    { name: 'A', url: 'https://shared.invalid/rss', sitemapUrl: 'https://a.invalid/sitemap.xml' },
    { name: 'B', url: 'https://shared.invalid/rss' },
    { name: 'D', url: 'https://d.invalid/rss' }
  ] },
  { code: 'CA', name: 'Canada', feeds: [{ name: 'C', url: 'https://shared.invalid/rss' }] }
] });
const source = name => catalog.sources.find(row => row.name === name);
const sorted = rows => rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const rawRows = (db, tables) => Object.fromEntries(tables.map(table => [table, sorted(db.prepare(`SELECT * FROM ${table}`).all())]));

function logicalRows(db) {
  const compact = urlStorageVersion(db) === 2;
  const relationship = (table, fields) => compact
    ? db.prepare(`SELECT ${fields.map(field => `r.${field}`).join(',')},u.url,r.first_seen,r.last_seen${table === 'scope_urls' ? ',r.baseline,r.kind' : ''} FROM ${table} r JOIN urls u ON u.id=r.url_id`).all()
    : db.prepare(`SELECT ${fields.join(',')},url,first_seen,last_seen${table === 'scope_urls' ? ',baseline,kind' : ''} FROM ${table}`).all();
  return {
    urls: sorted(db.prepare('SELECT url,normalization_version,kind,first_seen,last_seen FROM urls').all()),
    scope_urls: sorted(relationship('scope_urls', ['scope_kind', 'scope_id'])),
    endpoint_urls: sorted(relationship('endpoint_urls', ['endpoint_id'])),
    binding_urls: sorted(relationship('binding_urls', ['source_id', 'endpoint_id', 'country']))
  };
}

function database(t, legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'wns-url-storage-'));
  const path = join(directory, 'activity.sqlite');
  new ActivityLedger(path).close();
  if (legacy) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys=ON; DROP TABLE scope_urls; DROP TABLE endpoint_urls; DROP TABLE binding_urls; DROP TABLE urls;');
    db.exec(LEGACY_URL_SCHEMA);
    db.close();
  }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path;
}

function seed(path) {
  const ledger = new ActivityLedger(path);
  ledger.acquire('seed', leaseAt, 3600);
  ledger.syncRegistry(catalog, at);
  const collections = [];
  function visit(names, minute, urls, endpointIndex = 0, status = 'working_nonempty') {
    const sources = names.map(source), endpoint = sources[0].endpoints[endpointIndex];
    const checked_at = new Date(Date.parse(at) + minute * 60000).toISOString();
    const value = { id: collectionId(endpoint.id, checked_at, urls), endpoint, checked_at, status,
      format: endpoint.type === 'rss' ? 'rss' : 'urlset', reason: null, urls, traffic: 'production', http_status: status === 'timeout' ? null : 200 };
    const result = ledger.commit(value, sources, 'seed', leaseAt);
    collections.push({ value, sources });
    return result;
  }
  visit(['A', 'C'], 0, [], 0, 'valid_empty');
  const mixed = visit(['A', 'B', 'C'], 1, [old]);
  assert.equal(mixed.country_new.US, 0);
  assert.equal(mixed.country_new.CA, 1);
  assert.deepEqual(mixed.baseline_sources, [source('B').id]);
  visit(['A'], 2, [archive], 1);
  visit(['D'], 3, [], 0, 'valid_empty');
  visit(['D'], 4, [old]);
  visit(['C'], 5, [archive]);
  visit(['A'], 6, [], 0, 'timeout');
  ledger.db.prepare('UPDATE urls SET normalization_version=? WHERE url=?').run('legacy-normalization-0', old);
  ledger.db.prepare('INSERT INTO metadata VALUES(?,?)').run('opaque_legacy_metadata', '  preserved\n한글: café\t  ');
  const first = collections[0].value.id;
  const details = JSON.parse(String(ledger.db.prepare('SELECT details FROM collections WHERE id=?').get(first).details));
  ledger.db.prepare('UPDATE collections SET details=? WHERE id=?').run(`\n${JSON.stringify({ ...details, legacy_annotation: 'keep exact whitespace' }, null, 2)}\n`, first);
  ledger.reserveRequest(at, 12000);
  ledger.release('seed');
  ledger.close();
  return collections;
}

function assertCompact(db) {
  assert.equal(urlStorageVersion(db), 2);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  for (const table of urlTables.slice(1)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    assert.ok(columns.includes('url_id'));
    assert.ok(!columns.includes('url'));
    assert.match(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql, /WITHOUT\s+ROWID/i);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

test('legacy conversion preserves every logical URL field and untouched history, while fresh databases use the same compact layout', t => {
  const legacy = database(t, true), compact = database(t);
  seed(legacy); seed(compact);
  const db = new DatabaseSync(legacy); db.exec('PRAGMA foreign_keys=ON');
  const current = new DatabaseSync(compact); current.exec('PRAGMA foreign_keys=ON');
  t.after(() => { db.close(); current.close(); });
  assert.equal(urlStorageVersion(db), 1);
  assertCompact(current);
  const before = logicalRows(db), untouched = rawRows(db, preservedTables);
  assert.deepEqual(logicalRows(current), before);
  const migrated = migrateActivityUrlStorage(db);
  assert.deepEqual(migrated, { from: 1, to: 2, migrated: true,
    rows: Object.fromEntries(urlTables.map(table => [table, before[table].length])) });
  assertCompact(db);
  assert.deepEqual(logicalRows(db), before);
  assert.deepEqual(rawRows(db, preservedTables), untouched);
  assert.deepEqual(migrateActivityUrlStorage(db), { ...migrated, from: 2, migrated: false });
  assert.deepEqual(logicalRows(db), logicalRows(current));
});

test('reopening and continuing migrated, legacy and fresh ledgers yields identical baseline, replay and NEW results', t => {
  const paths = [database(t, true), database(t, true), database(t)];
  const collections = paths.map(seed);
  const migrate = new DatabaseSync(paths[0]); migrate.exec('PRAGMA foreign_keys=ON');
  migrateActivityUrlStorage(migrate); migrate.close();
  const outcomes = paths.map((path, i) => {
    const ledger = new ActivityLedger(path);
    try {
      assert.equal(urlStorageVersion(ledger.db), i === 1 ? 1 : 2);
      ledger.acquire('continue', leaseAt, 3600);
      const original = collections[i][1];
      const replay = ledger.commit(original.value, original.sources, 'continue', leaseAt);
      assert.equal(replay.replayed, true);
      const results = [];
      for (const [minute, names, urls] of [[7, ['A', 'B', 'C'], [old, archive, fresh]], [8, ['D'], [fresh]], [9, ['A', 'B', 'C'], [old, archive, fresh]]]) {
        const sources = names.map(source), endpoint = sources[0].endpoints[0];
        const checked_at = new Date(Date.parse(at) + minute * 60000).toISOString();
        const value = { id: collectionId(endpoint.id, checked_at, urls), endpoint, checked_at,
          status: 'working_nonempty', format: 'rss', reason: null, urls, traffic: 'production', http_status: 200 };
        results.push(ledger.commit(value, sources, 'continue', leaseAt));
      }
      assert.equal(results[0].country_new.US, 1);
      assert.equal(results[0].country_new.CA, 1);
      assert.equal(results[0].source_new[source('A').id], 1);
      assert.equal(results[1].source_new[source('D').id], 1);
      assert.equal(results[1].country_new.US, 0);
      assert.ok(Object.values(results[2].source_new).every(value => value === 0));
      assert.ok(Object.values(results[2].country_new).every(value => value === 0));
      ledger.release('continue');
      return { results, logical: logicalRows(ledger.db), history: rawRows(ledger.db, preservedTables), snapshot: ledger.snapshot(catalog, exportAt) };
    } finally { ledger.close(); }
  });
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.deepEqual(outcomes[0], outcomes[2]);
});

test('migration refuses a collector lease without changing the legacy schema or rows', t => {
  const path = database(t, true); seed(path);
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); t.after(() => db.close());
  db.prepare('INSERT INTO writer_lock VALUES(1,?,?)').run('active-collector', '2099-01-01T00:00:00.000Z');
  const before = rawRows(db, [...urlTables, ...preservedTables]);
  const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
  assert.throws(() => migrateActivityUrlStorage(db), /URL_MIGRATION_WRITER_ACTIVE/);
  assert.equal(urlStorageVersion(db), 1);
  assert.deepEqual(rawRows(db, [...urlTables, ...preservedTables]), before);
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all(), schema);
});

test('an orphan relationship aborts conversion and preserves the original schema and all original rows', t => {
  const path = database(t, true); seed(path);
  const db = new DatabaseSync(path); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare('INSERT INTO scope_urls VALUES(?,?,?,?,?,?,?)').run('country', 'US', 'https://missing.invalid/orphan', at, at, 1, 'candidate');
  db.exec('PRAGMA foreign_keys=ON');
  const before = rawRows(db, [...urlTables, ...preservedTables]);
  const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
  assert.throws(() => migrateActivityUrlStorage(db), /URL_MIGRATION_ROW_MISMATCH:scope_urls/);
  assert.equal(urlStorageVersion(db), 1);
  assert.deepEqual(rawRows(db, [...urlTables, ...preservedTables]), before);
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all(), schema);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('mixed URL schemas fail closed instead of silently creating a new baseline', t => {
  const path = database(t, true); seed(path);
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); t.after(() => db.close());
  db.exec('ALTER TABLE scope_urls RENAME COLUMN url TO broken_url');
  const before = rawRows(db, [...urlTables, ...preservedTables]);
  assert.throws(() => urlStorageVersion(db), /UNKNOWN_URL_STORAGE_SCHEMA/);
  assert.throws(() => migrateActivityUrlStorage(db));
  assert.deepEqual(rawRows(db, [...urlTables, ...preservedTables]), before);
});

test('repeated long URLs occupy less disk after lossless migration and explicit compaction', t => {
  const path = database(t, true);
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON'); t.after(() => db.close());
  const url = db.prepare('INSERT INTO urls VALUES(?,?,?,?,?)');
  const scope = db.prepare('INSERT INTO scope_urls VALUES(?,?,?,?,?,?,?)');
  const endpoint = db.prepare('INSERT INTO endpoint_urls VALUES(?,?,?,?)');
  const binding = db.prepare('INSERT INTO binding_urls VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 600; i++) {
    const value = `https://publisher.invalid/long/news/${i}/${'retained-path-segment-'.repeat(12)}?articleId=${i}&edition=US`;
    url.run(value, 'legacy-normalization-0', 'candidate', at, at);
    for (const country of ['US', 'CA']) {
      scope.run('country', country, value, at, at, i % 2, 'candidate');
      scope.run('source', `source-${country}`, value, at, at, i % 2, 'candidate');
      endpoint.run(`endpoint-${country}`, value, at, at);
      binding.run(`source-${country}`, `endpoint-${country}`, country, value, at, at);
    }
  }
  db.exec('COMMIT; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
  const beforeBytes = statSync(path).size, before = logicalRows(db);
  migrateActivityUrlStorage(db);
  db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
  assert.deepEqual(logicalRows(db), before);
  assertCompact(db);
  assert.ok(statSync(path).size < beforeBytes, 'The bounded repeated-URL fixture should shrink after compaction');
});
