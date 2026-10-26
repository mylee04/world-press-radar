import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { estimatePublisherInventory, estimatePublisherInventoryByCountry, estimateGlobalPublisherInventory } from '../dist/publisher-inventory.js';

const source = (name, urls, enabled = true, countryCode = 'US') => ({ name, enabled, countryCode,
  endpoints: urls.map((url, index) => ({ url, type: index === 0 ? 'rss' : 'sitemap' })) });

test('global brands are deduplicated across countries, not summed from country counts', () => {
  const sources = [source('BBC News', ['https://feeds.bbci.co.uk/news/rss.xml'], true, 'GB'),
    source('BBC World', ['https://www.bbc.com/news/feed'], true, 'US'),
    source('Independent Newsroom', ['https://independent.example/feed'], true, 'US')];
  const countries = estimatePublisherInventoryByCountry(sources);
  assert.equal(Object.values(countries).reduce((total, country) => total + country.unique_publishers, 0), 3);
  assert.equal(estimateGlobalPublisherInventory(sources).unique_publishers, 2);
  assert.equal(estimateGlobalPublisherInventory(null).unique_publishers, null);
  assert.equal(estimateGlobalPublisherInventory([]).unique_publishers, 0);
});

test('real NYT, Donga and NHK section/legacy endpoint registrations each count one brand', () => {
  const registry = JSON.parse(readFileSync(new URL('../../../data/rss-atlas.json', import.meta.url), 'utf8'));
  for (const [country, prefix, rows] of [['US', 'The New York Times', 6], ['KR', 'Donga Ilbo', 9], ['JP', 'NHK', 10]]) {
    const feeds = registry.countries.find(value => value.code === country).feeds
      .filter(feed => feed.name.startsWith(prefix) && feed.enabled !== false);
    assert.equal(feeds.length, rows);
    const result = estimatePublisherInventory(feeds.map(feed => source(feed.name, [feed.url, feed.sitemapUrl].filter(Boolean), true, country)));
    assert.equal(result.unique_publishers, 1);
    assert.equal(result.publisher_count_state, 'estimated_from_registry_identity');
  }
});

test('NHK current brand-domain headlines and legacy feeds remain one publisher without merging unrelated namesakes', () => {
  const nhk = [source('NHK News Headlines', ['https://news.web.nhk/n-data/conf/na/rss/cat0.xml'], true, 'JP'),
    source('NHK News Web (Japanese legacy category 1)', ['https://www3.nhk.or.jp/rss/news/cat1.xml'], true, 'JP')];
  assert.equal(estimatePublisherInventory(nhk).unique_publishers, 1);
  assert.equal(estimatePublisherInventory([...nhk, source('NHK unrelated namesake', ['https://other.example/feed'], true, 'JP')]).unique_publishers, 2);
});

test('Yahoo and Feedburner hosting do not turn separate newspapers into one publisher', () => {
  const yahoo = [source('Kyodo News', ['https://news.yahoo.co.jp/rss/media/kyodonews/all.xml']),
    source('Nikkan Kogyo', ['https://news.yahoo.co.jp/rss/media/nkogyo/all.xml']),
    source('Kyodo News - Business', ['https://news.yahoo.co.jp/rss/media/kyodonews/business.xml'])];
  assert.equal(estimatePublisherInventory(yahoo).unique_publishers, 2);
  const hosted = [source('Breitbart', ['https://feeds.feedburner.com/breitbart']),
    source('Vanity Fair', ['https://feeds.feedburner.com/vanityfair']),
    source('Vanity Fair - Politics', ['https://feeds.feedburner.com/vanityfair-politics'])];
  assert.equal(estimatePublisherInventory(hosted).unique_publishers, 2);
  assert.equal(estimatePublisherInventory(hosted).publisher_identity_basis.name_fallback_groups, 2);
  assert.match(estimatePublisherInventory(hosted).publisher_count_semantics, /사이트 도메인 없이/);
});

