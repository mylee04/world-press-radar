import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dashboardApp, dashboardSection, i18nHelpers, i18nBindings } from './dashboard-test-runtime.mjs';

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const prefixes = ['country', 'inventory', 'inventory-history', 'new-source'];
const countryCodes = 'US CN JP DE IN GB FR IT CA RU KR BR AU ES MX ID MA NL CH TR SA IL JO KW TW PL SE BE TH IR AR CL DO UY AT NZ NO IE PT DK FI CZ GR RO UA LU SK HU BG HR SI RS LT LV EE IS EG NG SG ZA BH QA AE SV EC OM CO MY PH VN MN PK KZ'.split(' ');

// The DOM fixture supplies transport and element operations only. The shipped
// renderers, filtering, sorting, pagination and event callbacks run unchanged.
class Element {
  constructor(tag = 'div', document) {
    this.tagName = tag.toUpperCase(); this.document = document;
    this.children = []; this.attributes = new Map(); this.listeners = new Map();
    this.dataset = {}; this.value = ''; this.disabled = false; this.hidden = false;
    this.open = false; this.isConnected = true; this.ownText = ''; this.className = '';
    this.parentElement = null;
  }
  get textContent() { return this.ownText + this.children.map(child => child.textContent ?? child.data ?? '').join(''); }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
  append(...children) {
    for (const child of children) {
      if (typeof child === 'object') { child.isConnected = this.isConnected; child.parentElement = this; }
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    const detach = child => {
      if (!child || typeof child !== 'object') return;
      child.isConnected = false; child.children?.forEach(detach);
    };
    this.children.forEach(detach); this.children = []; this.ownText = ''; this.append(...children);
  }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  get childElementCount() { return this.children.filter(child => child.tagName).length; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? []; entries.push(listener); this.listeners.set(type, entries);
  }
  async dispatch(type) {
    if (type === 'click' && this.disabled) return;
    for (const listener of this.listeners.get(type) ?? []) await listener({ target: this, preventDefault() {} });
  }
  focus() { this.document.activeElement = this; }
  scrollIntoView() { this.scrolled = true; }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const match = selector.match(/^([\w-]+)(?:\[([^=]+)="([^"]+)"\])?$/);
    return Boolean(match && this.tagName.toLowerCase() === match[1] && (!match[2] || this[match[2]] === match[3] || this.getAttribute(match[2]) === match[3]));
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child?.matches?.(selector)) return child;
      const match = child?.querySelector?.(selector); if (match) return match;
    }
    return null;
  }
}

