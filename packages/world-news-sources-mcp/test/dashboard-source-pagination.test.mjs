import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dashboardSection, i18nHelpers, i18nBindings } from './dashboard-test-runtime.mjs';

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');

// Exercise the shipped renderer and event handlers with a small DOM transport fixture.
// The fixture implements DOM operations only; all filtering, paging and caching run in app.js.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.isConnected = true;
    this.ownText = '';
  }
  get textContent() { return this.ownText + this.children.map(child => child.textContent ?? child.data ?? '').join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
  append(...children) {
    for (const child of children) {
      if (typeof child === 'object') child.isConnected = this.isConnected;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    const detach = child => {
      if (!child || typeof child !== 'object') return;
      child.isConnected = false;
      child.children?.forEach(detach);
    };
    this.children.forEach(detach);
    this.children = [];
    this.ownText = '';
    this.append(...children);
  }
  get lastChild() { return this.children.at(-1); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  async dispatch(type) {
    if (type === 'click' && this.disabled) return;
    for (const listener of this.listeners.get(type) ?? []) await listener({ target: this, preventDefault() {} });
  }
  scrollIntoView() {}
  querySelector(tag) {
    for (const child of this.children) {
      if (child?.tagName?.toLowerCase() === tag) return child;
      const match = child?.querySelector?.(tag);
      if (match) return match;
    }
    return null;
  }
}

function source(index) {
  const id = String(index).padStart(3, '0');
  return Object.freeze({ id: `us-${id}`, name: `Publisher ${id}`, active_registration_count: 1,
    endpoints: Object.freeze([{ type: 'rss', url: `https://publisher.example/${id}/feed` }]) });
}
function countryData(count = 237) {
  return { country: { country: 'US', inventory: { active_source_registrations: count } },
    sources: Array.from({ length: count }, (_, index) => source(index)).reverse() };
}

function fixture(data = countryData(), countryTransport) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const element = new Element();
      const tag = html.match(new RegExp(`<([\\w-]+)\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
      for (const [, name, value] of tag?.matchAll(/([\w-]+)="([^"]*)"/g) ?? []) element.setAttribute(name, value);
      element.hidden = Boolean(tag && /\bhidden(?:\s|>)/.test(tag));
      elements.set(id, element);
    }
    return elements.get(id);
  };
  for (const id of ['source-page-size', 'source-page-prev', 'source-page-next', 'source-page-status', 'source-page-range', 'source-pagination', 'source-search', 'source-list', 'source-count', 'language-select', 'date-input']) get(id);
  get('date-input').value = '2026-10-14';
  const requests = [], renderedDetails = [];
  let countryRenders = 0;
  const document = {
    documentElement: { lang: 'en' }, getElementById: get, createElement: tag => new Element(tag),
    createTextNode: data => ({ data, isConnected: true }),
    querySelectorAll: selector => {
      const attrs = [...selector.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
      return [...elements.values()].filter(element => attrs.every(attr => element.getAttribute(attr) !== null));
    }
  };
  const context = vm.createContext({ document, queueMicrotask, URLSearchParams,
    window: { localStorage: { setItem() {} }, matchMedia: () => ({ matches: true }) },
    valueText: value => typeof value === 'number' ? String(value) : '—',
    countryCode: country => country.country,
    countryName: country => country.country === 'US' ? 'United States' : 'South Korea',
    inventory: country => country.inventory ?? country,
    timeText: value => value ?? '—', appendMeta() {}, showError() {},
    renderCountries: () => { countryRenders++; },
    utcToday: () => get('date-input').value,
    dateQuery: extra => new URLSearchParams({ date: get('date-input').value, ...extra }).toString(),
    api: async route => {
      requests.push(route);
      if (route.startsWith('country?')) return countryTransport ? countryTransport(route) : countryData(3);
      if (route.startsWith('source?')) return { article_activity: { daily: { new_unique_candidate_urls: 0 } } };
      throw new Error(`Unexpected request: ${route}`);
    },
    renderSourceDetail: (content, detail, item) => { renderedDetails.push({ content, detail, item }); content.replaceChildren(new Element('article')); },
    badge: () => new Element('span'),
    errorMessage: error => error.message,
    fetch: () => { throw new Error('Pagination must not fetch production data'); }
  });
  const code = i18nHelpers + '\n' + i18nBindings + '\n'
    + dashboardSection('const state =', 'const numberFormats =') + '\n'
    + 'const $ = id => document.getElementById(id);\n'
    + dashboardSection('function node(', 'function valueText(') + '\n'
    + dashboardSection('async function selectCountry(', 'function aggregateValue(') + '\n'
    + dashboardSection("$('source-search').addEventListener", "$('investigate-selected').addEventListener")
    + '\nthis.ui={state,renderSources,selectCountry,applyLanguage};';
  vm.runInContext(code, context);
  const { ui } = context;
  ui.state.selected = 'US';
  ui.state.countries = [{ country: 'US' }, { country: 'KR' }];
  ui.state.countryData = data;
  ui.renderSources();
  return { ui, get, requests, renderedDetails, countryRenders: () => countryRenders,
    cards: () => get('source-list').children.filter(child => child.className === 'source-card'),
    names: () => get('source-list').children.filter(child => child.className === 'source-card').map(card => card.querySelector('h3').textContent) };
}

test('237 registrations start with ten sorted cards and offer only 10, 20 and 50 per page', () => {
  const select = html.match(/<select\b[^>]*id="source-page-size"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select, 'the shipped per-page selector must be present');
  assert.deepEqual([...select.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match => match[1]), ['10', '20', '50']);
  const view = fixture();
  assert.equal(view.cards().length, 10);
  assert.deepEqual(view.names(), Array.from({ length: 10 }, (_, index) => `Publisher ${String(index).padStart(3, '0')}`));
  assert.equal(view.get('source-page-size').value, '10');
  assert.equal(view.get('source-count').textContent, '237 / 237');
  assert.equal(view.get('source-page-status').textContent, 'Page 1 of 24');
  assert.equal(view.get('source-page-range').textContent, 'Showing 1–10 of 237');
  assert.equal(view.get('source-page-prev').disabled, true);
  assert.equal(view.get('source-page-next').disabled, false);
  assert.deepEqual(view.requests, []);
});

test('next and previous traverse every registration once and stop at the last partial page', async () => {
  const view = fixture(), visited = [...view.names()];
  await view.get('source-page-prev').dispatch('click');
  assert.equal(view.get('source-page-status').textContent, 'Page 1 of 24');
  for (let page = 2; page <= 24; page++) {
    await view.get('source-page-next').dispatch('click');
    visited.push(...view.names());
    assert.equal(view.get('source-page-status').textContent, `Page ${page} of 24`);
  }
  assert.equal(view.cards().length, 7);
  assert.equal(view.get('source-page-range').textContent, 'Showing 231–237 of 237');
  assert.equal(view.get('source-page-next').disabled, true);
  assert.equal(view.get('source-page-prev').disabled, false);
  assert.equal(new Set(visited).size, 237);
  assert.equal(visited.length, 237);
  await view.get('source-page-next').dispatch('click');
  assert.equal(view.get('source-page-status').textContent, 'Page 24 of 24');
  await view.get('source-page-prev').dispatch('click');
  assert.equal(view.get('source-page-status').textContent, 'Page 23 of 24');
  assert.equal(view.cards().length, 10);
  assert.deepEqual(view.requests, []);
});

test('changing page size resets to the first page without changing the saved registration totals', async () => {
  const data = countryData(), before = JSON.stringify(data), view = fixture(data);
  await view.get('source-page-next').dispatch('click');
  for (const [size, pages] of [[20, 12], [50, 5], [10, 24]]) {
    view.get('source-page-size').value = String(size);
    await view.get('source-page-size').dispatch('change');
    assert.equal(view.cards().length, size);
    assert.equal(view.names()[0], 'Publisher 000');
    assert.equal(view.get('source-page-status').textContent, `Page 1 of ${pages}`);
    assert.equal(view.get('source-page-range').textContent, `Showing 1–${size} of 237`);
    assert.equal(view.get('source-count').textContent, '237 / 237');
    await view.get('source-page-next').dispatch('click');
  }
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(view.requests, []);
});

test('search starts at the first matching page, includes endpoint URLs and hides empty paging controls', async () => {
  const view = fixture();
  for (let page = 1; page < 24; page++) await view.get('source-page-next').dispatch('click');
  view.get('source-search').value = 'Publisher 01';
  await view.get('source-search').dispatch('input');
  assert.equal(view.names()[0], 'Publisher 010');
  assert.equal(view.cards().length, 10);
  assert.equal(view.get('source-count').textContent, '10 / 237');
  assert.equal(view.get('source-page-range').textContent, 'Showing 1–10 of 10');
  assert.equal(view.get('source-page-status').textContent, 'Page 1 of 1');
  view.get('source-search').value = 'publisher.example/22';
  await view.get('source-search').dispatch('input');
  assert.equal(view.names()[0], 'Publisher 220');
  assert.equal(view.cards().length, 10);
  view.get('source-search').value = 'missing publisher';
  await view.get('source-search').dispatch('input');
  assert.equal(view.cards().length, 0);
  assert.equal(view.get('source-count').textContent, '0 / 237');
  assert.equal(view.get('source-pagination').hidden, true);
  assert.equal(view.get('source-page-prev').disabled, true);
  assert.equal(view.get('source-page-next').disabled, true);
  assert.match(view.get('source-list').textContent, /No sources match your search/);
  view.get('source-search').value = '';
  await view.get('source-search').dispatch('input');
  assert.equal(view.get('source-page-status').textContent, 'Page 1 of 24');
  assert.equal(view.get('source-pagination').hidden, false);
  assert.deepEqual(view.requests, []);
});

test('a refreshed smaller list clamps its page and a country switch resets paging while retaining page size', async () => {
  let finishCountry;
  const view = fixture(countryData(), () => new Promise(resolve => { finishCountry = resolve; }));
  view.get('source-page-size').value = '50';
  await view.get('source-page-size').dispatch('change');
  for (let page = 1; page < 5; page++) await view.get('source-page-next').dispatch('click');
  view.ui.state.countryData = countryData(3);
  view.ui.renderSources();
  assert.equal(view.cards().length, 3);
  assert.equal(view.get('source-page-status').textContent, 'Page 1 of 1');
  assert.equal(view.get('source-page-range').textContent, 'Showing 1–3 of 3');
  view.ui.state.countryData = countryData();
  view.ui.renderSources();
  await view.get('source-page-next').dispatch('click');
  view.get('source-search').value = 'Publisher';
  const selecting = view.ui.selectCountry('KR');
  assert.equal(view.get('source-pagination').hidden, true);
  assert.equal(view.get('source-search').value, '');
  assert.equal(view.cards().length, 0);
  finishCountry(countryData(23));
  await selecting;
  assert.equal(view.cards().length, 23);
  assert.equal(view.get('source-page-size').value, '50');
  assert.equal(view.get('source-page-status').textContent, 'Page 1 of 1');
  assert.equal(view.get('source-page-range').textContent, 'Showing 1–23 of 23');
  assert.equal(view.requests.length, 1);
  assert.match(view.requests[0], /country=KR/);
});

test('source details remain lazy and cached; language switching preserves the current page, cards and counters', async () => {
  const data = countryData(), before = JSON.stringify(data), view = fixture(data);
  await view.get('source-page-next').dispatch('click');
  assert.deepEqual(view.requests, []);
  const card = view.cards()[0];
  card.open = true;
  await card.dispatch('toggle');
  assert.equal(view.requests.length, 1);
  assert.match(view.requests[0], /source_id=us-010/);
  assert.equal(view.renderedDetails.length, 1);
  assert.equal(view.renderedDetails[0].detail.article_activity.daily.new_unique_candidate_urls, 0);
  const count = view.get('source-count').textContent;
  view.ui.applyLanguage('ko');
  assert.equal(view.cards()[0], card);
  assert.equal(card.open, true);
  assert.equal(view.ui.state.sourcePage, 2);
  assert.equal(view.get('source-page-status').textContent, '24페이지 중 2페이지');
  assert.equal(view.get('source-page-range').textContent, '237개 중 11–20개 표시');
  assert.equal(view.get('source-count').textContent, count);
  assert.equal(view.requests.length, 1);
  assert.equal(JSON.stringify(data), before);
  view.ui.applyLanguage('en');
  assert.equal(view.get('source-page-status').textContent, 'Page 2 of 24');
  assert.equal(view.get('source-page-range').textContent, 'Showing 11–20 of 237');
  await view.get('source-page-next').dispatch('click');
  await view.get('source-page-prev').dispatch('click');
  const replacementCard = view.cards()[0];
  replacementCard.open = true;
  await replacementCard.dispatch('toggle');
  assert.equal(view.requests.length, 1, 'returning to a page reuses the source/date detail cache');
  assert.equal(view.renderedDetails.length, 2);
});

test('empty countries and failed country loads never retain a working pagination footer', async () => {
  const empty = fixture(countryData(0));
  assert.equal(empty.cards().length, 0);
  assert.equal(empty.get('source-pagination').hidden, true);
  assert.equal(empty.get('source-page-prev').disabled, true);
  assert.equal(empty.get('source-page-next').disabled, true);
  const failure = fixture(countryData(), async () => { throw new Error('Saved records unavailable'); });
  await failure.ui.selectCountry('KR');
  assert.equal(failure.get('source-pagination').hidden, true);
  assert.equal(failure.cards().length, 0);
  assert.match(failure.get('source-list').textContent, /Could not load source details/);
});
