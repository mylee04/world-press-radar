import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dashboardSection, i18nHelpers, i18nBindings } from './dashboard-test-runtime.mjs';

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');

// Only DOM, clock and transport are simulated. Date selection, request guards,
// refresh events and source expansion run the shipped dashboard functions.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map();
    this.listeners = new Map(); this.dataset = {}; this.value = ''; this.text = '';
    this.hidden = false; this.disabled = false; this.open = false; this.isConnected = true;
  }
  get textContent() { return this.text + this.children.map(child => child.textContent ?? child.data ?? '').join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) {
    const detach = child => { if (child && typeof child === 'object') { child.isConnected = false; child.children?.forEach(detach); } };
    this.children.forEach(detach); this.children = []; this.text = ''; this.append(...children);
  }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  get childElementCount() { return this.children.length; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners); }
  async dispatch(type) { if (this.disabled && type === 'click') return; for (const listener of this.listeners.get(type) ?? []) await listener({ target: this, preventDefault() {} }); }
  scrollIntoView() {}
  focus() {}
}

const source = { id: 'us-publisher', name: 'Publisher', active_registration_count: 1,
  endpoints: [{ type: 'rss', url: 'https://publisher.example/rss' }] };
const overview = (date, label = date) => ({ date, label, items: [{ country: 'US' }], runtime: { investigations_enabled: true } });
const country = (date, label = date) => ({ date, label, country: { country: 'US', inventory: { active_source_registrations: 1 } }, sources: [source] });
const settle = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };

function fixture(instant = '2026-10-14T12:00:00.000Z', transport) {
  let currentTime = Date.parse(instant), timerId = 0;
  class ControlledDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const elements = new Map(), requests = [], summaries = [], sourceDetails = [], runs = [];
  const timers = new Map(), clearedTimers = [], windowListeners = new Map(), documentListeners = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const match = html.match(new RegExp(`<([\\w-]+)\\b[^>]*\\bid="${id}"[^>]*>`));
      const element = new Element(match?.[1]);
      for (const [, name, value] of match?.[0].matchAll(/([\w-]+)="([^"]*)"/g) ?? []) element.setAttribute(name, value);
      element.hidden = Boolean(match && /\bhidden(?:\s|>)/.test(match[0]));
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const addListener = (target, type, listener) => { const listeners = target.get(type) ?? []; listeners.push(listener); target.set(type, listeners); };
  const document = {
    visibilityState: 'visible', documentElement: { lang: 'en' }, getElementById: get,
    createElement: tag => new Element(tag), createTextNode: data => ({ data, isConnected: true }),
    querySelectorAll: () => [], addEventListener: (type, listener) => addListener(documentListeners, type, listener),
  };
  const window = {
    localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: true }),
    addEventListener: (type, listener) => addListener(windowListeners, type, listener),
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => { clearedTimers.push(id); timers.delete(id); },
  };
  let context;
  context = vm.createContext({ document, window, Date: ControlledDate, queueMicrotask, URLSearchParams,
    crypto: { randomUUID: () => 'new-request-id' },
    valueText: value => typeof value === 'number' ? String(value) : '—',
    countryCode: value => value.country, countryName: value => value.country === 'US' ? 'United States' : value.country,
    inventory: value => value.inventory ?? value, countryTableColumns: () => 7, timeText: value => value ?? '—',
    appendMeta() {}, badge: () => new Element('span'),
    errorMessage: error => String(error.localizedMessage ?? error.message),
    showError: (id, error) => { get(id).textContent = error ? String(error.localizedMessage ?? error.message) : ''; get(id).hidden = !error; },
    emptyRow: (target, columns, text) => { target.textContent = String(text); },
    renderSummary: data => summaries.push(data), renderCountries() {}, renderInventory() {},
    loadRunHistory: async () => {}, loadProposals: async () => {}, renderExecutionAccess() {}, setTab() {},
    followRun: run => runs.push(run), recoverStart: () => { throw Error('No accepted POST recovery should be requested by this fixture'); },
    renderSourceDetail: (content, detail) => { sourceDetails.push(detail); content.textContent = detail.label ?? 'Current source details'; },
    api: async (route, options = {}) => {
      requests.push({ route, options });
      if (transport) return transport(route, options);
      const date = new URLSearchParams(route.split('?')[1] ?? '').get('date');
      if (route.startsWith('overview?')) return overview(date);
      if (route.startsWith('country?')) return country(date);
      if (route.startsWith('source?')) return { date, label: `Source ${date}` };
      if (route === 'investigations' && options.method === 'POST') return { run: { id: 'fixture-run', date: JSON.parse(options.body).date } };
      throw Error(`Unexpected fixture request: ${route}`);
    },
    fetch: () => { throw Error('Today-view tests must not make HTTP requests'); },
  });
  const code = i18nHelpers + '\n' + i18nBindings + '\n'
    + dashboardSection('const $ =', 'const numberFormats =') + '\n'
    + dashboardSection('function node(', 'function valueText(') + '\n'
    + dashboardSection('function utcToday(', 'function setTab(') + '\n'
    + dashboardSection('async function loadOverview(', 'function aggregateValue(') + '\n'
    + dashboardSection('async function startInvestigation(', "document.querySelectorAll('[data-tab]')") + '\n'
    + dashboardSection("$('refresh').addEventListener", "$('country-search').addEventListener") + '\n'
    + dashboardSection("window.addEventListener('focus'", '\nscheduleUtcDay();') + '\n'
    + 'this.ui={state,utcToday,dateQuery,syncTodayView,refreshUtcDay,scheduleUtcDay,loadOverview,selectCountry,renderSources,startInvestigation};';
  vm.runInContext(code, context);
  get('investigation-engine').value = 'rules';
  return {
    ui: context.ui, get, requests, summaries, sourceDetails, runs, timers, clearedTimers, document,
    setTime: instant => { currentTime = Date.parse(instant); },
    fireTimer: async id => { const timer = timers.get(id); timers.delete(id); timer.callback(); await settle(); },
    dispatchWindow: async type => { for (const listener of windowListeners.get(type) ?? []) await listener(); await settle(); },
    dispatchDocument: async type => { for (const listener of documentListeners.get(type) ?? []) await listener(); await settle(); },
    cards: () => get('source-list').children.filter(child => child.className === 'source-card'),
  };
}

