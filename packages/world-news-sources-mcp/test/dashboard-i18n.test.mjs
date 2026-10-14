import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { i18nHelpers, i18nBindings, dashboardSection } from './dashboard-test-runtime.mjs';

function helpers(values = {}) {
  const context = vm.createContext(values);
  vm.runInContext(i18nHelpers + '\nthis.ui={normalizeLanguage,readLanguage,setLanguageValue,t,localizedJoin,UIError};', context);
  return context;
}

test('first visit is English even when the browser prefers Korean', () => {
  const context = helpers({ navigator: { language: 'ko-KR', languages: ['ko-KR'] }, window: { localStorage: { getItem: () => null } } });
  assert.equal(context.ui.readLanguage(), 'en');
  assert.equal(String(context.ui.t('검사 성공 · 신규 0')), 'Check succeeded · no new URLs');
});

test('only supported saved choices override English; inaccessible storage is harmless', () => {
  const context = helpers({ window: Object.defineProperty({}, 'localStorage', { get() { throw new Error('Blocked'); } }) });
  assert.equal(context.ui.readLanguage(), 'en');
  for (const value of [null, undefined, '', 'fr', 'ko-KR', '{bad-json}']) assert.equal(context.ui.readLanguage({ getItem: () => value }), 'en');
  assert.equal(context.ui.readLanguage({ getItem: () => 'ko' }), 'ko');
  assert.equal(context.ui.readLanguage({ getItem: () => 'en' }), 'en');
  assert.equal(context.ui.readLanguage({ getItem() { throw new Error('Denied'); } }), 'en');
});

test('existing labels, interpolations and authored errors follow the current choice', () => {
  const { ui } = helpers();
  const status = ui.t('완료'), count = ui.t`서버 대기 ${2}`, list = ui.localizedJoin([status, count], ' / ');
  const error = new ui.UIError(ui.t('관리자 로그인이 필요합니다.'));
  assert.equal(String(status), 'Completed');
  assert.equal(String(count), 'Server cooldown 2');
  ui.setLanguageValue('ko');
  assert.equal(String(status), '완료');
  assert.equal(String(count), '서버 대기 2');
  assert.equal(String(list), '완료 / 서버 대기 2');
  assert.equal(String(error.localizedMessage), '관리자 로그인이 필요합니다.');
});

function element(attrs = {}, textContent = '') {
  const attributes = new Map(Object.entries(attrs));
  return { textContent, isConnected: true, value: '', getAttribute: key => attributes.get(key) ?? null,
    setAttribute: (key, value) => attributes.set(key, value), attributes };
}

function bindings(storage) {
  const selector = element(), heading = element({ 'data-i18n-en': 'Collection quality', 'data-i18n-ko': '수집 품질' });
  const search = element({ 'data-i18n-placeholder-en': 'Search countries', 'data-i18n-placeholder-ko': '국가 검색' });
  search.value = 'US';
  const document = { documentElement: { lang: 'en' }, getElementById: () => selector,
    createTextNode: data => ({ data, isConnected: true }),
    querySelectorAll: query => query === '[data-i18n-en][data-i18n-ko]' ? [heading] : query.startsWith('[data-i18n-placeholder-') ? [search] : [] };
  const pending = { request_id: 'accepted-request', engine: 'openai' };
  const state = { overview: {}, selected: 'US', pendingStart: pending, run: { id: 'active-run', status: 'running' }, poll: 32, pollFailures: 2, activeTab: 'investigations' };
  let requests = 0, sorts = 0;
  const context = helpers({ document, state, queueMicrotask, window: { localStorage: storage }, renderCountries: () => { sorts++; }, fetch: () => { requests++; throw new Error('Unexpected network request'); } });
  vm.runInContext(i18nBindings + '\nthis.bindings={applyLanguage,setText,setLocalizedAttribute,localizedTextNode};', context);
  return { context, selector, heading, search, state, pending, requests: () => requests, sorts: () => sorts };
}

