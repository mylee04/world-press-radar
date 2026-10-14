import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const read = file => JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8'));
const report = read('audit.json'), schedule = read('schedule-verification.json');
assert.equal(report.countries, 73);
assert.equal(schedule.timer.ActiveState, 'active');
const ko = new Intl.DisplayNames(['ko'], { type: 'region' });
const countryName = code => `${ko.of(code)} (${code})`;
const safe = value => String(value).replaceAll('|', '\\|').replaceAll('[', '\\[').replaceAll(']', '\\]');
const linked = item => `[${safe(item.name)}](${item.website})`;
const inCountry = code => report.items.filter(item => item.country === code);
const presence = report.presence_counts;
const counts = report.registered_active_collection_counts;
const table = report.country_summary.map(country => {
  const items = inCountry(country.country);
  const missing = items.filter(item => item.presence_status === 'missing').map(linked);
  const other = items.filter(item => !['registered_active', 'missing'].includes(item.presence_status)).map(item => {
    const labels = { registered_disabled_only: '비활성', present_other_country: '다른 국가 등록', needs_review: '검토', registered_no_usable_url: '주소 미확인' };
    return `${linked(item)} (${labels[item.presence_status] ?? item.presence_status})`;
  });
  return `| ${countryName(country.country)} | ${country.active_registrations}/${country.registrations} | ${items.length} | ${missing.join('; ') || '—'} | ${other.join('; ') || '—'} |`;
}).join('\n');
const sparse = report.country_summary.filter(country => country.active_registrations < 10 && inCountry(country.country).some(item => item.presence_status === 'missing'));
const sparseTable = sparse.map(country => `| ${countryName(country.country)} | ${country.active_registrations} | ${inCountry(country.country).filter(item => item.presence_status === 'missing').map(linked).join('; ')} |`).join('\n');
const indexOnly = report.items.filter(item => item.presence_status === 'registered_active' && item.recorded_collection_coverage === 'index_only_gap');
const indexTable = indexOnly.map(item => `| ${countryName(item.country)} | ${linked(item)} | ${item.matched_source_evidence.flatMap(source => source.endpoints).filter(endpoint => endpoint.outcome === 'index_only').map(endpoint => `[등록 인덱스](${endpoint.url}) (${endpoint.last_recorded_check_at})`).join('; ')} |`).join('\n');