test('the calendar is a non-editable UTC today output and queries cannot carry an old selected date', () => {
  assert.match(html, /<output\b[^>]*id="date-input"/);
  assert.doesNotMatch(html, /<input\b[^>]*id="date-input"/);
  const view = fixture('2026-10-14T20:00:00-05:00');
  assert.equal(view.ui.state.date, null);
  view.get('date-input').value = '2020-01-01';
  assert.equal(view.ui.syncTodayView(), '2026-10-15');
  assert.equal(view.get('date-input').value, '2026-10-15');
  assert.equal(view.get('date-input').textContent, '2026-10-15');
  const query = new URLSearchParams(view.ui.dateQuery({ country: 'US', date: '2020-01-01' }));
  assert.equal(query.get('date'), '2026-10-15');
  assert.equal(query.get('country'), 'US');
  assert.equal(view.requests.length, 0);
});

test('refresh requests explicit UTC today rather than the backend previous-day default', async () => {
  const view = fixture();
  view.get('date-input').value = '2026-10-13';
  await view.get('refresh').dispatch('click');
  assert.equal(view.requests[0].route, 'overview?date=2026-10-14');
  assert.equal(view.ui.state.overview.date, '2026-10-14');
  assert.equal(view.get('date-input').textContent, '2026-10-14');
  assert.equal(view.get('refresh').disabled, false);
  assert.equal(view.requests.length, 1);
});

