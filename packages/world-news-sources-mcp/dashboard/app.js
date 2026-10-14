'use strict';

// BEGIN I18N HELPERS
// Only authored UI copy enters this catalog. Stored evidence and source text stay unchanged.
const LANGUAGE_STORAGE_KEY = 'wpr-quality-language';
const translations = Object.freeze({
  "미국": "United States",
  "한국": "South Korea",
  "일본": "Japan",
  "영국": "United Kingdom",
  "중국": "China",
  "프랑스": "France",
  "독일": "Germany",
  "인도": "India",
  "호주": "Australia",
  "캐나다": "Canada",
  "브라질": "Brazil",
  "이탈리아": "Italy",
  "스페인": "Spain",
  "러시아": "Russia",
  "멕시코": "Mexico",
  "인도네시아": "Indonesia",
  "튀르키예": "Türkiye",
  "사우디아라비아": "Saudi Arabia",
  "아르헨티나": "Argentina",
  "남아프리카공화국": "South Africa",
  "과거 성공 후 실패": "Failed after prior success",
  "회복 기록": "Recovery recorded",
  "오래된 콘텐츠": "Stale content",
  "접근 실패 · 기준 부족": "Access failed · insufficient baseline",
  "검사 성공 · 신규 0": "Check succeeded · no new URLs",
  "수집 성공": "Collection succeeded",
  "목록 확인": "Index checked",
  "기간 내 미검사": "Not checked in this period",
  "미추적 · 기록 부족": "Untracked · insufficient records",
  "검사 성공": "Check succeeded",
  "유효한 빈 응답": "Valid empty response",
  "검사 실패": "Check failed",
  "타임아웃": "Timed out",
  "조사 대상": "Review needed",
  "부분 구간": "Partial window",
  "기준 부족": "Insufficient baseline",
  "하락 신호 없음": "No decline signal",
  "실행 중": "Running",
  "완료": "Completed",
  "실패": "Failed",
  "대기": "Queued",
  "미추적": "Untracked",
  "미검사": "Not checked",
  "실패 / 목록만 확인": "Failed / index only",
  "부분 수집": "Partial collection",
  "검사 완료": "Checks complete",
  "저장 이력 범위 밖": "Outside saved history",
  "추적 기록 없음": "No tracking records",
  "추적 중": "Tracking",
  "미확인": "Unknown",
  "최근 콘텐츠 기록": "Recent content recorded",
  "오래된 저장 검사": "Stale saved check",
  "콘텐츠 날짜 없음": "No content date",
  "콘텐츠 날짜 신뢰 부족": "Unreliable content date",
  "저장 검사 성공": "Saved check succeeded",
  "저장 검사 실패": "Saved check failed",
  "완료되지 않은 저장 구간": "Incomplete saved window",
  "달력 구간 종료": "Calendar window closed",
  "마지막 검사 이후": "After the latest check",
  "자료 없음": "Unavailable",
  "관측된 집계": "Observed totals",
  "주소별 판단 근거 부족": "Insufficient endpoint history",
  "회차 기록 없음": "No cycle record",
  "회차 비교 제외": "Excluded from cycle comparison",
  "기준 축적 중": "Building a baseline",
  "근거 부족": "Insufficient evidence",
  "조회 실패": "Lookup failed",
  "일부 소스 표본 조사": "Source sample investigated",
  "국가 미확인": "Unknown country",
  "언론사 식별 근거가 없어 계산할 수 없습니다. 0개를 뜻하지 않습니다.": "Cannot calculate without publisher identity evidence. This does not mean zero publishers.",
  "등록된 소스의 식별 정보를 묶은 언론사 수 추정치입니다.": "Estimated publisher count from grouped registered source identities.",
  "활성 등록의 매체 브랜드 기준 추정입니다. 사이트 도메인·별칭으로 중복을 제거하며 모회사별로 합치지 않습니다. 공유 서버와 연결되지 않은 다른 도메인은 오차가 있을 수 있습니다.": "Estimates media brands from active registrations, deduplicating site domains and aliases without merging parent companies. Shared hosts and unlinked domains can introduce errors.",
  "{0}개 그룹은 사이트 도메인 없이 등록명·공유 피드 경로로 추정합니다.": "{0} groups are estimated from registration names or shared feed paths without a site domain.",
  "식별하지 못한 활성 등록 {0}개가 있습니다.": "{0} active registrations have unresolved identities.",
  "활성 등록에서 중복을 제거한 고유 언론사 수입니다.": "Unique publisher count after deduplicating active registrations.",
  "시각 미확인": "Time unknown",
  "{0} UTC (날짜 기록)": "{0} UTC (date recorded)",
  "조사 입력 한도에 도달했습니다.": "The investigation input limit was reached.",
  "모델 호출 한도에 도달했습니다.": "The model call limit was reached.",
  "조사 실행 한도에 도달했습니다.": "The investigation limit was reached.",
  "승인된 비용 한도에 도달했습니다.": "The approved cost limit was reached.",
  "이 조사 방식은 현재 실행할 수 없습니다.": "This investigation mode is currently unavailable.",
  "API 연결 설정을 확인해 주세요.": "Check the API connection settings.",
  "모델 실행 설정을 확인해 주세요.": "Check the model execution settings.",
  "조사가 중단됐습니다.": "The investigation was stopped.",
  "모델 조사를 완료하지 못했습니다. 실행 기록을 확인해 주세요.": "The model investigation could not finish. Check the execution record.",
  "모델 응답을 검증하지 못했습니다.": "The model response could not be verified.",
  "조사를 완료하지 못했습니다. 실행 기록을 확인해 주세요.": "The investigation could not finish. Check the execution record.",
  "데이터를 불러오지 못했습니다.": "Could not load the data.",
  "관리자 로그인 정보를 확인해 주세요.": "Check your administrator sign-in details.",
  "서버에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.": "Could not connect to the server. Try again shortly.",
  "조회 시간이 초과됐습니다. 잠시 후 다시 확인해 주세요.": "The lookup timed out. Try again shortly.",
  "관리자 로그인이 필요합니다.": "Administrator sign-in is required.",
  "현재 관리자 세션에서 이 수정안을 다시 승인해 주세요.": "Approve this proposal again in the current administrator session.",
  "등록 상태가 바뀌었습니다. 후보를 다시 검토해 주세요.": "The registry changed. Review the candidate again.",
  "검사 기록이 오래됐습니다. 후보를 다시 검사해 주세요.": "The validation record is stale. Check the candidate again.",
  "현재 등록에서 해당 소스 주소를 찾지 못했습니다.": "This source endpoint was not found in the current registry.",
  "이미 적용된 제안입니다. 기록을 다시 확인해 주세요.": "This proposal was already applied. Check its record.",
  "OpenAI 실행 설정을 확인해 주세요.": "Check the OpenAI execution settings.",
  "Jev 실행 설정을 확인해 주세요.": "Check the Jev execution settings.",
  "진행 중인 조사가 있습니다. 완료 후 다시 실행해 주세요.": "An investigation is in progress. Wait for it to finish before starting another.",
  "주소 미확인": "Unknown address",
  "대시보드 서버에 연결하지 못했습니다. 서버가 실행 중인지 확인한 뒤 연결을 다시 확인해 주세요.": "Could not connect to the dashboard server. Confirm the server is running, then reconnect.",
  "저장 기록 API가 JSON을 반환하지 않았습니다 ({0}).": "The saved-record API did not return JSON ({0}).",
  "조회 실패 ({0})": "Lookup failed ({0})",
  "서버 연결 복구 중 · 읽기 요청 재확인 {0}/{1}": "Reconnecting to the server · retrying read {0}/{1}",
  "평가 대상 없음": "No eligible endpoints",
  "자료 미제공": "Data unavailable",
  "{0} / {1} 주소": "{0} / {1} endpoints",
  "비율": "Rate",
  "확인 {0}": "Observed {0}",
  "서버 대기 {0}": "Server cooldown {0}",
  "서버가 요청한 재검사 대기시간을 따릅니다. {0}{1}": "Following the server-requested recheck delay. {0}{1}",
  "다음 재검사 {0} · ": "Next recheck {0} · ",
  "검사 전": "Awaiting check",
  "서버 제한 대기 없이 {0} 주소입니다. {1}": "Endpoints {0}, without a server cooldown. {1}",
  "이번 회차 검사를 기다리는": "awaiting a check in this cycle",
  "아직 검사 기록이 없는": "with no check recorded yet",
  "{0} UTC 기록": "{0} UTC records",
  "날짜 없음": "No date",
  "부분 구간 포함": "Includes partial windows",
  "저장된 검사 범위": "Saved check coverage",
  "완료 회차 기록 {0}/{1}개국": "Completed cycle records for {0}/{1} countries",
  "완료 회차 기록 없음": "No completed cycle records",
  "동시 하락 신호 · 공통 원인 우선 조사": "Simultaneous declines · investigate shared causes first",
  "검색 조건에 맞는 국가가 없습니다.": "No countries match your search.",
  "조회 가능한 국가 기록이 없습니다.": "No country records are available.",
  "갱신주기 이력 없음": "No update frequency history",
  "검사 기록 없음": "No check records",
  "활성 주소 없음": "No active endpoints",
  "검사 자료 없음": "No check data",
  "{0} {1}% · 기준 {2}%": "{0} {1}% · baseline {2}%",
  "성공률": "Success rate",
  "검사 범위": "Check coverage",
  "같은 국가·요일·수집 대상의 완료 회차를 비교합니다. 회차 기록이 없거나 충분하지 않으면 하락을 확정하지 않습니다.": "Compares completed cycles for the same country, weekday, and collection cohort. A decline is not confirmed without sufficient cycle records.",
  "저장된 구간을 비교한 참고 신호입니다. 완료된 수집 회차의 운영 장애 판정과 다릅니다.": "A reference signal comparing saved windows. It does not determine an operational failure in a completed collection cycle.",
  "{0} 상세 보기": "View {0} details",
  "스냅샷 생성 {0}": "Snapshot generated {0}",
  "저장 데이터 시각 미확인": "Saved data time unknown",
  " · 준비 필요": " · setup required",
  "로그아웃": "Sign out",
  "관리자": "Administrator",
  "이 환경에서는 조사 실행을 사용할 수 없습니다.": "Investigations are unavailable in this environment.",
  "저장된 조사 결과를 확인하세요.": "View saved investigation results.",
  "완료된 조사와 근거가 이곳에 표시됩니다.": "Completed investigations and their evidence appear here.",
  "규칙 기반": "Rules",
  "{0} · 읽기 전용": "{0} · read only",
  "다음 조회를 모델이 선택합니다. 조사 한도 ${0}.": "The model selects the next lookup. Investigation budget: ${0}.",
  "실행 비용 한도와 API 설정이 필요합니다.": "Execution budget and API settings are required.",
  "저장 근거를 분류합니다. 다음 조회는 규칙이 선택합니다.": "Classifies saved evidence. Rules select the next lookup.",
  "첫 관측": "First observed",
  "목록에서 사라짐": "Removed from observed registry",
  "다시 관측": "Observed again",
  "재활성화 관측": "Reactivation observed",
  "비활성화 관측": "Deactivation observed",
  "국가별 등록 상태를 불러오지 못했습니다.": "Could not load country registration counts.",
  "등록 기준 {0} · 보유량 순": "Registry as of {0} · sorted by holdings",
  "시각 없음": "No timestamp",
  "활성 등록의 언론사 식별 정보를 기준으로 중복 제거합니다. 추정치에는 ≈를 표시합니다.": "Deduplicates active registrations by publisher identity. Estimates are marked ≈.",
  "언론사 수와 이력의 집계 기준": "Publisher counts and history methodology",
  "≈는 등록된 소스의 식별 정보를 묶은 언론사 수 추정치입니다. 국가별 수에 집계 기준을 표시합니다.": "≈ estimates publishers by grouping registered source identities. Country counts identify their methodology.",
  "언론사 수는 활성 등록의 식별 정보를 기준으로 중복 제거합니다.": "Publisher counts deduplicate active registrations by identity.",
  "언론사 식별 근거가 없는 국가는 —로 표시합니다. 등록 항목을 언론사 수로 세지 않습니다.": "Countries without publisher identity evidence show —. Registrations are not counted as publishers.",
  "완전한 등록 목록의 관측 사이에서 달라진 정규화 소스를 셉니다. 첫 관측은 최초 기준선이며, 실제 등록일·삭제일을 뜻하지 않습니다.": "Counts normalized sources that changed between complete registry observations. The first observation is the baseline, not an actual registration or deletion date.",
  "변화는 기록된 이벤트만 셉니다. 이력이 완전해야 순증을 계산합니다.": "Changes count recorded events only. Net growth requires complete history.",
  "과거 변경 이력이 없어 이전 증가량을 계산하지 않습니다.": "Past growth is not calculated without change history.",
  "관측된 등록 변화": "Observed registry changes",
  "등록 변화와 신규 소스": "Registry changes and new sources",
  "국가별 관측 변화": "Observed changes by country",
  "등록 변화": "Registry changes",
  "국가": "Country",
  "재활성화": "Reactivated",
  "비활성화": "Deactivated",
  "사라짐": "Removed",
  "관측 순증": "Observed net change",
  "기록된 추가": "Recorded additions",
  "기록된 비활성화": "Recorded deactivations",
  "기록된 재활성화": "Recorded reactivations",
  "기록된 삭제": "Recorded deletions",
  "순증": "Net change",
  "조회일 UTC에 관측된 정규화 소스 변화. 실제 추가·삭제 시각과 다릅니다.": "Normalized source changes observed on the selected UTC date. Actual addition and deletion times may differ.",
  "조회일 UTC에 기록된 등록 변화": "Registry changes recorded on the selected UTC date",
  "이력이 없어 계산할 수 없습니다. 0건을 뜻하지 않습니다.": "Cannot calculate without history. This does not mean zero events.",
  "관측 시작 {0} · 조회일은 관측 이전입니다.": "Observation began {0} · the selected date precedes tracking.",
  "관측 기준선 {0} · 다음 완전한 목록부터 변화를 비교합니다.": "Observation baseline {0} · comparisons begin with the next complete registry.",
  "{0} UTC에 발견한 관측 사이 변화 · 정규화 소스 기준 · 실제 추가·삭제일 미상": "Changes discovered between observations on {0} UTC · normalized sources · actual addition and deletion dates unknown",
  "{0} UTC 기록 · —는 이력 없음. 0은 기록된 이벤트 없음. 과거 추가일은 추정하지 않습니다.": "{0} UTC records · — means no history; 0 means no recorded events. Past addition dates are not inferred.",
  "이력이 없어 과거 증가량을 집계하지 않습니다. 신규 0건을 뜻하지 않습니다.": "Past growth is unavailable without history. This does not mean zero additions.",
  "관측된 소스 변화": "Observed source changes",
  "신규 소스 목록": "New sources",
  "관측 이전": "Before tracking",
  "최초 기준선": "Initial baseline",
  "관측 {0}건": "{0} observed changes",
  "기록된 추가 {0}개{1}": "{0} recorded additions{1}",
  " · 별도 관측 {0}건": " · {0} separate observations",
  "추가 이력 미제공": "Addition history unavailable",
  "이 날짜는 관측 시작 이전입니다.": "This date precedes the start of observations.",
  "조회일에 기록된 관측 변화가 없습니다. 실제 변화 없음과 다릅니다.": "No observed changes were recorded on this date. This does not establish that no changes occurred.",
  "첫 목록을 기준선으로 저장했습니다. 과거 소스를 신규 추가로 세지 않습니다.": "The first registry was saved as the baseline. Existing sources are not counted as new additions.",
  "조회일에 기록된 추가가 없습니다.": "No additions were recorded on this date.",
  "등록 추가 이력이 제공되지 않습니다.": "Registry addition history is unavailable.",
  "이름 없음": "Unnamed",
  "사이트맵": "Sitemap",
  "유형 없음": "No endpoint type",
  "관측 구간 {0} → {1}": "Observation interval {0} → {1}",
  "기록된 추가 {0}": "Addition recorded {0}",
  "검증 {0} · HTTP {1}": "Validated {0} · HTTP {1}",
  "국가별 저장 기록을 조회합니다.": "Loading saved country records.",
  "국가를 선택하세요": "Select a country",
  "{0}개 국가의 저장 기록을 불러왔습니다.": "Loaded saved records for {0} countries.",
  "기록 조회에 실패했습니다. 다시 조회해 주세요.": "Could not load records. Refresh to try again.",
  "조회 실패 · 저장 데이터 연결을 확인하세요": "Lookup failed · check the saved data connection",
  "국가별 기록을 불러오지 못했습니다.": "Could not load country records.",
  "{0} 수집 상세": "{0} collection details",
  "등록 소스를 조회합니다.": "Loading registered sources.",
  "활성 등록": "Active registrations",
  "고유 언론사": "Unique publishers",
  "마지막 검사": "Latest check",
  "비교 기준": "Comparison baseline",
  "{0}개 같은 요일 완료 회차": "{0} completed cycles on the same weekday",
  "참고 기준": "Reference baseline",
  "{0}개 같은 요일 저장 구간": "{0} saved windows on the same weekday",
  "소스 상세 조회에 실패했습니다. 국가를 다시 선택해 주세요.": "Could not load source details. Select the country again.",
  "최근 7일 · 국가 자체의 저장 관측": "Last 7 days · saved observations for this country",
  "검사 범위 / 성공률 · UTC": "Check coverage / success rate · UTC",
  "저장 구간 종료": "Saved window closed",
  "이력 없음": "No history",
  "불완전 구간": "Incomplete window",
  "{0} UTC · 검사 범위 {1} · 수집 성공률 {2} · {3}": "{0} UTC · check coverage {1} · collection success rate {2} · {3}",
  "검색 조건에 맞는 소스가 없습니다.": "No sources match your search.",
  "이 국가에 조회 가능한 등록 소스가 없습니다.": "No registered sources are available for this country.",
  "이름 미확인": "Unknown name",
  "소스 ID 미확인": "Unknown source ID",
  "등록 {0}개": "{0} registrations",
  "{0}개 주소": "{0} endpoints",
  "이 소스의 실제 활동 이력을 조회합니다.": "Loading this source's recorded activity.",
  "기록 없음": "No records",
  "{0}일 미확인": "{0} days unknown",
  "기준선 제외": "Baseline excluded",
  "신규 발견 URL": "Newly discovered URLs",
  "최초 기준선 제외 · 소스 내 중복 제거 · 발행 기사 수와 다름": "Initial baseline excluded · deduplicated within the source · not a published article count",
  "조회일": "Selected date",
  "최근 7일": "Last 7 days",
  "최근 30일": "Last 30 days",
  "{0} ~ {1} 미포함": "{0} to {1}, end excluded",
  "등록된 주소가 없습니다.": "No registered endpoints.",
  "주소": "Endpoint",
  "저장 검사 {0}": "Saved check {0}",
  "검사 성공 {0} · 실패 {1}": "Successful checks {0} · failed {1}",
  "최근 콘텐츠 날짜 {0}": "Latest content date {0}",
  "저장 콘텐츠 날짜: {0}": "Saved content date: {0}",
  "오래됨": "Stale",
  "이전 정상 {0}": "Prior success {0}",
  "일": "Daily",
  "주": "Weekly",
  "월": "Monthly",
  "{0} 고유 URL": "{0} unique URLs",
  "미집계": "Not counted",
  "주소별 URL 집계 범위": "Endpoint URL counting scope",
  "주소별 고유 발견 수는 이력이 없어 계산하지 않습니다. 소스 집계에 귀속된 URL: {0}. 발행 기사 수와 다릅니다.": "Unique discoveries per endpoint are unavailable without history. URLs attributed to the source total: {0}. These are not published article counts.",
  "최근 7일 검사 · 발견 기록": "Last 7 days of checks and discoveries",
  "주소별 최근 7일 검사 수, 성공 검사 수와 소스 귀속 신규 URL": "Endpoint check counts, successful checks, and source-attributed new URLs over the last 7 days",
  "UTC 날짜": "UTC date",
  "검사": "Checks",
  "성공": "Successful",
  "소스 귀속 URL": "Source-attributed URLs",
  "구간": "Window",
  "검사 근거와 집계 범위 보기": "View check evidence and counting scope",
  "{0} 조사": "{0} investigation",
  "{0} UTC 저장 기록 · {1}": "{0} UTC saved records · {1}",
  "실행 ID {0}": "Run ID {0}",
  "조사 결과": "Investigation results",
  "소스": "Source",
  "저장 기록 기준 판단입니다.": "Assessment based on saved records.",
  "판정 근거": "Assessment evidence",
  "최근 활동 {0} · 과거 정상 {1} · 저장 검사 {2}": "Latest activity {0} · prior success {1} · saved check {2}",
  "확인한 범위에서 추가 점검 대상이 없습니다.": "No further review targets were found in the checked scope.",
  "정상·회복 기록 {0}건": "{0} healthy or recovered records",
  "실행 이벤트": "Execution event",
  "모델 ${0}": "Model ${0}",
  "도구 결과 표시 생략 있음": "Some tool result content is omitted",
  "실제 하위 작업 · 상위 {0}": "Recorded child task · parent {0}",
  "도구 인자 · 실제 결과": "Tool arguments · recorded result",
  "도구 인자 · 오류": "Tool arguments · error",
  "{0} · {1}회": "{0} · {1} calls",
  "없음 · 규칙 기반": "None · rules",
  "사용량 추정 · 실제 청구액 별도": "Usage estimate · actual billing separate",
  "모델의 추가 제안 · 검증 전": "Additional model suggestions · unverified",
  "확인된 소스": "Verified source",
  "{0}/{1}개 소스{2}": "{0}/{1} sources{2}",
  " · 일부 조사": " · partial investigation",
  "조사 범위 집계 중": "Calculating investigation scope",
  "MCP {0}회": "MCP {0} calls",
  "{0} {1}회": "{0} {1} calls",
  "추정 ${0}": "Estimated ${0}",
  "사용량 미확인": "Usage unknown",
  "토큰 사용량 환산은 실제 청구액과 다를 수 있습니다.": "Token usage estimates may differ from the actual charge.",
  "모델 비용 $0": "Model cost $0",
  "{0}초": "{0} seconds",
  "실행 한도 도달": "Execution limit reached",
  "일부 기록 제외": "Some records omitted",
  "실제 실행 기록 · {0}개 이벤트": "Recorded execution · {0} events",
  "실행 ID {0}{1}": "Run ID {0}{1}",
  " · 입력 {0} / 출력 {1} 토큰": " · input {0} / output {1} tokens",
  "조사 {0}. 실제 실행 이벤트 {1}개.": "Investigation {0}. {1} recorded execution events.",
  "제안": "Proposed",
  "승인됨": "Approved",
  "로컬 적용됨": "Applied locally",
  "회복 확인": "Recovery confirmed",
  "되돌림": "Rolled back",
  "후보 검증됨 · 적용 전": "Candidate validated · not applied",
  "기사 수집 확인 필요": "Article collection needs verification",
  "수집 회차 대기": "Awaiting a collection cycle",
  "수집 성공 · 새 콘텐츠 대기": "Collection succeeded · awaiting new content",
  "등록 변경 · 재검토 필요": "Registry changed · review required",
  "제안 기록": "Proposal record",
  "대체 주소 검토": "Review an alternative endpoint",
  "해당 언론사의 공식 홈페이지": "Publisher's official homepage",
  "공식 후보 확인": "Check official candidates",
  "홈페이지에 명시된 RSS·사이트맵만 확인합니다.": "Checks only RSS feeds and sitemaps declared on the homepage.",
  "공식 선언과 주소를 검사하는 중입니다.": "Checking official declarations and endpoints.",
  "검증된 대체 주소를 찾지 못했습니다. 등록은 변경하지 않았습니다.": "No validated alternative endpoint was found. The registry was not changed.",
  "검사한 후보 {0}개": "{0} candidates checked",
  "형식 검사 성공": "Format check succeeded",
  "주소 수정 제안": "Endpoint repair proposal",
  "현재": "Current",
  "변경": "Replacement",
  "공식 선언": "Official declaration",
  "HTTP {0} · {1}개 URL 포함 · {2}": "HTTP {0} · {1} URLs included · {2}",
  "로컬 등록부 적용됨 · 서버 다시 시작/운영 배포 필요": "Applied to local registry · server restart or production deployment required",
  "로컬 등록부 적용됨 · 운영 배포는 별도입니다.": "Applied to the local registry · production deployment is separate.",
  "적용은 로컬 등록에만 반영됩니다. 운영 배포는 별도입니다.": "Changes apply only to the local registry. Production deployment is separate.",
  "처리 중": "Processing",
  "공식 홈페이지와 위 주소 교체를 확인했습니다.": "I verified the official homepage and the endpoint replacement above.",
  "승인 갱신": "Renew approval",
  "수정 승인": "Approve repair",
  "승인한 수정 적용": "Apply approved repair",
  "후보 재검사": "Recheck candidate",
  "주소 변경은 인증된 관리자만 적용할 수 있습니다.": "Only an authenticated administrator can apply endpoint changes.",
  "적용 이후 정상 수집과 새 콘텐츠를 확인했습니다.": "Successful collection and new content were verified after applying the change.",
  "적용 후 정상 수집 회차와 새 콘텐츠가 확인되어야 회복으로 판단합니다.": "Recovery requires a successful collection cycle and new content after applying the change.",
  "후보 검사 기록": "Candidate check record",
  "수정 제안 {0}건": "{0} repair proposals",
  "실행 접수 기록을 찾지 못했습니다. 서버 재시작·기록 만료 여부를 확인해 주세요. 자동으로 조사를 다시 시작하지 않았습니다.": "The accepted request record was not found. Check for a server restart or expired record. The investigation was not restarted automatically.",
  "서버 연결이 끊겨 실행 접수 여부를 확인하지 못했습니다. 연결 다시 확인으로 기존 요청을 조회할 수 있습니다.": "The connection was lost before request acceptance could be confirmed. Reconnect to look up the existing request.",
  "실행 기록이 서버에 없습니다. 서버 재시작이나 기록 만료로 이전 결과를 조회할 수 없습니다.": "The run record is unavailable on the server. A restart or expired record prevents lookup of previous results.",
  "서버 연결이 끊겨 조사 상태를 확인하고 있습니다. 마지막 결과를 유지하며 기존 조사만 다시 조회합니다.": "The connection was lost while checking investigation status. The last result is retained while only the existing investigation is retried.",
  "실행 기록 없음": "Run record unavailable",
  "연결 확인 중": "Reconnecting",
  "이 환경에서는 조사 실행이 비활성화되어 있습니다.": "Investigations are disabled in this environment.",
  "실행 접수 여부 확인 중 · 조사를 중복 시작하지 않습니다.": "Checking request acceptance · the investigation will not be started twice."
});
let language = 'en';
function normalizeLanguage(value) { return value === 'ko' ? 'ko' : 'en'; }
function readLanguage(storage) {
  try { return normalizeLanguage((storage ?? window.localStorage).getItem(LANGUAGE_STORAGE_KEY)); }
  catch { return 'en'; }
}
function setLanguageValue(value) { language = normalizeLanguage(value); return language; }
class LocalizedText {
  constructor(render) { this.render = render; }
  toString() { return String(this.render()); }
  [Symbol.toPrimitive]() { return this.toString(); }
  replace(...args) { return this.toString().replace(...args); }
}
const staticTranslationCache = new Map();
function t(template, ...values) {
  const tagged = Array.isArray(template);
  const key = tagged ? template.map((part, index) => `${index ? `{${index - 1}}` : ''}${part}`).join('') : template;
  if (!tagged && !Object.hasOwn(translations, key)) return template;
  if (!tagged && staticTranslationCache.has(key)) return staticTranslationCache.get(key);
  const result = new LocalizedText(() => {
    const pattern = language === 'ko' ? key : translations[key] ?? key;
    return tagged ? pattern.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? '')) : pattern;
  });
  result.key = key;
  if (!tagged) staticTranslationCache.set(key, result);
  return result;
}
function localizedJoin(values, separator = '') { return new LocalizedText(() => values.map(String).join(separator)); }
class UIError extends Error {
  constructor(message) { super(String(message)); if (message instanceof LocalizedText) this.localizedMessage = message; }
}
// END I18N HELPERS

