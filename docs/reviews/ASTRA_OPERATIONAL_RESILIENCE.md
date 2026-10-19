# Astra 장기 운영 복구 리뷰 · 0.13.0

2026-10-19. gpt-6-astra의 읽기 전용 독립 감사와 수정 후 재검토다. [동결 파일 23개](../evidence/0.13/reviewed-files.json)의 manifest SHA-256 `8892b2dc4e3410e48946e33dd4fec5a548862584a275c2131e9ab487cdb0c39b`에 결부된다. 검사 전후 모든 파일의 일치를 확인했다.

| 발견한 경계 | 최종 반영 |
| --- | --- |
| 일시적 embedding 실패 3회 뒤 재개 명령 부재 | 현재 profile의 실패·임대 만료 indexing을 제한적으로 재등록하는 CLI. 살아 있는 lease·ready·다른 profile 보호 |
| 용량 조기 반환 또는 대상 없음 때문에 stale 캐시 정리가 생략됨 | 용량 판단 전에 제한된 정리. 정정된 episode도 현재 원문 revision으로 재생성 |
| 마지막 indexing 시도 중 Worker 종료 시 새 CLI도 대상을 놓침 | 만료된 indexing을 포함하도록 수정. dry-run→apply→같은 원문 새 token 성공 회귀 |
| 최신 원문 우선과 같은 원문/설정의 lease 소유자 구분 부재 | 오래된 원문부터 처리. claim token·유효 lease로 늦은 성공/실패 덮어쓰기 차단 |
| 같은 DB의 다른 schema 검사가 claim 잠금을 공유함 | 현재 schema와 index 명칭의 두 키로 구분. 같은 schema 제외·다른 schema 진행 확인 |
| 동시 백업의 서비스 재시작이 다른 백업의 일관성을 깨뜨릴 수 있음 | 프로젝트 공통 파일 잠금. 최초 상태 조회 전 획득, 최종 서비스 복구까지 유지. 복원도 같은 guard 사용 |
| 큐 실패 전에 ready heartbeat를 갱신 | 마지막 정상 tick·큐 오류 분리. 현재 ready와 정상 tick·heartbeat가 모두 유효해야 healthy |
| 선택적 정리 실패가 claim을 가로막고 매 tick 재시도 | 별도 비동기 정리·60초 재시도 간격·정리 오류 코드. 정리가 막혀도 queued Run 완료 확인 |
| 누적 종료 이력에서 활성 조건의 일부만 인덱스에 포함 | `lease_owner IS NOT NULL`까지 포함한 partial index와 두 행 조회 한도. 10만 종료 Run의 쿼리 계획 측정 |
| DB idle 오류·느린 SSE의 복구 경계 | 실제 idle backend 종료 후 같은 Pool 재연결, backpressure 발생 시 연결 종료·새로 동기화 |

최종 검토 범위에서 **남은 필수 P0/P1/P2 발견은 없다.** 독립 검사 **운영 10/10 + 단위 3/3**, 실패·skip 0이다. 전체 자동 검사 수에 중복 합산하지 않는다. 최초 리뷰의 코드 경로 지적과 수정 후 실제 회귀를 구분하며, 전체 회귀·복원 완료나 수년 운영을 대신하는 승인은 아니다.

검사에는 포트 5448의 격리된 PostgreSQL schema와 fixture를 사용했다. 실제 외부 모델 호출·운영 프로세스/이미지 변경은 없었다. 실제 모델 품질·대규모 의미 검색·운영 SLO·PITR/HA는 이 리뷰의 증명 범위가 아니다. [운영 계약과 한도](../LONG_TERM_OPERATIONS.md) · [전체 검증](../SERVER_VERIFICATION.md)
