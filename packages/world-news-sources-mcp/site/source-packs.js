const root = document.getElementById('source-packs');
const choices = document.getElementById('pack-choices');
const detail = document.getElementById('pack-detail');
const status = document.getElementById('pack-status');
const language = document.getElementById('pack-language');
const words = {
  en: {
    eyebrow: 'Build your monitoring list', heading: 'Start with a curated source pack.', language: 'Pack language',
    intro: 'Choose a purpose, check the saved evidence, and download addresses for your news reader or collector.',
    loading: 'Loading source packs…', error: 'Source packs could not be loaded. Your existing searches are still available in ChatGPT.', retry: 'Try again',
    choose: 'Choose a source pack', snapshot: 'Saved snapshot', unknown: 'Not recorded', saved: 'This preview reads saved observations. Publisher sites are not checked during your visit.',
    publishers: 'publishers', rss: 'usable RSS', sitemaps: 'usable sitemaps', excluded: 'excluded by default', selectionNote: 'A selected starting list, not a complete national media directory.',
    all: 'Show and export all configured addresses, including failed, empty, index-only, stale, unknown, or inactive addresses.',
    selectionCounts: (shown, total, excluded) => `Showing ${shown} of ${total} selected publishers; ${excluded} excluded from this view.`,
    downloads: 'Download addresses', opml: 'OPML · RSS only', csv: 'CSV · typed addresses', json: 'JSON · full evidence',
    defaults: 'Default lists and exports require an enabled address with a recorded positive article-URL count from the last 36 hours. Content dates must be within 30 days and not marked stale or unreliable. Missing content dates remain unknown and may be included. Complete or current article coverage is not guaranteed.',
    countMissing: 'the saved result does not retain an extracted article-URL count.',
    opmlNote: 'OPML contains RSS/Atom feeds only. CSV and JSON keep RSS and sitemap types separate. Open a CSV/JSON in a compatible collector; a feed reader may not accept sitemaps.',
    importOne: 'For a feed reader, download OPML and use its Import subscriptions option.',
    importTwo: 'For a collector, use the typed CSV or JSON and route each address to the matching RSS or sitemap parser.',
    importThree: 'Run a first collection in your own tool. These downloads contain addresses and evidence, not article content.',
    methodology: 'Selection criteria and known gaps', criteria: 'Selection criteria', gaps: 'Known gaps', officialEvidence: 'Official evidence', noGaps: 'No additional gap notes were recorded. This is a selected starting list, not a complete national media directory.',
    publisherDetails: 'Publishers and saved evidence', expand: 'Expand a publisher to review official provenance and each address.',
    aliases: 'Also known as', languages: 'Language', topics: 'Topics', scope: 'Scope', homepage: 'Publisher website', official: 'Official provenance', verified: 'Evidence reviewed',
    noProvenance: 'No official provenance was recorded.', endpoints: 'addresses', disabled: 'Registration inactive',
    usable: 'Usable in saved checks', valid_empty: 'Valid XML · empty', index_only: 'Sitemap index only', failed: 'Check failed', stale: 'Evidence is stale', evidence_unavailable: 'Evidence unavailable',
    collection: 'Actual collection', audit: 'Structural audit', content: 'Newest content date', basis: 'Status based on',
    collectionBasis: 'latest actual collection', auditBasis: 'latest structural audit', contentMissing: 'Not provided or not established',
    recent: 'recent', missing: 'date missing', unreliable: 'date unreliable', not_evaluated: 'freshness not evaluated',
    feedDate: 'feed item date', sitemapDate: 'sitemap last-modified date', staleContent: 'old content date',
    noCollection: 'No saved collection result', noAudit: 'No saved structural audit', success: 'Succeeded', failure: 'Failed', staleResult: 'evidence is stale', malformed: 'Invalid XML or feed format', blocked: 'Access blocked', timeout: 'Timed out', http_error: 'HTTP failure', network_error: 'Network failure', incomplete: 'Incomplete check',
    exportIncluded: 'Included in the default export.', exportExcluded: 'Excluded from the default export', observationOld: 'the latest observation is over 36 hours old or has no valid time.', contentOld: 'the recorded content date is over 30 days old.', contentStale: 'the content date is marked stale.', contentUnreliable: 'the content date is not reliable.', exclusionUnknown: 'usable evidence has not been established.',
    urls: 'listed URLs', items: 'entries', reason: 'Result note', different: 'The saved collection and structural audit differ. Their check times are shown separately.',
    indexNote: 'This is a list of child sitemaps. Article URLs in those files have not been established by this result.',
    emptyNote: 'The response was valid but contained no usable article URLs. This is not a failed XML check.',
    unknownNote: 'This address is excluded by default until usable evidence is available.',
    prompt: 'Ask about this pack in ChatGPT', copy: 'Copy pack prompt', copied: 'Copied. Paste into a new ChatGPT chat with World News Sources selected.', selected: 'Prompt selected. Copy it and paste into ChatGPT.',
    promptText: id => `Show the ${id} source pack. Explain the selection and gaps, compare the latest collection with structural audit results, and give me the usable RSS and sitemap export links.`,
    noAddresses: 'No addresses were recorded for this publisher.', unavailable: 'No source packs are available in this snapshot.',
  },
  ko: {
    eyebrow: '뉴스 모니터링 시작하기', heading: '목적에 맞는 소스 묶음으로 시작하세요.', language: '묶음 안내 언어',
    intro: '목적을 고르고 저장된 검증 근거를 확인한 뒤, 뉴스 리더나 수집기에 연결할 주소를 내려받으세요.',
    loading: '소스 묶음을 불러오는 중…', error: '소스 묶음을 불러오지 못했습니다. ChatGPT의 기존 검색 기능은 계속 이용할 수 있습니다.', retry: '다시 시도',
    choose: '소스 묶음 선택', snapshot: '저장된 스냅샷', unknown: '기록 없음', saved: '저장된 관측 결과를 보여줍니다. 페이지를 방문할 때 언론사 사이트를 실시간 검사하지 않습니다.',
    publishers: '언론사', rss: '사용 가능한 RSS', sitemaps: '사용 가능한 사이트맵', excluded: '기본 내보내기 제외', selectionNote: '시작용 선정 목록이며 국가 전체 언론사 목록은 아닙니다.',
    all: '실패·빈 XML·사이트맵 인덱스·오래된 근거·미확인·비활성 주소도 목록과 내보내기에 포함합니다.',
    selectionCounts: (shown, total, excluded) => `선정 언론사 ${total}곳 중 ${shown}곳 표시, 현재 보기에서 ${excluded}곳 제외`,
    downloads: '주소 내려받기', opml: 'OPML · RSS 전용', csv: 'CSV · 주소 종류 구분', json: 'JSON · 전체 근거',
    defaults: '기본 목록과 내보내기는 최근 36시간 안에 기사 URL을 1개 이상 추출한 기록이 있는 활성 주소만 포함합니다. 콘텐츠 날짜는 30일 이내여야 하며 오래되었거나 신뢰할 수 없다는 판정이 없어야 합니다. 날짜가 없으면 미확인 상태로 포함될 수 있으며, 전체 기사 확보나 최신성을 보장하지 않습니다.',
    countMissing: '저장된 결과에 실제 추출한 기사 URL 개수가 없습니다.',
    opmlNote: 'OPML에는 RSS/Atom 피드만 포함합니다. CSV·JSON은 RSS와 사이트맵 종류를 유지합니다. 사이트맵을 지원하는 수집기에서 사용하세요.',
    importOne: '뉴스 리더에서는 OPML을 내려받아 구독 가져오기 기능을 사용하세요.',
    importTwo: '수집기에서는 CSV·JSON의 주소 종류에 따라 RSS 또는 사이트맵 파서를 연결하세요.',
    importThree: '사용하는 도구에서 첫 수집을 실행하세요. 파일에는 주소와 검증 근거가 들어 있으며 기사 본문은 포함하지 않습니다.',
    methodology: '선정 기준과 아직 부족한 부분', criteria: '선정 기준', gaps: '아직 부족한 부분', officialEvidence: '공식 근거', noGaps: '추가로 기록된 누락 안내는 없습니다. 이 묶음은 시작용 선정 목록이며 국가 전체 언론사 목록이 아닙니다.',
    publisherDetails: '언론사와 저장된 검증 근거', expand: '언론사를 펼치면 공식 근거와 주소별 결과를 확인할 수 있습니다.',
    aliases: '다른 이름', languages: '언어', topics: '분야', scope: '수집 범위', homepage: '언론사 홈페이지', official: '공식 출처 근거', verified: '근거 확인일',
    noProvenance: '공식 출처 근거가 기록되지 않았습니다.', endpoints: '개 주소', disabled: '비활성 등록',
    usable: '저장된 검사에서 사용 가능', valid_empty: '정상 XML · 목록 비어 있음', index_only: '사이트맵 인덱스만 확인', failed: '검사 실패', stale: '오래된 검사 근거', evidence_unavailable: '검증 근거 조회 불가',
    collection: '실제 수집', audit: 'XML 구조 검사', content: '가장 최근 콘텐츠 날짜', basis: '상태 판단 근거',
    collectionBasis: '최근 실제 수집', auditBasis: '최근 XML 구조 검사', contentMissing: '날짜 미제공 또는 확인하지 못함',
    recent: '최근', missing: '날짜 없음', unreliable: '날짜 신뢰 불가', not_evaluated: '최신성 미평가',
    feedDate: '피드 항목 날짜', sitemapDate: '사이트맵 마지막 수정일', staleContent: '오래된 콘텐츠 날짜',
    noCollection: '저장된 수집 결과 없음', noAudit: '저장된 구조 검사 없음', success: '성공', failure: '실패', staleResult: '오래된 검사 근거', malformed: 'XML 또는 피드 형식 오류', blocked: '접근 차단', timeout: '시간 초과', http_error: 'HTTP 오류', network_error: '네트워크 오류', incomplete: '검사 미완료',
    exportIncluded: '기본 내보내기에 포함합니다.', exportExcluded: '기본 내보내기 제외', observationOld: '최근 관측이 36시간보다 오래되었거나 유효한 시각이 없습니다.', contentOld: '기록된 콘텐츠 날짜가 30일보다 오래되었습니다.', contentStale: '콘텐츠 날짜가 오래된 것으로 판정됐습니다.', contentUnreliable: '콘텐츠 날짜를 신뢰할 수 없습니다.', exclusionUnknown: '사용 가능한 근거를 아직 확인하지 못했습니다.',
    urls: '개 목록 URL', items: '개 항목', reason: '결과 설명', different: '저장된 실제 수집과 구조 검사 결과가 다릅니다. 각 검사 시각을 따로 확인하세요.',
    indexNote: '하위 사이트맵 목록입니다. 이 결과만으로 하위 파일의 기사 URL까지 확보한 것은 아닙니다.',
    emptyNote: '유효한 응답이지만 사용 가능한 기사 URL이 없었습니다. XML 검사 실패와 구분됩니다.',
    unknownNote: '사용 가능한 근거를 확보하기 전까지 기본 내보내기에서 제외합니다.',
    prompt: 'ChatGPT에서 이 묶음 질문하기', copy: '묶음 질문 복사', copied: '복사했습니다. World News Sources를 선택한 새 ChatGPT 대화에 붙여넣으세요.', selected: '질문을 선택했습니다. 복사해 ChatGPT에 붙여넣으세요.',
    promptText: id => `${id} 소스 묶음을 보여줘. 선정 기준과 누락을 설명하고, 최근 실제 수집과 XML 구조 검사 결과를 비교한 뒤, 사용 가능한 RSS·사이트맵 내보내기 링크를 알려줘.`,
    noAddresses: '이 언론사에 기록된 주소가 없습니다.', unavailable: '이 스냅샷에는 소스 묶음이 없습니다.',
  },
};
let lang = 'en';
let catalog;
let selected;
let includeAll = false;
let loading = false;
const t = key => words[lang][key] ?? key;
const local = value => typeof value === 'string' ? value : value?.[lang] ?? value?.en ?? '';
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
};
const time = value => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC` : t('unknown');
};
const safeLink = (url, label, className) => {
  let parsed;
  try { parsed = new URL(url); } catch { return node('span', label ?? url, className); }
  if (parsed.protocol !== 'https:') return node('span', label ?? url, className);
  const anchor = node('a', label ?? url, className);
  anchor.href = parsed.href;
  anchor.rel = 'noopener noreferrer';
  return anchor;
};
function resultText(result) {
  if (!result) return '';
  const value = result.status === 'stale' && result.last_outcome ? result.last_outcome : result.status ?? result.last_outcome;
  const outcome = ['healthy', 'success', 'succeeded', 'working_nonempty'].includes(value) ? t('success') : ['unhealthy', 'failed', 'failure'].includes(value) ? t('failure') : t(value);
  const parts = [time(result.checked_at), outcome];
  if (result.status === 'stale') parts.push(t('staleResult'));
  if (result.audit_status && result.audit_status !== value && result.audit_status !== 'working_nonempty') parts.push(t(result.audit_status));
  if (result.format) parts.push(result.format);
  if (result.http_status != null) parts.push(`HTTP ${result.http_status}`);
  const count = result.observed_url_count ?? result.entries_with_url ?? result.entry_count;
  if (Number.isFinite(count)) parts.push(`${count} ${t('urls')}`);
  return parts.filter(Boolean).join(' · ');
}
function datum(dl, label, text) {
  dl.append(node('dt', label), node('dd', text));
}
function exclusionText(reason) {
  const keys = { registration_disabled: 'disabled', observation_older_than_36_hours: 'observationOld', recorded_content_date_older_than_30_days: 'contentOld', content_stale: 'contentStale', content_unreliable: 'contentUnreliable', article_url_count_not_recorded: 'countMissing' };
  if (keys[reason]) return t(keys[reason]);
  if (typeof reason === 'string' && reason.startsWith('endpoint_') && words[lang][reason.slice(9)]) return t(reason.slice(9));
  return t('exclusionUnknown');
}
function endpointView(endpoint) {
  const evidence = endpoint.status_evidence ?? {};
  const state = evidence.status ?? 'unknown';
  const box = node('div', null, 'pack-endpoint');
  const heading = node('div', null, 'pack-endpoint-heading');
  heading.append(node('strong', endpoint.type === 'rss' ? 'RSS / Atom' : 'Sitemap'));
  const badge = node('span', t(state), 'pack-badge');
  badge.dataset.tone = state === 'usable' && endpoint.enabled !== false ? 'good' : ['valid_empty', 'index_only', 'failed'].includes(state) ? 'warning' : 'neutral';
  heading.append(badge);
  box.append(heading, safeLink(endpoint.url, endpoint.url));
  if (endpoint.enabled === false) box.append(node('p', t('disabled'), 'pack-reason'));
  if (endpoint.default_export_eligible === true) box.append(node('p', t('exportIncluded'), 'pack-reason'));
  if (endpoint.default_export_eligible === false) box.append(node('p', `${t('exportExcluded')}: ${exclusionText(endpoint.exclusion_reason)}`, 'pack-reason'));
  const dl = node('dl', null, 'pack-evidence');
  datum(dl, t('collection'), evidence.latest_collection ? resultText(evidence.latest_collection) : t('noCollection'));
  datum(dl, t('audit'), evidence.structural_audit?.checked_at ? resultText(evidence.structural_audit) : t('noAudit'));
  const content = evidence.content ?? {};
  const contentParts = [content.newest_content_at ? time(content.newest_content_at) : t('contentMissing')];
  if (content.date_kind) contentParts.push(content.date_kind === 'sitemap_lastmod' ? t('sitemapDate') : t('feedDate'));
  if (content.freshness && content.freshness !== 'missing') contentParts.push(content.freshness === 'stale' ? t('staleContent') : t(content.freshness));
  datum(dl, t('content'), contentParts.join(' · '));
  datum(dl, t('basis'), evidence.basis ? `${t(evidence.basis === 'collection' ? 'collectionBasis' : 'auditBasis')} · ${time(evidence.observed_at)}` : t('unknown'));
  box.append(dl);
  if (evidence.reason) box.append(node('p', `${t('reason')}: ${evidence.reason}`, 'pack-reason'));
  if (evidence.conflict?.present) box.append(node('p', t('different'), 'pack-notice'));
  if (state === 'index_only') box.append(node('p', t('indexNote'), 'pack-reason'));
  if (state === 'valid_empty') box.append(node('p', t('emptyNote'), 'pack-reason'));
  if (['unknown', 'stale', 'evidence_unavailable'].includes(state)) box.append(node('p', t('unknownNote'), 'pack-reason'));
  return box;
}
function publisherView(entry) {
  const disclosure = node('details', null, 'pack-publisher');
  const summary = node('summary');
  const endpoints = list(entry.sources).flatMap(source => list(source.endpoints));
  summary.append(node('strong', local(entry.name)), node('span', `${endpoints.length} ${lang === 'en' && endpoints.length === 1 ? 'address' : t('endpoints')}`));
  disclosure.append(summary);
  const body = node('div', null, 'pack-publisher-content');
  const aliases = list(entry.aliases).map(local).filter(Boolean);
  if (aliases.length) body.append(node('p', `${t('aliases')}: ${aliases.join(' · ')}`));
  body.append(node('p', `${t('languages')}: ${list(entry.language).join(', ') || t('unknown')} · ${t('topics')}: ${list(entry.topics).map(local).join(', ') || t('unknown')}`));
  if (entry.scope_description || entry.scope) body.append(node('p', `${t('scope')}: ${local(entry.scope_description) || local(entry.scope)}`));
  if (entry.homepage) body.append(safeLink(entry.homepage, t('homepage')));
  body.append(node('p', t('official')));
  const evidenceList = node('ul', null, 'pack-provenance');
  for (const evidence of list(entry.evidence)) {
    const li = node('li');
    li.append(safeLink(evidence.url, local(evidence.claim) || evidence.url), node('span', ` · ${t('verified')}: ${time(evidence.checked_at)}`));
    evidenceList.append(li);
  }
  body.append(evidenceList.children.length ? evidenceList : node('p', t('noProvenance')));
  for (const endpoint of endpoints) body.append(endpointView(endpoint));
  if (!endpoints.length) body.append(node('p', t('noAddresses'), 'pack-empty'));
  disclosure.append(body);
  return disclosure;
}
function downloads(pack) {
  const section = node('div');
  section.append(node('h4', t('downloads')));
  const scope = node('label', null, 'pack-export-scope');
  const checkbox = node('input');
  checkbox.type = 'checkbox';
  checkbox.checked = includeAll;
  checkbox.disabled = loading;
  checkbox.addEventListener('change', () => {
    checkbox.disabled = true;
    load(checkbox.checked);
  });
  scope.append(checkbox, node('span', t('all')));
  section.append(node('p', t('defaults'), 'pack-export-note'), scope);
  const actions = node('div', null, 'pack-downloads');
  for (const format of ['opml', 'csv', 'json']) {
    const anchor = node('a', t(format), 'button button-secondary');
    anchor.href = exportUrl(pack.id, format);
    anchor.dataset.format = format;
    actions.append(anchor);
  }
  section.append(actions, node('p', t('opmlNote'), 'pack-export-note'));
  const steps = node('ol', null, 'pack-instructions');
  for (const key of ['importOne', 'importTwo', 'importThree']) steps.append(node('li', t(key)));
  section.append(steps);
  return section;
}
function exportUrl(id, format) {
  return `/source-packs/${encodeURIComponent(id)}/export?format=${format}${includeAll ? '&include=all' : ''}`;
}
function gapView(gap, tag = 'li', className) {
  const element = node(tag, undefined, className);
  if (!gap || typeof gap !== 'object' || (!gap.publisher && !gap.reason && !gap.evidence_url)) {
    element.textContent = local(gap);
    return element;
  }
  if (gap.publisher) element.append(node('strong', `${local(gap.publisher)}: `));
  if (gap.reason) element.append(node('span', local(gap.reason)));
  if (gap.evidence_url) element.append(node('span', ' · '), safeLink(gap.evidence_url, t('officialEvidence')));
  return element;
}
function methodology(pack) {
  const details = node('details', null, 'pack-method');
  details.append(node('summary', t('methodology')), node('h4', t('criteria')));
  const criteria = node('ul');
  for (const criterion of list(pack.selection_criteria)) criteria.append(node('li', local(criterion)));
  details.append(criteria, node('h4', t('gaps')));
  const gaps = node('ul');
  for (const gap of list(pack.gaps)) gaps.append(gapView(gap));
  details.append(gaps.children.length ? gaps : node('p', t('noGaps')));
  return details;
}
function promptView(pack) {
  const box = node('div', null, 'pack-prompt');
  box.append(node('h4', t('prompt')));
  const prompt = node('blockquote', t('promptText')(pack.id));
  box.append(prompt);
  if (!navigator.clipboard?.writeText) return box;
  const button = node('button', t('copy'), 'copy-prompt');
  button.type = 'button';
  const feedback = node('p', '', 'pack-copy-status');
  feedback.setAttribute('role', 'status');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(prompt.textContent);
      feedback.textContent = t('copied');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(prompt);
      const selection = window.getSelection();
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      feedback.textContent = t('selected');
    }
  });
  box.append(button, feedback);
  return box;
}
function renderDetail() {
  const pack = catalog?.packs.find(pack => pack.id === selected);
  detail.replaceChildren();
  if (!pack) return;
  const panel = node('article', null, 'pack-panel');
  panel.lang = lang;
  const title = node('h3', local(pack.title));
  title.id = 'pack-active-title';
  panel.setAttribute('aria-labelledby', title.id);
  panel.append(title, node('p', local(pack.description)), node('p', `${t('snapshot')}: ${time(catalog.snapshot_at)}`, 'pack-snapshot'), node('p', t('saved'), 'pack-export-note'));
  const counts = node('div', null, 'pack-summary');
  for (const [key, label] of [['publishers', 'publishers'], ['usable_rss', 'rss'], ['usable_sitemaps', 'sitemaps'], ['excluded_endpoints', 'excluded']]) {
    const value = key === 'publishers' ? (pack.selection?.returned_publishers ?? list(pack.entries).length) : pack.summary?.[key] ?? (key === 'excluded_endpoints' ? pack.summary?.unknown_or_unusable : undefined);
    const item = node('span');
    item.append(node('strong', Number.isFinite(value) ? value : '?'), node('span', t(label)));
    counts.append(item);
  }
  panel.append(counts, node('p', t('selectionNote'), 'pack-note'));
  if (pack.selection) panel.append(node('p', words[lang].selectionCounts(pack.selection.returned_publishers, pack.selection.matched_publishers, pack.selection.excluded_publishers), 'pack-export-note'));
  if (list(pack.gaps).length) {
    const gap = gapView(pack.gaps[0], 'p', 'pack-notice');
    gap.prepend(node('span', `${t('gaps')}: `));
    panel.append(gap);
  }
  panel.append(downloads(pack), methodology(pack));
  const publishers = node('div', null, 'pack-publishers');
  publishers.append(node('h4', t('publisherDetails')), node('p', t('expand'), 'pack-export-note'));
  for (const entry of list(pack.entries)) publishers.append(publisherView(entry));
  panel.append(publishers, promptView(pack));
  detail.append(panel);
}
function render() {
  root.lang = lang;
  for (const element of root.querySelectorAll('[data-pack-i18n]')) element.textContent = t(element.dataset.packI18n);
  choices.setAttribute('aria-label', t('choose'));
  choices.replaceChildren();
  if (loading) status.textContent = t('loading');
  if (!catalog) return;
  status.textContent = catalog.packs.length ? '' : t('unavailable');
  for (const pack of catalog.packs) {
    const button = node('button', null, 'pack-choice');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(pack.id === selected));
    button.setAttribute('aria-controls', 'pack-detail');
    button.append(node('strong', local(pack.title)), node('span', [pack.country, pack.language, `${pack.selection?.returned_publishers ?? list(pack.entries).length} ${t('publishers')}`].filter(Boolean).join(' · ')));
    button.addEventListener('click', () => {
      selected = pack.id;
      for (const choice of choices.children) choice.setAttribute('aria-pressed', String(choice === button));
      renderDetail();
    });
    choices.append(button);
  }
  renderDetail();
}
async function load(nextIncludeAll = includeAll) {
  if (loading) return;
  loading = true;
  status.textContent = t('loading');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/source-packs${nextIncludeAll ? '?include=all' : ''}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Source pack request failed');
    const data = await response.json();
    if (!Array.isArray(data.packs)) throw new Error('Invalid source pack response');
    catalog = data;
    includeAll = nextIncludeAll;
    selected = data.packs.some(pack => pack.id === selected) ? selected : data.packs[0]?.id;
    loading = false;
    render();
  } catch {
    loading = false;
    renderDetail();
    status.replaceChildren(node('span', t('error')));
    const retry = node('button', t('retry'), 'copy-prompt');
    retry.type = 'button';
    retry.addEventListener('click', () => load(nextIncludeAll));
    status.append(retry);
  } finally {
    window.clearTimeout(timeout);
  }
}
language.addEventListener('change', () => {
  lang = language.value === 'ko' ? 'ko' : 'en';
  render();
  if (!catalog && !loading) load();
});
render();
load();
