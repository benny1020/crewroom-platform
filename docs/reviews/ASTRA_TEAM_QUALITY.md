# Astra 공동 사용·대량 문서 리뷰

2026-10-21. `gpt-6-astra`가 base `024f2cda1d0c4d86f43926dbaf2cd8029e172d89` 위의 변경을 단계별로 읽기 전용 검토했다. 최종 동결 대상은 코드·검사·설정·벤치마크 29개다. 리뷰어의 독립 테스트 실행은 **0회**이며 구현 담당자의 자동 검사와 구분한다.

## 발견과 반영

| 검토 내용 | 반영 |
| --- | --- |
| 많은 타 업무 문서가 현재 업무의 발견을 방해 | 기본 task 범위, 명시적 project 검색 |
| 책임 인계 뒤 옛 요청자의 snapshot·권한 유지 | 종료 확인 후 옛 Run 취소, 새 요청자로 snapshot 준비 |
| 코드 checkpoint가 옛 기억·문서 출처를 잃음 | legacy retry chain 포함 검증·상속, 정정 시 거절·patch 보존 |
| GET 조회가 서로 직렬화되고 대기 중 옛 권한 유지 | 공유 read-only transaction, 잠금 후 재인증, 구성원 변경의 배타 잠금 선행 |
| source revision이 빠진 비정상 데이터의 SQL null 비교 | `IS NOT TRUE`로 거절, 누락·null 회귀 |
| 모델 목록의 bulk 기록이 출처를 섞거나 일부만 남을 가능성 | 문서별 refs 유지, 관찰 append·현재 read-set upsert, 동일 transaction의 후속 검증과 전체 rollback 회귀 |
| “문서를 읽었다”는 모델 문장과 실제 행동의 차이 | 본문 조회·반환 글자 수·성공 저장 수 별도 표시, 미조회 이어가기 안내 |
| 읽기 CTE inline으로 출처 배열 순서·fingerprint가 바뀔 가능성 | 014는 CTE 힌트 한 곳만 변경. 013→014의 전체 반환 행·출처 배열·revision·기존 refs 검증 |

29개 파일은 검토 전후 SHA-256이 일치했다. `013_agent_workspace.sql`은 기존 HEAD와 동일하고, 014의 view 본문은 `run_sources AS NOT MATERIALIZED` 한 곳만 다르다. [동결 파일](../evidence/0.14.1/reviewed-files.json)의 bundle은 아래와 같다.

`09e323d1f72b1219a05c7a3ae05be23c32509a5a8aba98aa102813c200d24566`

계산은 path 오름차순으로 `UTF8(path + NUL + lowercase SHA256 + LF)`를 연결한 bytes의 SHA-256이다. 마지막 행에도 LF를 포함한다. 원본 manifest SHA-256은 `18c32bcf06edfc6321191414beaeef10b65673af689f902aae66d3bf929c7f3e`이다.

최종 코드 동결본에 필수 P0/P1/P2 추가 발견 없이 승인했다. 이 승인은 전체 테스트·성능 측정·복원 또는 최종 커밋 승인을 대신하지 않는다. 해당 결과는 [검증 기록](../SERVER_VERIFICATION.md)에 별도로 남긴다.

브라우저 검사 종료 시 기본 강제 종료로 fixture schema가 남는 문제도 발견했다. Playwright에 10초의 SIGTERM 종료를 지정하고, 기존 정리 handler가 해당 schema를 삭제하는 것을 24개 브라우저 검사 종료 뒤 확인했다. 런타임 변경은 없다.

## 해석의 경계

부하 검사는 각 burst 전에 lease를 직접 60초로 설정하고 마지막 보조 Run도 완료 전에 연장한다. 유효 lease 안의 경합 검사이며 장기간 자연 heartbeat·자동 복구의 증거가 아니다. 실제 endpoint의 추론·문서 관리·스킬 작성 품질은 이 코드 리뷰로 입증하지 않는다.