test('UTC midnight refresh clears yesterday display caches while preserving accepted investigations', async () => {
  const view = fixture('2026-10-14T23:59:59.900Z');
  view.ui.syncTodayView();
  const activeRun = { id: 'already-running', date: '2026-10-14', status: 'running' };
  const pending = { request_id: 'already-accepted', country: 'US', date: '2026-10-14', engine: 'rules' };
  Object.assign(view.ui.state, { run: activeRun, pendingStart: pending, poll: 88, countryPage: 3, inventoryPage: 4, sourcePage: 5, countryData: country('2026-10-14') });
  view.ui.state.sourceCache.set('old-source:2026-10-14', Promise.resolve({ date: '2026-10-14' }));
  view.get('country-detail').hidden = false;
  view.ui.scheduleUtcDay();
  const firstTimer = view.ui.state.dayTimer;
  assert.equal(view.timers.get(firstTimer).delay, 150);
  view.setTime('2026-10-15T00:00:00.050Z');
  await view.fireTimer(firstTimer);
  assert.equal(view.get('date-input').textContent, '2026-10-15');
  assert.equal(view.ui.state.overview.date, '2026-10-15');
  assert.equal(view.ui.state.sourceCache.size, 0);
  assert.equal(view.ui.state.countryData, null);
  assert.equal(view.get('country-detail').hidden, true);
  assert.equal(view.ui.state.countryPage, 1); assert.equal(view.ui.state.inventoryPage, 1); assert.equal(view.ui.state.sourcePage, 1);
  assert.equal(view.ui.state.run, activeRun); assert.equal(view.ui.state.pendingStart, pending); assert.equal(view.ui.state.poll, 88);
  assert.deepEqual(view.requests.map(request => request.route), ['overview?date=2026-10-15']);
  assert.ok(view.timers.get(view.ui.state.dayTimer).delay > 86399000, 'the next timer targets the following UTC midnight');
});

test('a hidden page returning after midnight reloads today once; same-day focus makes no request', async () => {
  const view = fixture('2026-10-14T23:00:00.000Z');
  view.ui.syncTodayView();
  view.document.visibilityState = 'hidden'; view.setTime('2026-10-15T02:00:00.000Z');
  await view.dispatchDocument('visibilitychange');
  assert.equal(view.requests.length, 0);
  view.document.visibilityState = 'visible'; await view.dispatchDocument('visibilitychange');
  assert.equal(view.requests[0].route, 'overview?date=2026-10-15');
  assert.equal(view.get('date-input').textContent, '2026-10-15');
  await view.dispatchWindow('focus');
  assert.equal(view.requests.length, 1);
});

test('an old overview response arriving after today is loaded cannot overwrite today or report an error', async () => {
  const pending = [];
  const view = fixture('2026-10-14T23:59:00.000Z', route => new Promise(resolve => pending.push({ route, resolve })));
  const yesterdayLoad = view.ui.loadOverview();
  view.setTime('2026-10-15T00:01:00.000Z');
  const todayLoad = view.ui.loadOverview();
  pending[1].resolve(overview('2026-10-15', 'current')); await todayLoad;
  pending[0].resolve(overview('2026-10-14', 'late-old')); await yesterdayLoad;
  assert.equal(view.ui.state.overview.label, 'current');
  assert.deepEqual(view.summaries.map(data => data.date), ['2026-10-15']);
  assert.equal(view.get('page-error').hidden, true);
  assert.equal(view.get('date-input').textContent, '2026-10-15');
});

test('a previous-day server response to a today overview or country request is rejected', async () => {
  const view = fixture('2026-10-15T01:00:00.000Z', route => route.startsWith('overview?') ? overview('2026-10-14') : country('2026-10-14'));
  await view.ui.loadOverview();
  assert.equal(view.ui.state.overview, null);
  assert.equal(view.summaries.length, 0);
  assert.match(view.get('page-error').textContent, /today.*Refresh/);
  view.ui.state.countries = [{ country: 'US' }];
  await view.ui.selectCountry('US');
  assert.equal(view.ui.state.countryData, null);
  assert.match(view.get('country-detail-error').textContent, /today.*Refresh/);
  assert.equal(view.cards().length, 0);
  assert.ok(view.requests.every(request => new URLSearchParams(request.route.split('?')[1]).get('date') === '2026-10-15'));
});