const text = `# 국가별 대표 언론사 등록 공백 조사 — 2026-10-14

기존 World Press Radar의 **73개국, 5,437개 등록행**을 국가별 대표 매체 **${report.selected_anchors}개 항목**과 대조했다. 선정 목록에서 **미등록 ${presence.missing ?? 0}개, 비활성 등록만 있는 매체 ${presence.registered_disabled_only ?? 0}개, 다른 국가에 등록된 매체 ${presence.present_other_country ?? 0}개, 별도 검토 ${presence.needs_review ?? 0}개**가 확인됐다. 활성 등록으로 대조된 항목은 ${presence.registered_active ?? 0}개다. 같은 매체를 여러 국가의 기준 항목으로 선정할 수 있으므로 글로벌 고유 회사 수와 다르다. 이 숫자의 분모는 이번 선정 목록이며, 전체 주요 언론사 수나 보급률이 아니다.

## 조사 기준과 범위

- 국가마다 4–6개의 종합신문·공영/주요 방송·통신사·경제지를 기관 역할과 편집 범위로 선정했다. 발행 부수나 시청률 순위를 새로 추정하지 않았다. [Reuters Institute Digital News Report 2026의 국가별 자료](https://reutersinstitute.politics.ox.ac.uk/digital-news-report/2026/country-and-market-data)는 해당 시장의 배경 자료이며, 그 조사에 없는 국가도 기관 공식 자료로 살폈다.
- 미등록·비활성·검토 후보에는 공식 홈페이지, 기관 소개, 소유사 브랜드 소개 또는 공식 사이트의 검색 수록 자료를 연결했다. 조회 제한과 확인 수준은 각 지역 JSON에 남겼다. 모든 기존 활성 매체의 정체성을 이번에 다시 온라인 검증했다는 뜻은 아니다.
- 이름·언어별 별칭·공식 도메인·해당 언론사에 귀속된 피드 경로를 대조했다. 같은 이름의 타국 신문, 계열사의 다른 매체, 일반적인 Yahoo/Feedburner 호스트를 일괄 같은 언론사로 세지 않았다. 회사 본사와 편집 대상 국가가 다를 수 있어 다른 국가 등록은 별도 검토한다.
- **활성 등록은 작동하는 수집 주소를 보장하지 않는다.** 공식 홈페이지 접속 성공도 RSS·사이트맵 성공과 다르다. 후보 주소가 null이면 아직 검증하지 않았다는 뜻이다.
- 등록행은 회사 수·고유 언론사 수·주소 수와 다르다. 한 매체에 여러 섹션/언어 등록이 있고, 한 행에 RSS와 사이트맵이 함께 있을 수 있다.

## 매일 검사 일정

[서버의 실제 systemd 사용자 타이머](schedule-verification.json)를 ${schedule.verified_at_utc}에 읽기 전용으로 확인했다. 타이머는 enabled/active이고 **매일 UTC 03:00, 한국 시간 정오**에 실행한다. 다음 예정은 **2026-10-15 03:00 UTC**다.

활성 RSS·사이트맵 주소 전체를 당일 대상으로 선정하는 daily_all_active 정책이다. 마지막 확인 회차는 5,458개 중 5,457개를 실제 검사했으며, Yomiuri의 한 주소는 같은 호스트의 HTTP 429 대기 때문에 다음 시점으로 유예됐다. 병렬 6개, 같은 호스트 간격 2초, 제한된 타임아웃·재시도 및 Retry-After를 유지한다. 신규 URL 0건만으로 장애로 판정하지 않는다.

마지막 서비스는 수집 뒤 기존 고정 등록 수를 기대한 smoke 검증 때문에 실패 상태로 끝났다. 동적 등록 수 검증 수정은 설치돼 있지만 **다음 정기 실행의 최종 성공은 아직 확인할 수 없다**. 이번 조사는 작업을 재시작하거나 중복 수집을 실행하지 않았다.

## 먼저 보강할 국가

활성 등록행이 10개 미만이고 이번 대표 매체 목록에 미등록 후보가 있는 국가다. 이 우선순위는 수집 공백을 기준으로 하며 언론사의 영향력 순위가 아니다.

| 국가 | 현재 활성 등록행 | 미등록 대표 후보 |
| --- | ---: | --- |
${sparseTable}

## 73개국 대조표

‘—’는 **이번 선정 목록에서 해당 유형의 공백을 찾지 않았다는 뜻**이다. 해당 국가의 모든 주요 언론사를 확보했다는 뜻은 아니다. 비활성 매체는 새 언론사로 추가하지 말고 기존 주소와 비활성 사유부터 검토해야 한다.

| 국가 | 등록행 활성/전체 | 선정 대표 매체 | 미등록 후보 | 비활성·국가 분류·별도 검토 |
| --- | ---: | ---: | --- | --- |
${table}

## 등록과 실제 수집의 차이

체크섬을 검증한 **${report.historical_records_read.toLocaleString('en-US')}개 저장 검사 기록**에서 주소별 가장 최근 결과를 연결했다. 자료 시점은 **${report.source_activity_snapshot_at}**다. 이번 조사의 실시간 재검사 결과가 아니다. 활성 등록으로 분류한 ${presence.registered_active}개 대표 매체 중 ${counts.at_least_one_successful_saved_xml ?? 0}개는 해당 국가의 등록 주소에서 성공한 RSS/Atom/RDF/URL-set XML 기록이 적어도 하나 있다. 빈 XML이나 신규 발견 0건도 유효할 수 있으며, 이 수치는 현재 발행 기사 수·최신성·전체 섹션 확보율을 뜻하지 않는다.

활성 등록이 있으나 최신 저장 결과에서 성공한 기사 XML을 확인하지 못한 매체 ${counts.no_successful_saved_xml_in_active_matches ?? 0}개는 별도 주소 검토 대상이다. 저장 결과만으로 지속 장애를 확정하지 않는다. 인덱스만 확인되는 매체는 ${indexOnly.length}개다.

소속이나 형식 검토가 남은 GoGo·News24·Al Ittihad의 활성 등록행은 위 세 집계에서 제외했다. Al Ittihad로 이름이 붙은 Azure 주소에는 XML 성공 기록이 있지만, 실제 매체 소속은 미확인이라 확보된 수집 범위로 세지 않았다. 합본 JSON은 주소별 기술적 결과와 검토 상태를 함께 남기고 별도 집계를 제공한다.

| 국가 | 매체 | 인덱스만 확인된 저장 근거 |
| --- | --- | --- |
${indexTable || '| — | — | — |'}

Reuters는 미국 항목에 등록돼 있지만 기사 URL-set이 아닌 news-sitemap-index만 있다. 따라서 미등록 언론사로 추가하기보다, 공식 인덱스가 선언한 하위 기사 사이트맵을 검토해야 한다. 몽골 GoGo는 홈페이지가 sitemapUrl로 등록돼 있어 별도 검토로 분리했다. 일본 Kyodo의 Yahoo 언론사 전용 RSS는 이미 등록된 것으로 처리했다.

## 다음 적용 단계

1. 미등록 후보의 공식 공개 RSS·사이트맵 선언을 찾고 현재 robots 정책, XML 형식, 기사 URL 포함 여부, 중복·국가·언어를 확인한다.
2. 서버에서 제한된 검증을 실시해 로컬 접근 성공과 실제 운영 수집 성공을 구분한다. 통신사 사이트에 공개 피드가 없으면 기사 공급 계약이나 대체 공식 배포 가능성을 별도로 확인한다.
3. 신규 후보 추가안을 검토 가능하게 만들고, 기존 주소 교체·비활성 해제는 개별 관리자 승인 절차를 거친다.
4. 적용된 새 주소의 첫 관측은 baseline으로 처리하고, 다음 정기 회차에서 실제 수집과 대시보드 반영을 확인한다.

이번에는 **레지스트리 변경 0, 수집 작업 시작 0, 후보 XML 요청 0, 유료 모델 호출 0**이다. 공식 선언을 찾은 주소도 검증 완료나 추가 승인 상태로 표시하지 않았다.

## 근거 파일

- [합본 및 주소별 저장 검사 근거](audit.json)
- [아시아·태평양 18개국](asia-pacific.json)
- [유럽 32개국](europe.json)
- [미주·아프리카·중동 23개국](americas-africa-middle-east.json)
- [실제 타이머 조회](schedule-verification.json)

레지스트리 SHA-256: **${report.registry_sha256}**. 원본 레지스트리와 검사 이력은 기존 비공개 운영 스냅샷에서 읽었고 변경하지 않았다. [summarize.mjs](summarize.mjs)는 해당 로컬 스냅샷과 빌드된 dist가 있을 때 읽기 전용 대조 결과를 다시 만들며, [render-report.mjs](render-report.mjs)는 이 문서를 생성한다.
`;
writeFileSync(join(import.meta.dirname, 'README.md'), text);
console.log(JSON.stringify({ country_rows: report.country_summary.length, selected_anchors: report.selected_anchors, missing: presence.missing, sparse_priority_countries: sparse.map(country => country.country), index_only: indexOnly.map(item => `${item.country}:${item.name}`) }));
