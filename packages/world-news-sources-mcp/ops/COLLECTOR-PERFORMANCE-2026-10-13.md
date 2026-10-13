# 수집 성능 조사 — 2026-10-13

현재 자료는 Rust 전환의 필요성을 입증하지 않는다. 실제 주소 표본에서는 HTTP·대기가 XML 처리보다 길었고, 수집 시작 전 백업 무결성 검사도 구체적인 지연 후보다. 실제 전체 작업에서 네트워크·DB 저장·내보내기가 차지하는 비중은 아직 분리되지 않았다. 최적화와 전수 검사 정책의 운영 반영은 보류한다.

후속 조사에서는 같은 Oracle 서버의 격리 DB로 저장·내보내기와 최소 SQL 개선을 비교했다. 반복 SQL 준비 비용을 줄인 로컬 구현과 검증은 [저장 경로 후속 보고서](COLLECTOR-STORAGE-2026-10-13.md)에 기록한다. 운영 반영과 전체 회차 속도 판단은 여전히 별도다.

## 조사 조건

운영 Oracle의 기존 `recovery-cause-aware-1-20261002` 릴리스를 확인했다. 전역 worker 2개, 같은 서버 간격 2초, 요청 제한 8초다. 준비된 6-worker 전수 검사 버전을 배포하거나 타이머를 바꾸지 않았다.

기존 실행 기록과 DB 메타데이터를 읽고, 현재 cooldown을 존중하는 공개 주소 8개만 실제 검사했다. 실제 검사는 재시도·운영 DB 쓰기 없이 수행했다. 유료 모델 호출, 신규 백업/DB 복제, 소스 변경, 키 출력은 없었다. 운영 DB의 무결성 진단은 읽기 전용·60초 제한이었다.

## 기존 운영 실행 기록

| UTC 날짜 | 기록된 검사 | 첫 완료→마지막 완료 | 전체 서비스 시간 | timed refresh CPU 사용 비율 |
| --- | ---: | ---: | ---: | ---: |
| 10월 11일 | 3,717 | 38분 26초 | 50분 14초 | 9% |
| 10월 12일 | 3,806 | 41분 41초 | 56분 20초 | 8% |
| 10월 13일 | 3,780 | 42분 11초 | 54분 1초 | 8% |

CPU 비율은 GNU time이 refresh 프로세스 묶음에 대해 보고한 CPU 시간/경과 시간이다. 서버 전체 CPU 사용률이나 지속적인 포화 측정은 아니다. Refresh에는 테스트·수집·빌드·배포·검증이 포함되며 wrapper의 백업·최종 DB 검증은 제외된다. 첫·마지막 검사 사이도 순수 네트워크 시간으로 해석하지 않는다. 최대 RSS는 약 306~328 MiB였다.

10월 13일은 수집 후 usage acknowledgment smoke assertion에서 실패했다. 이것을 전체 뉴스 수집 중단이나 CPU 병목으로 분류하지 않는다. 기존 collection ledger에는 endpoint별 `durationMs`와 단계별 시간이 보존되지 않아 전체 p50/p95를 복원할 수 없다.

## 실제 주소 8개 단계 계측

기존에 성공한 큰 RSS 4개·기사 URL sitemap 4개를 서로 다른 호스트에서 골랐다. 무작위 표본이 아니며 실패한 주소를 다른 성공 주소로 교체하지 않았다. 기존 production의 fetch/XML 모듈, 2-worker 조건과 본문 제한(RSS 4 MiB / sitemap 8 MiB)을 사용했다.

| 항목 | 실제 측정 |
| --- | --- |
| 결과 | HTTP 200 7개, 8초 타임아웃 1개 |
| 성공 요청 HTTP·대기·압축 해제 | 중앙값 2.497초, 범위 0.865~5.336초 |
| 성공 XML 검사·URL 추출 | 중앙값 0.128초, 범위 0.061~0.302초 |
| 5.05 MB·49,974개 URL sitemap | XML 검사·추출 0.274초 |

HTTP 구간에는 host gate, DNS, 연결, TLS, 리디렉션, 헤더·본문, 압축 해제가 합쳐져 있다. 각각의 비중은 별도 측정되지 않았다. 병렬 wall 시간은 겹치므로 더해서 전체 시간을 예측하지 않는다. DB 저장은 생략했으므로 전체 운영 병목이나 worker 증가 효과를 이 표본으로 단정하지 않는다.

## 수집 시작 전 지연

Wrapper는 백업 → 백업 파일 `quick_check` → 오래된 백업 정리 → timed refresh → 성공 시 원본 DB `quick_check` 순서다. 기존 백업 파일의 마지막 쓰기 시각은 서비스 시작 약 50~68초 후였다. 마지막 쓰기 시각은 무결성 검사의 종료 시각이 아니다.