function namedFunction(name) {
  const start = dashboardApp.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the shipped ${name} function must be present`);
  // Shipped top-level functions close at column zero; nested blocks are indented.
  const rest = dashboardApp.slice(start), closing = /^}/m.exec(rest);
  assert.ok(closing, `the shipped ${name} function must be complete`);
  return rest.slice(0, closing.index + 1);
}

function dataFixture(count = 73) {
  const countries = countryCodes.slice(0, count).map((code, index) => Object.freeze({
    country: code, name: `Country ${code}`, date: '2026-10-14',
    inventory: Object.freeze({ active_source_registrations: 100 + index, disabled_source_registrations: index,
      unique_publishers: 80 + index, unique_active_rss_endpoints: 60 + index, unique_active_sitemap_endpoints: 40 + index }),
    metrics: Object.freeze({ attempt_coverage: { value: index + 1, numerator: index + 1, denominator: 100 },
      success_rate: { value: 100 - index, numerator: 100 - index, denominator: 100 },
      ...(index === count - 1 ? { freshness: { value: 91, numerator: 91, denominator: 100 } } : {}) }),
    ...(index === count - 1 ? { completed_cycle_baseline: { state: 'comparable_completed_cycles', reasons: [], current: { attempt_coverage: 100 } } } : {}),
  }));
  const additions = countries.slice(0, 23).map((country, index) => Object.freeze({ source_id: `added-${index}`,
    name: `Added publisher ${String(index).padStart(2, '0')}`, country: country.country,
    recorded_at: '2026-10-14T01:00:00Z', recorded_at_basis: 'operator_initial_registration', endpoints: [] }));
  return { date: '2026-10-14', items: countries, latest_collection: '2026-10-14T03:30:00Z',
    registry_snapshot_at: '2026-10-14T04:00:00Z',
    global_inventory: { active_countries: count, active_source_registrations: 5097, unique_publishers: 2853,
      unique_active_rss_endpoints: 3707, unique_active_sitemap_endpoints: 1790 },
    runtime: { investigations_enabled: false },
    inventory_changes: { date: '2026-10-14', recorded_events_only: true, additions,
      per_country: countries.map(country => ({ country: country.country, additions: 1, deactivations: 0, reactivations: 0, deletions: null, net_change: null })) } };
}

function fixture(data = dataFixture()) {
  const elements = new Map(), requests = [], detailRenders = [];
  const document = {
    documentElement: { lang: 'en' }, activeElement: null,
    createElement: tag => new Element(tag, document),
    createTextNode: data => ({ data, isConnected: true }),
    querySelectorAll: selector => {
      if (selector.startsWith('.')) return [...elements.values()].filter(element => element.matches(selector));
      const attrs = [...selector.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
      return [...elements.values()].filter(element => attrs.length && attrs.every(attr => element.getAttribute(attr) !== null));
    },
  };
  const get = id => {
    if (!elements.has(id)) {
      const tag = html.match(new RegExp(`<([\\w-]+)\\b[^>]*\\bid="${id}"[^>]*>`));
      const element = new Element(tag?.[1] ?? 'div', document);
      for (const [, name, value] of tag?.[0]?.matchAll(/([\w-]+)="([^"]*)"/g) ?? []) element.setAttribute(name, value);
      element.hidden = Boolean(tag && /\bhidden(?:\s|>)/.test(tag[0]));
      element.parentElement = new Element('div', document);
      elements.set(id, element);
      if (id === 'investigation-engine') {
        for (const value of ['rules', 'openai', 'jev']) { const option = new Element('option', document); option.value = value; element.append(option); }
        element.value = 'rules'; element.selectedOptions = [element.firstChild];
      }
    }
    return elements.get(id);
  };
  document.getElementById = get;
  for (const prefix of prefixes) for (const suffix of ['page-size', 'page-prev', 'page-next', 'page-status', 'page-range', 'pagination']) get(`${prefix}-${suffix}`);
  for (const id of ['country-search', 'country-sort', 'country-rows', 'country-count', 'inventory-rows', 'inventory-history-rows',
    'new-source-list', 'source-list', 'language-select', 'date-input']) get(id);
  get('country-sort').value = 'economy'; get('date-input').value = '2026-10-14';
  const mountedDetail = new Element('article', document); mountedDetail.textContent = 'Previously loaded source details'; get('source-list').append(mountedDetail);
  const context = vm.createContext({ document, queueMicrotask, URLSearchParams,
    window: { localStorage: { setItem() {} }, matchMedia: () => ({ matches: true }) },
    utcToday: () => '2026-10-14', syncTodayView: () => false,
    dateQuery: extra => new URLSearchParams({ date: '2026-10-14', ...extra }).toString(),
    api: async route => { requests.push(route); if (!route.startsWith('country?')) throw new Error(`Unexpected request: ${route}`);
      return { country: { country: new URLSearchParams(route.split('?')[1]).get('country'), inventory: { active_source_registrations: 7 } }, sources: [] }; },
    showError() {}, renderEngineStatus() {}, renderExecutionAccess() {},
    renderCountryTrend() {}, renderSources: () => { detailRenders.push('sources'); },
    fetch: () => { throw new Error('Country pagination must not fetch production data'); },
    safeLink: value => { const a = new Element('a', document); a.textContent = value; return a; },
  });
  const code = i18nHelpers + '\n' + i18nBindings + '\n'
    + 'const $ = id => document.getElementById(id);\n'
    + dashboardSection('const state =', 'const numberFormats =') + '\n'
    + dashboardSection('const numberFormats =', 'function humanInvestigationError(') + '\n'
    + namedFunction('emptyRow') + '\n'
    + dashboardSection('function renderMetric(', 'function renderCountries(') + '\n'
    + namedFunction('renderCountries') + '\n' + namedFunction('renderSummary') + '\n'
    + dashboardSection('function registryHistoryView(', 'async function loadOverview(') + '\n'
    + dashboardSection('async function selectCountry(', 'function renderCountryTrend(') + '\n'
    + namedFunction('bindPagination') + '\n'
    + "bindPagination('country','countryPage','countryPageSize',renderCountries);\n"
    + "bindPagination('inventory','inventoryPage','inventoryPageSize',renderInventory);\n"
    + "bindPagination('inventory-history','inventoryHistoryPage','inventoryHistoryPageSize',renderInventory);\n"
    + "bindPagination('new-source','newSourcePage','newSourcePageSize',renderInventory);\n"
    + dashboardSection("$('country-search').addEventListener", "$('source-search').addEventListener")
    + '\nthis.ui={state,renderCountries,renderInventory,renderSummary,selectCountry,applyLanguage,countryName,compareEconomy};';
  vm.runInContext(code, context);
  const { ui } = context;
  ui.state.date = data.date; ui.state.overview = data; ui.state.countries = data.items;
  ui.state.sourcePage = 3; ui.state.sourcePageSize = 20;
  ui.state.sourceCache.set('retained:2026-10-14', Promise.resolve({ retained: true }));
  ui.renderSummary(data); ui.renderCountries(); ui.renderInventory();
  const rows = id => get(id).children.filter(child => child.tagName === 'TR' && !child.children.some(cell => cell.className === 'empty-cell'));
  return { ui, get, document, requests, data, mountedDetail, detailRenders,
    countryRows: () => rows('country-rows'), inventoryRows: () => rows('inventory-rows'), historyRows: () => rows('inventory-history-rows'),
    sourceCards: () => get('new-source-list').children.filter(child => child.className === 'new-source-card'),
    countryNames: () => rows('country-rows').map(row => row.children[0].textContent),
    inventoryNames: () => rows('inventory-rows').map(row => row.children[0].textContent),
  };
}

test('73 countries start at ten per page in both tables and all country selectors offer only 10, 20 and 50', () => {
  for (const prefix of prefixes) {
    const select = html.match(new RegExp(`<select\\b[^>]*id="${prefix}-page-size"[^>]*>([\\s\\S]*?)<\\/select>`))?.[1];
    assert.ok(select, `${prefix} must offer a per-page selector`);
    assert.deepEqual([...select.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(match => match[1]), ['10', '20', '50']);
  }
  const view = fixture();
  assert.equal(view.get('inventory-history-details').open, false, 'registration details remain collapsed until opened by the reader');
  assert.equal(view.countryRows().length, 10); assert.equal(view.inventoryRows().length, 10);
  assert.equal(view.historyRows().length, 10); assert.equal(view.sourceCards().length, 10);
  assert.equal(view.get('country-page-status').textContent, 'Page 1 of 8');
  assert.equal(view.get('inventory-page-range').textContent, 'Showing 1–10 of 73');
  assert.deepEqual(view.countryNames().slice(0, 2), ['United States', 'China']);
  assert.equal(view.get('country-count').textContent, '73');
  for (const prefix of prefixes) assert.equal(view.get(`${prefix}-page-size`).value, '10');
  assert.deepEqual(view.requests, []);
});

test('country and inventory pages traverse every country exactly once and stop at their partial final pages', async () => {
  const view = fixture(), visited = [...view.countryNames()];
  for (let page = 2; page <= 8; page++) {
    await view.get('country-page-next').dispatch('click'); visited.push(...view.countryNames());
    assert.equal(view.get('country-page-status').textContent, `Page ${page} of 8`);
  }
  assert.equal(view.countryRows().length, 3); assert.equal(view.get('country-page-range').textContent, 'Showing 71–73 of 73');
  assert.equal(view.get('country-page-next').disabled, true); assert.equal(view.get('country-page-prev').disabled, false);
  assert.equal(visited.length, 73); assert.equal(new Set(visited).size, 73);
  const expected = [...view.data.items].sort(view.ui.compareEconomy).map(view.ui.countryName);
  assert.deepEqual(visited, expected);
  await view.get('country-page-next').dispatch('click'); assert.equal(view.ui.state.countryPage, 8);
  await view.get('country-page-prev').dispatch('click'); assert.equal(view.countryRows().length, 10);
  const inventoryVisited = [...view.inventoryNames()];
  for (let page = 2; page <= 8; page++) {
    await view.get('inventory-page-next').dispatch('click'); inventoryVisited.push(...view.inventoryNames());
  }
  const inventoryExpected = [...view.data.items].sort((a, b) => b.inventory.active_source_registrations - a.inventory.active_source_registrations).map(view.ui.countryName);
  assert.deepEqual(inventoryVisited, inventoryExpected); assert.equal(new Set(inventoryVisited).size, 73);
  assert.equal(view.inventoryRows().length, 3); assert.equal(view.get('inventory-page-next').disabled, true);
  assert.equal(view.get('inventory-page-range').textContent, 'Showing 71–73 of 73');
  assert.equal(view.ui.state.countryPage, 7, 'inventory traversal does not move the country table');
  assert.deepEqual(view.requests, []);
});

test('per-page choices reset only their own list and use total matched countries for page counts', async () => {
  const view = fixture();
  await view.get('inventory-page-next').dispatch('click'); await view.get('inventory-history-page-next').dispatch('click');
  await view.get('new-source-page-next').dispatch('click');
  for (const [size, pages] of [[20, 4], [50, 2], [10, 8]]) {
    await view.get('country-page-next').dispatch('click');
    view.get('country-page-size').value = String(size); await view.get('country-page-size').dispatch('change');
    assert.equal(view.countryRows().length, size); assert.equal(view.ui.state.countryPage, 1);
    assert.equal(view.get('country-page-status').textContent, `Page 1 of ${pages}`);
    assert.equal(view.ui.state.inventoryPage, 2); assert.equal(view.ui.state.inventoryHistoryPage, 2); assert.equal(view.ui.state.newSourcePage, 2);
    assert.equal(view.ui.state.sourcePage, 3);
  }
  for (const [size, pages] of [[20, 4], [50, 2]]) {
    view.get('inventory-page-size').value = String(size); await view.get('inventory-page-size').dispatch('change');
    assert.equal(view.inventoryRows().length, size); assert.equal(view.ui.state.inventoryPage, 1);
    assert.equal(view.get('inventory-page-status').textContent, `Page 1 of ${pages}`);
  }
  assert.equal(view.ui.state.countryPageSize, 10); assert.equal(view.ui.state.inventoryHistoryPage, 2); assert.equal(view.ui.state.newSourcePage, 2);
  assert.deepEqual(view.requests, []);
});

test('search and sort apply to the whole country result, reset its page and preserve unrelated pages', async () => {
  const view = fixture();
  await view.get('inventory-page-next').dispatch('click'); await view.get('country-page-next').dispatch('click');
  view.get('country-sort').value = 'inventory'; await view.get('country-sort').dispatch('change');
  assert.equal(view.ui.state.countryPage, 1);
  const expected = [...view.data.items].sort((a, b) => b.inventory.active_source_registrations - a.inventory.active_source_registrations).map(view.ui.countryName);
  assert.deepEqual(view.countryNames(), expected.slice(0, 10));
  await view.get('country-page-next').dispatch('click');
  view.get('country-search').value = 'KR'; await view.get('country-search').dispatch('input');
  assert.equal(view.ui.state.countryPage, 1); assert.deepEqual(view.countryNames(), ['South Korea']);
  assert.equal(view.get('country-count').textContent, '1'); assert.equal(view.get('country-page-status').textContent, 'Page 1 of 1');
  view.get('country-search').value = '한국'; await view.get('country-search').dispatch('input');
  assert.deepEqual(view.countryNames(), ['South Korea'], 'Korean country names remain searchable in the English UI');
  view.get('country-search').value = 'No such country'; await view.get('country-search').dispatch('input');
  assert.equal(view.countryRows().length, 0); assert.equal(view.get('country-pagination').hidden, true);
  assert.equal(view.get('country-page-prev').disabled, true); assert.equal(view.get('country-page-next').disabled, true);
  view.get('country-search').value = ''; await view.get('country-search').dispatch('input');
  assert.deepEqual(view.countryNames(), expected.slice(0, 10)); assert.equal(view.get('country-pagination').hidden, false);
  assert.equal(view.ui.state.inventoryPage, 2); assert.equal(view.ui.state.sourcePage, 3); assert.deepEqual(view.requests, []);
});

test('pagination keeps whole-registry totals, hidden-country metrics and detailed source state intact', async () => {
  const view = fixture(), before = JSON.stringify(view.data);
  const stats = ['stat-countries', 'stat-publishers', 'stat-sources', 'stat-rss', 'stat-sitemaps'];
  const totals = stats.map(id => view.get(id).textContent);
  assert.deepEqual(totals, ['73', '2,853', '5,097', '3,707', '1,790']);
  assert.equal(view.get('freshness-heading').hidden, false, 'a country outside page one still makes the freshness column available');
  assert.equal(view.get('observation-heading').hidden, false, 'a country outside page one still makes the observation column available');
  const focused = view.get('country-page-next'); focused.focus();
  for (const prefix of prefixes) await view.get(`${prefix}-page-next`).dispatch('click');
  assert.deepEqual(stats.map(id => view.get(id).textContent), totals);
  assert.equal(view.document.activeElement, focused); assert.equal(view.get('source-list').firstChild, view.mountedDetail);
  assert.equal(view.ui.state.sourcePage, 3); assert.equal(view.ui.state.sourcePageSize, 20); assert.equal(view.ui.state.sourceCache.size, 1);
  assert.equal(JSON.stringify(view.data), before); assert.deepEqual(view.requests, []);
});

test('history and new-source pages include all records without changing the inventory page or actual registration count', async () => {
  const view = fixture(), sources = view.sourceCards().map(card => card.querySelector('h3').textContent);
  view.get('inventory-history-details').open = true;
  for (let page = 2; page <= 3; page++) {
    await view.get('new-source-page-next').dispatch('click'); sources.push(...view.sourceCards().map(card => card.querySelector('h3').textContent));
  }
  assert.equal(sources.length, 23); assert.equal(new Set(sources).size, 23); assert.equal(view.sourceCards().length, 3);
  assert.equal(view.get('new-source-page-range').textContent, 'Showing 21–23 of 23');
  assert.equal(view.get('new-source-page-next').disabled, true); assert.equal(view.get('new-source-count').textContent, '23 recorded additions');
  assert.equal(view.ui.state.inventoryPage, 1); assert.equal(view.ui.state.inventoryHistoryPage, 1);
  view.get('inventory-history-page-size').value = '50'; await view.get('inventory-history-page-size').dispatch('change');
  assert.equal(view.historyRows().length, 50); await view.get('inventory-history-page-next').dispatch('click');
  assert.equal(view.historyRows().length, 23); assert.equal(view.get('inventory-history-page-range').textContent, 'Showing 51–73 of 73');
  assert.equal(view.ui.state.newSourcePage, 3); assert.equal(view.ui.state.countryPage, 1); assert.deepEqual(view.requests, []);
  assert.equal(view.get('inventory-history-details').open, true, 'paging preserves an explicitly opened registration section');
});

test('language changes update page labels without requests and a visible country opens its own details', async () => {
  const view = fixture();
  for (const prefix of prefixes) await view.get(`${prefix}-page-next`).dispatch('click');
  view.ui.applyLanguage('ko');
  assert.equal(view.get('country-page-status').textContent, '8페이지 중 2페이지');
  assert.equal(view.get('inventory-page-range').textContent, '73개 중 11–20개 표시');
  assert.equal(view.ui.state.countryPage, 2); assert.equal(view.ui.state.inventoryPage, 2); assert.equal(view.ui.state.inventoryHistoryPage, 2); assert.equal(view.ui.state.newSourcePage, 2);
  assert.equal(view.ui.state.sourcePage, 3); assert.deepEqual(view.requests, []);
  view.ui.applyLanguage('en');
  const code = [...view.data.items].sort(view.ui.compareEconomy)[10].country;
  const button = view.countryRows()[0].querySelector('button'); await button.dispatch('click');
  assert.equal(view.requests.length, 1); assert.match(view.requests[0], new RegExp(`country=${code}(?:&|$)`));
  assert.equal(view.ui.state.selected, code); assert.equal(view.ui.state.countryPage, 2);
  assert.equal(view.ui.state.inventoryPage, 2); assert.equal(view.ui.state.sourcePage, 1);
  assert.equal(view.get('country-detail').hidden, false); assert.equal(view.detailRenders.length, 1);
});

test('smaller refreshes clamp existing pages and empty data disables every pagination footer', async () => {
  const view = fixture();
  for (let page = 2; page <= 8; page++) await view.get('country-page-next').dispatch('click');
  view.ui.state.countries = view.data.items.slice(0, 3); view.ui.renderCountries(); view.ui.renderInventory();
  assert.equal(view.countryRows().length, 3); assert.equal(view.ui.state.countryPage, 1); assert.equal(view.get('country-page-status').textContent, 'Page 1 of 1');
  assert.equal(view.inventoryRows().length, 3);
  const empty = fixture(dataFixture(0));
  for (const prefix of prefixes) {
    assert.equal(empty.get(`${prefix}-pagination`).hidden, true);
    assert.equal(empty.get(`${prefix}-page-prev`).disabled, true); assert.equal(empty.get(`${prefix}-page-next`).disabled, true);
  }
  assert.equal(empty.countryRows().length, 0); assert.equal(empty.inventoryRows().length, 0); assert.equal(empty.sourceCards().length, 0);
});