test('different newspapers of one corporate group remain separate, including shared Dow Jones feeds', () => {
  const independentBrands = [source('The Sydney Morning Herald', ['https://www.smh.com.au/rss.xml']),
    source('The Age', ['https://www.theage.com.au/rss.xml']),
    source('Hindustan Times', ['https://www.hindustantimes.com/rss.xml']),
    source('Livemint', ['https://www.livemint.com/rss.xml']),
    source('Wall Street Journal', ['https://feeds.a.dj.com/rss/RSSWorldNews.xml']),
    source("Barron's", ['https://feeds.a.dj.com/rss/RSSBarrons.xml'])];
  assert.equal(estimatePublisherInventory(independentBrands).unique_publishers, 6);
});

test('one source binds feed and sitemap domains; disabled rows cannot bridge active brands', () => {
  const active = [source('Example - RSS', ['https://feeds.publisher.com/rss']),
    source('Example - Combined', ['https://feeds.publisher.com/rss', 'https://publisher-news.com/sitemap.xml']),
    source('Example - Sitemap', ['https://publisher-news.com/sitemap-news.xml'])];
  assert.equal(estimatePublisherInventory(active).unique_publishers, 1);
  assert.equal(estimatePublisherInventory([...active,
    source('Other', ['https://other.com/rss']),
    source('Inactive bridge', ['https://publisher-news.com/a', 'https://other.com/a'], false)]).unique_publishers, 2);
});

test('private host domains stay separate and explicit BBC aliases cross its two domains', () => {
  const values = [source('BBC News', ['https://feeds.bbci.co.uk/news/rss.xml']),
    source('BBC News - World', ['https://www.bbc.com/news/rss.xml']),
    source('Independent One', ['https://one.substack.com/feed']),
    source('Independent Two', ['https://two.substack.com/feed'])];
  assert.equal(estimatePublisherInventory(values).unique_publishers, 3);
  assert.equal(estimatePublisherInventory([
    source('BBC News', ['https://www.bbc.co.uk/rss.xml']),
    source('BBC News - World', ['https://www.bbc.com/rss.xml']),
  ]).unique_publishers, 1);
});

test('missing or invalid URLs use disclosed registration names, never invalid hostname fragments', () => {
  const values = [source('Alpha - Politics', ['not a url']), source('Alpha - Science', []),
    source('Beta', ['file:///beta.xml']), source('Gamma', ['https://user:password@alpha.com/rss'])];
  const result = estimatePublisherInventory(values);
  assert.equal(result.unique_publishers, 3);
  assert.equal(result.publisher_identity_basis.name_fallback_groups, 3);
  assert.match(result.publisher_count_semantics, /등록명/);
  assert.equal(estimatePublisherInventory([source('', [])]).unique_publishers, null);
});

test('absent complete listing stays unknown while known empty/inactive listing is zero', () => {
  assert.equal(estimatePublisherInventory(null).unique_publishers, null);
  assert.equal(estimatePublisherInventory(undefined).unique_publishers, null);
  assert.equal(estimatePublisherInventory([]).unique_publishers, 0);
  assert.equal(estimatePublisherInventory([source('Inactive', ['https://disabled.com/rss'], false)]).unique_publishers, 0);
});

test('counts and disclosure are stable under row/endpoint order and keep countries independent', () => {
  const values = [source('One', ['https://one.com/rss', 'https://mirror.net/sitemap']),
    source('One - Mirror', ['https://mirror.net/another.xml']),
    source('Hosted', ['https://rsshub.app/one']), source('Missing', []),
    source('One', ['https://one.com/rss'], true, 'JP')];
  const reversed = values.toReversed().map(value => ({ ...value, endpoints: value.endpoints.toReversed() }));
  assert.deepEqual(estimatePublisherInventory(values), estimatePublisherInventory(reversed));
  const countries = estimatePublisherInventoryByCountry(values);
  assert.deepEqual(Object.keys(countries), ['JP', 'US']);
  assert.equal(countries.JP.unique_publishers, 1);
  assert.equal(countries.US.unique_publishers, 3);
});