10월 13일에는 refresh 실패로 마지막 원본 DB 검증이 실행되지 않았다. 서비스 전체 3,240.77초에서 timed refresh 2,625.09초를 빼면 사전 wrapper 구간은 약 10분 16초다. 백업 마지막 쓰기 이후 약 9분 14초의 검증·정리 구간이 단계별로 미계측 상태다.

Idle 상태의 약 4.95 GB 원본 DB에서 읽기 전용 `PRAGMA quick_check`를 실행했을 때 60.15초 제한까지 완료되지 않았고 CPU는 5.22초였다. **제한에 따른 의도한 중단이며 DB 손상이나 무결성 실패의 증거가 아니다.** 백업 검증은 실제 지연 후보지만 과거 9분 전체를 이 검사에 귀속시키거나 디스크 병목이라고 확정할 수는 없다. 검증 생략을 제안하지 않는다.

특정 endpoint의 최신 collection 조회는 full scan·정렬을 사용했고, idle warm-cache 3회 중앙값 21.98 ms였다. 이 조회가 운영 hot path에서 반복되는지 확인되지 않아 우선 병목이라고 부르지 않는다.

## 로컬 처리 비용 보충 측정

Apple M1 / Node 26에서 현재 브랜치의 XML·URL·SQLite·archive 함수를 합성 자료와 격리 DB로 측정했다. 실제 Oracle / Node 22 운영 수치로 환산하지 않는다.

| sitemap URL 수 | XML 중앙값 | 기존 URL 관계 갱신 중앙값 | 전체 신규 저장 중앙값 |
| ---: | ---: | ---: | ---: |
| 1,000 | 10.1 ms | 37.3 ms | 43.7 ms |
| 10,000 | 82.3 ms | 380.3 ms | 582.1 ms |
| 50,000 | 403.3 ms | 1,913.3 ms | 3,268.8 ms |

큰 문서에서는 DB 관계 갱신 비용이 XML보다 컸다. 합성 이력 150,000건의 전체 archive는 약 2.4초였고 한 건 추가 후에도 약 2.8초였다. 모두 실제 운영 병목 확정이 아닌 다음 계측 후보다. 50,000건 RSS 실험은 실제 4 MiB 제한을 초과하므로 운영 비교에서 제외했다.

준비 버전의 scheduling도 endpoint 1,000개·collection 50,000건으로 별도 확인했다. 기존 endpoint/time covering index를 사용하며 전체 scheduling 중앙값은 11.80 ms였다. 이 규모에서 큰 병목 증거가 없었고, 운영 v3의 쿼리나 정책이 바뀌었다는 뜻은 아니다.

## 다음 측정과 판단 기준

1. 기존 2-worker 정책을 유지한 정상 회차에서 backup/check/planning/collection/commit/export/build/smoke 구간을 monotonic 시간으로 분리한다. host 대기·HTTP·XML·DB의 endpoint별 수치도 보존한다. 현재 저장 자료만으로 이 시간을 소급 복원할 수 없다.
2. DB commit·export와 디스크 대기 비중이 크면 해당 저장 경로를 먼저 개선한다. host/HTTP 대기가 크면 다른 서버 간 병렬화 효과를 비교하되 같은 서버 간격·429·`Retry-After`는 유지한다.
3. XML 처리의 실제 CPU 비중이 크게 확인될 때 Rust를 같은 입력으로 비교한다. 지금은 언어 변경의 근거가 없다.

관찰 로그는 endpoint ID·상태·숫자 시간만 기록하며 본문·기사 URL 목록·키를 남기지 않는다. 운영 계측 코드나 설정 반영도 이번 조사에서는 수행하지 않았다. 전체 DB 쓰기/내보내기 단계 측정이 남아 있어 지배적인 단일 병목은 미확정이다.

## 원시 근거와 재현 자료

- [기존 운영 기록·DB 조회](../output/news-quality/collector-performance-baseline-2026-10-13.json)
- [실제 HTTP/XML 8개 단계](../output/news-quality/collector-live-phase-probes-2026-10-13.json)
- [시작 구간·읽기 전용 DB 계측](../output/news-quality/collector-startup-readonly-probes-2026-10-13.json)
- [로컬 CPU·DB 상세](../output/news-quality/performance/cpu-db-report.md)
- [로컬 측정 원시 결과](../output/news-quality/performance/cpu-db-results.json)

원시 자료는 이 workspace의 ignored output에 보존한다. 저장소 문서에는 수치·방법·한계를 남기고 비공개 운영 파일이나 자격 증명을 포함하지 않는다.
