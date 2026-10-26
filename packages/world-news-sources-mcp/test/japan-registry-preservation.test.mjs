import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRegistry } from '../dist/catalog.js';
import { ActivityLedger } from '../dist/activity-ledger.js';
import { searchCuratedSources } from '../dist/source-packs.js';

const raw = JSON.parse(readFileSync(new URL('../../../data/rss-atlas.json', import.meta.url), 'utf8'));
const catalog = normalizeRegistry(raw);
const NHK = 'src_a4257f72f8574d8a74f20140';
const ASAHI = 'src_ecbd91598fa0498c81261924';

test('Japan repairs retain historic publisher identities and the existing Asahi sitemap binding', () => {
  const nhk = catalog.sources.find(source => source.id === NHK);
  const asahi = catalog.sources.find(source => source.id === ASAHI);
  assert.equal(nhk.name, 'NHK News Headlines');
  assert.equal(nhk.language, 'ja');
  assert.equal(nhk.endpoints[0].url, 'https://news.web.nhk/n-data/conf/na/rss/cat0.xml');
  assert.equal(asahi.language, 'ja');
  assert.deepEqual(new Set(asahi.endpoints.map(endpoint => endpoint.url)), new Set([
    'http://rss.asahi.com/rss/asahi/newsheadlines.rdf', 'https://www.asahi.com/sitemap.xml',
  ]));
  assert.equal(catalog.sources.find(source => source.id === 'src_0720caa54d65ed03ca5ac188').category, 'society');
  assert.equal(catalog.sources.find(source => source.id === 'src_b25024633f66352c872e52fe').category, 'science');
  assert.ok(catalog.sources.filter(source => source.countryCode === 'JP' && source.name.startsWith('NHK')).every(source => source.language === 'ja'));
  assert.equal(searchCuratedSources(catalog, { country: 'JP', query: 'NHK', language: 'ja', include: 'all' }).items[0].id, NHK);
});

test('new feed bindings exclude their first list without rewriting previous discoveries or binding baselines', () => {
  const before = normalizeRegistry({ countries: [{ code: 'JP', name: 'Japan', feeds: [
    { name: 'NHK World (EN)', url: 'https://www3.nhk.or.jp/rss/news/cat0.xml' },
    { name: 'Asahi Shimbun', sitemapUrl: 'https://www.asahi.com/sitemap.xml' },
  ] }] });
  const selected = raw.countries.find(country => country.code === 'JP').feeds.filter(feed => [NHK, ASAHI].includes(feed.persistent_source_id));
  const after = normalizeRegistry({ countries: [{ code: 'JP', name: 'Japan', feeds: selected }] });
  const dir = mkdtempSync(join(tmpdir(), 'japan-baseline-'));
  const ledger = new ActivityLedger(join(dir, 'activity.sqlite'));
  const now = '2026-10-26T02:25:00.000Z';
  let sequence = 0;
  const visit = (source, endpoint, urls) => ledger.commit({ id: `japan-${++sequence}`, endpoint,
    checked_at: `2026-10-${sequence < 4 ? '24' : '26'}T00:0${sequence}:00.000Z`,
    status: 'working_nonempty', format: endpoint.type === 'rss' ? 'rss' : 'urlset', reason: null,
    urls, traffic: 'production' }, [source], 'test', now);
  try {
    ledger.acquire('test', now, 3600);
    ledger.syncRegistry(before, now);
    const oldNhk = before.sources.find(source => source.id === NHK);
    const oldAsahi = before.sources.find(source => source.id === ASAHI);
    visit(oldNhk, oldNhk.endpoints[0], ['https://news.web.nhk/newsweb/na/old']);
    assert.equal(visit(oldNhk, oldNhk.endpoints[0], ['https://news.web.nhk/newsweb/na/before-change']).country_new.JP, 1);
    visit(oldAsahi, oldAsahi.endpoints[0], ['https://www.asahi.com/articles/old.html']);
    const records = ledger.db.prepare('SELECT * FROM collections ORDER BY id').all();
    const baselines = ledger.db.prepare('SELECT source_id,endpoint_id,baseline_at FROM bindings ORDER BY source_id,endpoint_id').all();
    ledger.syncRegistry(after, now);
    assert.deepEqual(ledger.db.prepare('SELECT * FROM collections ORDER BY id').all(), records);
    for (const binding of baselines) {
      assert.equal(ledger.db.prepare('SELECT baseline_at FROM bindings WHERE source_id=? AND endpoint_id=?').get(binding.source_id, binding.endpoint_id).baseline_at, binding.baseline_at);
    }
    const nhk = after.sources.find(source => source.id === NHK);
    const asahi = after.sources.find(source => source.id === ASAHI);
    for (const [source, endpoint] of [[nhk, nhk.endpoints[0]], [asahi, asahi.endpoints.find(value => value.type === 'rss')]]) {
      assert.equal(ledger.db.prepare('SELECT baseline_at FROM bindings WHERE source_id=? AND endpoint_id=?').get(source.id, endpoint.id).baseline_at, null);
      const first = visit(source, endpoint, ['https://publisher.example/articles/previously-unseen-archive']);
      assert.equal(first.source_new[source.id], 0);
      assert.equal(first.country_new.JP, 0);
    }
    assert.equal(visit(nhk, nhk.endpoints[0], ['https://news.web.nhk/newsweb/na/after-baseline']).country_new.JP, 1);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