test('yesterday country details arriving after the same country was refreshed cannot replace its today sources', async () => {
  let resolveOldCountry;
  const view = fixture('2026-10-14T23:59:00.000Z', route => {
    const date = new URLSearchParams(route.split('?')[1]).get('date');
    if (route.startsWith('overview?')) return overview(date);
    if (date === '2026-10-14') return new Promise(resolve => { resolveOldCountry = resolve; });
    return country(date, 'today-country');
  });
  view.ui.syncTodayView(); view.ui.state.countries = [{ country: 'US' }];
  const oldSelection = view.ui.selectCountry('US');
  view.setTime('2026-10-15T00:01:00.000Z'); await view.ui.loadOverview();
  resolveOldCountry(country('2026-10-14', 'old-country')); await oldSelection;
  assert.equal(view.ui.state.countryData.label, 'today-country');
  assert.equal(view.ui.state.countryData.date, '2026-10-15');
  assert.equal(view.cards().length, 1);
  assert.equal(view.get('country-detail-error').hidden, true);
});

test('a source response crossing midnight cannot populate the old card or reuse its cache for today', async () => {
  let resolveOldSource;
  const view = fixture('2026-10-14T23:59:00.000Z', route => {
    const date = new URLSearchParams(route.split('?')[1]).get('date');
    if (route.startsWith('overview?')) return overview(date);
    if (route.startsWith('country?')) return country(date);
    if (date === '2026-10-14') return new Promise(resolve => { resolveOldSource = resolve; });
    return { date, label: 'today-source' };
  });
  view.ui.syncTodayView(); view.ui.state.countries = [{ country: 'US' }];
  await view.ui.selectCountry('US');
  const oldCard = view.cards()[0]; oldCard.open = true; const oldContent = oldCard.children[1];
  const oldExpansion = oldCard.dispatch('toggle');
  view.setTime('2026-10-15T00:01:00.000Z'); await view.ui.loadOverview();
  resolveOldSource({ date: '2026-10-14', label: 'old-source' }); await oldExpansion;
  assert.equal(view.sourceDetails.length, 0); assert.ok(!oldContent.textContent.includes('old-source'));
  const newCard = view.cards()[0]; newCard.open = true; await newCard.dispatch('toggle');
  assert.deepEqual(view.sourceDetails.map(detail => detail.label), ['today-source']);
  assert.deepEqual(view.requests.filter(request => request.route.startsWith('source?')).map(request => new URLSearchParams(request.route.split('?')[1]).get('date')), ['2026-10-14', '2026-10-15']);
});

test('a previous-day source payload returned for today is rejected before displaying activity', async () => {
  const view = fixture('2026-10-15T01:00:00.000Z', route => route.startsWith('country?') ? country('2026-10-15') : { date: '2026-10-14', label: 'wrong-day-source' });
  view.ui.syncTodayView(); view.ui.state.countries = [{ country: 'US' }];
  await view.ui.selectCountry('US');
  const card = view.cards()[0]; card.open = true; await card.dispatch('toggle');
  assert.equal(view.sourceDetails.length, 0);
  assert.match(card.children[1].textContent, /today.*Refresh/);
  assert.equal(card.children[1].dataset.loaded, 'false');
});

test('a newly requested investigation sends UTC today even if yesterday remains in the date display', async () => {
  const view = fixture('2026-10-15T00:01:00.000Z');
  view.get('date-input').value = '2026-10-14'; view.ui.state.date = '2026-10-14';
  view.ui.state.overview = overview('2026-10-14');
  await view.ui.startInvestigation('US');
  const posts = view.requests.filter(request => request.options.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].route, 'investigations');
  const input = JSON.parse(posts[0].options.body);
  assert.equal(input.date, '2026-10-15'); assert.equal(input.country, 'US'); assert.equal(input.engine, 'rules');
  assert.equal(view.runs[0].date, '2026-10-15');
});