// BEGIN I18N BINDINGS
// Bind authored getters to existing text nodes so switching language preserves forms and run state.
const languageBindings = new Map();
let bindingPruneScheduled = false;
function pruneLanguageBindings() {
  bindingPruneScheduled = false;
  for (const target of languageBindings.keys()) if (target.isConnected === false) languageBindings.delete(target);
}
function bindLanguage(target, key, update) {
  let entries = languageBindings.get(target);
  if (!entries) { entries = new Map(); languageBindings.set(target, entries); }
  entries.set(key, update); update();
  if (!bindingPruneScheduled) { bindingPruneScheduled = true; queueMicrotask(pruneLanguageBindings); }
}
function localizedTextNode(getter) {
  const text = document.createTextNode('');
  bindLanguage(text, 'data', () => { text.data = String(getter() ?? ''); });
  return text;
}
function setText(element, getter) {
  bindLanguage(element, 'textContent', () => { element.textContent = String(getter() ?? ''); });
}
function setLocalizedAttribute(element, attribute, getter) {
  bindLanguage(element, attribute, () => { element.setAttribute(attribute, String(getter() ?? '')); });
}
function applyStaticLanguage() {
  document.documentElement.lang = language;
  document.querySelectorAll('[data-i18n-en][data-i18n-ko]').forEach(element => {
    element.textContent = element.getAttribute(`data-i18n-${language}`);
  });
  ['title', 'aria-label', 'placeholder', 'content'].forEach(attribute => {
    document.querySelectorAll(`[data-i18n-${attribute}-en][data-i18n-${attribute}-ko]`).forEach(element => {
      element.setAttribute(attribute, element.getAttribute(`data-i18n-${attribute}-${language}`));
    });
  });
  const selector = document.getElementById('language-select');
  if (selector) selector.value = language;
}
function applyLanguage(value, persist = true) {
  setLanguageValue(value);
  if (persist) { try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Storage can be blocked. The current choice still works. */ } }
  applyStaticLanguage();
  for (const [target, entries] of languageBindings) {
    if (target.isConnected === false) { languageBindings.delete(target); continue; }
    for (const update of entries.values()) update();
  }
  // Refresh only the country table for locale-sensitive sorting/search. Details and forms stay mounted.
  if (state.overview) renderCountries();
}
// END I18N BINDINGS

