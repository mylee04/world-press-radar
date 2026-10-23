import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import collector, { aggregateStatements, preferenceStatements, validateAggregate, validatePreference, actorCutoff, PRUNE_ACTORS } from '../metrics/worker.mjs';

const day = new Date('2026-10-23T12:00:00Z');
const key = 'a'.repeat(64), other = 'b'.repeat(64);
const secret = 'local-test-secret-not-for-production-12345';
function database() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../metrics/schema.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql) {
      return { bind(...args) { return { sql, args, async run() { return raw.prepare(sql).run(...args); } }; } };
    },
    async batch(statements) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(({sql,args}) => raw.prepare(sql).run(...args));
        raw.exec('COMMIT'); return results;
      } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  return { raw, db };
}
const event = (extra = {}) => ({tool: 'search_sources', traffic: 'unclassified', outcome: 'success', duration_ms: 50,
  product: {channel: 'mcp', identity: 'provided', actor_key: key, search: 'nonempty'}, ...extra});
const request = (path, body, auth = secret) => new Request(`https://metrics.example${path}`, {method: 'POST',
  headers: {'content-type': 'application/json', authorization: `Bearer ${auth}`}, body: JSON.stringify(body)});

// All tests use local SQLite and a mock D1 batch adapter. No external requests are made.
test('additive tables preserve old counters and distinguish all newly recognized tools', async () => {
  const {raw, db} = database();
  try {
    for (const tool of ['search_sources', 'get_source_article_activity', 'get_country_collection_quality', 'get_source_collection_quality', 'list_source_packs', 'get_source_pack', 'export_source_pack', 'set_usage_analytics']) {
      const value = {tool, traffic: 'inspection', outcome: 'success', duration_ms: 20};
      await db.batch(aggregateStatements(db, value, day));
    }
    assert.equal(raw.prepare('SELECT SUM(calls) n FROM daily_tool_usage').get().n, 1);
    assert.equal(raw.prepare('SELECT SUM(calls) n FROM daily_activity_tool_usage').get().n, 1);
    assert.equal(raw.prepare('SELECT SUM(calls) n FROM daily_extended_tool_usage').get().n, 6);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM daily_tool_usage WHERE tool='unknown'").get().n, 0);
    assert.deepEqual(raw.prepare('PRAGMA table_info(usage_actor_days)').all().map(row => row.name), ['day', 'actor_key']);
  } finally { raw.close(); }
});

test('strict projection rejects raw identities, arbitrary fields and ineligible identities', () => {
  for (const value of [
    event({query: 'private search'}), event({product: {...event().product, subject: 'private user'}}),
    event({product: {...event().product, actor_key: 'raw user id'}}),
    event({traffic: 'inspection'}), event({outcome: 'error'}), event({tool: 'unknown'}),
    event({tool: 'set_usage_analytics', product: {channel: 'mcp', identity: 'provided', actor_key: key}}),
    event({product: {channel: 'mcp', identity: 'missing', actor_key: key}}),
    event({tool: 'get_source'}),
  ]) assert.throws(() => validateAggregate(value));
  assert.throws(() => validatePreference({actor_key: key, enabled: false, subject: 'private user'}));
  assert.throws(() => validatePreference({actor_key: key, enabled: 'false'}));
  assert.doesNotThrow(() => validateAggregate(event()));
});

test('known zero results, empty pagination pages and unknown results have distinct counters', async () => {
  const {raw, db} = database();
  try {
    for (const search of ['nonempty', 'zero_matches', 'empty_page', 'unknown']) {
      await db.batch(aggregateStatements(db, event({product: {channel: 'mcp', identity: 'missing', search}}), day));
    }
    await db.batch(aggregateStatements(db, event({outcome: 'error', product: {channel: 'mcp', identity: 'excluded'}}), day));
    const row = raw.prepare('SELECT * FROM daily_product_usage').get();
    assert.equal(row.events, 5); assert.equal(row.search_nonempty, 1); assert.equal(row.search_zero_matches, 1);
    assert.equal(row.search_empty_page, 1); assert.equal(row.search_unknown, 1);
    assert.equal(row.identity_missing, 4); assert.equal(row.identity_excluded, 1);
    assert.equal(row.search_nonempty + row.search_zero_matches + row.search_empty_page, 3);
    assert.equal(raw.prepare('SELECT errors FROM daily_tool_usage').get().errors, 1);
  } finally { raw.close(); }
});

