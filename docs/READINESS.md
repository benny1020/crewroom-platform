# 직접 사용 시작 · 0.14.0

설치별로 워크스페이스 하나를 운영한다. 일반 대화·공용 스킬·개인 비서는 모델 URL/ID와 계정으로 시작할 수 있다. 코드 수정·실제 검사는 추가로 GitLab과 프로젝트 실행 이미지를 준비한다. [검증·독립 리뷰와 증거](SERVER_VERIFICATION.md)

[에이전트 작업공간](AGENT_WORKSPACE.md)에서 계획·진행 메모를 저장하고, 실패 후에도 현재 문서를 다시 읽어 이어갑니다. 문서는 초안이며 검사·완료 상태와 구분합니다.

## 시작 순서

1. [README 설치](../README.md#서버-실행)대로 서버를 띄우고 팀장·팀원 계정을 발급한다. 개인 비서 본문은 팀장에게도 공유하지 않는다.
2. [연결 설정](CONFIGURATION.md)에서 제공자 형식·모델 URL·ID와 필요한 인증을 설정한다. 키는 비밀 파일로 저장한다. 인증 없는 endpoint는 빈 키 파일로 사용할 수 있다.
3. 키 파일을 바꿨다면 비밀 볼륨을 다시 준비하고 App/Worker를 재생성한다. 아래 진단은 모델을 호출하지 않는다.

```bash
docker compose run --rm --no-deps init-secrets
docker compose up -d --force-recreate app worker
npm run doctor
# GitLab 코드 수정·검사를 사용할 때만 추가 진단
npm run doctor -- --code
```

기본 진단은 App의 release/ready·migration hash·같은 release Worker의 최근 60초 heartbeat와 정상 tick·모델 설정을 요구한다. 부분 embedding 설정도 오류다. 자동 정리가 최근 3분 안에 성공하지 않았으면 별도 경고한다. 각 Docker probe는 최대 20초, HTTP probe는 각각 3초다. URL·키·원본 오류 본문은 출력하지 않는다. `ready:true`는 설정/서비스 진단 통과이며 실제 추론·저장소 접근권·모델 품질을 확인했다는 뜻이 아니다.

4. 브라우저에서 로그인해 **AI와 스킬 만들기**에 작은 반복 업무를 설명한다. 초안 → 자연어 수정 → 예시 확인 → 저장/적용 → 동료에게 같은 스킬로 요청 순서로 사용한다. 예시는 텍스트 시뮬레이션이며 실제 코드 검사를 실행하지 않는다. [스킬 사용 흐름](SKILL_STUDIO.md)
5. 결과의 근거·미확인 사항·다음 행동을 읽고 사람이 수용한다. 공용 업무는 두 계정으로 이어받고, 개인 업무는 다른 계정에 보이지 않는지 확인한다. 실패·질문·재작업도 업무방에 남긴다.

## 실제 연결 품질 확인

답변 평가는 DB가 필요 없고 기본 명령은 계획만 출력한다. `.env`를 읽을 때 Node 24의 `--env-file`을 사용한다. 먼저 두 문항으로 연결을 확인하고 같은 환경에서 전체 20문항을 평가한다.

```bash
npm run evaluate:answers
MODEL_API_KEY_FILE=.local/secrets/model_api_key node --env-file=.env scripts/evaluate-answers.mjs --live --case=timeout-1,unknown-1 --max-calls=2
MODEL_API_KEY_FILE=.local/secrets/model_api_key node --env-file=.env scripts/evaluate-answers.mjs --live --max-calls=20
```

이 평가는 고정된 문맥을 모델 adapter에 직접 전달한다. 사례별 실제 답변과 `humanReview`를 읽어 출처·모름 응답·낡은 사실·실행하지 않은 검사 주장을 판정한다. 자동 문구 검사는 의미적 정답 판정이 아니다. [답변 평가 계약](ANSWER_EVALUATION.md)

기억 검색은 **운영 DB와 분리한** `TEST_DATABASE_URL`을 준비한다. 명령은 매번 고유 임시 schema에 합성 자료를 넣고 정리한다. 기본값은 외부 호출 없는 키워드 회귀다. 의미 검색을 쓸 때만 별도 endpoint와 명시적 색인+질문 호출 예산을 사용한다.

```bash
# 테스트 전용 DB 환경 변수를 준비한 셸에서 실행
npm run evaluate:memory
# 전체 Git 이력이 있는 checkout에서만 지원하는 과거 키워드 비교
npm run evaluate:memory -- --baseline
# 선택적 embedding: .env + 키 파일, 최대 80회 요청
EMBEDDING_API_KEY_FILE=.local/secrets/embedding_api_key node --env-file=.env scripts/evaluate-memory.mjs --embeddings --max-calls=80
```

`--baseline`과 `--embeddings`는 함께 쓰지 않는다. 호출 수는 금액 상한이 아니다. 새 로컬 보고서는 0600으로 저장하며 금지 정보·필수 출처 누락·낮은 회수율·불완전/불일치 의미 검색은 성공 종료하지 않는다. [코퍼스·품질 gate와 한계](MEMORY_ARCHITECTURE.md#기억-품질-평가)

## 검증 범위

| 범위                                  | 판정 근거                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| 로그인·역할·개인/부서/팀 경계         | 실제 PostgreSQL API·두 계정 브라우저 회귀                                            |
| 스킬 설명·수정·예시·게시·적용         | 실제 영속 실행/화면, 엄격한 스키마·출처·버전/권한 검사. 모델 응답은 fixture/loopback |
| 개발·QA·중지·복구                     | 실제 Docker Job/검사·DB 원장·미확인 발송 차단·암호화 복원 훈련                       |
| 긴 대화·대량 이력                     | 100만 메시지·10만 종료 Run의 별도 합성 측정. 대상 서버 SLO와 별도                    |
| endpoint 오류                         | 두 API 형식의 HTTP 인증/한도/서버 오류·JSON/출력 형식 거절. 자동 재시도 없음         |
| 실제 모델의 업무·스킬 생성 품질       | endpoint 연결 후 실제 응답과 사람 판정 필요                                          |
| 실제 사용 시간 절감·대상 서버 RPO/RTO | 팀 시범 사용과 해당 서버 복원 실측 필요                                              |

자동 검사 결과와 최종 커밋 CI는 [검증 기록](SERVER_VERIFICATION.md)에서 확인한다. 실제 모델 연결·실사용 기록을 fixture 결과로 대신하지 않는다. 다음 사용 범위 확대는 [마일스톤](MILESTONES.md)에 따라 판단한다.