test('switching updates mounted text and attributes, persists the choice and preserves accepted work', () => {
  const saved = new Map(), fixture = bindings({ getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) });
  const { context, state } = fixture, target = element(), raw = element();
  const original = '검사 성공 · 신규 0 <script>untrusted evidence</script>';
  context.bindings.setText(target, () => context.ui.t('검사 성공 · 신규 0'));
  context.bindings.setLocalizedAttribute(target, 'title', () => context.ui.t('미확인'));
  context.bindings.setText(raw, () => original);
  const before = JSON.stringify(state);
  context.bindings.applyLanguage('ko');
  assert.equal(fixture.heading.textContent, '수집 품질');
  assert.equal(fixture.search.getAttribute('placeholder'), '국가 검색');
  assert.equal(fixture.search.value, 'US');
  assert.equal(fixture.selector.value, 'ko');
  assert.equal(target.textContent, '검사 성공 · 신규 0');
  assert.equal(target.getAttribute('title'), '미확인');
  assert.equal(raw.textContent, original);
  assert.equal(saved.get('wpr-quality-language'), 'ko');
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.pendingStart, fixture.pending);
  assert.equal(fixture.requests(), 0);
  assert.equal(fixture.sorts(), 1);
  context.bindings.applyLanguage('en');
  assert.equal(target.textContent, 'Check succeeded · no new URLs');
  assert.equal(target.getAttribute('title'), 'Unknown');
  assert.equal(raw.textContent, original);
  assert.equal(context.ui.readLanguage({ getItem: key => saved.get(key) }), 'en');
});

test('storage write failures still allow the current page to switch', () => {
  const { context, heading } = bindings({ setItem() { throw new Error('Quota exceeded'); } });
  assert.doesNotThrow(() => context.bindings.applyLanguage('ko'));
  assert.equal(heading.textContent, '수집 품질');
});

test('normal renders release detached language bindings without requiring a language switch', async () => {
  const { context } = bindings({ setItem() {} });
  vm.runInContext('this.bindingCount=()=>languageBindings.size;', context);
  const oldNode = element(), mountedNode = element();
  context.bindings.setText(oldNode, () => context.ui.t('완료'));
  context.bindings.setText(mountedNode, () => context.ui.t('실행 중'));
  oldNode.isConnected = false;
  assert.equal(context.bindingCount(), 2);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(context.bindingCount(), 1);
  context.bindings.applyLanguage('ko');
  assert.equal(mountedNode.textContent, '실행 중');
});

test('country names follow language while the US/China economic priority stays stable', () => {
  const context = helpers();
  vm.runInContext(dashboardSection('const regionNames =', '// IMF Data Mapper')
    + dashboardSection('const nominalGdp2026 =', 'const classificationLabels =')
    + dashboardSection('function countryCode(', 'function inventory(')
    + '\nthis.countries={countryName,compareEconomy};', context);
  assert.equal(context.countries.countryName({ country: 'US' }), 'United States');
  assert.equal(context.countries.countryName({ country: 'KR' }), 'South Korea');
  assert.equal(context.countries.countryName({ country: 'NL' }), 'Netherlands');
  assert.equal(context.countries.countryName({ country: '<script>' }), 'Unknown country');
  assert.ok(context.countries.compareEconomy({ country: 'US' }, { country: 'CN' }) < 0);
  context.ui.setLanguageValue('ko');
  assert.equal(context.countries.countryName({ country: 'US' }), '미국');
  assert.equal(context.countries.countryName({ country: 'KR' }), '한국');
  assert.equal(context.countries.countryName({ country: 'NL' }), '네덜란드');
  assert.ok(context.countries.compareEconomy({ country: 'CN' }, { country: 'DE' }) < 0);
});

test('publisher estimate caveats and unknown counts survive both languages', () => {
  const context = helpers({ valueText: String });
  vm.runInContext(dashboardSection('function publisherCountNote(', 'function publisherCountCell(')
    + '\nthis.publisherNote=publisherCountNote;', context);
  const known = context.publisherNote({ unique_publishers: 28, publisher_count_state: 'estimated_from_registry_identity', publisher_identity_basis: { name_fallback_groups: 5 } });
  const unknown = context.publisherNote({ unique_publishers: null, publisher_identity_basis: { unresolved_active_registrations: 2 } });
  assert.match(String(known), /media brands.*parent companies.*Shared hosts/);
  assert.match(String(known), /5.*registration names/);
  assert.match(String(unknown), /does not mean zero/);
  assert.match(String(unknown), /2/);
  context.ui.setLanguageValue('ko');
  assert.match(String(known), /매체 브랜드.*모회사.*공유 서버/);
  assert.match(String(known), /5개 그룹/);
  assert.match(String(unknown), /0개를 뜻하지/);
});