// Rendering uses text nodes only. Source names, URLs and tool results are untrusted data.
const $ = (id) => document.getElementById(id);
const state = { overview: null, countries: [], selected: null, countryData: null, countryRequest: 0, overviewRequest: 0, accessRevision: 0, sourceCache: new Map(), run: null, poll: null, activeTab: 'status', pendingStart: null, pollFailures: 0, adminSession: null, reloadRequiredProposals: new Set() };
const numberFormats = { en: new Intl.NumberFormat('en-US'), ko: new Intl.NumberFormat('ko-KR') };
const regionNames = { en: new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }), ko: new Intl.DisplayNames(['ko'], { type: 'region', fallback: 'none' }) };
const koreanCountries = { US: t('미국'), KR: t('한국'), JP: t('일본'), GB: t('영국'), CN: t('중국'), FR: t('프랑스'), DE: t('독일'), IN: t('인도'), AU: t('호주'), CA: t('캐나다'), BR: t('브라질'), IT: t('이탈리아'), ES: t('스페인'), RU: t('러시아'), MX: t('멕시코'), ID: t('인도네시아'), TR: t('튀르키예'), SA: t('사우디아라비아'), AR: t('아르헨티나'), ZA: t('남아프리카공화국') };
// IMF Data Mapper NGDPD: 2026 nominal GDP estimate, billion current US dollars.
// Retrieved 2026-10-13. https://www.imf.org/external/datamapper/api/v1/NGDPD/2026
const nominalGdp2026 = Object.freeze({"US":32642.373,"CN":21546.403,"JP":4341.986,"DE":5471.299,"IN":4060.207,"GB":4268.446,"FR":3554.155,"IT":2701.737,"CA":2490.256,"RU":2861.156,"KR":2245.847,"BR":2654.761,"AU":2110.657,"ES":2085.276,"MX":2176.236,"ID":1479.954,"MA":195.632,"NL":1423.856,"CH":1135.739,"TR":1817.987,"SA":1343.346,"IL":746.982,"JO":64.88,"KW":146.911,"TW":1019.596,"PL":1133.088,"SE":745.081,"BE":772.699,"TH":599.115,"IR":311.95,"AR":768.206,"CL":402.243,"DO":145.362,"UY":95.155,"AT":616.896,"NZ":273.395,"NO":651.712,"IE":709.972,"PT":375.197,"DK":499.354,"FI":338.564,"CZ":427.953,"GR":304.627,"RO":470.091,"UA":229.406,"LU":108.33,"SK":167.062,"HU":265.911,"BG":146.507,"HR":115.915,"SI":88.869,"RS":111.204,"LT":104.721,"LV":53.162,"EE":51.029,"IS":42.772,"EG":442.886,"NG":386.671,"SG":667.889,"ZA":489.083,"BH":46.018,"QA":203.044,"AE":661.018,"SV":39.379,"EC":138.199,"OM":121.397,"CO":572.735,"MY":547.1,"PH":501.692,"VN":542.13,"MN":31.131,"PK":450.134,"KZ":397.921});
function compareEconomy(a, b) {
  const left = countryCode(a), right = countryCode(b);
  const pinned = { US: 0, CN: 1 };
  const priority = (pinned[left] ?? 2) - (pinned[right] ?? 2);
  if (priority) return priority;
  return (nominalGdp2026[right] ?? -Infinity) - (nominalGdp2026[left] ?? -Infinity)
    || countryName(a).localeCompare(countryName(b), language);
}
const classificationLabels = {
  failure_after_prior_success: [t('과거 성공 후 실패'), 'failure'], recovered_after_failure: [t('회복 기록'), 'healthy'],
  stale_content_evidence: [t('오래된 콘텐츠'), 'attention'], access_failure_without_normal_baseline: [t('접근 실패 · 기준 부족'), 'attention'],
  successful_no_new_discoveries: [t('검사 성공 · 신규 0'), 'healthy'], successful_collection: [t('수집 성공'), 'healthy'],
  index_only: [t('목록 확인'), 'neutral'], not_attempted_in_period: [t('기간 내 미검사'), 'neutral'], untracked_or_no_available_checks: [t('미추적 · 기록 부족'), 'neutral'],
  working_nonempty: [t('검사 성공'), 'healthy'], valid_empty: [t('유효한 빈 응답'), 'healthy'], fetch_failed: [t('검사 실패'), 'failure'], timeout: [t('타임아웃'), 'failure'],
  review_needed: [t('조사 대상'), 'attention'], partial_window: [t('부분 구간'), 'neutral'], insufficient_baseline: [t('기준 부족'), 'neutral'], no_drop_signal: [t('하락 신호 없음'), 'healthy'],
  running: [t('실행 중'), 'running'], completed: [t('완료'), 'healthy'], failed: [t('실패'), 'failure'], queued: [t('대기'), 'neutral'],
  not_tracked: [t('미추적'), 'neutral'], not_collected: [t('미검사'), 'neutral'], failed_or_index_only: [t('실패 / 목록만 확인'), 'attention'], partial: [t('부분 수집'), 'neutral'], complete: [t('검사 완료'), 'healthy'],
  history_not_in_snapshot: [t('저장 이력 범위 밖'), 'neutral'], not_initialized: [t('추적 기록 없음'), 'neutral'], initialized: [t('추적 중'), 'neutral'], unknown: [t('미확인'), 'neutral']
};
Object.assign(classificationLabels, { recent: [t('최근 콘텐츠 기록'), 'healthy'], stale: [t('오래된 저장 검사'), 'attention'], missing: [t('콘텐츠 날짜 없음'), 'neutral'], unreliable: [t('콘텐츠 날짜 신뢰 부족'), 'neutral'], healthy: [t('저장 검사 성공'), 'healthy'], unhealthy: [t('저장 검사 실패'), 'failure'], partial_snapshot_window: [t('완료되지 않은 저장 구간'), 'neutral'], closed_calendar_window: [t('달력 구간 종료'), 'neutral'], after_latest_collection: [t('마지막 검사 이후'), 'neutral'], history_unavailable: [t('저장 이력 범위 밖'), 'neutral'], unavailable: [t('자료 없음'), 'neutral'], observed: [t('관측된 집계'), 'healthy'], insufficient_endpoint_history: [t('주소별 판단 근거 부족'), 'neutral'], completion_not_recorded: [t('회차 기록 없음'), 'neutral'], incomplete_or_explicit_cycle: [t('회차 비교 제외'), 'neutral'], insufficient_completed_cycle_history: [t('기준 축적 중'), 'neutral'], insufficient_evidence: [t('근거 부족'), 'neutral'], lookup_failed: [t('조회 실패'), 'failure'], bounded_country_sample: [t('일부 소스 표본 조사'), 'neutral'] });

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined && content !== null) element.append(localizedTextNode(typeof content === 'function' ? content : () => content));
  return element;
}
function valueText(value, fallback = '—') { return typeof value === 'number' && Number.isFinite(value) ? numberFormats[language].format(value) : fallback; }
function countryCode(country) { return String(country.country ?? country.code ?? country.countryCode ?? '').toUpperCase(); }
function countryName(country) {
  const code = countryCode(country);
  if (koreanCountries[code]) return String(koreanCountries[code]);
  return String(/^[A-Z]{2}$/.test(code) ? regionNames[language].of(code) ?? t('국가 미확인') : t('국가 미확인'));
}
function countrySearchNames(country) {
  const code = countryCode(country), names = [countryName(country), country.name, koreanCountries[code]?.key];
  if (/^[A-Z]{2}$/.test(code)) names.push(regionNames.en.of(code), regionNames.ko.of(code));
  return names;
}
function endpointTypeText(type) { return type === 'sitemap' ? t('사이트맵') : type === 'rss' ? 'RSS' : type; }
function inventory(country) { return country.inventory ?? country; }
function metrics(country) { return country.metrics ?? country; }
function publisherCountText(counts) {
  const value = counts.unique_publishers;
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${counts.publisher_count_state === 'estimated_from_registry_identity' ? '≈ ' : ''}${valueText(value)}`;
}
function publisherCountNote(counts) {
  const basis = counts.publisher_identity_basis ?? {};
  if (typeof counts.unique_publishers !== 'number' || !Number.isFinite(counts.unique_publishers)) {
    const notes = [t('언론사 식별 근거가 없어 계산할 수 없습니다. 0개를 뜻하지 않습니다.')];
    if (basis.unresolved_active_registrations > 0) notes.push(t`식별하지 못한 활성 등록 ${valueText(basis.unresolved_active_registrations)}개가 있습니다.`);
    return localizedJoin(notes, ' ');
  }
  if (counts.publisher_count_state !== 'estimated_from_registry_identity') return t('활성 등록에서 중복을 제거한 고유 언론사 수입니다.');
  const notes = [t('활성 등록의 매체 브랜드 기준 추정입니다. 사이트 도메인·별칭으로 중복을 제거하며 모회사별로 합치지 않습니다. 공유 서버와 연결되지 않은 다른 도메인은 오차가 있을 수 있습니다.')];
  if (basis.name_fallback_groups > 0) notes.push(t`${valueText(basis.name_fallback_groups)}개 그룹은 사이트 도메인 없이 등록명·공유 피드 경로로 추정합니다.`);
  return localizedJoin(notes, ' ');
}
function publisherCountCell(counts) { const cell = node('td', 'numeric publisher-count', () => (publisherCountText(counts))); setLocalizedAttribute(cell, 'title', () => (publisherCountNote(counts))); return cell; }
function countryTableColumns() { return 9 - Number($('freshness-heading').hidden) - Number($('observation-heading').hidden); }
function timeText(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return t('미확인');
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}
function clockText(value) { return value && Number.isFinite(Date.parse(value)) ? `${new Date(value).toISOString().slice(11, 23)} UTC` : t('시각 미확인'); }
function evidenceTimeText(timestamp, calendarDate) {
  if (typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return timeText(timestamp);
  const date = calendarDate ?? timestamp;
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) ? t`${date} UTC (날짜 기록)` : t('미확인');
}
function badge(value, fallback) {
  const key = typeof value === 'object' && value !== null ? value.state ?? value.status ?? value.classification : value;
  const [label, style] = classificationLabels[key] ?? [fallback ?? key ?? t('미확인'), 'neutral'];
  return node('span', `badge ${style}`, () => (label));
}
function appendMeta(target, label, value) {
  const entry = node('span', '', () => (label));
  entry.append(node('strong', '', () => (value ?? t('미확인'))));
  target.append(entry);
}
function humanInvestigationError(value) {
  if (typeof value !== 'string') return value;
  const code = value.trim();
  if (/^(OPENAI|JEV)_CONTEXT_LIMIT$/.test(code)) return t('조사 입력 한도에 도달했습니다.');
  if (/^(OPENAI|JEV)_MODEL_CALL_LIMIT$/.test(code)) return t('모델 호출 한도에 도달했습니다.');
  if (code === 'OPENAI_READ_TOOL_LIMIT' || code === 'INVESTIGATION_LIMIT') return t('조사 실행 한도에 도달했습니다.');
  if (/^(OPENAI|JEV)_(RUN|SESSION)_BUDGET_LIMIT$/.test(code) || /^(OPENAI|JEV)_COST_BOUND_EXCEEDED$/.test(code)) return t('승인된 비용 한도에 도달했습니다.');
  if (/^(OPENAI|JEV)_EXECUTION_NOT_AUTHORIZED$/.test(code)) return t('이 조사 방식은 현재 실행할 수 없습니다.');
  if (/^(OPENAI|JEV)_KEY_SOURCE_(INVALID|UNAVAILABLE)$/.test(code)) return t('API 연결 설정을 확인해 주세요.');
  if (/^(OPENAI|JEV)_(PRICING_REQUIRED|PRICED_MODEL_MISMATCH|PRICED_MODEL_REQUIRED)$/.test(code)) return t('모델 실행 설정을 확인해 주세요.');
  if (/^(OPENAI|JEV)_RUN_CANCELLED$/.test(code)) return t('조사가 중단됐습니다.');
  if (/^(OPENAI|JEV)_(MODEL_REQUEST_FAILED|AGENT_RUN_FAILED|CLASSIFIER_RUN_FAILED)$/.test(code)) return t('모델 조사를 완료하지 못했습니다. 실행 기록을 확인해 주세요.');
  if (/^(OPENAI|JEV)_(USAGE_MISSING|USAGE_COST_UNKNOWN|RESPONSE_INVALID_OR_USAGE_MISSING|ANSWER_SET_MISMATCH|PROBABILITY_CONTRACT_INVALID|RESPONSE_LIMIT)$/.test(code)) return t('모델 응답을 검증하지 못했습니다.');
  if (/^(OPENAI|JEV)_[A-Z_]+$/.test(code)) return t('조사를 완료하지 못했습니다. 실행 기록을 확인해 주세요.');
  return value;
}
function errorMessage(error) {
  if (error?.localizedMessage) return error.localizedMessage;
  const text = error instanceof Error ? error.message : t('데이터를 불러오지 못했습니다.');
  const messages = { QUALITY_ADMIN_AUTH_REQUIRED: t('관리자 로그인 정보를 확인해 주세요.'), QUALITY_CLOUD_UNAVAILABLE: t('서버에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.'), QUALITY_CLOUD_TIMEOUT: t('조회 시간이 초과됐습니다. 잠시 후 다시 확인해 주세요.'), WORKFLOW_AUTH_REQUIRED: t('관리자 로그인이 필요합니다.'), WORKFLOW_EXACT_APPROVAL_REQUIRED: t('현재 관리자 세션에서 이 수정안을 다시 승인해 주세요.'), WORKFLOW_REGISTRY_CHANGED: t('등록 상태가 바뀌었습니다. 후보를 다시 검토해 주세요.'), WORKFLOW_VALIDATION_EXPIRED: t('검사 기록이 오래됐습니다. 후보를 다시 검사해 주세요.'), WORKFLOW_SOURCE_ENDPOINT_NOT_FOUND: t('현재 등록에서 해당 소스 주소를 찾지 못했습니다.'), WORKFLOW_ALREADY_APPLIED: t('이미 적용된 제안입니다. 기록을 다시 확인해 주세요.'), OPENAI_EXECUTION_NOT_AUTHORIZED: t('OpenAI 실행 설정을 확인해 주세요.'), JEV_EXECUTION_NOT_AUTHORIZED: t('Jev 실행 설정을 확인해 주세요.'), INVESTIGATION_BUSY: t('진행 중인 조사가 있습니다. 완료 후 다시 실행해 주세요.') };
  return messages[text] ?? humanInvestigationError(text);
}
function showError(id, error) { setText($(id), () => (error ? errorMessage(error) : '')); $(id).hidden = !error; }
function emptyRow(target, columns, text) { target.replaceChildren(); const row = node('tr'); const cell = node('td', 'empty-cell', () => (text)); cell.colSpan = columns; row.append(cell); target.append(row); }
function describeState(value) { return classificationLabels[value]?.[0] ?? value ?? t('미확인'); }
function safeLink(url) {
  const anchor = node('a', 'endpoint-url', () => (url || t('주소 미확인')));
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); anchor.href = parsed.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; } catch { anchor.removeAttribute('href'); }
  return anchor;
}
class DashboardConnectionError extends UIError {
  constructor() { super(t('대시보드 서버에 연결하지 못했습니다. 서버가 실행 중인지 확인한 뒤 연결을 다시 확인해 주세요.')); this.name = 'DashboardConnectionError'; }
}
class DashboardHttpError extends UIError {
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
        throw new DashboardHttpError(t`저장 기록 API가 JSON을 반환하지 않았습니다 (${response.status}).`, response.status);
      }
      if (!response.ok) throw new DashboardHttpError(data.error?.message ?? data.error ?? data.message ?? t`조회 실패 (${response.status})`, response.status);
      return data;
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'AbortError') throw error;
      if (attempt + 1 >= attempts) throw new DashboardConnectionError();
      setText($('screen-status'), () => (t`서버 연결 복구 중 · 읽기 요청 재확인 ${attempt + 1}/${attempts - 1}`));
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
    const reason = unavailableLabel ?? (metric?.denominator === 0 ? t('평가 대상 없음') : t('자료 미제공'));
    element.append(node('span', 'metric-unknown', () => ('—')));
    setLocalizedAttribute(element, 'title', () => (reason));
    return element;
  }
  const amount = metric.value;
  const main = node('span', 'metric-value', () => (amount.toFixed(1)));
  main.append(node('span', 'metric-unit', () => ('%')));
  element.append(main);
  const fraction = typeof metric.numerator === 'number' && typeof metric.denominator === 'number' ? t`${valueText(metric.numerator)} / ${valueText(metric.denominator)} 주소` : t('비율');
  element.append(node('span', 'metric-fraction', () => (fraction)));
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
  const observed = t`확인 ${timeText(schedule.as_of)}`;
  if (positive(schedule.deferred_endpoints)) {
    const note = node('span', 'schedule-deferred', () => (t`서버 대기 ${valueText(schedule.deferred_endpoints)}`));
    setLocalizedAttribute(note, 'title', () => (t`서버가 요청한 재검사 대기시간을 따릅니다. ${schedule.next_recheck_at ? t`다음 재검사 ${timeText(schedule.next_recheck_at)} · ` : ''}${observed}`));
    notes.append(note);
  }
  if (positive(schedule.unattempted_unrestricted_endpoints)) {
    const running = schedule.cycle_status === 'running';
    const note = node('span', 'schedule-unattempted', () => (`${running ? t('검사 전') : t('미검사')} ${valueText(schedule.unattempted_unrestricted_endpoints)}`));
    setLocalizedAttribute(note, 'title', () => (t`서버 제한 대기 없이 ${running ? t('이번 회차 검사를 기다리는') : t('아직 검사 기록이 없는')} 주소입니다. ${observed}`));
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
  const clauses = [t`${data.date || t('날짜 없음')} UTC 기록`, partial ? t('부분 구간 포함') : t('저장된 검사 범위')];
  clauses.push(completed ? t`완료 회차 기록 ${completed}/${countries.length}개국` : t('완료 회차 기록 없음'));
  const common = data.completed_cycle_common_signal ?? data.common_collector_signal;
  if (common?.state === 'investigate_common_collector_first') clauses.push(t('동시 하락 신호 · 공통 원인 우선 조사'));
  return clauses.join(' / ');
}

function renderCountries() {
  const search = $('country-search').value.trim().toLocaleLowerCase();
  const exactCode = state.countries.some((country) => countryCode(country).toLocaleLowerCase() === search);
  const countries = state.countries.filter((country) => exactCode ? countryCode(country).toLocaleLowerCase() === search : [countryCode(country), ...countrySearchNames(country)].some((value) => String(value ?? '').toLocaleLowerCase().includes(search)));
  const sort = $('country-sort').value;
  const metricSort = (country, kind) => metrics(country)[kind]?.value ?? Infinity;
  const attentionRank = (country) => ({ review_needed: 0, partial_window: 1, incomplete_or_explicit_cycle: 1, insufficient_baseline: 2, insufficient_completed_cycle_history: 2, completion_not_recorded: 2, no_drop_signal: 3 })[countryAssessment(country).state] ?? 2;
  countries.sort((a, b) => {
    if (sort === 'economy') return compareEconomy(a, b);
    if (sort === 'coverage') return metricSort(a, 'attempt_coverage') - metricSort(b, 'attempt_coverage');
    if (sort === 'success') return metricSort(a, 'success_rate') - metricSort(b, 'success_rate');
    if (sort === 'inventory') return (inventory(b).active_source_registrations ?? 0) - (inventory(a).active_source_registrations ?? 0);
    if (sort === 'attention' && attentionRank(a) !== attentionRank(b)) return attentionRank(a) - attentionRank(b);
    return countryName(a).localeCompare(countryName(b), language);
  });
  setText($('country-count'), () => (`${countries.length}`));
  const showFreshness = state.countries.some((country) => typeof metrics(country).freshness?.value === 'number');
  $('freshness-heading').hidden = !showFreshness;
  const showObservation = state.countries.some((country) => ['review_needed', 'no_drop_signal'].includes(countryAssessment(country).state));
  $('observation-heading').hidden = !showObservation;
  const tbody = $('country-rows'); tbody.replaceChildren();
  if (!countries.length) { emptyRow(tbody, countryTableColumns(), state.countries.length ? t('검색 조건에 맞는 국가가 없습니다.') : t('조회 가능한 국가 기록이 없습니다.')); return; }
  countries.forEach((country) => {
    const code = countryCode(country), row = node('tr', `country-row${state.selected === code ? ' selected' : ''}`);
    const nameCell = node('td'), button = node('button', 'country-button'); button.type = 'button';
    const title = node('span', 'country-name', () => (countryName(country)));
    button.append(title); button.addEventListener('click', () => selectCountry(code, true)); nameCell.append(button); row.append(nameCell);
    row.append(publisherCountCell(inventory(country)));
    const details = metrics(country);
    ['attempt_coverage', 'success_rate', 'freshness'].forEach((kind) => {
      const cell = node('td'); cell.hidden = kind === 'freshness' && !showFreshness;
      const unavailableLabel = country.lookup_error ? t('조회 실패')
        : kind === 'freshness' ? t('갱신주기 이력 없음')
        : details[kind]?.denominator === 0 ? kind === 'success_rate' ? t('검사 기록 없음') : t('활성 주소 없음')
        : country.period?.state === 'not_tracked' ? t('추적 기록 없음')
        : country.period?.state === 'history_unavailable' ? t('저장 이력 범위 밖') : t('검사 자료 없음');
      cell.append(renderMetric(details[kind], unavailableLabel));
      if (kind === 'attempt_coverage') appendCollectionSchedule(cell, country);
      row.append(cell);
    });
    const counts = inventory(country); row.append(node('td', 'numeric', () => (valueText(counts.active_source_registrations))));
    const endpointCell = node('td', 'numeric endpoint-pair'); endpointCell.append(localizedTextNode(() => (valueText(counts.unique_active_rss_endpoints))), node('span', '', () => ('/')), localizedTextNode(() => (valueText(counts.unique_active_sitemap_endpoints)))); row.append(endpointCell);
    const assessment = countryAssessment(country), status = node('td'); status.hidden = !showObservation; status.append(badge(assessment.state));
    setLocalizedAttribute(status, 'title', () => (assessment.reasons?.length ? assessment.reasons.map((reason) => typeof reason === 'string' ? reason : t`${reason.metric === 'success_rate' ? t('성공률') : t('검사 범위')} ${Number(reason.current).toFixed(1)}% · 기준 ${Number(reason.baseline).toFixed(1)}%`).join('\n') : assessment.scope === 'completed_cycles' ? t('같은 국가·요일·수집 대상의 완료 회차를 비교합니다. 회차 기록이 없거나 충분하지 않으면 하락을 확정하지 않습니다.') : t('저장된 구간을 비교한 참고 신호입니다. 완료된 수집 회차의 운영 장애 판정과 다릅니다.')));
    row.append(status); const arrowCell = node('td'), arrow = node('button', 'row-arrow', () => ('↗')); arrow.type = 'button'; setLocalizedAttribute(arrow, 'aria-label', () => (t`${countryName(country)} 상세 보기`)); arrow.addEventListener('click', () => selectCountry(code, true)); arrowCell.append(arrow); row.append(arrowCell); tbody.append(row);
  });
}

function renderSummary(data) {
  const global = data.global_inventory ?? data.global_totals ?? data.inventory?.global_totals;
  const sum = (key) => state.countries.reduce((total, country) => total + (inventory(country)[key] ?? 0), 0);
  setText($('stat-countries'), () => (valueText(global?.active_countries ?? state.countries.filter((country) => (inventory(country).active_source_registrations ?? 0) > 0).length)));
  // The same publisher can appear in multiple countries; use the server's global deduplicated count.
  setText($('stat-publishers'), () => (publisherCountText(global ?? {})));
  setLocalizedAttribute($('stat-publishers').parentElement, 'title', () => (publisherCountNote(global ?? {})));
  setText($('stat-sources'), () => (valueText(global?.active_source_registrations ?? sum('active_source_registrations'))));
  // Endpoint IDs can cross country boundaries. A global unique total needs server deduplication.
  setText($('stat-rss'), () => (valueText(global?.unique_active_rss_endpoints)));
  setText($('stat-sitemaps'), () => (valueText(global?.unique_active_sitemap_endpoints)));
  setText($('as-of'), () => (timeText(data.latest_collection)));
  setText($('snapshot-status'), () => (data.snapshot_at ? t`스냅샷 생성 ${timeText(data.snapshot_at)}` : t('저장 데이터 시각 미확인')));
  const date = data.date ?? $('date-input').value;
  if (date) $('date-input').value = date;
  setText($('data-note'), () => (observationNote({ ...data, date, items: state.countries })));
  const runtime = data.runtime ?? {};
  const investigationsEnabled = runtime.investigations_enabled !== false;
  ['openai', 'jev'].forEach((engine) => {
    const provider = runtime[engine] ?? {};
    const option = $('investigation-engine').querySelector(`option[value="${engine}"]`);
    option.disabled = !provider.available || !investigationsEnabled;
    setText(option, () => (`${engine === 'openai' ? 'OpenAI' : 'Jev'}${provider.available ? '' : t(' · 준비 필요')}`));
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
  setText($('admin-access'), () => (authenticated ? t('로그아웃') : t('관리자')));
  if (authenticated || !cloud) $('admin-login-form').hidden = true;
  $('runtime-note').hidden = allowed || cloud;
  setText($('runtime-note'), () => (t('이 환경에서는 조사 실행을 사용할 수 없습니다.')));
  $('run-history').open = cloud && !authenticated;
  if (cloud && !authenticated && !state.run) {
    setText($('investigation-empty').querySelector('h3'), () => (t('저장된 조사 결과를 확인하세요.')));
    setText($('investigation-empty').querySelector('p'), () => (t('완료된 조사와 근거가 이곳에 표시됩니다.')));
  }
}

function renderEngineStatus() {
  const engine = $('investigation-engine').value;
  const provider = state.overview?.runtime?.[engine] ?? {};
  const name = engine === 'openai' ? 'OpenAI' : engine === 'jev' ? 'Jev' : t('규칙 기반');
  setText($('investigation-mode'), () => (t`${name} · 읽기 전용`));
  const note = $('openai-note'); note.hidden = engine === 'rules';
  setText(note, () => (engine === 'openai'
    ? provider.available ? t`다음 조회를 모델이 선택합니다. 조사 한도 $${provider.per_run_budget_usd ?? '—'}.` : t('실행 비용 한도와 API 설정이 필요합니다.')
    : engine === 'jev' ? t('저장 근거를 분류합니다. 다음 조회는 규칙이 선택합니다.') : ''));
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
const registryEventLabels = { registration_observed: t('첫 관측'), registry_removal_observed: t('목록에서 사라짐'), registration_reappearance_observed: t('다시 관측'), reactivation_observed: t('재활성화 관측'), deactivation_observed: t('비활성화 관측') };
function renderInventory() {
  const data = state.overview ?? {}, view = registryHistoryView(data);
  const countries = [...state.countries].sort((a, b) => (inventory(b).active_source_registrations ?? 0) - (inventory(a).active_source_registrations ?? 0));
  const tbody = $('inventory-rows'); tbody.replaceChildren();
  countries.forEach((country) => {
    const row = node('tr'), counts = inventory(country); row.append(node('td', 'country-name', () => (countryName(country))));
    row.append(publisherCountCell(counts));
    ['active_source_registrations', 'disabled_source_registrations', 'unique_active_rss_endpoints', 'unique_active_sitemap_endpoints'].forEach((key) => row.append(node('td', 'numeric', () => (valueText(counts[key], country.lookup_error ? t('조회 실패') : '—')))));
    tbody.append(row);
  });
  if (!countries.length) emptyRow(tbody, 6, t('국가별 등록 상태를 불러오지 못했습니다.'));
  const registryAt = data.registry_snapshot_at ?? view.registryAt;
  setText($('inventory-note'), () => (t`등록 기준 ${registryAt ? timeText(registryAt) : t('시각 없음')} · 보유량 순`));
  const publisherKnown = countries.length > 0 && countries.every((country) => typeof inventory(country).unique_publishers === 'number' && Number.isFinite(inventory(country).unique_publishers));
  const publisherEstimated = countries.some((country) => inventory(country).publisher_count_state === 'estimated_from_registry_identity');
  const publisherNotes = [...new Map(countries.filter((country) => typeof inventory(country).unique_publishers === 'number').map((country) => { const note = publisherCountNote(inventory(country)); return [String(note), note]; })).values()];
  document.querySelectorAll('.publisher-heading').forEach((heading) => { setLocalizedAttribute(heading, 'title', () => (publisherNotes.length === 1 ? publisherNotes[0] : t('활성 등록의 언론사 식별 정보를 기준으로 중복 제거합니다. 추정치에는 ≈를 표시합니다.'))); });
  const availability = $('inventory-availability'); availability.replaceChildren(); setText($('inventory-availability-title'), () => (t('언론사 수와 이력의 집계 기준')));
  availability.append(node('p', '', () => (publisherNotes.length === 1 ? publisherNotes[0] : publisherEstimated ? t('≈는 등록된 소스의 식별 정보를 묶은 언론사 수 추정치입니다. 국가별 수에 집계 기준을 표시합니다.') : publisherKnown ? t('언론사 수는 활성 등록의 식별 정보를 기준으로 중복 제거합니다.') : t('언론사 식별 근거가 없는 국가는 —로 표시합니다. 등록 항목을 언론사 수로 세지 않습니다.'))));
  availability.append(node('p', '', () => (view.mode === 'observed' ? t('완전한 등록 목록의 관측 사이에서 달라진 정규화 소스를 셉니다. 첫 관측은 최초 기준선이며, 실제 등록일·삭제일을 뜻하지 않습니다.') : view.mode === 'actual' ? t('변화는 기록된 이벤트만 셉니다. 이력이 완전해야 순증을 계산합니다.') : t('과거 변경 이력이 없어 이전 증가량을 계산하지 않습니다.'))));
  setText($('inventory-history-title'), () => (view.mode === 'observed' ? t('관측된 등록 변화') : t('등록 변화와 신규 소스')));
  setText($('inventory-change-heading'), () => (view.mode === 'observed' ? t('국가별 관측 변화') : t('등록 변화')));
  const historyBody = $('inventory-history-rows'), head = $('inventory-history-head'); historyBody.replaceChildren(); head.replaceChildren();
  const headings = view.mode === 'observed' ? [t('국가'), t('첫 관측'), t('다시 관측'), t('재활성화'), t('비활성화'), t('사라짐'), t('관측 순증')] : [t('국가'), t('기록된 추가'), t('기록된 비활성화'), t('기록된 재활성화'), t('기록된 삭제'), t('순증')];
  headings.forEach((name, index) => { const cell = node('th', index ? 'numeric' : '', () => (name)); cell.scope = 'col'; head.append(cell); });
  setText($('inventory-history-caption'), () => (view.mode === 'observed' ? t('조회일 UTC에 관측된 정규화 소스 변화. 실제 추가·삭제 시각과 다릅니다.') : t('조회일 UTC에 기록된 등록 변화')));
  const observedRows = [...view.rows].sort((a, b) => (b.observed_additions ?? 0) - (a.observed_additions ?? 0) || compareEconomy(a, b));
  const actualRows = countries.map((country) => view.rows.find((change) => countryCode(change) === countryCode(country)) ?? country.inventory_changes ?? { country: countryCode(country) })
    .sort((a, b) => (b.added ?? b.additions ?? 0) - (a.added ?? a.additions ?? 0) || compareEconomy(a, b));
  const rows = view.mode === 'observed' ? observedRows : actualRows;
  $('inventory-history-table').hidden = view.mode === 'unavailable' || view.mode === 'observed' && !view.rows.length;
  if (!$('inventory-history-table').hidden) rows.forEach((change) => {
    const row = node('tr'); row.append(node('td', 'country-name', () => (countryName(change))));
    const counts = view.mode === 'observed' ? [change.observed_additions, change.observed_reappearances, change.observed_reactivations, change.observed_deactivations, change.observed_registry_removals, change.observed_net_normalized_sources] : [change.added ?? change.additions, change.deactivations, change.reactivations ?? change.reactivated, change.deletions, change.net_change ?? change.net];
    counts.forEach((count) => { const cell = node('td', 'numeric', () => (valueText(count))); if (typeof count !== 'number') setLocalizedAttribute(cell, 'title', () => (t('이력이 없어 계산할 수 없습니다. 0건을 뜻하지 않습니다.'))); row.append(cell); }); historyBody.append(row);
  });
  const beforeBaseline = view.mode === 'observed' && view.date < String(view.baseline).slice(0, 10);
  setText($('inventory-history-note'), () => (view.mode === 'observed'
    ? beforeBaseline ? t`관측 시작 ${timeText(view.baseline)} · 조회일은 관측 이전입니다.`
      : !view.comparison ? t`관측 기준선 ${timeText(view.baseline)} · 다음 완전한 목록부터 변화를 비교합니다.`
        : t`${view.date} UTC에 발견한 관측 사이 변화 · 정규화 소스 기준 · 실제 추가·삭제일 미상`
    : view.mode === 'actual' ? t`${view.date} UTC 기록 · —는 이력 없음. 0은 기록된 이벤트 없음. 과거 추가일은 추정하지 않습니다.` : t('이력이 없어 과거 증가량을 집계하지 않습니다. 신규 0건을 뜻하지 않습니다.')));
  setText($('source-events-title'), () => (view.mode === 'observed' ? t('관측된 소스 변화') : t('신규 소스 목록')));
  const events = view.mode === 'observed' ? [...view.events].reverse() : [...view.events, ...(view.observations ?? [])], list = $('new-source-list'); list.replaceChildren();
  setText($('new-source-count'), () => (view.mode === 'observed' ? beforeBaseline ? t('관측 이전') : !view.comparison ? t('최초 기준선') : t`관측 ${events.length}건` : view.mode === 'actual' ? t`기록된 추가 ${view.events.length}개${view.observations?.length ? t` · 별도 관측 ${view.observations.length}건` : ''}` : t('추가 이력 미제공')));
  if (view.mode === 'actual' && view.events.length) $('inventory-history-details').open = true;
  if (!events.length) {
    list.append(node('div', 'inventory-empty', () => (beforeBaseline ? t('이 날짜는 관측 시작 이전입니다.') : view.mode === 'observed' ? view.comparison ? t('조회일에 기록된 관측 변화가 없습니다. 실제 변화 없음과 다릅니다.') : t('첫 목록을 기준선으로 저장했습니다. 과거 소스를 신규 추가로 세지 않습니다.') : view.mode === 'actual' ? t('조회일에 기록된 추가가 없습니다.') : t('등록 추가 이력이 제공되지 않습니다.'))));
    return;
  }
  events.forEach((source) => {
    const observation = Boolean(registryEventLabels[source.kind]);
    const card = node('article', 'new-source-card'); card.append(node('h3', '', () => (source.name ?? source.source_name ?? source.source?.name ?? t('이름 없음'))));
    const types = [...new Set((source.endpoints ?? []).map((endpoint) => endpoint.type))].map(endpointTypeText);
    card.append(node('p', '', () => (`${countryName(source)} · ${types.join(' / ') || (source.endpoint_types ?? []).map(endpointTypeText).join(' / ') || endpointTypeText(source.type ?? source.endpoint_type) || t('유형 없음')}${observation ? ` · ${registryEventLabels[source.kind]}` : ''}`)));
    card.append(node('p', '', () => (observation ? t`관측 구간 ${timeText(source.previous_observed_at).replace(' UTC', '')} → ${timeText(source.observed_at)}` : t`기록된 추가 ${timeText(source.recorded_at ?? source.added_at ?? source.at)}`)));
    for (const endpoint of source.endpoints ?? []) {
      const check = endpoint.latest_validation;
      if (check) { const line = node('p', '', () => (t`검증 ${timeText(check.checked_at)} · HTTP ${valueText(check.http_status)}`)); line.append(badge(check.status)); card.append(line); }
      card.append(safeLink(endpoint.url));
      if (check?.reason) card.append(node('p', '', () => (check.reason)));
    }
    if (source.url) card.append(safeLink(source.url));
    if (source.validation?.reason ?? source.reason) card.append(node('p', '', () => (source.validation?.reason ?? source.reason)));
    list.append(card);
  });
}

async function loadOverview() {
  const request = ++state.overviewRequest;
  $('refresh').disabled = true; showError('page-error', null); setText($('screen-status'), () => (t('국가별 저장 기록을 조회합니다.')));
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
    const select = $('investigation-country'), previous = select.value; select.replaceChildren(node('option', '', () => (t('국가를 선택하세요')))); select.firstChild.value = '';
    state.countries.forEach((country) => { const option = node('option', '', () => (countryName(country))); option.value = countryCode(country); select.append(option); });
    select.value = state.countries.some((country) => countryCode(country) === previous) ? previous : '';
    const code = state.countries.some((country) => countryCode(country) === state.selected) ? state.selected : null;
    if (code) await selectCountry(code);
    setText($('screen-status'), () => (t`${state.countries.length}개 국가의 저장 기록을 불러왔습니다.`));
  } catch (error) {
    if (request !== state.overviewRequest) return;
    showError('page-error', error); emptyRow($('country-rows'), countryTableColumns(), t('기록 조회에 실패했습니다. 다시 조회해 주세요.'));
    setText($('snapshot-status'), () => (t('조회 실패 · 저장 데이터 연결을 확인하세요'))); setText($('screen-status'), () => (t('국가별 기록을 불러오지 못했습니다.')));
  } finally { if (request === state.overviewRequest) $('refresh').disabled = false; }
}

async function selectCountry(code, scroll = false) {
  const request = ++state.countryRequest; state.selected = code; state.countryData = null;
  const country = state.countries.find((item) => countryCode(item) === code);
  $('country-detail').hidden = false; setText($('detail-title'), () => (t`${countryName(country ?? { country: code })} 수집 상세`)); $('source-list').replaceChildren(node('div', 'empty-cell', () => (t('등록 소스를 조회합니다.'))));
  setText($('source-count'), () => ('')); $('source-search').value = ''; $('country-detail-meta').replaceChildren(); $('country-trend').replaceChildren(); showError('country-detail-error', null); renderCountries();
  $('investigation-country').value = code;
  if (scroll) $('country-detail').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  try {
    const data = await api(`country?${dateQuery({ country: code })}`);
    if (request !== state.countryRequest) return;
    state.countryData = data;
    const info = data.country && typeof data.country === 'object' ? data.country : country;
    const counts = inventory(info ?? {}); const meta = $('country-detail-meta');
    appendMeta(meta, t('활성 등록'), valueText(counts.active_source_registrations));
    if (typeof counts.unique_publishers === 'number' && Number.isFinite(counts.unique_publishers)) { appendMeta(meta, t('고유 언론사'), publisherCountText(counts)); setLocalizedAttribute(meta.lastChild, 'title', () => (publisherCountNote(counts))); }
    appendMeta(meta, t('마지막 검사'), timeText(info?.period?.last_collection_at ?? data.latest_collection));
    const completed = country?.completed_cycle_baseline ?? info?.completed_cycle_baseline;
    if (completed?.state === 'comparable_completed_cycles') appendMeta(meta, t('비교 기준'), t`${valueText(completed.samples)}개 같은 요일 완료 회차`);
    else if (!completed && info?.baseline?.state === 'comparable_closed_calendar_windows') appendMeta(meta, t('참고 기준'), t`${valueText(info.baseline.samples)}개 같은 요일 저장 구간`);
    renderCountryTrend(info);
    renderSources();
  } catch (error) { if (request !== state.countryRequest) return; showError('country-detail-error', error); $('source-list').replaceChildren(node('div', 'empty-cell', () => (t('소스 상세 조회에 실패했습니다. 국가를 다시 선택해 주세요.')))); }
}

function renderCountryTrend(country) {
  const target = $('country-trend'); target.replaceChildren();
  if (!country?.daily?.length) return;
  const caption = node('div', 'trend-caption', () => (t('최근 7일 · 국가 자체의 저장 관측')));
  caption.append(node('span', '', () => (t('검사 범위 / 성공률 · UTC'))));
  target.append(caption);
  const grid = node('div', 'trend-grid');
  country.daily.forEach((day) => {
    const card = node('div', 'trend-day');
    card.append(node('span', 'trend-date', () => (String(day.date).slice(5))));
    const ratio = (metric) => metric && typeof metric.value === 'number' ? `${metric.value.toFixed(0)}%` : '—';
    const value = node('div', 'trend-value', () => (ratio(day.attempt_coverage))); value.append(node('span', '', () => ('/')), localizedTextNode(() => (ratio(day.success_rate)))); card.append(value);
    card.append(node('span', 'trend-state', () => (day.period?.observation_window_closed ? t('저장 구간 종료') : day.period?.state === 'not_tracked' ? t('미추적') : day.period?.state === 'after_latest_collection' ? t('마지막 검사 이후') : day.period?.state === 'history_unavailable' ? t('이력 없음') : t('불완전 구간'))));
    setLocalizedAttribute(card, 'title', () => (t`${day.date} UTC · 검사 범위 ${ratio(day.attempt_coverage)} · 수집 성공률 ${ratio(day.success_rate)} · ${describeState(day.period?.state)}`));
    grid.append(card);
  });
  target.append(grid);
}

function renderSources() {
  const query = $('source-search').value.trim().toLocaleLowerCase();
  const all = state.countryData?.sources ?? state.countryData?.items ?? [];
  const sources = all.filter((source) => [source.name, ...((source.endpoints ?? []).map((endpoint) => endpoint.url))].some((value) => String(value ?? '').toLocaleLowerCase().includes(query)));
  sources.sort((a, b) => String(a.name).localeCompare(String(b.name), language));
  setText($('source-count'), () => (`${sources.length} / ${all.length}`));
  const list = $('source-list'); list.replaceChildren();
  if (!sources.length) { list.append(node('div', 'empty-cell', () => (query ? t('검색 조건에 맞는 소스가 없습니다.') : t('이 국가에 조회 가능한 등록 소스가 없습니다.')))); return; }
  sources.forEach((source) => {
    const card = node('details', 'source-card'), summary = node('summary'), heading = node('div', 'source-heading');
    const marker = node('span', '', () => ('+')); marker.setAttribute('aria-hidden', 'true'); heading.append(marker);
    const title = node('div'); title.append(node('h3', '', () => (source.name ?? t('이름 미확인'))), node('p', '', () => ([source.category, source.language].filter(Boolean).join(' · ') || `${source.id ?? t('소스 ID 미확인')}`))); heading.append(title);
    const meta = node('div', 'source-heading-meta'); meta.append(node('span', 'registration-meta', () => (t`등록 ${valueText(source.activeRegistrationCount ?? source.active_registration_count)}개`)), node('span', '', () => (t`${source.endpoints?.length ?? 0}개 주소`)));
    if (source.initialization ?? source.status) meta.append(badge(source.initialization ?? source.status));
    summary.append(heading, meta); const content = node('div', 'source-content'); card.append(summary, content); list.append(card);
    card.addEventListener('toggle', async () => {
      setText(marker, () => (card.open ? '−' : '+'));
      if (!card.open || content.dataset.loaded === 'true') return;
      content.dataset.loaded = 'true'; content.replaceChildren(node('div', 'empty-cell', () => (t('이 소스의 실제 활동 이력을 조회합니다.'))));
      const key = `${source.id}:${$('date-input').value}`;
      try {
        if (!state.sourceCache.has(key)) state.sourceCache.set(key, api(`source?${dateQuery({ source_id: source.id })}`));
        const detail = await state.sourceCache.get(key);
        renderSourceDetail(content, detail, source);
      } catch (error) { state.sourceCache.delete(key); content.dataset.loaded = 'false'; content.replaceChildren(node('p', 'notice danger', () => (errorMessage(error)))); }
    });
  });
}

function aggregateValue(period) { return period && typeof period.new_unique_candidate_urls === 'number' ? period.new_unique_candidate_urls : null; }
function periodNote(period) {
  if (!period) return t('기록 없음');
  const notes = [];
  if (period.unknown_days > 0) notes.push(t`${period.unknown_days}일 미확인`);
  if (period.interval_may_be_open_or_incomplete) notes.push(t('불완전 구간'));
  if (period.state) notes.push(describeState(period.state));
  return notes.join(' · ') || t('기준선 제외');
}
function renderSourceDetail(content, detail, source) {
  content.replaceChildren();
  const activity = detail.article_activity ?? {};
  const section = node('div', 'source-activity'); const description = node('div', 'activity-description', () => (t('신규 발견 URL')));
  description.append(node('p', 'small-note', () => (t('최초 기준선 제외 · 소스 내 중복 제거 · 발행 기사 수와 다름')))); section.append(description);
  const counts = node('dl');
  [['daily', t('조회일')], ['weekly', t('최근 7일')], ['monthly', t('최근 30일')]].forEach(([key, label]) => {
    const period = activity[key], group = node('div'); group.append(node('dt', '', () => (label))); const value = node('dd', '', () => (valueText(aggregateValue(period)))); value.append(node('small', '', () => (periodNote(period)))); group.append(value); counts.append(group);
    if (period?.from && period?.to_exclusive) setLocalizedAttribute(group, 'title', () => (t`${timeText(period.from)} ~ ${timeText(period.to_exclusive)} 미포함`));
  });
  section.append(counts); content.append(section);
  const endpoints = detail.endpoints ?? source.endpoints ?? [];
  if (!endpoints.length) content.append(node('p', 'notice', () => (t('등록된 주소가 없습니다.'))));
  endpoints.forEach((endpoint) => {
    const card = node('article', 'endpoint-card'), header = node('div', 'endpoint-header'), address = node('div'); address.append(node('span', 'endpoint-type', () => (endpoint.type === 'sitemap' ? t('사이트맵') : endpoint.type === 'rss' ? 'RSS' : t('주소'))), safeLink(endpoint.url));
    header.append(address, badge(endpoint.classification ?? endpoint.health?.status)); card.append(header);
    const health = endpoint.health ?? {}; const daily = endpoint.daily ?? {}; const evidence = [];
    if (health.checked_at) evidence.push(t`저장 검사 ${timeText(health.checked_at)}`);
    if (typeof daily.successful_checks === 'number' || typeof daily.failed_checks === 'number') evidence.push(t`검사 성공 ${valueText(daily.successful_checks)} · 실패 ${valueText(daily.failed_checks)}`);
    if (health.newest_content_at) evidence.push(t`최근 콘텐츠 날짜 ${timeText(health.newest_content_at)}`);
    if (health.content_freshness) evidence.push(t`저장 콘텐츠 날짜: ${health.content_freshness === 'stale' ? t('오래됨') : describeState(health.content_freshness)}`);
    if (endpoint.prior_success_at) evidence.push(t`이전 정상 ${timeText(endpoint.prior_success_at)}`);
    if (evidence.length) card.append(node('p', 'endpoint-summary', () => (evidence.join(' · '))));
    const urlCounts = node('div', 'endpoint-counts');
    [['daily', t('일')], ['weekly', t('주')], ['monthly', t('월')]].forEach(([key, label]) => { const item = node('span', '', () => (t`${label} 고유 URL`)); item.append(node('strong', '', () => (valueText(endpoint[key]?.new_unique_candidate_urls, t('미집계'))))); urlCounts.append(item); });
    const hasIndependentCounts = ['daily', 'weekly', 'monthly'].some((key) => typeof endpoint[key]?.new_unique_candidate_urls === 'number');
    if (hasIndependentCounts) card.append(urlCounts);
    const attribution = new LocalizedText(() => [['daily', t('일')], ['weekly', t('주')], ['monthly', t('월')]].map(([key, label]) => `${label} ${valueText(endpoint[key]?.attributed_source_new_urls)}`).join(' · '));
    if (!hasIndependentCounts) {
      const limitation = node('details', 'endpoint-raw'); limitation.append(node('summary', '', () => (t('주소별 URL 집계 범위'))), node('p', 'endpoint-limitation', () => (t`주소별 고유 발견 수는 이력이 없어 계산하지 않습니다. 소스 집계에 귀속된 URL: ${attribution}. 발행 기사 수와 다릅니다.`))); card.append(limitation);
    }
    if (endpoint.days?.length) {
      const dailyHistory = node('details', 'endpoint-raw endpoint-history');
      dailyHistory.append(node('summary', '', () => (t('최근 7일 검사 · 발견 기록'))));
      const shell = node('div', 'table-shell'); const table = node('table');
      const caption = node('caption', 'sr-only', () => (t('주소별 최근 7일 검사 수, 성공 검사 수와 소스 귀속 신규 URL'))); table.append(caption);
      const head = node('thead'), headerRow = node('tr');
      [t('UTC 날짜'), t('검사'), t('성공'), t('소스 귀속 URL'), t('구간')].forEach((label) => { const cell = node('th', '', () => (label)); cell.scope = 'col'; headerRow.append(cell); }); head.append(headerRow); table.append(head);
      const body = node('tbody'); endpoint.days.forEach((day) => { const row = node('tr'); row.append(node('td', '', () => (day.date)), node('td', 'numeric', () => (valueText(day.checks))), node('td', 'numeric', () => (valueText(day.successful_checks))), node('td', 'numeric', () => (valueText(day.attributed_source_new_urls))), node('td', '', () => (describeState(day.period?.state)))); body.append(row); }); table.append(body); shell.append(table); dailyHistory.append(shell); card.append(dailyHistory);
    }
    const raw = node('details', 'endpoint-raw'); raw.append(node('summary', '', () => (t('검사 근거와 집계 범위 보기'))), node('pre', '', () => (JSON.stringify({ classification: endpoint.classification, health: endpoint.health, daily: endpoint.daily, weekly: endpoint.weekly, monthly: endpoint.monthly, days: endpoint.days }, null, 2)))); card.append(raw); content.append(card);
  });
}

function renderRun(run) {
  state.run = run; state.pendingStart = null; state.pollFailures = 0; $('reconnect-investigation').hidden = true; $('investigation-empty').hidden = true; $('investigation-run').hidden = false;
  const country = state.countries.find((item) => countryCode(item) === run.country);
  setText($('run-title'), () => (t`${countryName(country ?? { country: run.country })} 조사`));
  setText($('run-meta'), () => (t`${run.date ?? t('날짜 없음')} UTC 저장 기록 · ${timeText(run.started_at)}`));
  setLocalizedAttribute($('run-meta'), 'title', () => (t`실행 ID ${run.id}`));
  const status = badge(run.status); $('run-status').className = status.className; setText($('run-status'), () => (describeState(run.status)));
  const summary = $('run-summary'); summary.replaceChildren(); summary.hidden = !run.summary && !run.findings?.length;
  if (!summary.hidden) {
    summary.append(node('h4', '', () => (t('조사 결과'))));
    if (run.summary) {
      const text = typeof run.summary === 'string' ? run.status === 'failed' ? humanInvestigationError(run.summary) : run.summary.replace(new RegExp(`^${run.country}:\\s*`), '') : JSON.stringify(run.summary, null, 2);
      summary.append(node('div', 'result-summary', () => (text)));
    }
    const findings = Array.isArray(run.findings) ? run.findings : [];
    const normal = new Set(['successful_collection', 'successful_no_new_discoveries', 'index_only', 'recovered_after_failure']);
    const actionable = findings.filter((finding) => typeof finding === 'string' || !normal.has(finding.classification ?? finding.state ?? finding.kind));
    const remainder = findings.filter((finding) => !actionable.includes(finding));
    const appendFinding = (list, finding) => {
      const item = node('li');
      if (typeof finding === 'string') setText(item, () => (finding));
      else {
        const heading = node('div', 'finding-heading'); heading.append(node('strong', '', () => (finding.source_name ?? finding.name ?? finding.title ?? t('소스'))), badge(finding.classification ?? finding.state ?? finding.kind)); item.append(heading);
        if (finding.url) item.append(safeLink(finding.url));
        item.append(node('p', '', () => (finding.proposed_action ?? finding.reason ?? finding.message ?? finding.description ?? t('저장 기록 기준 판단입니다.'))));
        const evidence = finding.assessment?.evidence;
        if (evidence) {
          const detail = node('details', 'finding-evidence'); detail.append(node('summary', '', () => (t('판정 근거'))), node('p', '', () => (t`최근 활동 ${evidenceTimeText(evidence.last_collection_at, evidence.selected_collection_date)} · 과거 정상 ${evidenceTimeText(evidence.prior_success_at, evidence.prior_success_date)} · 저장 검사 ${evidenceTimeText(evidence.health_checked_at)}`))); item.append(detail);
        }
        if (!['running', 'queued'].includes(run.status) && state.overview?.runtime?.repair_workflow?.enabled
          && finding.source_id && finding.endpoint_id && ['failure_after_prior_success', 'stale_content_evidence', 'access_failure_without_normal_baseline'].includes(finding.classification)) item.append(repairReview(finding));
      }
      list.append(item);
    };
    if (actionable.length) {
      const list = node('ul', 'finding-list'); actionable.forEach((finding) => appendFinding(list, finding)); summary.append(list);
    } else if (findings.length) summary.append(node('p', 'result-note', () => (t('확인한 범위에서 추가 점검 대상이 없습니다.'))));
    if (remainder.length) {
      const disclosure = node('details', 'result-details'); disclosure.append(node('summary', '', () => (t`정상·회복 기록 ${remainder.length}건`)));
      const list = node('ul', 'finding-list'); remainder.forEach((finding) => appendFinding(list, finding)); disclosure.append(list); summary.append(disclosure);
    }
  }
  const list = $('event-list');
  // Preserve disclosure states during real event polling.
  const open = new Set([...list.querySelectorAll('details[open]')].map((detail) => detail.dataset.event)); list.replaceChildren();
  (run.events ?? []).forEach((event, index) => {
    const eventState = event.status ?? (event.type === 'tool_completed' ? 'completed' : event.type === 'tool_failed' ? 'failed' : event.type === 'tool_started' ? 'running' : 'neutral');
    const item = node('li', `event ${eventState}`); const header = node('div', 'event-head');
    header.append(node('span', 'event-title', () => (event.tool ?? event.name ?? event.type ?? t('실행 이벤트'))), node('span', 'event-meta', () => (clockText(event.at)))); item.append(header);
    const metadata = [describeState(eventState)];
    if (typeof event.duration_ms === 'number') metadata.push(`${event.duration_ms < 1000 ? `${event.duration_ms} ms` : `${(event.duration_ms / 1000).toFixed(2)} s`}`);
    if (typeof event.model_cost_usd === 'number') metadata.push(t`모델 $${event.model_cost_usd.toFixed(4)}`);
    if (event.error) metadata.push(typeof event.error === 'string' ? event.error : JSON.stringify(event.error));
    if (event.message) metadata.push(String(event.message));
    if (event.result_truncated) metadata.push(t('도구 결과 표시 생략 있음'));
    item.append(node('p', 'event-caption', () => (metadata.join('  ·  '))));
    if (event.parent_id) item.append(node('p', 'event-branch', () => (t`실제 하위 작업 · 상위 ${event.parent_id}`)));
    if (event.args !== undefined || event.result !== undefined || event.error) {
      const detail = node('details'); detail.dataset.event = String(event.id ?? index); detail.open = open.has(detail.dataset.event);
      detail.append(node('summary', '', () => (event.result !== undefined ? t('도구 인자 · 실제 결과') : t('도구 인자 · 오류'))), node('pre', '', () => (JSON.stringify({ ...(event.args !== undefined ? { args: event.args } : {}), ...(event.result !== undefined ? { result: event.result } : {}), ...(event.error ? { error: event.error } : {}) }, null, 2)))); item.append(detail);
    }
    list.append(item);
  });
  const footer = $('run-footer'); footer.replaceChildren();
  const cost = run.cost ?? {};
  const providerName = cost.provider === 'openai' ? 'OpenAI' : cost.provider === 'jev' ? 'Jev' : null;
  setText($('scope-model'), () => (providerName ? t`${providerName} · ${valueText(cost.model_calls)}회` : t('없음 · 규칙 기반')));
  setText($('scope-model-cost'), () => (providerName ? t('사용량 추정 · 실제 청구액 별도') : '$0.00'));
  if (run.model_assessment) {
    const proposal = node('details', 'result-details'); proposal.append(node('summary', '', () => (t('모델의 추가 제안 · 검증 전'))));
    if (run.model_assessment.summary) proposal.append(node('p', '', () => (run.model_assessment.summary)));
    const steps = node('ul');
    (run.model_assessment.proposed_steps ?? []).forEach((step) => {
      const source = (run.findings ?? []).find((finding) => finding.source_id === step.source_id);
      steps.append(node('li', '', () => (`${source?.source_name ?? t('확인된 소스')} · ${step.reason ?? step.action}`)));
    });
    if (steps.childElementCount) proposal.append(steps);
    summary.append(proposal); summary.hidden = false;
  }
  const sampled = typeof run.available_sources === 'number' && typeof run.inspected_sources === 'number' && run.inspected_sources < run.available_sources;
  const scope = typeof run.inspected_sources === 'number' ? t`${valueText(run.inspected_sources)}/${valueText(run.available_sources)}개 소스${sampled ? t(' · 일부 조사') : ''}` : t('조사 범위 집계 중');
  footer.append(node('span', '', () => (scope)), node('span', '', () => (t`MCP ${valueText(run.tool_calls)}회`)));
  if (providerName) {
    footer.append(node('span', '', () => (t`${providerName} ${valueText(cost.model_calls)}회`)));
    const amount = typeof cost.model_cost_usd === 'number' ? `$${cost.model_cost_usd.toFixed(4)}` : typeof cost.estimated_model_cost_usd === 'number' ? t`추정 $${cost.estimated_model_cost_usd.toFixed(4)}` : t('사용량 미확인');
    const charge = node('span', '', () => (amount)); setLocalizedAttribute(charge, 'title', () => (t('토큰 사용량 환산은 실제 청구액과 다를 수 있습니다.'))); footer.append(charge);
  } else footer.append(node('span', '', () => (t('모델 비용 $0'))));
  if (run.finished_at && Number.isFinite(Date.parse(run.started_at)) && Number.isFinite(Date.parse(run.finished_at))) footer.append(node('span', '', () => (t`${((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000).toFixed(1)}초`)));
  if (run.limit_reached) footer.append(node('span', '', () => (t('실행 한도 도달'))));
  else if (run.truncated && !sampled) footer.append(node('span', '', () => (t('일부 기록 제외'))));
  setText($('execution-summary'), () => (t`실제 실행 기록 · ${(run.events ?? []).length}개 이벤트`));
  setLocalizedAttribute($('execution-summary'), 'title', () => (t`실행 ID ${run.id}${typeof cost.input_tokens === 'number' ? t` · 입력 ${cost.input_tokens} / 출력 ${cost.output_tokens} 토큰` : ''}`));
  renderExecutionAccess();
  setText($('screen-status'), () => (t`조사 ${describeState(run.status)}. 실제 실행 이벤트 ${(run.events ?? []).length}개.`));
}

const repairLabels = {
  proposed: t('제안'), approved: t('승인됨'), applied: t('로컬 적용됨'), recovered: t('회복 확인'), rolled_back: t('되돌림'),
  candidate_only: t('후보 검증됨 · 적용 전'), still_failing: t('검사 실패'), stale_content: t('오래된 콘텐츠'),
  valid_empty_pending: t('기사 수집 확인 필요'), validation_passed_waiting_for_collector: t('수집 회차 대기'),
  collector_success_confirmed: t('수집 성공 · 새 콘텐츠 대기'), registry_changed: t('등록 변경 · 재검토 필요')
};
function repairStateLabel(proposal) {
  const recovery = proposal.recovery;
  const currentRecovery = recovery && (!proposal.applied_at || Date.parse(recovery.checked_at) >= Date.parse(proposal.applied_at));
  const state = currentRecovery && !['proposed', 'approved'].includes(proposal.state) ? recovery.status : proposal.state;
  return repairLabels[state] ?? t('제안 기록');
}
function repairReview(finding) {
  const detail = node('details', 'repair-review'); detail.append(node('summary', '', () => (t('대체 주소 검토'))));
  const form = node('form', 'repair-form');
  const label = node('label', '', () => (t('해당 언론사의 공식 홈페이지')));
  const input = node('input'); input.type = 'url'; input.required = true; input.placeholder = 'https://'; input.autocomplete = 'off';
  label.append(input); form.append(label);
  const submit = node('button', 'secondary-button', () => (t('공식 후보 확인'))); submit.type = 'submit'; form.append(submit); detail.append(form);
  detail.append(node('p', 'small-note', () => (t('홈페이지에 명시된 RSS·사이트맵만 확인합니다.'))));
  const output = node('div', 'repair-output'); detail.append(output);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; output.replaceChildren(node('p', 'small-note', () => (t('공식 선언과 주소를 검사하는 중입니다.'))));
    try {
      const data = await api('proposals', { method: 'POST', body: JSON.stringify({ source_id: finding.source_id, endpoint_id: finding.endpoint_id, official_url: input.value.trim() }) });
      output.replaceChildren();
      if (data.proposal) { renderRepairProposal(output, data.proposal); await loadProposals(); }
      else output.append(node('p', 'small-note', () => (t('검증된 대체 주소를 찾지 못했습니다. 등록은 변경하지 않았습니다.'))));
      if (data.candidates?.length) {
        const candidates = node('details', 'finding-evidence'); candidates.append(node('summary', '', () => (t`검사한 후보 ${data.candidates.length}개`)));
        data.candidates.forEach((candidate) => {
          const row = node('p', 'small-note', () => (`${candidate.validation?.status === 'valid' ? t('형식 검사 성공') : t('검사 실패')} · ${candidate.validation?.reason ?? candidate.validation?.content_freshness ?? ''}`));
          row.append(safeLink(candidate.url)); candidates.append(row);
        }); output.append(candidates);
      }
    } catch (error) { output.replaceChildren(node('p', 'notice danger', () => (errorMessage(error)))); }
    finally { submit.disabled = false; }
  });
  return detail;
}
function renderRepairProposal(target, proposal, reloadRequired = false) {
  target.replaceChildren();
  const content = proposal.content ?? {}, card = node('article', 'repair-card');
  if (reloadRequired && content.proposal_id) state.reloadRequiredProposals.add(content.proposal_id);
  reloadRequired ||= state.reloadRequiredProposals.has(content.proposal_id);
  const heading = node('div', 'finding-heading'); heading.append(node('strong', '', () => (content.source_name ?? t('주소 수정 제안'))), node('span', 'badge neutral', () => (repairStateLabel(proposal)))); card.append(heading);
  const addresses = node('dl', 'repair-addresses');
  [[t('현재'), content.old_url], [t('변경'), content.new_url], [t('공식 선언'), content.candidate?.official_document_url ?? content.official_url]].forEach(([name, url]) => {
    const value = node('dd'); value.append(safeLink(url)); addresses.append(node('dt', '', () => (name)), value);
  }); card.append(addresses);
  const check = content.candidate?.validation ?? {};
  card.append(node('p', 'small-note', () => (t`HTTP ${valueText(check.http_status)} · ${valueText(check.entries_with_url)}개 URL 포함 · ${timeText(check.checked_at)}`)));
  const scopeNote = node('p', 'small-note', () => (reloadRequired ? t('로컬 등록부 적용됨 · 서버 다시 시작/운영 배포 필요') : ['applied', 'recovered'].includes(proposal.state) ? t('로컬 등록부 적용됨 · 운영 배포는 별도입니다.') : t('적용은 로컬 등록에만 반영됩니다. 운영 배포는 별도입니다.')));
  if (reloadRequired) scopeNote.setAttribute('role', 'status'); card.append(scopeNote);
  const output = node('p', 'small-note'); output.setAttribute('role', 'status'); card.append(output);
  const controls = node('div', 'repair-controls');
  const owner = state.adminSession?.authenticated === true;
  const submit = async (action, body, button) => {
    controls.querySelectorAll('button').forEach((control) => { control.disabled = true; }); setText(output, () => (t('처리 중')));
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
      setText(output, () => (errorMessage(error)));
      controls.querySelectorAll('button').forEach((control) => { control.disabled = control.dataset.action === 'verify' ? false : !owner || (control.dataset.action === 'approve' && !card.querySelector('input[type=checkbox]')?.checked); });
    }
  };
  if (['proposed', 'approved'].includes(proposal.state)) {
    const confirm = node('label', 'repair-confirm'); const checkbox = node('input'); checkbox.type = 'checkbox';
    confirm.append(checkbox, localizedTextNode(() => (t('공식 홈페이지와 위 주소 교체를 확인했습니다.')))); card.append(confirm);
    const approve = node('button', 'secondary-button', () => (proposal.state === 'approved' ? t('승인 갱신') : t('수정 승인'))); approve.type = 'button'; approve.dataset.action = 'approve'; approve.disabled = true;
    checkbox.addEventListener('change', () => { approve.disabled = !owner || !checkbox.checked; });
    approve.addEventListener('click', () => submit('approve', { proposal_digest: proposal.proposal_digest, expected_registry_hash: content.registry_hash }, approve)); controls.append(approve);
    if (proposal.state === 'approved') {
      const approval = (proposal.approvals ?? []).filter((item) => item.action === 'apply').at(-1);
      if (approval) {
        const apply = node('button', 'primary-button', () => (t('승인한 수정 적용'))); apply.type = 'button'; apply.dataset.action = 'apply'; apply.disabled = !owner;
        apply.addEventListener('click', () => submit('apply', { approval_id: approval.approval_id, expected_registry_hash: content.registry_hash }, apply)); controls.append(apply);
      }
    }
  }
  const verify = node('button', 'secondary-button', () => (['applied', 'recovered'].includes(proposal.state) ? t('회복 확인') : t('후보 재검사'))); verify.type = 'button'; verify.dataset.action = 'verify';
  verify.addEventListener('click', () => submit('verify', {}, verify)); controls.append(verify); card.append(controls);
  if (!owner) card.append(node('p', 'small-note', () => (t('주소 변경은 인증된 관리자만 적용할 수 있습니다.'))));
  if (['applied', 'recovered'].includes(proposal.state)) card.append(node('p', 'small-note', () => (proposal.state === 'recovered' ? t('적용 이후 정상 수집과 새 콘텐츠를 확인했습니다.') : t('적용 후 정상 수집 회차와 새 콘텐츠가 확인되어야 회복으로 판단합니다.'))));
  else if (proposal.recovery) card.append(node('p', 'small-note', () => (repairLabels[proposal.recovery.status] ?? t('후보 검사 기록'))));
  target.append(card);
}
async function loadProposals() {
  const revision = state.accessRevision;
  const data = await api('proposals');
  if (revision !== state.accessRevision || state.overview?.runtime?.admin_auth_required && !state.adminSession?.authenticated) return;
  const items = Array.isArray(data) ? data : data.items ?? data.proposals ?? [];
  $('repair-records').hidden = !items.length;
  setText($('repair-records-title'), () => (t`수정 제안 ${items.length}건`));
  const list = $('repair-record-list'); list.replaceChildren();
  items.forEach((proposal) => {
    const detail = node('details', 'repair-record'); detail.append(node('summary', '', () => (`${proposal.content?.source_name ?? t('소스')} · ${repairStateLabel(proposal)}`)));
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
    const button = node('button', 'history-button', () => (`${countryName({ country: run.country })} · ${run.date ?? t('날짜 없음')} · ${describeState(run.status)}`));
    button.type = 'button'; setLocalizedAttribute(button, 'title', () => (`${timeText(run.started_at)} · ${run.cost?.provider ?? 'rules'}`));
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
    showError('investigation-error', new UIError(error instanceof DashboardHttpError && error.status === 404
      ? t('실행 접수 기록을 찾지 못했습니다. 서버 재시작·기록 만료 여부를 확인해 주세요. 자동으로 조사를 다시 시작하지 않았습니다.')
      : t('서버 연결이 끊겨 실행 접수 여부를 확인하지 못했습니다. 연결 다시 확인으로 기존 요청을 조회할 수 있습니다.')));
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
    showError('investigation-error', new UIError(missing
      ? t('실행 기록이 서버에 없습니다. 서버 재시작이나 기록 만료로 이전 결과를 조회할 수 없습니다.')
      : t('서버 연결이 끊겨 조사 상태를 확인하고 있습니다. 마지막 결과를 유지하며 기존 조사만 다시 조회합니다.')));
    setText($('run-status'), () => (missing ? t('실행 기록 없음') : t('연결 확인 중')));
    $('start-investigation').disabled = !missing; $('investigate-selected').disabled = !missing;
    if (!missing && ++state.pollFailures <= 3) state.poll = window.setTimeout(() => pollRun(id), 2500);
  }
}
async function startInvestigation(country) {
  if (state.overview?.runtime?.admin_auth_required && !state.adminSession?.authenticated) { showError('investigation-error', new UIError(t('관리자 로그인이 필요합니다.'))); return; }
  if (state.overview?.runtime?.investigations_enabled === false) { showError('investigation-error', new UIError(t('이 환경에서는 조사 실행이 비활성화되어 있습니다.'))); return; }
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
      setText($('screen-status'), () => (t('실행 접수 여부 확인 중 · 조사를 중복 시작하지 않습니다.')));
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
applyLanguage(readLanguage(), false);
$('language-select')?.addEventListener('change', event => applyLanguage(event.target.value));
loadOverview();
