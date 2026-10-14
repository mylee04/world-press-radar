'use strict';

// Rendering uses text nodes only. Source names, URLs and tool results are untrusted data.
const $ = (id) => document.getElementById(id);
const state = { overview: null, countries: [], selected: null, countryData: null, countryRequest: 0, overviewRequest: 0, accessRevision: 0, sourceCache: new Map(), run: null, poll: null, activeTab: 'status', pendingStart: null, pollFailures: 0, adminSession: null, reloadRequiredProposals: new Set() };
const numberFormat = new Intl.NumberFormat('ko-KR');
const koreanRegionNames = new Intl.DisplayNames(['ko'], { type: 'region', fallback: 'none' });
const koreanCountries = { US: '미국', KR: '한국', JP: '일본', GB: '영국', CN: '중국', FR: '프랑스', DE: '독일', IN: '인도', AU: '호주', CA: '캐나다', BR: '브라질', IT: '이탈리아', ES: '스페인', RU: '러시아', MX: '멕시코', ID: '인도네시아', TR: '튀르키예', SA: '사우디아라비아', AR: '아르헨티나', ZA: '남아프리카공화국' };
// IMF Data Mapper NGDPD: 2026 nominal GDP estimate, billion current US dollars.
// Retrieved 2026-10-13. https://www.imf.org/external/datamapper/api/v1/NGDPD/2026
const nominalGdp2026 = Object.freeze({"US":32642.373,"CN":21546.403,"JP":4341.986,"DE":5471.299,"IN":4060.207,"GB":4268.446,"FR":3554.155,"IT":2701.737,"CA":2490.256,"RU":2861.156,"KR":2245.847,"BR":2654.761,"AU":2110.657,"ES":2085.276,"MX":2176.236,"ID":1479.954,"MA":195.632,"NL":1423.856,"CH":1135.739,"TR":1817.987,"SA":1343.346,"IL":746.982,"JO":64.88,"KW":146.911,"TW":1019.596,"PL":1133.088,"SE":745.081,"BE":772.699,"TH":599.115,"IR":311.95,"AR":768.206,"CL":402.243,"DO":145.362,"UY":95.155,"AT":616.896,"NZ":273.395,"NO":651.712,"IE":709.972,"PT":375.197,"DK":499.354,"FI":338.564,"CZ":427.953,"GR":304.627,"RO":470.091,"UA":229.406,"LU":108.33,"SK":167.062,"HU":265.911,"BG":146.507,"HR":115.915,"SI":88.869,"RS":111.204,"LT":104.721,"LV":53.162,"EE":51.029,"IS":42.772,"EG":442.886,"NG":386.671,"SG":667.889,"ZA":489.083,"BH":46.018,"QA":203.044,"AE":661.018,"SV":39.379,"EC":138.199,"OM":121.397,"CO":572.735,"MY":547.1,"PH":501.692,"VN":542.13,"MN":31.131,"PK":450.134,"KZ":397.921});
function compareEconomy(a, b) {
  const left = countryCode(a), right = countryCode(b);
  const pinned = { US: 0, CN: 1 };
  const priority = (pinned[left] ?? 2) - (pinned[right] ?? 2);
  if (priority) return priority;
  return (nominalGdp2026[right] ?? -Infinity) - (nominalGdp2026[left] ?? -Infinity)
    || countryName(a).localeCompare(countryName(b), 'ko');
}
const classificationLabels = {
  failure_after_prior_success: ['과거 성공 후 실패', 'failure'], recovered_after_failure: ['회복 기록', 'healthy'],
  stale_content_evidence: ['오래된 콘텐츠', 'attention'], access_failure_without_normal_baseline: ['접근 실패 · 기준 부족', 'attention'],
  successful_no_new_discoveries: ['검사 성공 · 신규 0', 'healthy'], successful_collection: ['수집 성공', 'healthy'],
  index_only: ['목록 확인', 'neutral'], not_attempted_in_period: ['기간 내 미검사', 'neutral'], untracked_or_no_available_checks: ['미추적 · 기록 부족', 'neutral'],
  working_nonempty: ['검사 성공', 'healthy'], valid_empty: ['유효한 빈 응답', 'healthy'], fetch_failed: ['검사 실패', 'failure'], timeout: ['타임아웃', 'failure'],
  review_needed: ['조사 대상', 'attention'], partial_window: ['부분 구간', 'neutral'], insufficient_baseline: ['기준 부족', 'neutral'], no_drop_signal: ['하락 신호 없음', 'healthy'],
  running: ['실행 중', 'running'], completed: ['완료', 'healthy'], failed: ['실패', 'failure'], queued: ['대기', 'neutral'],
  not_tracked: ['미추적', 'neutral'], not_collected: ['미검사', 'neutral'], failed_or_index_only: ['실패 / 목록만 확인', 'attention'], partial: ['부분 수집', 'neutral'], complete: ['검사 완료', 'healthy'],
  history_not_in_snapshot: ['저장 이력 범위 밖', 'neutral'], not_initialized: ['추적 기록 없음', 'neutral'], initialized: ['추적 중', 'neutral'], unknown: ['미확인', 'neutral']
};
Object.assign(classificationLabels, { recent: ['최근 콘텐츠 기록', 'healthy'], stale: ['오래된 저장 검사', 'attention'], missing: ['콘텐츠 날짜 없음', 'neutral'], unreliable: ['콘텐츠 날짜 신뢰 부족', 'neutral'], healthy: ['저장 검사 성공', 'healthy'], unhealthy: ['저장 검사 실패', 'failure'], partial_snapshot_window: ['완료되지 않은 저장 구간', 'neutral'], closed_calendar_window: ['달력 구간 종료', 'neutral'], after_latest_collection: ['마지막 검사 이후', 'neutral'], history_unavailable: ['저장 이력 범위 밖', 'neutral'], unavailable: ['자료 없음', 'neutral'], observed: ['관측된 집계', 'healthy'], insufficient_endpoint_history: ['주소별 판단 근거 부족', 'neutral'], completion_not_recorded: ['회차 기록 없음', 'neutral'], incomplete_or_explicit_cycle: ['회차 비교 제외', 'neutral'], insufficient_completed_cycle_history: ['기준 축적 중', 'neutral'], insufficient_evidence: ['근거 부족', 'neutral'], lookup_failed: ['조회 실패', 'failure'], bounded_country_sample: ['일부 소스 표본 조사', 'neutral'] });

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined && content !== null) element.textContent = String(content);
  return element;
}
function valueText(value, fallback = '—') { return typeof value === 'number' && Number.isFinite(value) ? numberFormat.format(value) : fallback; }
function countryCode(country) { return String(country.country ?? country.code ?? country.countryCode ?? '').toUpperCase(); }
function countryName(country) {
  const code = countryCode(country);
  if (koreanCountries[code]) return koreanCountries[code];
  return /^[A-Z]{2}$/.test(code) ? koreanRegionNames.of(code) ?? '국가 미확인' : '국가 미확인';
}
function inventory(country) { return country.inventory ?? country; }
function metrics(country) { return country.metrics ?? country; }
function publisherCountText(counts) {
  const value = counts.unique_publishers;
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${counts.publisher_count_state === 'estimated_from_registry_identity' ? '≈ ' : ''}${valueText(value)}`;
}
function publisherCountNote(counts) {
  if (typeof counts.publisher_count_semantics === 'string' && counts.publisher_count_semantics) return counts.publisher_count_semantics;
  if (typeof counts.unique_publishers !== 'number' || !Number.isFinite(counts.unique_publishers)) return '언론사 식별 근거가 없어 계산할 수 없습니다. 0개를 뜻하지 않습니다.';
  return counts.publisher_count_state === 'estimated_from_registry_identity' ? '등록된 소스의 식별 정보를 묶은 언론사 수 추정치입니다.' : '활성 등록에서 중복을 제거한 고유 언론사 수입니다.';
}
function publisherCountCell(counts) { const cell = node('td', 'numeric publisher-count', publisherCountText(counts)); cell.title = publisherCountNote(counts); return cell; }
function countryTableColumns() { return 9 - Number($('freshness-heading').hidden) - Number($('observation-heading').hidden); }
function timeText(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '미확인';
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}
function clockText(value) { return value && Number.isFinite(Date.parse(value)) ? `${new Date(value).toISOString().slice(11, 23)} UTC` : '시각 미확인'; }
function evidenceTimeText(timestamp, calendarDate) {
  if (typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return timeText(timestamp);
  const date = calendarDate ?? timestamp;
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) ? `${date} UTC (날짜 기록)` : '미확인';
}
function badge(value, fallback) {
  const key = typeof value === 'object' && value !== null ? value.state ?? value.status ?? value.classification : value;
  const [label, style] = classificationLabels[key] ?? [fallback ?? key ?? '미확인', 'neutral'];
  return node('span', `badge ${style}`, label);
}
function appendMeta(target, label, value) {
  const entry = node('span', '', label);
  entry.append(node('strong', '', value ?? '미확인'));
  target.append(entry);
}
function humanInvestigationError(value) {
  if (typeof value !== 'string') return value;
  const code = value.trim();
  if (/^(OPENAI|JEV)_CONTEXT_LIMIT$/.test(code)) return '조사 입력 한도에 도달했습니다.';
  if (/^(OPENAI|JEV)_MODEL_CALL_LIMIT$/.test(code)) return '모델 호출 한도에 도달했습니다.';
  if (code === 'OPENAI_READ_TOOL_LIMIT' || code === 'INVESTIGATION_LIMIT') return '조사 실행 한도에 도달했습니다.';
  if (/^(OPENAI|JEV)_(RUN|SESSION)_BUDGET_LIMIT$/.test(code) || /^(OPENAI|JEV)_COST_BOUND_EXCEEDED$/.test(code)) return '승인된 비용 한도에 도달했습니다.';
  if (/^(OPENAI|JEV)_EXECUTION_NOT_AUTHORIZED$/.test(code)) return '이 조사 방식은 현재 실행할 수 없습니다.';
  if (/^(OPENAI|JEV)_KEY_SOURCE_(INVALID|UNAVAILABLE)$/.test(code)) return 'API 연결 설정을 확인해 주세요.';
  if (/^(OPENAI|JEV)_(PRICING_REQUIRED|PRICED_MODEL_MISMATCH|PRICED_MODEL_REQUIRED)$/.test(code)) return '모델 실행 설정을 확인해 주세요.';
  if (/^(OPENAI|JEV)_RUN_CANCELLED$/.test(code)) return '조사가 중단됐습니다.';
  if (/^(OPENAI|JEV)_(MODEL_REQUEST_FAILED|AGENT_RUN_FAILED|CLASSIFIER_RUN_FAILED)$/.test(code)) return '모델 조사를 완료하지 못했습니다. 실행 기록을 확인해 주세요.';
  if (/^(OPENAI|JEV)_(USAGE_MISSING|USAGE_COST_UNKNOWN|RESPONSE_INVALID_OR_USAGE_MISSING|ANSWER_SET_MISMATCH|PROBABILITY_CONTRACT_INVALID|RESPONSE_LIMIT)$/.test(code)) return '모델 응답을 검증하지 못했습니다.';
  if (/^(OPENAI|JEV)_[A-Z_]+$/.test(code)) return '조사를 완료하지 못했습니다. 실행 기록을 확인해 주세요.';
  return value;
}
function errorMessage(error) {
  const text = error instanceof Error ? error.message : '데이터를 불러오지 못했습니다.';
  const messages = { QUALITY_ADMIN_AUTH_REQUIRED: '관리자 로그인 정보를 확인해 주세요.', QUALITY_CLOUD_UNAVAILABLE: '서버에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.', QUALITY_CLOUD_TIMEOUT: '조회 시간이 초과됐습니다. 잠시 후 다시 확인해 주세요.', WORKFLOW_AUTH_REQUIRED: '관리자 로그인이 필요합니다.', WORKFLOW_EXACT_APPROVAL_REQUIRED: '현재 관리자 세션에서 이 수정안을 다시 승인해 주세요.', WORKFLOW_REGISTRY_CHANGED: '등록 상태가 바뀌었습니다. 후보를 다시 검토해 주세요.', WORKFLOW_VALIDATION_EXPIRED: '검사 기록이 오래됐습니다. 후보를 다시 검사해 주세요.', WORKFLOW_SOURCE_ENDPOINT_NOT_FOUND: '현재 등록에서 해당 소스 주소를 찾지 못했습니다.', WORKFLOW_ALREADY_APPLIED: '이미 적용된 제안입니다. 기록을 다시 확인해 주세요.', OPENAI_EXECUTION_NOT_AUTHORIZED: 'OpenAI 실행 설정을 확인해 주세요.', JEV_EXECUTION_NOT_AUTHORIZED: 'Jev 실행 설정을 확인해 주세요.', INVESTIGATION_BUSY: '진행 중인 조사가 있습니다. 완료 후 다시 실행해 주세요.' };
  return messages[text] ?? humanInvestigationError(text);
}
function showError(id, error) { $(id).textContent = error ? errorMessage(error) : ''; $(id).hidden = !error; }
function emptyRow(target, columns, text) { target.replaceChildren(); const row = node('tr'); const cell = node('td', 'empty-cell', text); cell.colSpan = columns; row.append(cell); target.append(row); }
function describeState(value) { return classificationLabels[value]?.[0] ?? value ?? '미확인'; }
function safeLink(url) {
  const anchor = node('a', 'endpoint-url', url || '주소 미확인');
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); anchor.href = parsed.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } catch { anchor.removeAttribute('href'); }
  return anchor;
}
class DashboardConnectionError extends Error {
  constructor() { super('대시보드 서버에 연결하지 못했습니다. 서버가 실행 중인지 확인한 뒤 연결을 다시 확인해 주세요.'); this.name = 'DashboardConnectionError'; }
}
class DashboardHttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(path, options = {}) {
  const read = !options.method || options.method === 'GET';
  // Retry only reads. A POST can have been accepted even if its response was lost.
  const attempts = read ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), /^(overview|country|source)\?/.test(path) ? 120000 : 10000);
    try {
      const response = await fetch(`/quality/api/${path}`, { ...options, signal: abort.signal,
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
      let data;
      try { data = await response.json(); } catch (error) {
        if (error instanceof TypeError || error.name === 'AbortError') throw error;
        throw new DashboardHttpError(`저장 기록 API가 JSON을 반환하지 않았습니다 (${response.status}).`, response.status);
      }
      if (!response.ok) throw new DashboardHttpError(data.error?.message ?? data.error ?? data.message ?? `조회 실패 (${response.status})`, response.status);
      return data;
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'AbortError') throw error;
      if (attempt + 1 >= attempts) throw new DashboardConnectionError();
      $('screen-status').textContent = `서버 연결 복구 중 · 읽기 요청 재확인 ${attempt + 1}/${attempts - 1}`;
      await new Promise(resolve => window.setTimeout(resolve, 500 * (attempt + 1)));
    } finally { window.clearTimeout(timeout); }
  }
}
function dateQuery(extra = {}) {
  const params = new URLSearchParams(extra);
  if ($('date-input').value) params.set('date', $('date-input').value);
  return params.toString();
}

function setTab(tab, focus = false) {
  state.activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(`panel-${button.dataset.tab}`).hidden = !active;
    if (active && focus) button.focus();
  });
}

function renderMetric(metric, unavailableLabel) {
  const element = node('div', 'metric');
  if (typeof metric === 'number') metric = { value: metric };
  const known = metric && typeof metric.value === 'number' && Number.isFinite(metric.value);
  if (!known) {
    const reason = unavailableLabel ?? (metric?.denominator === 0 ? '평가 대상 없음' : '자료 미제공');
    element.append(node('span', 'metric-unknown', '—'));
    element.title = reason;
    return element;
  }
  const amount = metric.value;
  const main = node('span', 'metric-value', amount.toFixed(1));
  main.append(node('span', 'metric-unit', '%'));
  element.append(main);
  const fraction = typeof metric.numerator === 'number' && typeof metric.denominator === 'number' ? `${valueText(metric.numerator)} / ${valueText(metric.denominator)} 주소` : '비율';
  element.append(node('span', 'metric-fraction', fraction));
  const bar = node('meter', `metric-bar${amount < 50 ? ' bad' : amount < 80 ? ' low' : ''}`);
  bar.min = 0; bar.max = 100; bar.value = Math.max(0, Math.min(100, amount)); bar.setAttribute('aria-hidden', 'true'); element.append(bar);
  return element;
}

function appendCollectionSchedule(cell, country) {
  const schedule = country.collection_schedule;
  if (schedule?.policy !== 'daily_all_active' || !schedule.as_of || !Number.isFinite(Date.parse(schedule.as_of))) return;
  const reportDate = country.date ?? country.period?.date ?? state.overview?.date ?? $('date-input').value;
  if (reportDate && new Date(schedule.as_of).toISOString().slice(0, 10) !== reportDate) return;
  const notes = node('div', 'collection-schedule');
  const positive = (count) => typeof count === 'number' && Number.isFinite(count) && count > 0;
  const observed = `확인 ${timeText(schedule.as_of)}`;
  if (positive(schedule.deferred_endpoints)) {
    const note = node('span', 'schedule-deferred', `서버 대기 ${valueText(schedule.deferred_endpoints)}`);
    note.title = `서버가 요청한 재검사 대기시간을 따릅니다. ${schedule.next_recheck_at ? `다음 재검사 ${timeText(schedule.next_recheck_at)} · ` : ''}${observed}`;
    notes.append(note);
  }
  if (positive(schedule.unattempted_unrestricted_endpoints)) {
    const running = schedule.cycle_status === 'running';
    const note = node('span', 'schedule-unattempted', `${running ? '검사 전' : '미검사'} ${valueText(schedule.unattempted_unrestricted_endpoints)}`);
    note.title = `서버 제한 대기 없이 ${running ? '이번 회차 검사를 기다리는' : '아직 검사 기록이 없는'} 주소입니다. ${observed}`;
    notes.append(note);
  }
  if (notes.childElementCount) cell.append(notes);
}

function countryAssessment(country) {
  const baseline = country.completed_cycle_baseline;
  if (baseline?.state === 'comparable_completed_cycles') return { state: baseline.reasons?.length ? 'review_needed' : 'no_drop_signal', reasons: baseline.reasons ?? [], scope: 'completed_cycles' };
  if (baseline?.state) return { state: baseline.state, reasons: baseline.reasons ?? [], scope: 'completed_cycles' };
  if (country.operational_anomaly?.state) return { ...country.operational_anomaly, scope: 'completed_cycles' };
  return country.anomaly ?? { state: country.period?.state };
}
function observationNote(data) {
  const countries = data.items ?? data.countries ?? [];
  const partial = countries.some((country) => country.period?.observation_window_closed === false || country.period?.run_completion === 'partial' || country.period?.run_completion === 'failed');
  const completed = countries.filter((country) => {
    const baseline = country.completed_cycle_baseline;
    if (baseline) return ['comparable_completed_cycles', 'insufficient_completed_cycle_history'].includes(baseline.state)
      && baseline.current?.attempt_coverage === 100;
    // A legacy status alone can describe a completed explicit-address probe.
    // Count it only if full production cohort metadata independently proves it.
    const period = country.period ?? {};
    return period.run_completion === 'completed' && period.lane === 'production' && period.scope === 'due_endpoints'
      && Number.isSafeInteger(period.eligible_endpoints) && period.eligible_endpoints > 0
      && period.eligible_endpoints === period.planned_endpoints && period.planned_endpoints === period.attempted_endpoints;
  }).length;
  const clauses = [`${data.date || '날짜 없음'} UTC 기록`, partial ? '부분 구간 포함' : '저장된 검사 범위'];
  clauses.push(completed ? `완료 회차 기록 ${completed}/${countries.length}개국` : '완료 회차 기록 없음');
  const common = data.completed_cycle_common_signal ?? data.common_collector_signal;
  if (common?.state === 'investigate_common_collector_first') clauses.push('동시 하락 신호 · 공통 원인 우선 조사');
  return clauses.join(' / ');
}

function renderCountries() {
  const search = $('country-search').value.trim().toLocaleLowerCase();
  const exactCode = state.countries.some((country) => countryCode(country).toLocaleLowerCase() === search);
  const countries = state.countries.filter((country) => exactCode ? countryCode(country).toLocaleLowerCase() === search : [countryCode(country), countryName(country), country.name].some((value) => String(value ?? '').toLocaleLowerCase().includes(search)));
  const sort = $('country-sort').value;
  const metricSort = (country, kind) => metrics(country)[kind]?.value ?? Infinity;
  const attentionRank = (country) => ({ review_needed: 0, partial_window: 1, incomplete_or_explicit_cycle: 1, insufficient_baseline: 2, insufficient_completed_cycle_history: 2, completion_not_recorded: 2, no_drop_signal: 3 })[countryAssessment(country).state] ?? 2;
  countries.sort((a, b) => {
    if (sort === 'economy') return compareEconomy(a, b);
    if (sort === 'coverage') return metricSort(a, 'attempt_coverage') - metricSort(b, 'attempt_coverage');
    if (sort === 'success') return metricSort(a, 'success_rate') - metricSort(b, 'success_rate');
    if (sort === 'inventory') return (inventory(b).active_source_registrations ?? 0) - (inventory(a).active_source_registrations ?? 0);
    if (sort === 'attention' && attentionRank(a) !== attentionRank(b)) return attentionRank(a) - attentionRank(b);
    return countryName(a).localeCompare(countryName(b), 'ko');
  });
  $('country-count').textContent = `${countries.length}`;
  const showFreshness = state.countries.some((country) => typeof metrics(country).freshness?.value === 'number');
  $('freshness-heading').hidden = !showFreshness;
  const showObservation = state.countries.some((country) => ['review_needed', 'no_drop_signal'].includes(countryAssessment(country).state));
  $('observation-heading').hidden = !showObservation;
  const tbody = $('country-rows'); tbody.replaceChildren();
  if (!countries.length) { emptyRow(tbody, countryTableColumns(), state.countries.length ? '검색 조건에 맞는 국가가 없습니다.' : '조회 가능한 국가 기록이 없습니다.'); return; }
  countries.forEach((country) => {
    const code = countryCode(country), row = node('tr', `country-row${state.selected === code ? ' selected' : ''}`);
    const nameCell = node('td'), button = node('button', 'country-button'); button.type = 'button';
    const title = node('span', 'country-name', countryName(country));
    button.append(title); button.addEventListener('click', () => selectCountry(code, true)); nameCell.append(button); row.append(nameCell);
    row.append(publisherCountCell(inventory(country)));
    const details = metrics(country);
    ['attempt_coverage', 'success_rate', 'freshness'].forEach((kind) => {
      const cell = node('td'); cell.hidden = kind === 'freshness' && !showFreshness;
      const unavailableLabel = country.lookup_error ? '조회 실패'
        : kind === 'freshness' ? '갱신주기 이력 없음'
        : details[kind]?.denominator === 0 ? kind === 'success_rate' ? '검사 기록 없음' : '활성 주소 없음'
        : country.period?.state === 'not_tracked' ? '추적 기록 없음'
        : country.period?.state === 'history_unavailable' ? '저장 이력 범위 밖' : '검사 자료 없음';
      cell.append(renderMetric(details[kind], unavailableLabel));
      if (kind === 'attempt_coverage') appendCollectionSchedule(cell, country);
      row.append(cell);
    });
    const counts = inventory(country); row.append(node('td', 'numeric', valueText(counts.active_source_registrations)));
    const endpointCell = node('td', 'numeric endpoint-pair'); endpointCell.append(document.createTextNode(valueText(counts.unique_active_rss_endpoints)), node('span', '', '/'), document.createTextNode(valueText(counts.unique_active_sitemap_endpoints))); row.append(endpointCell);
    const assessment = countryAssessment(country), status = node('td'); status.hidden = !showObservation; status.append(badge(assessment.state));
    status.title = assessment.reasons?.length ? assessment.reasons.map((reason) => typeof reason === 'string' ? reason : `${reason.metric === 'success_rate' ? '성공률' : '검사 범위'} ${Number(reason.current).toFixed(1)}% · 기준 ${Number(reason.baseline).toFixed(1)}%`).join('\n') : assessment.scope === 'completed_cycles' ? '같은 국가·요일·수집 대상의 완료 회차를 비교합니다. 회차 기록이 없거나 충분하지 않으면 하락을 확정하지 않습니다.' : '저장된 구간을 비교한 참고 신호입니다. 완료된 수집 회차의 운영 장애 판정과 다릅니다.';
    row.append(status); const arrowCell = node('td'), arrow = node('button', 'row-arrow', '↗'); arrow.type = 'button'; arrow.setAttribute('aria-label', `${countryName(country)} 상세 보기`); arrow.addEventListener('click', () => selectCountry(code, true)); arrowCell.append(arrow); row.append(arrowCell); tbody.append(row);
  });
}

function renderSummary(data) {
  const global = data.global_inventory ?? data.global_totals ?? data.inventory?.global_totals;
  const sum = (key) => state.countries.reduce((total, country) => total + (inventory(country)[key] ?? 0), 0);
  $('stat-countries').textContent = valueText(global?.active_countries ?? state.countries.filter((country) => (inventory(country).active_source_registrations ?? 0) > 0).length);
  // The same publisher can appear in multiple countries; use the server's global deduplicated count.
  $('stat-publishers').textContent = publisherCountText(global ?? {});
  $('stat-publishers').parentElement.title = publisherCountNote(global ?? {});
  $('stat-sources').textContent = valueText(global?.active_source_registrations ?? sum('active_source_registrations'));
  // Endpoint IDs can cross country boundaries. A global unique total needs server deduplication.
  $('stat-rss').textContent = valueText(global?.unique_active_rss_endpoints);
  $('stat-sitemaps').textContent = valueText(global?.unique_active_sitemap_endpoints);
  $('as-of').textContent = timeText(data.latest_collection);
  $('snapshot-status').textContent = data.snapshot_at ? `스냅샷 생성 ${timeText(data.snapshot_at)}` : '저장 데이터 시각 미확인';
  const date = data.date ?? $('date-input').value;
  if (date) $('date-input').value = date;
  $('data-note').textContent = observationNote({ ...data, date, items: state.countries });
  const runtime = data.runtime ?? {};
  const investigationsEnabled = runtime.investigations_enabled !== false;
  ['openai', 'jev'].forEach((engine) => {
    const provider = runtime[engine] ?? {};
    const option = $('investigation-engine').querySelector(`option[value="${engine}"]`);
    option.disabled = !provider.available || !investigationsEnabled;
    option.textContent = `${engine === 'openai' ? 'OpenAI' : 'Jev'}${provider.available ? '' : ' · 준비 필요'}`;
  });
  const selectedEngine = $('investigation-engine').selectedOptions[0];
  if (selectedEngine?.disabled) $('investigation-engine').value = 'rules';
  renderEngineStatus();
  renderExecutionAccess();
}

function canRunInvestigation() {
  const runtime = state.overview?.runtime ?? {};
  return runtime.investigations_enabled !== false && (!runtime.admin_auth_required || state.adminSession?.authenticated === true);
}
function renderExecutionAccess() {
  const runtime = state.overview?.runtime ?? {};
  const cloud = runtime.admin_auth_required === true;
  const authenticated = state.adminSession?.authenticated === true;
  const allowed = canRunInvestigation();
  const busy = ['running', 'queued'].includes(state.run?.status);
  $('start-investigation').disabled = !allowed || busy;
  $('investigate-selected').disabled = !allowed || busy;
  $('investigate-selected').hidden = cloud && !authenticated;
  $('investigation-form').hidden = cloud && !authenticated;
  $('admin-access').hidden = !cloud || !runtime.admin_login_enabled;
  $('admin-access').textContent = authenticated ? '로그아웃' : '관리자';
  if (authenticated || !cloud) $('admin-login-form').hidden = true;
  $('runtime-note').hidden = allowed || cloud;
  $('runtime-note').textContent = '이 환경에서는 조사 실행을 사용할 수 없습니다.';
  $('run-history').open = cloud && !authenticated;
  if (cloud && !authenticated && !state.run) {
    $('investigation-empty').querySelector('h3').textContent = '저장된 조사 결과를 확인하세요.';
    $('investigation-empty').querySelector('p').textContent = '완료된 조사와 근거가 이곳에 표시됩니다.';
  }
}

function renderEngineStatus() {
  const engine = $('investigation-engine').value;
  const provider = state.overview?.runtime?.[engine] ?? {};
  const name = engine === 'openai' ? 'OpenAI' : engine === 'jev' ? 'Jev' : '규칙 기반';
  $('investigation-mode').textContent = `${name} · 읽기 전용`;
  const note = $('openai-note'); note.hidden = engine === 'rules';
  note.textContent = engine === 'openai'
    ? provider.available ? `다음 조회를 모델이 선택합니다. 조사 한도 $${provider.per_run_budget_usd ?? '—'}.` : '실행 비용 한도와 API 설정이 필요합니다.'
    : engine === 'jev' ? '저장 근거를 분류합니다. 다음 조회는 규칙이 선택합니다.' : '';
}

function registryHistoryView(data) {
  const history = data.history ?? {}, changes = data.inventory_changes ?? data.registry_changes ?? {};
  const date = data.date ?? history.date ?? changes.date;
  const observed = history.baseline_observed_at && Array.isArray(history.observed_registry_changes) && (!history.date || history.date === date);
  const rows = Array.isArray(changes) ? changes : changes.per_country ?? changes.countries ?? changes.items ?? [];
  const keys = ['added', 'additions', 'deactivations', 'reactivations', 'reactivated', 'deletions', 'net_change', 'net'];
  const actual = (!changes.date || changes.date === date) && (changes.recorded_events_only === true || changes.history_complete === true)
    && rows.some((row) => keys.some((key) => typeof row[key] === 'number'));
  const additions = [changes.additions, changes.new_sources, data.new_sources,
    Array.isArray(changes.events) ? changes.events.filter(event => ['added', 'source_added'].includes(event.type)) : null].find(Array.isArray) ?? [];
  const events = additions
    .filter(source => {
      const at = source.recorded_at ?? source.added_at ?? source.at;
      return typeof at === 'string' && Number.isFinite(Date.parse(at)) && new Date(at).toISOString().slice(0, 10) === date;
    });
  const recordedChanges = events.length > 0 || rows.some(row => keys.some(key => typeof row[key] === 'number' && row[key] !== 0));
  if (actual && (recordedChanges || !observed)) {
    const known = new Set([...events, ...(changes.source_transitions ?? [])].map(source => source.source_id).filter(Boolean));
    // A source with a real dated event is listed once. Other observation-only
    // changes keep their unknown occurrence date and observation interval.
    const observations = observed ? history.observed_registry_changes.filter(source => !known.has(source.source_id)) : [];
    return { mode: 'actual', date, rows, events, observations, registryAt: changes.as_of };
  }
  if (observed) return {
    mode: 'observed', date: history.date ?? data.date, rows: history.per_country ?? [], events: history.observed_registry_changes,
    baseline: history.baseline_observed_at, latest: history.latest_registry_observed_at,
    registryAt: history.registry_snapshot_at, comparison: !!history.latest_registry_observed_at && Date.parse(history.latest_registry_observed_at) > Date.parse(history.baseline_observed_at)
  };
  return { mode: 'unavailable', date, rows, events: [], registryAt: changes.as_of };
}
const registryEventLabels = { registration_observed: '첫 관측', registry_removal_observed: '목록에서 사라짐', registration_reappearance_observed: '다시 관측', reactivation_observed: '재활성화 관측', deactivation_observed: '비활성화 관측' };
function renderInventory() {
  const data = state.overview ?? {}, view = registryHistoryView(data);
  const countries = [...state.countries].sort((a, b) => (inventory(b).active_source_registrations ?? 0) - (inventory(a).active_source_registrations ?? 0));
  const tbody = $('inventory-rows'); tbody.replaceChildren();
  countries.forEach((country) => {
    const row = node('tr'), counts = inventory(country); row.append(node('td', 'country-name', countryName(country)));
    row.append(publisherCountCell(counts));
    ['active_source_registrations', 'disabled_source_registrations', 'unique_active_rss_endpoints', 'unique_active_sitemap_endpoints'].forEach((key) => row.append(node('td', 'numeric', valueText(counts[key], country.lookup_error ? '조회 실패' : '—'))));
    tbody.append(row);
  });
  if (!countries.length) emptyRow(tbody, 6, '국가별 등록 상태를 불러오지 못했습니다.');
  const registryAt = data.registry_snapshot_at ?? view.registryAt;
  $('inventory-note').textContent = `등록 기준 ${registryAt ? timeText(registryAt) : '시각 없음'} · 보유량 순`;
  const publisherKnown = countries.length > 0 && countries.every((country) => typeof inventory(country).unique_publishers === 'number' && Number.isFinite(inventory(country).unique_publishers));
  const publisherEstimated = countries.some((country) => inventory(country).publisher_count_state === 'estimated_from_registry_identity');
  const publisherNotes = [...new Set(countries.filter((country) => typeof inventory(country).unique_publishers === 'number').map((country) => publisherCountNote(inventory(country))))];
  document.querySelectorAll('.publisher-heading').forEach((heading) => { heading.title = publisherNotes.length === 1 ? publisherNotes[0] : '활성 등록의 언론사 식별 정보를 기준으로 중복 제거합니다. 추정치에는 ≈를 표시합니다.'; });
  const availability = $('inventory-availability'); availability.replaceChildren(); $('inventory-availability-title').textContent = '언론사 수와 이력의 집계 기준';
  availability.append(node('p', '', publisherNotes.length === 1 ? publisherNotes[0] : publisherEstimated ? '≈는 등록된 소스의 식별 정보를 묶은 언론사 수 추정치입니다. 국가별 수에 집계 기준을 표시합니다.' : publisherKnown ? '언론사 수는 활성 등록의 식별 정보를 기준으로 중복 제거합니다.' : '언론사 식별 근거가 없는 국가는 —로 표시합니다. 등록 항목을 언론사 수로 세지 않습니다.'));
  availability.append(node('p', '', view.mode === 'observed' ? '완전한 등록 목록의 관측 사이에서 달라진 정규화 소스를 셉니다. 첫 관측은 최초 기준선이며, 실제 등록일·삭제일을 뜻하지 않습니다.' : view.mode === 'actual' ? '변화는 기록된 이벤트만 셉니다. 이력이 완전해야 순증을 계산합니다.' : '과거 변경 이력이 없어 이전 증가량을 계산하지 않습니다.'));
  $('inventory-history-title').textContent = view.mode === 'observed' ? '관측된 등록 변화' : '등록 변화와 신규 소스';
  $('inventory-change-heading').textContent = view.mode === 'observed' ? '국가별 관측 변화' : '등록 변화';
  const historyBody = $('inventory-history-rows'), head = $('inventory-history-head'); historyBody.replaceChildren(); head.replaceChildren();
  const headings = view.mode === 'observed' ? ['국가', '첫 관측', '다시 관측', '재활성화', '비활성화', '사라짐', '관측 순증'] : ['국가', '기록된 추가', '기록된 비활성화', '기록된 재활성화', '기록된 삭제', '순증'];
  headings.forEach((name, index) => { const cell = node('th', index ? 'numeric' : '', name); cell.scope = 'col'; head.append(cell); });
  $('inventory-history-caption').textContent = view.mode === 'observed' ? '조회일 UTC에 관측된 정규화 소스 변화. 실제 추가·삭제 시각과 다릅니다.' : '조회일 UTC에 기록된 등록 변화';
  const observedRows = [...view.rows].sort((a, b) => (b.observed_additions ?? 0) - (a.observed_additions ?? 0) || compareEconomy(a, b));
  const actualRows = countries.map((country) => view.rows.find((change) => countryCode(change) === countryCode(country)) ?? country.inventory_changes ?? { country: countryCode(country) })
    .sort((a, b) => (b.added ?? b.additions ?? 0) - (a.added ?? a.additions ?? 0) || compareEconomy(a, b));
  const rows = view.mode === 'observed' ? observedRows : actualRows;
  $('inventory-history-table').hidden = view.mode === 'unavailable' || view.mode === 'observed' && !view.rows.length;
  if (!$('inventory-history-table').hidden) rows.forEach((change) => {
    const row = node('tr'); row.append(node('td', 'country-name', countryName(change)));
    const counts = view.mode === 'observed' ? [change.observed_additions, change.observed_reappearances, change.observed_reactivations, change.observed_deactivations, change.observed_registry_removals, change.observed_net_normalized_sources] : [change.added ?? change.additions, change.deactivations, change.reactivations ?? change.reactivated, change.deletions, change.net_change ?? change.net];
    counts.forEach((count) => { const cell = node('td', 'numeric', valueText(count)); if (typeof count !== 'number') cell.title = '이력이 없어 계산할 수 없습니다. 0건을 뜻하지 않습니다.'; row.append(cell); }); historyBody.append(row);
  });
  const beforeBaseline = view.mode === 'observed' && view.date < String(view.baseline).slice(0, 10);
  $('inventory-history-note').textContent = view.mode === 'observed'
    ? beforeBaseline ? `관측 시작 ${timeText(view.baseline)} · 조회일은 관측 이전입니다.`
      : !view.comparison ? `관측 기준선 ${timeText(view.baseline)} · 다음 완전한 목록부터 변화를 비교합니다.`
        : `${view.date} UTC에 발견한 관측 사이 변화 · 정규화 소스 기준 · 실제 추가·삭제일 미상`
    : view.mode === 'actual' ? `${view.date} UTC 기록 · —는 이력 없음. 0은 기록된 이벤트 없음. 과거 추가일은 추정하지 않습니다.` : '이력이 없어 과거 증가량을 집계하지 않습니다. 신규 0건을 뜻하지 않습니다.';
  $('source-events-title').textContent = view.mode === 'observed' ? '관측된 소스 변화' : '신규 소스 목록';
  const events = view.mode === 'observed' ? [...view.events].reverse() : [...view.events, ...(view.observations ?? [])], list = $('new-source-list'); list.replaceChildren();
  $('new-source-count').textContent = view.mode === 'observed' ? beforeBaseline ? '관측 이전' : !view.comparison ? '최초 기준선' : `관측 ${events.length}건` : view.mode === 'actual' ? `기록된 추가 ${view.events.length}개${view.observations?.length ? ` · 별도 관측 ${view.observations.length}건` : ''}` : '추가 이력 미제공';
  if (view.mode === 'actual' && view.events.length) $('inventory-history-details').open = true;
  if (!events.length) {
    list.append(node('div', 'inventory-empty', beforeBaseline ? '이 날짜는 관측 시작 이전입니다.' : view.mode === 'observed' ? view.comparison ? '조회일에 기록된 관측 변화가 없습니다. 실제 변화 없음과 다릅니다.' : '첫 목록을 기준선으로 저장했습니다. 과거 소스를 신규 추가로 세지 않습니다.' : view.mode === 'actual' ? '조회일에 기록된 추가가 없습니다.' : '등록 추가 이력이 제공되지 않습니다.'));
    return;
  }
  events.forEach((source) => {
    const observation = Boolean(registryEventLabels[source.kind]);
    const card = node('article', 'new-source-card'); card.append(node('h3', '', source.name ?? source.source_name ?? source.source?.name ?? '이름 없음'));
    const types = [...new Set((source.endpoints ?? []).map((endpoint) => endpoint.type))].map((type) => type === 'sitemap' ? '사이트맵' : type === 'rss' ? 'RSS' : type);
    card.append(node('p', '', `${countryName(source)} · ${types.join(' / ') || (source.endpoint_types ?? []).join(' / ') || source.type || source.endpoint_type || '유형 없음'}${observation ? ` · ${registryEventLabels[source.kind]}` : ''}`));
    card.append(node('p', '', observation ? `관측 구간 ${timeText(source.previous_observed_at).replace(' UTC', '')} → ${timeText(source.observed_at)}` : `기록된 추가 ${timeText(source.recorded_at ?? source.added_at ?? source.at)}`));
    for (const endpoint of source.endpoints ?? []) {
      const check = endpoint.latest_validation;
      if (check) { const line = node('p', '', `검증 ${timeText(check.checked_at)} · HTTP ${valueText(check.http_status)}`); line.append(badge(check.status)); card.append(line); }
      card.append(safeLink(endpoint.url));
      if (check?.reason) card.append(node('p', '', check.reason));
    }
    if (source.url) card.append(safeLink(source.url));
    if (source.validation?.reason ?? source.reason) card.append(node('p', '', source.validation?.reason ?? source.reason));
    list.append(card);
  });
}

async function loadOverview() {
  const request = ++state.overviewRequest;
  $('refresh').disabled = true; showError('page-error', null); $('screen-status').textContent = '국가별 저장 기록을 조회합니다.';
  try {
    const data = await api(`overview?${dateQuery()}`);
    if (request !== state.overviewRequest) return;
    state.overview = data; state.countries = data.items ?? data.countries ?? []; state.sourceCache.clear();
    renderSummary(data); renderCountries(); renderInventory();
    loadRunHistory().catch(() => {});
    if (data.runtime?.repair_workflow?.enabled || data.runtime?.admin_auth_required) {
      try { state.adminSession = await api('admin/session'); if (data.runtime?.repair_workflow?.enabled) await loadProposals(); } catch { state.adminSession = null; }
      renderExecutionAccess();
    }
    const select = $('investigation-country'), previous = select.value; select.replaceChildren(node('option', '', '국가를 선택하세요')); select.firstChild.value = '';
    state.countries.forEach((country) => { const option = node('option', '', countryName(country)); option.value = countryCode(country); select.append(option); });
    select.value = state.countries.some((country) => countryCode(country) === previous) ? previous : '';
    const code = state.countries.some((country) => countryCode(country) === state.selected) ? state.selected : null;
    if (code) await selectCountry(code);
    $('screen-status').textContent = `${state.countries.length}개 국가의 저장 기록을 불러왔습니다.`;
  } catch (error) {
    if (request !== state.overviewRequest) return;
    showError('page-error', error); emptyRow($('country-rows'), countryTableColumns(), '기록 조회에 실패했습니다. 다시 조회해 주세요.');
    $('snapshot-status').textContent = '조회 실패 · 저장 데이터 연결을 확인하세요'; $('screen-status').textContent = '국가별 기록을 불러오지 못했습니다.';
  } finally { if (request === state.overviewRequest) $('refresh').disabled = false; }
}

async function selectCountry(code, scroll = false) {
  const request = ++state.countryRequest; state.selected = code; state.countryData = null;
  const country = state.countries.find((item) => countryCode(item) === code);
  $('country-detail').hidden = false; $('detail-title').textContent = `${countryName(country ?? { country: code })} 수집 상세`; $('source-list').replaceChildren(node('div', 'empty-cell', '등록 소스를 조회합니다.'));
  $('source-count').textContent = ''; $('source-search').value = ''; $('country-detail-meta').replaceChildren(); $('country-trend').replaceChildren(); showError('country-detail-error', null); renderCountries();
  $('investigation-country').value = code;
  if (scroll) $('country-detail').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  try {
    const data = await api(`country?${dateQuery({ country: code })}`);
    if (request !== state.countryRequest) return;
    state.countryData = data;
    const info = data.country && typeof data.country === 'object' ? data.country : country;
    const counts = inventory(info ?? {}); const meta = $('country-detail-meta');
    appendMeta(meta, '활성 등록', valueText(counts.active_source_registrations));
    if (typeof counts.unique_publishers === 'number' && Number.isFinite(counts.unique_publishers)) { appendMeta(meta, '고유 언론사', publisherCountText(counts)); meta.lastChild.title = publisherCountNote(counts); }
    appendMeta(meta, '마지막 검사', timeText(info?.period?.last_collection_at ?? data.latest_collection));
    const completed = country?.completed_cycle_baseline ?? info?.completed_cycle_baseline;
    if (completed?.state === 'comparable_completed_cycles') appendMeta(meta, '비교 기준', `${valueText(completed.samples)}개 같은 요일 완료 회차`);
    else if (!completed && info?.baseline?.state === 'comparable_closed_calendar_windows') appendMeta(meta, '참고 기준', `${valueText(info.baseline.samples)}개 같은 요일 저장 구간`);
    renderCountryTrend(info);
    renderSources();
  } catch (error) { if (request !== state.countryRequest) return; showError('country-detail-error', error); $('source-list').replaceChildren(node('div', 'empty-cell', '소스 상세 조회에 실패했습니다. 국가를 다시 선택해 주세요.')); }
}

function renderCountryTrend(country) {
  const target = $('country-trend'); target.replaceChildren();
  if (!country?.daily?.length) return;
  const caption = node('div', 'trend-caption', '최근 7일 · 국가 자체의 저장 관측');
  caption.append(node('span', '', '검사 범위 / 성공률 · UTC'));
  target.append(caption);
  const grid = node('div', 'trend-grid');
  country.daily.forEach((day) => {
    const card = node('div', 'trend-day');
    card.append(node('span', 'trend-date', String(day.date).slice(5)));
    const ratio = (metric) => metric && typeof metric.value === 'number' ? `${metric.value.toFixed(0)}%` : '—';
    const value = node('div', 'trend-value', ratio(day.attempt_coverage)); value.append(node('span', '', '/'), document.createTextNode(ratio(day.success_rate))); card.append(value);
    card.append(node('span', 'trend-state', day.period?.observation_window_closed ? '저장 구간 종료' : day.period?.state === 'not_tracked' ? '미추적' : day.period?.state === 'after_latest_collection' ? '마지막 검사 이후' : day.period?.state === 'history_unavailable' ? '이력 없음' : '불완전 구간'));
    card.title = `${day.date} UTC · 검사 범위 ${ratio(day.attempt_coverage)} · 수집 성공률 ${ratio(day.success_rate)} · ${describeState(day.period?.state)}`;
    grid.append(card);
  });
  target.append(grid);
}

function renderSources() {
  const query = $('source-search').value.trim().toLocaleLowerCase();
  const all = state.countryData?.sources ?? state.countryData?.items ?? [];
  const sources = all.filter((source) => [source.name, ...((source.endpoints ?? []).map((endpoint) => endpoint.url))].some((value) => String(value ?? '').toLocaleLowerCase().includes(query)));
  sources.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
  $('source-count').textContent = `${sources.length} / ${all.length}`;
  const list = $('source-list'); list.replaceChildren();
  if (!sources.length) { list.append(node('div', 'empty-cell', query ? '검색 조건에 맞는 소스가 없습니다.' : '이 국가에 조회 가능한 등록 소스가 없습니다.')); return; }
  sources.forEach((source) => {
    const card = node('details', 'source-card'), summary = node('summary'), heading = node('div', 'source-heading');
    const marker = node('span', '', '+'); marker.setAttribute('aria-hidden', 'true'); heading.append(marker);
    const title = node('div'); title.append(node('h3', '', source.name ?? '이름 미확인'), node('p', '', [source.category, source.language].filter(Boolean).join(' · ') || `${source.id ?? '소스 ID 미확인'}`)); heading.append(title);
    const meta = node('div', 'source-heading-meta'); meta.append(node('span', 'registration-meta', `등록 ${valueText(source.activeRegistrationCount ?? source.active_registration_count)}개`), node('span', '', `${source.endpoints?.length ?? 0}개 주소`));
    if (source.initialization ?? source.status) meta.append(badge(source.initialization ?? source.status));
    summary.append(heading, meta); const content = node('div', 'source-content'); card.append(summary, content); list.append(card);
    card.addEventListener('toggle', async () => {
      marker.textContent = card.open ? '−' : '+';
      if (!card.open || content.dataset.loaded === 'true') return;
      content.dataset.loaded = 'true'; content.replaceChildren(node('div', 'empty-cell', '이 소스의 실제 활동 이력을 조회합니다.'));
      const key = `${source.id}:${$('date-input').value}`;
      try {
        if (!state.sourceCache.has(key)) state.sourceCache.set(key, api(`source?${dateQuery({ source_id: source.id })}`));
        const detail = await state.sourceCache.get(key);
        renderSourceDetail(content, detail, source);
      } catch (error) { state.sourceCache.delete(key); content.dataset.loaded = 'false'; content.replaceChildren(node('p', 'notice danger', errorMessage(error))); }
    });
  });
}

function aggregateValue(period) { return period && typeof period.new_unique_candidate_urls === 'number' ? period.new_unique_candidate_urls : null; }
function periodNote(period) {
  if (!period) return '기록 없음';
  const notes = [];
  if (period.unknown_days > 0) notes.push(`${period.unknown_days}일 미확인`);
  if (period.interval_may_be_open_or_incomplete) notes.push('불완전 구간');
  if (period.state) notes.push(describeState(period.state));
  return notes.join(' · ') || '기준선 제외';
}
function renderSourceDetail(content, detail, source) {
  content.replaceChildren();
  const activity = detail.article_activity ?? {};
  const section = node('div', 'source-activity'); const description = node('div', 'activity-description', '신규 발견 URL');
  description.append(node('p', 'small-note', '최초 기준선 제외 · 소스 내 중복 제거 · 발행 기사 수와 다름')); section.append(description);
  const counts = node('dl');
  [['daily', '조회일'], ['weekly', '최근 7일'], ['monthly', '최근 30일']].forEach(([key, label]) => {
    const period = activity[key], group = node('div'); group.append(node('dt', '', label)); const value = node('dd', '', valueText(aggregateValue(period))); value.append(node('small', '', periodNote(period))); group.append(value); counts.append(group);
    if (period?.from && period?.to_exclusive) group.title = `${timeText(period.from)} ~ ${timeText(period.to_exclusive)} 미포함`;
  });
  section.append(counts); content.append(section);
  const endpoints = detail.endpoints ?? source.endpoints ?? [];
  if (!endpoints.length) content.append(node('p', 'notice', '등록된 주소가 없습니다.'));
  endpoints.forEach((endpoint) => {
    const card = node('article', 'endpoint-card'), header = node('div', 'endpoint-header'), address = node('div'); address.append(node('span', 'endpoint-type', endpoint.type === 'sitemap' ? '사이트맵' : endpoint.type === 'rss' ? 'RSS' : '주소'), safeLink(endpoint.url));
    header.append(address, badge(endpoint.classification ?? endpoint.health?.status)); card.append(header);
    const health = endpoint.health ?? {}; const daily = endpoint.daily ?? {}; const evidence = [];
    if (health.checked_at) evidence.push(`저장 검사 ${timeText(health.checked_at)}`);
    if (typeof daily.successful_checks === 'number' || typeof daily.failed_checks === 'number') evidence.push(`검사 성공 ${valueText(daily.successful_checks)} · 실패 ${valueText(daily.failed_checks)}`);
    if (health.newest_content_at) evidence.push(`최근 콘텐츠 날짜 ${timeText(health.newest_content_at)}`);
    if (health.content_freshness) evidence.push(`저장 콘텐츠 날짜: ${health.content_freshness === 'stale' ? '오래됨' : describeState(health.content_freshness)}`);
    if (endpoint.prior_success_at) evidence.push(`이전 정상 ${timeText(endpoint.prior_success_at)}`);
    if (evidence.length) card.append(node('p', 'endpoint-summary', evidence.join(' · ')));
    const urlCounts = node('div', 'endpoint-counts');
    [['daily', '일'], ['weekly', '주'], ['monthly', '월']].forEach(([key, label]) => { const item = node('span', '', `${label} 고유 URL`); item.append(node('strong', '', valueText(endpoint[key]?.new_unique_candidate_urls, '미집계'))); urlCounts.append(item); });
    const hasIndependentCounts = ['daily', 'weekly', 'monthly'].some((key) => typeof endpoint[key]?.new_unique_candidate_urls === 'number');
    if (hasIndependentCounts) card.append(urlCounts);
    const attribution = [['daily', '일'], ['weekly', '주'], ['monthly', '월']].map(([key, label]) => `${label} ${valueText(endpoint[key]?.attributed_source_new_urls)}`).join(' · ');
    if (!hasIndependentCounts) {
      const limitation = node('details', 'endpoint-raw'); limitation.append(node('summary', '', '주소별 URL 집계 범위'), node('p', 'endpoint-limitation', `주소별 고유 발견 수는 이력이 없어 계산하지 않습니다. 소스 집계에 귀속된 URL: ${attribution}. 발행 기사 수와 다릅니다.`)); card.append(limitation);
    }
    if (endpoint.days?.length) {
      const dailyHistory = node('details', 'endpoint-raw endpoint-history');
      dailyHistory.append(node('summary', '', '최근 7일 검사 · 발견 기록'));
      const shell = node('div', 'table-shell'); const table = node('table');
      const caption = node('caption', 'sr-only', '주소별 최근 7일 검사 수, 성공 검사 수와 소스 귀속 신규 URL'); table.append(caption);
      const head = node('thead'), headerRow = node('tr');
      ['UTC 날짜', '검사', '성공', '소스 귀속 URL', '구간'].forEach((label) => { const cell = node('th', '', label); cell.scope = 'col'; headerRow.append(cell); }); head.append(headerRow); table.append(head);
      const body = node('tbody'); endpoint.days.forEach((day) => { const row = node('tr'); row.append(node('td', '', day.date), node('td', 'numeric', valueText(day.checks)), node('td', 'numeric', valueText(day.successful_checks)), node('td', 'numeric', valueText(day.attributed_source_new_urls)), node('td', '', describeState(day.period?.state))); body.append(row); }); table.append(body); shell.append(table); dailyHistory.append(shell); card.append(dailyHistory);
    }
    const raw = node('details', 'endpoint-raw'); raw.append(node('summary', '', '검사 근거와 집계 범위 보기'), node('pre', '', JSON.stringify({ classification: endpoint.classification, health: endpoint.health, daily: endpoint.daily, weekly: endpoint.weekly, monthly: endpoint.monthly, days: endpoint.days }, null, 2))); card.append(raw); content.append(card);
  });
}

function renderRun(run) {
  state.run = run; state.pendingStart = null; state.pollFailures = 0; $('reconnect-investigation').hidden = true; $('investigation-empty').hidden = true; $('investigation-run').hidden = false;
  const country = state.countries.find((item) => countryCode(item) === run.country);
  $('run-title').textContent = `${countryName(country ?? { country: run.country })} 조사`;
  $('run-meta').textContent = `${run.date ?? '날짜 없음'} UTC 저장 기록 · ${timeText(run.started_at)}`;
  $('run-meta').title = `실행 ID ${run.id}`;
  const status = badge(run.status); $('run-status').className = status.className; $('run-status').textContent = status.textContent;
  const summary = $('run-summary'); summary.replaceChildren(); summary.hidden = !run.summary && !run.findings?.length;
  if (!summary.hidden) {
    summary.append(node('h4', '', '조사 결과'));
    if (run.summary) {
      const text = typeof run.summary === 'string' ? run.status === 'failed' ? humanInvestigationError(run.summary) : run.summary.replace(new RegExp(`^${run.country}:\\s*`), '') : JSON.stringify(run.summary, null, 2);
      summary.append(node('div', 'result-summary', text));
    }
    const findings = Array.isArray(run.findings) ? run.findings : [];
    const normal = new Set(['successful_collection', 'successful_no_new_discoveries', 'index_only', 'recovered_after_failure']);
    const actionable = findings.filter((finding) => typeof finding === 'string' || !normal.has(finding.classification ?? finding.state ?? finding.kind));
    const remainder = findings.filter((finding) => !actionable.includes(finding));
    const appendFinding = (list, finding) => {
      const item = node('li');
      if (typeof finding === 'string') item.textContent = finding;
      else {
        const heading = node('div', 'finding-heading'); heading.append(node('strong', '', finding.source_name ?? finding.name ?? finding.title ?? '소스'), badge(finding.classification ?? finding.state ?? finding.kind)); item.append(heading);
        if (finding.url) item.append(safeLink(finding.url));
        item.append(node('p', '', finding.proposed_action ?? finding.reason ?? finding.message ?? finding.description ?? '저장 기록 기준 판단입니다.'));
        const evidence = finding.assessment?.evidence;
        if (evidence) {
          const detail = node('details', 'finding-evidence'); detail.append(node('summary', '', '판정 근거'), node('p', '', `최근 활동 ${evidenceTimeText(evidence.last_collection_at, evidence.selected_collection_date)} · 과거 정상 ${evidenceTimeText(evidence.prior_success_at, evidence.prior_success_date)} · 저장 검사 ${evidenceTimeText(evidence.health_checked_at)}`)); item.append(detail);
        }
        if (!['running', 'queued'].includes(run.status) && state.overview?.runtime?.repair_workflow?.enabled
          && finding.source_id && finding.endpoint_id && ['failure_after_prior_success', 'stale_content_evidence', 'access_failure_without_normal_baseline'].includes(finding.classification)) item.append(repairReview(finding));
      }
      list.append(item);
    };
    if (actionable.length) {
      const list = node('ul', 'finding-list'); actionable.forEach((finding) => appendFinding(list, finding)); summary.append(list);
    } else if (findings.length) summary.append(node('p', 'result-note', '확인한 범위에서 추가 점검 대상이 없습니다.'));
    if (remainder.length) {
      const disclosure = node('details', 'result-details'); disclosure.append(node('summary', '', `정상·회복 기록 ${remainder.length}건`));
      const list = node('ul', 'finding-list'); remainder.forEach((finding) => appendFinding(list, finding)); disclosure.append(list); summary.append(disclosure);
    }
  }
  const list = $('event-list');
  // Preserve disclosure states during real event polling.
  const open = new Set([...list.querySelectorAll('details[open]')].map((detail) => detail.dataset.event)); list.replaceChildren();
  (run.events ?? []).forEach((event, index) => {
    const eventState = event.status ?? (event.type === 'tool_completed' ? 'completed' : event.type === 'tool_failed' ? 'failed' : event.type === 'tool_started' ? 'running' : 'neutral');
    const item = node('li', `event ${eventState}`); const header = node('div', 'event-head');
    header.append(node('span', 'event-title', event.tool ?? event.name ?? event.type ?? '실행 이벤트'), node('span', 'event-meta', clockText(event.at))); item.append(header);
    const metadata = [describeState(eventState)];
    if (typeof event.duration_ms === 'number') metadata.push(`${event.duration_ms < 1000 ? `${event.duration_ms} ms` : `${(event.duration_ms / 1000).toFixed(2)} s`}`);
    if (typeof event.model_cost_usd === 'number') metadata.push(`모델 $${event.model_cost_usd.toFixed(4)}`);
    if (event.error) metadata.push(typeof event.error === 'string' ? event.error : JSON.stringify(event.error));
    if (event.message) metadata.push(String(event.message));
    if (event.result_truncated) metadata.push('도구 결과 표시 생략 있음');
    item.append(node('p', 'event-caption', metadata.join('  ·  ')));
    if (event.parent_id) item.append(node('p', 'event-branch', `실제 하위 작업 · 상위 ${event.parent_id}`));
    if (event.args !== undefined || event.result !== undefined || event.error) {
      const detail = node('details'); detail.dataset.event = String(event.id ?? index); detail.open = open.has(detail.dataset.event);
      detail.append(node('summary', '', event.result !== undefined ? '도구 인자 · 실제 결과' : '도구 인자 · 오류'), node('pre', '', JSON.stringify({ ...(event.args !== undefined ? { args: event.args } : {}), ...(event.result !== undefined ? { result: event.result } : {}), ...(event.error ? { error: event.error } : {}) }, null, 2))); item.append(detail);
    }
    list.append(item);
  });
  const footer = $('run-footer'); footer.replaceChildren();
  const cost = run.cost ?? {};
  const providerName = cost.provider === 'openai' ? 'OpenAI' : cost.provider === 'jev' ? 'Jev' : null;
  $('scope-model').textContent = providerName ? `${providerName} · ${valueText(cost.model_calls)}회` : '없음 · 규칙 기반';
  $('scope-model-cost').textContent = providerName ? '사용량 추정 · 실제 청구액 별도' : '$0.00';
  if (run.model_assessment) {
    const proposal = node('details', 'result-details'); proposal.append(node('summary', '', '모델의 추가 제안 · 검증 전'));
    if (run.model_assessment.summary) proposal.append(node('p', '', run.model_assessment.summary));
    const steps = node('ul');
    (run.model_assessment.proposed_steps ?? []).forEach((step) => {
      const source = (run.findings ?? []).find((finding) => finding.source_id === step.source_id);
      steps.append(node('li', '', `${source?.source_name ?? '확인된 소스'} · ${step.reason ?? step.action}`));
    });
    if (steps.childElementCount) proposal.append(steps);
    summary.append(proposal); summary.hidden = false;
  }
  const sampled = typeof run.available_sources === 'number' && typeof run.inspected_sources === 'number' && run.inspected_sources < run.available_sources;
  const scope = typeof run.inspected_sources === 'number' ? `${valueText(run.inspected_sources)}/${valueText(run.available_sources)}개 소스${sampled ? ' · 일부 조사' : ''}` : '조사 범위 집계 중';
  footer.append(node('span', '', scope), node('span', '', `MCP ${valueText(run.tool_calls)}회`));
  if (providerName) {
    footer.append(node('span', '', `${providerName} ${valueText(cost.model_calls)}회`));
    const amount = typeof cost.model_cost_usd === 'number' ? `$${cost.model_cost_usd.toFixed(4)}` : typeof cost.estimated_model_cost_usd === 'number' ? `추정 $${cost.estimated_model_cost_usd.toFixed(4)}` : '사용량 미확인';
    const charge = node('span', '', amount); charge.title = '토큰 사용량 환산은 실제 청구액과 다를 수 있습니다.'; footer.append(charge);
  } else footer.append(node('span', '', '모델 비용 $0'));
  if (run.finished_at && Number.isFinite(Date.parse(run.started_at)) && Number.isFinite(Date.parse(run.finished_at))) footer.append(node('span', '', `${((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000).toFixed(1)}초`));
  if (run.limit_reached) footer.append(node('span', '', '실행 한도 도달'));
  else if (run.truncated && !sampled) footer.append(node('span', '', '일부 기록 제외'));
  $('execution-summary').textContent = `실제 실행 기록 · ${(run.events ?? []).length}개 이벤트`;
  $('execution-summary').title = `실행 ID ${run.id}${typeof cost.input_tokens === 'number' ? ` · 입력 ${cost.input_tokens} / 출력 ${cost.output_tokens} 토큰` : ''}`;
  renderExecutionAccess();
  $('screen-status').textContent = `조사 ${describeState(run.status)}. 실제 실행 이벤트 ${(run.events ?? []).length}개.`;
}

const repairLabels = {
  proposed: '제안', approved: '승인됨', applied: '로컬 적용됨', recovered: '회복 확인', rolled_back: '되돌림',
  candidate_only: '후보 검증됨 · 적용 전', still_failing: '검사 실패', stale_content: '오래된 콘텐츠',
  valid_empty_pending: '기사 수집 확인 필요', validation_passed_waiting_for_collector: '수집 회차 대기',
  collector_success_confirmed: '수집 성공 · 새 콘텐츠 대기', registry_changed: '등록 변경 · 재검토 필요'
};
function repairStateLabel(proposal) {
  const recovery = proposal.recovery;
  const currentRecovery = recovery && (!proposal.applied_at || Date.parse(recovery.checked_at) >= Date.parse(proposal.applied_at));
  const state = currentRecovery && !['proposed', 'approved'].includes(proposal.state) ? recovery.status : proposal.state;
  return repairLabels[state] ?? '제안 기록';
}
function repairReview(finding) {
  const detail = node('details', 'repair-review'); detail.append(node('summary', '', '대체 주소 검토'));
  const form = node('form', 'repair-form');
  const label = node('label', '', '해당 언론사의 공식 홈페이지');
  const input = node('input'); input.type = 'url'; input.required = true; input.placeholder = 'https://'; input.autocomplete = 'off';
  label.append(input); form.append(label);
  const submit = node('button', 'secondary-button', '공식 후보 확인'); submit.type = 'submit'; form.append(submit); detail.append(form);
  detail.append(node('p', 'small-note', '홈페이지에 명시된 RSS·사이트맵만 확인합니다.'));
  const output = node('div', 'repair-output'); detail.append(output);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; output.replaceChildren(node('p', 'small-note', '공식 선언과 주소를 검사하는 중입니다.'));
    try {
      const data = await api('proposals', { method: 'POST', body: JSON.stringify({ source_id: finding.source_id, endpoint_id: finding.endpoint_id, official_url: input.value.trim() }) });
      output.replaceChildren();
      if (data.proposal) { renderRepairProposal(output, data.proposal); await loadProposals(); }
      else output.append(node('p', 'small-note', '검증된 대체 주소를 찾지 못했습니다. 등록은 변경하지 않았습니다.'));
      if (data.candidates?.length) {
        const candidates = node('details', 'finding-evidence'); candidates.append(node('summary', '', `검사한 후보 ${data.candidates.length}개`));
        data.candidates.forEach((candidate) => {
          const row = node('p', 'small-note', `${candidate.validation?.status === 'valid' ? '형식 검사 성공' : '검사 실패'} · ${candidate.validation?.reason ?? candidate.validation?.content_freshness ?? ''}`);
          row.append(safeLink(candidate.url)); candidates.append(row);
        }); output.append(candidates);
      }
    } catch (error) { output.replaceChildren(node('p', 'notice danger', errorMessage(error))); }
    finally { submit.disabled = false; }
  });
  return detail;
}
function renderRepairProposal(target, proposal, reloadRequired = false) {
  target.replaceChildren();
  const content = proposal.content ?? {}, card = node('article', 'repair-card');
  if (reloadRequired && content.proposal_id) state.reloadRequiredProposals.add(content.proposal_id);
  reloadRequired ||= state.reloadRequiredProposals.has(content.proposal_id);
  const heading = node('div', 'finding-heading'); heading.append(node('strong', '', content.source_name ?? '주소 수정 제안'), node('span', 'badge neutral', repairStateLabel(proposal))); card.append(heading);
  const addresses = node('dl', 'repair-addresses');
  [['현재', content.old_url], ['변경', content.new_url], ['공식 선언', content.candidate?.official_document_url ?? content.official_url]].forEach(([name, url]) => {
    const value = node('dd'); value.append(safeLink(url)); addresses.append(node('dt', '', name), value);
  }); card.append(addresses);
  const check = content.candidate?.validation ?? {};
  card.append(node('p', 'small-note', `HTTP ${valueText(check.http_status)} · ${valueText(check.entries_with_url)}개 URL 포함 · ${timeText(check.checked_at)}`));
  const scopeNote = node('p', 'small-note', reloadRequired ? '로컬 등록부 적용됨 · 서버 다시 시작/운영 배포 필요' : ['applied', 'recovered'].includes(proposal.state) ? '로컬 등록부 적용됨 · 운영 배포는 별도입니다.' : '적용은 로컬 등록에만 반영됩니다. 운영 배포는 별도입니다.');
  if (reloadRequired) scopeNote.setAttribute('role', 'status'); card.append(scopeNote);
  const output = node('p', 'small-note'); output.setAttribute('role', 'status'); card.append(output);
  const controls = node('div', 'repair-controls');
  const owner = state.adminSession?.authenticated === true;
  const submit = async (action, body, button) => {
    controls.querySelectorAll('button').forEach((control) => { control.disabled = true; }); output.textContent = '처리 중';
    try {
      const result = await api(`proposals/${encodeURIComponent(content.proposal_id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      const updated = result.proposal ?? result;
      renderRepairProposal(target, updated, result.registry_reload_required === true); await loadProposals();
    } catch (error) {
      if (error instanceof DashboardConnectionError) {
        try {
          const data = await api('proposals');
          const restored = (Array.isArray(data) ? data : data.items ?? []).find((item) => item.content?.proposal_id === content.proposal_id);
          if (restored) { renderRepairProposal(target, restored); await loadProposals(); return; }
        } catch { /* Never replay approval or registry mutations after a lost response. */ }
      }
      output.textContent = errorMessage(error);
      controls.querySelectorAll('button').forEach((control) => { control.disabled = control.dataset.action === 'verify' ? false : !owner || (control.dataset.action === 'approve' && !card.querySelector('input[type=checkbox]')?.checked); });
    }
  };
  if (['proposed', 'approved'].includes(proposal.state)) {
    const confirm = node('label', 'repair-confirm'); const checkbox = node('input'); checkbox.type = 'checkbox';
    confirm.append(checkbox, document.createTextNode('공식 홈페이지와 위 주소 교체를 확인했습니다.')); card.append(confirm);
    const approve = node('button', 'secondary-button', proposal.state === 'approved' ? '승인 갱신' : '수정 승인'); approve.type = 'button'; approve.dataset.action = 'approve'; approve.disabled = true;
    checkbox.addEventListener('change', () => { approve.disabled = !owner || !checkbox.checked; });
    approve.addEventListener('click', () => submit('approve', { proposal_digest: proposal.proposal_digest, expected_registry_hash: content.registry_hash }, approve)); controls.append(approve);
    if (proposal.state === 'approved') {
      const approval = (proposal.approvals ?? []).filter((item) => item.action === 'apply').at(-1);
      if (approval) {
        const apply = node('button', 'primary-button', '승인한 수정 적용'); apply.type = 'button'; apply.dataset.action = 'apply'; apply.disabled = !owner;
        apply.addEventListener('click', () => submit('apply', { approval_id: approval.approval_id, expected_registry_hash: content.registry_hash }, apply)); controls.append(apply);
      }
    }
  }
  const verify = node('button', 'secondary-button', ['applied', 'recovered'].includes(proposal.state) ? '회복 확인' : '후보 재검사'); verify.type = 'button'; verify.dataset.action = 'verify';
  verify.addEventListener('click', () => submit('verify', {}, verify)); controls.append(verify); card.append(controls);
  if (!owner) card.append(node('p', 'small-note', '주소 변경은 인증된 관리자만 적용할 수 있습니다.'));
  if (['applied', 'recovered'].includes(proposal.state)) card.append(node('p', 'small-note', proposal.state === 'recovered' ? '적용 이후 정상 수집과 새 콘텐츠를 확인했습니다.' : '적용 후 정상 수집 회차와 새 콘텐츠가 확인되어야 회복으로 판단합니다.'));
  else if (proposal.recovery) card.append(node('p', 'small-note', repairLabels[proposal.recovery.status] ?? '후보 검사 기록')); 
  target.append(card);
}
async function loadProposals() {
  const revision = state.accessRevision;
  const data = await api('proposals');
  if (revision !== state.accessRevision || state.overview?.runtime?.admin_auth_required && !state.adminSession?.authenticated) return;
  const items = Array.isArray(data) ? data : data.items ?? data.proposals ?? [];
  $('repair-records').hidden = !items.length;
  $('repair-records-title').textContent = `수정 제안 ${items.length}건`;
  const list = $('repair-record-list'); list.replaceChildren();
  items.forEach((proposal) => {
    const detail = node('details', 'repair-record'); detail.append(node('summary', '', `${proposal.content?.source_name ?? '소스'} · ${repairStateLabel(proposal)}`));
    const content = node('div'); renderRepairProposal(content, proposal); detail.append(content); list.append(detail);
  });
}

function followRun(run) {
  showError('investigation-error', null); renderRun(run);
  if (!['running', 'queued'].includes(run.status)) loadRunHistory().catch(() => {});
  if (['running', 'queued'].includes(run.status)) state.poll = window.setTimeout(() => pollRun(run.id), 900);
}
async function loadRunHistory() {
  const revision = state.accessRevision;
  const data = await api('investigations');
  if (revision !== state.accessRevision) return;
  const runs = (Array.isArray(data) ? data : data.items ?? []).slice(0, 10);
  const list = $('run-history-list'); list.replaceChildren();
  $('run-history').hidden = !runs.length;
  runs.forEach((run) => {
    const button = node('button', 'history-button', `${countryName({ country: run.country })} · ${run.date ?? '날짜 없음'} · ${describeState(run.status)}`);
    button.type = 'button'; button.title = `${timeText(run.started_at)} · ${run.cost?.provider ?? 'rules'}`;
    button.addEventListener('click', async () => {
      if (state.poll) window.clearTimeout(state.poll);
      button.disabled = true;
      try { const record = await api(`investigations/${encodeURIComponent(run.id)}`); setTab('investigations'); followRun(record); }
      catch (error) { showError('investigation-error', error); }
      finally { button.disabled = false; }
    }); list.append(button);
  });
  if (state.overview?.runtime?.admin_auth_required && !state.adminSession?.authenticated && !state.run && runs[0]) {
    const latest = await api(`investigations/${encodeURIComponent(runs[0].id)}`);
    if (revision === state.accessRevision && !state.run) renderRun(latest);
  }
}

async function recoverStart(requestId) {
  try {
    const run = await api(`investigations/requests/${encodeURIComponent(requestId)}`);
    if (state.pendingStart?.request_id !== requestId) return;
    followRun(run);
  } catch (error) {
    if (state.pendingStart?.request_id !== requestId) return;
    $('reconnect-investigation').hidden = false;
    showError('investigation-error', new Error(error instanceof DashboardHttpError && error.status === 404
      ? '실행 접수 기록을 찾지 못했습니다. 서버 재시작·기록 만료 여부를 확인해 주세요. 자동으로 조사를 다시 시작하지 않았습니다.'
      : '서버 연결이 끊겨 실행 접수 여부를 확인하지 못했습니다. 연결 다시 확인으로 기존 요청을 조회할 수 있습니다.'));
    $('start-investigation').disabled = false; $('investigate-selected').disabled = false;
  }
}
async function pollRun(id) {
  try {
    const run = await api(`investigations/${encodeURIComponent(id)}`);
    if (state.run?.id !== id) return;
    followRun(run);
  } catch (error) {
    if (state.run?.id !== id) return;
    $('reconnect-investigation').hidden = false;
    const missing = error instanceof DashboardHttpError && error.status === 404;
    showError('investigation-error', new Error(missing
      ? '실행 기록이 서버에 없습니다. 서버 재시작이나 기록 만료로 이전 결과를 조회할 수 없습니다.'
      : '서버 연결이 끊겨 조사 상태를 확인하고 있습니다. 마지막 결과를 유지하며 기존 조사만 다시 조회합니다.'));
    $('run-status').textContent = missing ? '실행 기록 없음' : '연결 확인 중';
    $('start-investigation').disabled = !missing; $('investigate-selected').disabled = !missing;
    if (!missing && ++state.pollFailures <= 3) state.poll = window.setTimeout(() => pollRun(id), 2500);
  }
}
async function startInvestigation(country) {
  if (state.overview?.runtime?.admin_auth_required && !state.adminSession?.authenticated) { showError('investigation-error', new Error('관리자 로그인이 필요합니다.')); return; }
  if (state.overview?.runtime?.investigations_enabled === false) { showError('investigation-error', new Error('이 환경에서는 조사 실행이 비활성화되어 있습니다.')); return; }
  if (!country) { $('investigation-country').focus(); return; }
  if (state.poll) window.clearTimeout(state.poll);
  setTab('investigations'); $('investigation-country').value = country; $('start-investigation').disabled = true; showError('investigation-error', null);
  $('investigate-selected').disabled = true; $('reconnect-investigation').hidden = true;
  const input = { country, date: $('date-input').value || undefined, engine: $('investigation-engine').value };
  const samePending = state.pendingStart && ['country', 'date', 'engine'].every(key => state.pendingStart[key] === input[key]);
  const request = samePending ? state.pendingStart : { ...input, request_id: crypto.randomUUID() };
  state.pendingStart = request;
  try {
    const data = await api('investigations', { method: 'POST', body: JSON.stringify(request) });
    if (state.pendingStart?.request_id !== request.request_id) return;
    followRun(data.run ?? data);
  } catch (error) {
    if (state.pendingStart?.request_id !== request.request_id) return;
    if (error instanceof DashboardConnectionError) {
      $('screen-status').textContent = '실행 접수 여부 확인 중 · 조사를 중복 시작하지 않습니다.';
      await recoverStart(request.request_id);
    } else {
      state.pendingStart = null; showError('investigation-error', error);
      renderExecutionAccess();
    }
  }
}

document.querySelectorAll('[data-tab]').forEach((button, index, buttons) => {
  button.addEventListener('click', () => setTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => { let next; if (event.key === 'ArrowRight') next = (index + 1) % buttons.length; else if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = buttons.length - 1; if (next !== undefined) { event.preventDefault(); setTab(buttons[next].dataset.tab, true); } });
});
$('date-input').max = new Date().toISOString().slice(0, 10);
$('date-input').addEventListener('change', loadOverview);
$('refresh').addEventListener('click', loadOverview);
$('country-search').addEventListener('input', renderCountries);
$('country-sort').addEventListener('change', renderCountries);
$('source-search').addEventListener('input', renderSources);
$('investigate-selected').addEventListener('click', () => startInvestigation(state.selected));
$('investigation-engine').addEventListener('change', renderEngineStatus);
$('admin-access').addEventListener('click', async () => {
  if (state.adminSession?.authenticated) {
    $('admin-access').disabled = true;
    try {
      await api('admin/session', { method: 'DELETE' });
      state.accessRevision++;
      state.adminSession = null;
      if (state.poll) window.clearTimeout(state.poll);
      state.run = null; state.pendingStart = null; $('investigation-run').hidden = true; $('investigation-empty').hidden = false;
      $('repair-records').hidden = true; $('repair-record-list').replaceChildren(); $('run-history-list').replaceChildren();
      await loadOverview();
    } catch (error) { showError('investigation-error', error); }
    finally { $('admin-access').disabled = false; }
  } else {
    setTab('investigations'); $('admin-login-form').hidden = !$('admin-login-form').hidden;
    if (!$('admin-login-form').hidden) $('admin-password').focus();
  }
});
$('admin-login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('admin-login-submit').disabled = true; showError('admin-login-error', null);
  const password = $('admin-password').value; $('admin-password').value = '';
  try {
    state.adminSession = await api('admin/session', { method: 'POST', body: JSON.stringify({ password }) });
    state.accessRevision++;
    $('admin-login-form').hidden = true; await loadOverview();
  } catch (error) { showError('admin-login-error', error); }
  finally { $('admin-login-submit').disabled = false; }
});
$('reconnect-investigation').addEventListener('click', () => {
  if (state.poll) window.clearTimeout(state.poll);
  state.pollFailures = 0;
  if (state.pendingStart) recoverStart(state.pendingStart.request_id);
  else if (state.run?.id) pollRun(state.run.id);
});
$('investigation-form').addEventListener('submit', (event) => { event.preventDefault(); startInvestigation($('investigation-country').value); });
loadOverview();