test('web exports are separate from MCP totals and nonempty versus empty exports', async () => {
  const {raw, db} = database();
  try {
    for (const [channel, kind] of [['mcp', 'nonempty'], ['web_export', 'empty'], ['web_export', 'unknown']]) {
      await db.batch(aggregateStatements(db, event({tool: 'export_source_pack', product: {channel, identity: 'excluded', export: kind}}), day));
    }
    await db.batch(aggregateStatements(db, event({tool: 'export_source_pack', outcome: 'error', product: {channel: 'web_export', identity: 'excluded'}}), day));
    assert.throws(() => validateAggregate(event({tool: 'export_source_pack', outcome: 'error', product: {channel: 'web_export', identity: 'excluded', export: 'unknown'}})));
    assert.throws(() => validateAggregate(event({tool: 'export_source_pack', product: {channel: 'web_export', identity: 'missing', export: 'nonempty'}})));
    const rows = raw.prepare('SELECT * FROM daily_product_usage ORDER BY channel').all();
    assert.equal(rows[0].export_nonempty, 1); assert.equal(rows[1].export_empty, 1); assert.equal(rows[1].export_unknown, 1); assert.equal(rows[1].events, 3);
    assert.equal(raw.prepare('SELECT SUM(calls) n FROM daily_extended_tool_usage').get().n, 1);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_actor_days').get().n, 0);
  } finally { raw.close(); }
});

test('repeat tracking defaults off, opting out erases presence and opt-in does not reconstruct it', async () => {
  const {raw, db} = database();
  try {
    await db.batch(aggregateStatements(db, event(), day));
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_actor_days').get().n, 0);
    assert.equal(raw.prepare('SELECT identity_disabled n FROM daily_product_usage').get().n, 1);
    await db.batch(aggregateStatements(db, event(), day, true));
    await db.batch(aggregateStatements(db, event(), day, true));
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_actor_days').get().n, 1);
    await db.batch(preferenceStatements(db, {actor_key: key, enabled: false}));
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_actor_days').get().n, 0);
    await db.batch(aggregateStatements(db, event(), day, true));
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_actor_days').get().n, 0);
    assert.equal(raw.prepare('SELECT identity_suppressed n FROM daily_product_usage').get().n, 1);
    await db.batch(preferenceStatements(db, {actor_key: key, enabled: true}));
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_actor_days').get().n, 0);
    await db.batch(aggregateStatements(db, event(), day, true));
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_actor_days').get().n, 1);
    assert.equal(raw.prepare('SELECT SUM(calls) n FROM daily_tool_usage').get().n, 5);
  } finally { raw.close(); }
});

test('presence expires after 30 UTC days while opt-out remains and returns require a previous day', async () => {
  const {raw, db} = database();
  try {
    assert.equal(actorCutoff(day), '2026-09-24');
    for (const [date, actor] of [['2026-09-23', key], ['2026-09-24', key], ['2026-10-16', key], ['2026-10-23', key], ['2026-10-15', other], ['2026-10-23', other]]) {
      raw.prepare('INSERT INTO usage_actor_days VALUES (?,?)').run(date, actor);
    }
    raw.prepare('INSERT INTO usage_opt_out VALUES (?)').run('c'.repeat(64));
    await db.prepare(PRUNE_ACTORS).bind(actorCutoff(day)).run();
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM usage_actor_days WHERE day='2026-09-23'").get().n, 0);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM usage_actor_days WHERE day='2026-09-24'").get().n, 1);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_opt_out').get().n, 1);
    const report = readFileSync(new URL('../metrics/report.sql', import.meta.url), 'utf8');
    const query = report.slice(report.indexOf('SELECT a.day')).replaceAll("date('now','-6 days')", "date('2026-10-23','-6 days')");
    const rows = raw.prepare(query).all();
    assert.equal(rows[0].day, '2026-10-23'); assert.equal(rows[0].observed_keys, 2);
    assert.equal(rows[0].returning_keys_prior_7_days, 1);
  } finally { raw.close(); }
});

test('D1 batch rollback prevents partial tool, product and presence writes', async () => {
  const {raw, db} = database();
  try {
    const statements = aggregateStatements(db, event(), day, true);
    statements.splice(2, 0, db.prepare('INSERT INTO deliberately_missing_table VALUES (1)').bind());
    await assert.rejects(db.batch(statements));
    for (const table of ['daily_tool_usage', 'daily_product_usage', 'usage_actor_days']) {
      assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
    }
  } finally { raw.close(); }
});

test('private authenticated preference works with tracking off and HTTP never returns actor keys', async () => {
  const {raw, db} = database();
  try {
    const env = {METRICS_WRITE_SECRET: secret, DB: db};
    assert.equal((await collector.fetch(request('/v1/preference', {actor_key: key, enabled: false}, 'wrong'), env)).status, 401);
    assert.equal((await collector.fetch(new Request('https://metrics.example/v1/preference'), env)).status, 405);
    assert.equal((await collector.fetch(new Request('https://metrics.example/report'), env)).status, 404);
    const response = await collector.fetch(request('/v1/preference', {actor_key: key, enabled: false}), env);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), {enabled: false});
    assert.equal((await collector.fetch(request('/v1/aggregate', event()), env)).status, 204);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM usage_actor_days').get().n, 0);
    assert.equal(raw.prepare('SELECT identity_disabled n FROM daily_product_usage').get().n, 1);
    assert.equal((await collector.fetch(request('/v1/aggregate', {...event(), rawSubject: 'sensitive'}), env)).status, 400);
  } finally { raw.close(); }
});
