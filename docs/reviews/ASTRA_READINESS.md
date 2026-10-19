# 0.13.1 최종 동결 소스 독립 리뷰

**판정: 동결된 검토 범위에 남은 필수 P0/P1/P2 발견 없음.**

기준 HEAD: e9e9a9f6cd85db80dba6c732c90d700396929670. 입력은 docs/evidence/0.13.1/reviewed-files.json의 24개 파일이며 manifest SHA-256은 d85b9a22b1053c027b851b62ea4c7aca5adbc2af7d0b7dc9bc639d8a10c088f9이다. 검토 전후 24개 파일의 SHA-256이 모두 일치했고 manifest 자체도 변경되지 않았다.

## 수정 확인

- 의미 평가가 semanticCoverageVersion=1과 matched/no_matches를 요구하여 차원 불일치·coverage 누락·저하 상태의 키워드 결과를 정상 의미 검색 점수로 집계하지 않는다. 색인과 질문 호출에 공유 예산이 적용되고, 문항 완결성·출처·금지 정보·회수율 gate가 종료 코드에 반영된다.
- 과거 baseline은 DB/endpoint 작업 전에 Git 소스를 검사하며 키워드 전용으로 제한된다. Git 이력 없는 소스 패키지의 제한을 문서화했다.
- doctor는 일반 대화·스킬과 코드 실행의 요구를 구분하고, release/schema hash/최근 정상 Worker tick/부분 embedding 설정을 확인한다. probe 시간과 출력을 제한하며 실제 모델 품질 검증으로 표시하지 않는다.
- provider의 인증·요청 한도·endpoint 오류 분류, 잘못된 JSON/구조 거절과 안전한 오류 메시지를 확인했다. 이전에도 limitedText가 HTTP 실패를 거부했다는 사실을 문서가 정확히 명시한다.
- 두 provider의 실제 loopback Worker 검사가 오류 응답의 미게시, responded 원장, timeout의 DISPATCH_UNKNOWN/unknown 원장, 자동 재발송 금지를 확인한다.
- 설치·첫 사용·평가 문서는 fixture 계약 검사와 실제 endpoint/실무 품질의 차이를 유지하며, 비밀 볼륨 재준비와 선택 기능 경계를 설명한다. 릴리스 표기와 백업/복원 허용 버전 변경도 확인했다.

## 독립 재실행

1. node --test tests/doctor.test.js tests/memory-evaluation-cli.test.js tests/integrations.test.js — **16/16, exit 0**.
2. TEST_DATABASE_URL=postgresql://crewroom@127.0.0.1:5448/crewroom node --test --test-concurrency=1 tests/server/memory-evaluation.test.js tests/server/provider-failures.test.js — **5/5, exit 0**.

합계 **21개 통과, 실패 0, skip 0**. 전체 테스트 수에 독립 재실행을 중복 합산하지 않는다. 고유 테스트 schema와 loopback/주입 fixture만 사용했으며 외부 모델·embedding·저장소 호출은 0회다. 운영 서비스·이미지·계정·소스·커밋은 변경하지 않았다.

## 한계

전체 회귀·브라우저·Docker Runner·암호화 복원은 부모 작업의 별도 실행 결과를 따른다. 이 리뷰는 동결된 변경의 정확성/회귀 검토이며 실제 모델 추론 품질, embedding 효용, 저장소 접근권, 운영 endpoint, 팀의 시간 절감이나 배포 전체를 승인하지 않는다. 동결 목록 밖에서 이후 추가하는 SERVER_VERIFICATION/evidence/리뷰 문서는 이 검사 전후 hash 보증에 포함하지 않는다.

검사 전후 기록과 정확한 파일 해시는 [기계 판독 리뷰](../evidence/0.13.1/review.json)와 [동결 manifest](../evidence/0.13.1/reviewed-files.json)에 저장했다.
