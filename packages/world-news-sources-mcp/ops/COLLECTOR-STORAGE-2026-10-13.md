# DB 저장 경로 측정·개선 — 2026-10-13

같은 Oracle 서버에서 운영에 설치된 v3 코드를 격리 DB로 측정한 결과, URL마다 동일 SQL을 다시 준비하는 비용이 확인됐다. 해당 반복 비용만 줄이는 최소 변경을 로컬 브랜치에 구현했다. 운영 DB·코드·수집 정책·스케줄·배포는 바꾸지 않았다. 하루 전체 수집의 지배적인 병목이나 전체 속도 개선율은 아직 미확정이며 Rust 전환 근거는 없다.

## 실제 작업량과 저장 비용

운영 기록을 읽기 전용으로 집계했다. 10월 13일 UTC 3,780개 검사에서 URL 출현량은 692,087개였고, 10,000개 이상 URL을 가진 문서 10개가 그중 37.8%를 차지했다. 1,000개 이상 문서 106개는 64.4%를 차지했다. 출현량은 중복 제거한 기사 수나 발행량이 아니다.

Oracle Neoverse-N1 / Node 22.22.3에서 기존 `recovery-cause-aware-1-20261002` 모듈을 합성 `.invalid` URL과 임시 DB로 호출했다. 기본 WAL·synchronous FULL 설정을 유지했다. 운영 DB는 복사하지 않았고 HTTP·유료 API 호출도 없었다.

| URL 수 | 기존 URL 재관측 중앙값 | 신규 URL 저장 중앙값 |
| ---: | ---: | ---: |
| 100 | 10.63 ms | 11.18 ms |
| 1,000 | 71.63 ms | 88.14 ms |
| 10,000 | 744.10 ms | 1,067.04 ms |
| 50,000 | 3,847.60 ms | 5,108.06 ms |

100~10,000은 3회, 50,000은 2회 기록했다. 첫 fixture는 warmup으로 제외했다. 별도 호출 진단에서 10,000개 기존 URL의 scope 존재 조회 SQL이 **20,000회 준비되며 약 160 ms**를 사용했다. 진단 wrapper의 추가 비용이 있으므로 이 수치는 위 표의 순수 실행 중앙값과 직접 비교하지 않는다.

현재 보유 이력 규모인 53,346개 합성 collection 요약을 내보내는 archive 중앙값은 **1.971초**(2회)였다. 합성 source/country scope는 각각 5,034/72개다. 작은 warm 임시 DB이며 4.95 GB 운영 DB의 cold-cache 상태를 재현한 것은 아니다. 이력 내보내기를 38~42분 수집 구간의 주 병목으로 단정하지 않는다.

## 구현한 최소 변경

`ActivityLedger.commit()` 안에서 다음 세 가지를 바꿨다.

1. Scope 존재 조회 SQL을 transaction마다 한 번 준비해 모든 URL에 재사용한다.
2. 국가 목록과 미초기화 binding에 따른 baseline 판정을 URL 루프 전에 계산한다.
3. 사용하지 않는 scope UPSERT `RETURNING`을 제거하고 `.run()`으로 실행한다.

실제 존재 조회는 유지한다. `first_seen === checked_at`으로 신규 여부를 대체하지 않는다. 같은 시각에 다른 endpoint가 같은 기사를 발견해도 국가 합계는 한 번만 증가해야 하기 때문이다. 기존 `first_seen`·baseline은 보존하고 `last_seen` 갱신, source/country별 중복 제거, collection별 원자적 transaction, 오류 rollback과 replay를 유지한다. 관계 갱신을 생략하거나 여러 collection을 한 transaction으로 합치지 않는다.

## 전후 비교와 검증

Oracle의 기존 v3 compiled module을 임시 디렉터리에 복사해 위 세 변경만 적용한 후보와 비교했다. 원본 production module은 수정하지 않았다. 표본 순서는 교대로 바꾸며 별도 SQL 계수 wrapper 없이 측정한다. 비교한 입력의 반환값과 전체 durable 테이블의 정렬 SHA-256이 같아야 결과를 채택한다.

| 단일 source 입력 | 기존 중앙값 | 개선 후보 중앙값 | 저장 시간 감소 |
| --- | ---: | ---: | ---: |
| 10,000개 기존 URL | 740.811 ms | 403.090 ms | 45.6% |
| 10,000개 신규 URL | 1,078.847 ms | 494.320 ms | 54.2% |
| 50,000개 기존 URL | 3,917.013 ms | 2,097.401 ms | 46.5% |
| 50,000개 신규 URL | 5,153.067 ms | 2,509.877 ms | 51.3% |

10,000개는 각 3회, 50,000개는 각 2회 측정이며 전체 수집 속도 개선율이 아니다. 작은 warm DB·합성 입력·현재 디스크 조건에 한정된 비교다. 모든 표본의 반환값과 11개 durable 테이블 digest가 일치했다. 총 저장·archive 및 전후 비교 실험은 181.72초 안에 끝났고 최고 RSS는 374.2 MiB였다. 원본 운영 모듈 SHA-256도 전후 같았으며 임시 DB·모듈은 정리했다.

추가 로컬 비교에서는 3개 source·2개 국가, 1,000~50,000개 URL의 완료된 **25페어 모두** 반환값·모든 의미 있는 DB 행 digest가 같았고 replay 후 DB가 바뀌지 않았다. 10,000개 URL에서 SQL 준비 호출은 50,028→29회였다. 주 행렬 일부는 테스트 실행과 약 13초 겹쳤고 마지막 50,000개 전체 신규 case는 시간 제한으로 1페어만 완료했다. 독립적인 wrapper 없는 보충 실험도 동등성을 확인했지만 운영 개선 설명은 Oracle 비교를 우선한다. 최종 compiled 구현은 측정 후보와 변수명·공백 외 차이가 없음을 독립 검토했다.

Build와 전체 **252개 테스트**가 통과했다. 새 테스트는 동일 시각의 국가 중복 제거, 한 endpoint의 혼합 초기화 상태에서 국가 baseline 우선 규칙, replay/rollback 후 관계·scope·recovery 전체 불변을 확인한다. UI에 별도 성능 문구나 패널을 추가하지 않았다.

## 남은 확인

실제 정상 회차에서 backup 검증, host/HTTP 대기, DB commit, archive 시간을 함께 계측해야 전체 지연 비중과 운영 개선 효과를 확인할 수 있다. 운영 반영·전수 검사·worker 변경은 이 저장 실험의 결과로 자동 적용하지 않았다. 신규 소스 초기화나 검사 결과를 과거 기록으로 채우지도 않았다.

원시 근거는 workspace의 ignored output에 보존한다.

- [Oracle 저장·archive 보고서](../output/news-quality/performance/oracle-storage-report.md)
- [Oracle 입력·SQL 진단·원시 표본](../output/news-quality/performance/oracle-storage-report.json)
- [Oracle 전후 비교](../output/news-quality/performance/oracle-storage-ab-results.json)
- [로컬 전후 비교·동등성](../output/news-quality/performance/storage-ab-results.json)
- [최종 구현과 후보 비교](../output/news-quality/performance/storage-ab-final-module-review.json)
- [전체 테스트 로그](../output/news-quality/performance/storage-test-run.log)
