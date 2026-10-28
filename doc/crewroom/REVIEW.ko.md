# Crewroom 첫 구현 리뷰

2026-10-28 · Astra 설계·코드 리뷰 · Sol 제품 구현

**2026-10-29 현재 판정: 새 제품 5d2b242의 기본 CI 3개 job·전체 CI 21개 job·production 이미지 인증/ACL/재시작/복원을 수용한다. 추가 runtime qualification은 첫 remote warm 사례 실행 중 host의 1,200초 제한에 도달했으며, 내부 정지 원인은 미확정이다.** 제품 SHA는 `5d2b242658efe63c10c495bf526b329db2f2f064`다. 이전 기준선 `13e79d1a419ce1930b641edb8d587a23555dc535`의 45,760개 통과 수는 별도 역사적 증거이며 새 SHA로 승계하지 않는다. [새 집계 영수증](regression-receipt-5d2b242.json)은 실제 고유 사례 45,761개 통과·실패 0·retry 0, 조건부 skip 100개를 확인한다. 전체 Crewroom 확장 요구의 완료, 실제 모델·GitLab 연결이나 EC2 운영 배포 승인을 뜻하지 않는다. 아래에는 수정 전 실패와 수정 후 증거를 함께 보존한다.

## 검토 대상과 유지한 경계

기반 revision은 `cff331f6ca0a652b5e41641c68dfa5fa584c22ae`이며 [소스 기록](../../crewroom/UPSTREAM.json)을 따른다. 원본 MIT attribution과 Crewroom 독창 자산의 0BSD 범위를 구분한다. 전체 source import와 제품 변경은 각각 검토할 수 있어야 한다. 원래 Crewroom checkout/runtime/database는 이 검토 대상이 아니다.

검토는 `AGENTS.md`, 적용되는 `rules/`, [foundation 기록](../plans/2026-10-28-crewroom-paperclip-foundation.md), [아키텍처](ARCHITECTURE.ko.md), 실제 UI/API/service 소스를 기준으로 했다. 기존 제어 계층의 권한, task, durable wake, session, issue privacy를 재사용하는 방향은 타당하다. 별도 Crewroom scheduler나 BoardChat subprocess를 도입할 이유는 없다.

| 소스에서 확인한 첫 구현 | 보장하지 않는 것 |
|---|---|
| 한국어 팀 홈, 부서 표시, 에이전트 워크룸, 기본 비서 선택 | 부서 ACL, 사용자별 독립 agent ownership |
| `metadata.crewroom.schemaVersion=1` 표시 계약 | metadata를 수정해 얻는 추가 권한 |
| 실제 agents/live-runs/issues 읽기, live-runs `minCount:0` | animation, 과거 성공 run을 현재 작업으로 해석 |
| 기존 Agent Chat에서 새 conversation을 private issue로 생성 | agent home/memory/provider session의 사용자별 격리 |
| company-scoped capability projection, 선택한 assignee 범위 검사 | capability 응답을 write authorization token으로 사용 |
| 설치된 skill/version 확인 후 일반 issue에 사용 요청과 version을 기록 | 실행 당시 immutable snapshot을 강제한 실행 증거 |

## 코드 리뷰 발견 사항

### R1 · P1 · 개인 대화 진입의 에이전트 권한 검사

검토 시점의 `server/src/routes/issues.ts` chat ensure는 agent reference를 찾은 뒤 일반 `svc.create`로 호출했다. 생성 service의 assignable 검사는 company와 상태를 확인하지만 요청자의 assignment permission을 받지 않는다. private agent ID를 아는 회사 사용자가 일반 task 생성의 `tasks:assign` 검사를 거치지 않고 conversation을 만들 수 있는 경로다. private issue 생성에 따른 assignment grant도 이 권한 검사를 대신하지 않는다.

필수 수정은 새 endpoint나 별도 ACL이 아니라 기존 concrete assignee의 `tasks:assign` 판단을 chat route에 재사용하는 것이다. 기존 대화 이력을 읽는 권한과 새 실행을 요청하는 권한은 구별해야 한다. 현재 board의 `agent:read`/`agent:wake`만으로 private assignment policy가 검사되지는 않으므로 메시지·새 session·queued interrupt의 실행 admission은 `agent:wake`와 concrete issue/project/assignee scope의 `tasks:assign`을 함께 만족해야 한다. durable dispatch에서도 기존 responsible-user admission을 유지한다. 과거에 대화를 만들었다는 사실이 이후 철회된 실행 권한을 영구 보유하게 해서는 안 된다.

검증 조건: private agent 미허용 사용자 직접 API 차단, 허용된 scope의 정상 생성, company 경계, viewer 쓰기 차단, 생성 이후 권한 철회 시 새 실행 거부와 소유한 이력 읽기 보존. 현재 상태: **소스 수정 및 6개 capability 회귀 통과 확인**. `assertCanUseConversationAgent`가 `agent:wake`와 concrete `tasks:assign`을 함께 검사하며 ensure POST, 메시지·session reset, queued interrupt에 적용된다. 읽기 GET에는 새 실행 권한을 요구하지 않는다.

### R2 · P2 · 업무·스킬 목록과 기존 event invalidation 연결

`["crewroom", "tasks", companyId, agentId]`와 별도 skill query keys는 기존 `LiveUpdatesProvider`의 canonical issues/skills invalidation에 포함되지 않았다. 새 업무 모달이 만든 업무나 다른 사용자가 완료한 업무가 홈에 반영되지 않을 수 있다. 새 polling 대신 기존 query-key family 또는 company-scoped event invalidation을 재사용해야 한다. 권한 변경 event에서도 capability projection을 다시 읽되 실제 write API의 재검사는 유지한다.

검증 조건: 화면을 열린 채로 업무 생성·수정·완료 후 자동 갱신, 다른 assignee/company로 이동할 때 결과 혼합 없음, 실패 시 오래된 결과를 최신 상태라고 표시하지 않음. 현재 상태: **소스 수정 및 관련 UI 회귀 통과 확인, live event 화면 검증은 별도**. Crewroom 목록이 canonical issues/companySkills key family를 사용하며 agent skill sync와 company-member/agent 권한 변경의 capability invalidation을 연결한다. 새 polling은 도입하지 않는다.

### R3 · P2 · 스킬 실행 후 이동과 팀 변경 상태

`SkillsSection`의 mounted ref는 effect cleanup에서 `false`가 된 뒤 setup에서 복원되지 않았다. 앱이 사용하는 React StrictMode의 effect 재실행 후 성공한 업무로 이동하지 않는 원인이 된다. setup에서 mounted 상태를 복원하거나 기존 lifecycle 패턴을 재사용해야 한다. 회사 변경 시에는 선택 skill/agent와 요청 identity를 분리해 이전 회사 선택이 새 요청에 섞이지 않아야 한다.

검증 조건: StrictMode에서 업무 생성 후 실제 task로 이동, 실패 retry는 같은 idempotency key 사용, 변경된 요청은 새 key, team 변경 시 이전 선택 잔존 없음. 현재 상태: **소스 수정 및 관련 UI 회귀 통과 확인**. effect setup에서 mounted ref를 복원하고 company key로 스킬·개인 설정 subtree를 분리한다. 늦게 도착한 chat ensure 응답은 사용자·company 변경, unmount 또는 abort 이후 private query cache에 기록하거나 이동하지 않는다.

## 대화에서 업무로 이어지는 설계 검토

[아키텍처 13절](ARCHITECTURE.ko.md#13-대화를-주-진입으로-삼는-업무-계약)의 소유자는 기존 Agent Chat, native/HTTP task creation, issue service와 `chat-completion-delivery`다. 명확한 Standard 실행 요청을 최소 task로 인계하고 질문·아이디어는 대화로 답한다. 사용자가 계획만 요청했거나 Ask/Plan 모드 또는 명시적 승인 조건이 있으면 기존 gate를 지킨다. 생성 후 대화는 task 링크를 답하고 종료하며 별도 polling이나 Crewroom queue를 만들지 않는다.

업무별 의견·재요청은 기존 issue comment와 완료 업무의 `reopen` 흐름을 재사용한다. task/result를 확인하고 같은 업무의 산출물 revision을 이어간다. 단순 감사·평가를 재실행 요청으로 해석하지 않는다. 원 대화의 완료 알림은 새 작업의 허가가 아니다. 아래 R4 수정 후 실제 기본 UI/API에서 ‘고마워’는 같은 업무의 완료 상태를 유지하고, 명시적 수정 요청은 같은 업무를 다시 여는 것을 확인했다. 이 directive는 사용자 의도를 모델에 안내하는 정책이며 한국어 의도 인식의 실제 품질을 입증한 결과가 아니다.

### R4 · P1 · 의견만 저장하는 선택과 서버의 암묵적 재실행

active composer의 체크박스를 끈 채 `reopen`을 생략해도 서버 `shouldImplicitlyMoveCommentedIssueToTodo`가 human+closed+agent 조건으로 업무를 다시 연다. POST comment와 PATCH comment 경로에 모두 존재하며 기존 route 테스트도 이를 명시한다. 따라서 UI mock에서 `reopen:undefined`를 확인하는 것만으로 ‘의견만 저장’ 동작을 증명할 수 없다.

좁은 수정 계약은 명시적인 `reopen:false`가 암묵적 재실행보다 우선하도록 하고, 필드가 없는 기존 client 동작은 유지하는 것이다. UI·API client·PATCH/POST 두 경로를 동기화한다. 완료·취소 업무에 의견을 남겼을 때 comment는 저장되고 status와 wake는 변하지 않아야 하며, 실행 의도가 없는 의견 저장 때문에 닫힌 workspace를 복구하지 않아야 한다. 체크한 수정 요청은 기존 권한·pause·workspace 복구 gate를 따른다. 현재 상태: **서버·MCP·두 composer 수정 및 집중 회귀 통과, 실제 기본 UI/API 상태 전이 확인**. 서버 278개 중 실제 PostgreSQL/API 12개가 완료·취소, POST/PATCH, false/true/생략을 검증하며 별도 MCP 16개가 false 직렬화를 포함한다. 기본 `TaskChatThread → TaskChatComposer`와 classic `IssueChatThread` 모두 수정했다. [브라우저 검증](UI-VERIFICATION.ko.md)에서는 false가 같은 task의 done을 유지하고 true가 같은 task를 todo로 바꾸며 live run은 0개였다. 브라우저 결과만으로 wake 횟수나 모델 재작업 성공을 주장하지 않는다.

private source 보호는 기존 `issueService.create`의 run provenance 상속으로 확인했다. native/HTTP task 생성에 visibility 필드가 없다는 사실만으로 공개 유출이라고 판단해서는 안 된다. source run으로 찾은 issue가 private이면 top-level task여도 private root와 access edge를 상속한다. public project 선택과 structural parent 제거는 이 보호를 해제하지 않는다. 신규 회귀는 실제 PostgreSQL에서 두 생성 경로의 owner/source/privacy 유지, 비허용 사용자 읽기 거부, 재시도 중복 방지를 검증한다. 모델 호출·실제 dispatch·전체 private 데이터 경로 수용과는 별도 증거다.

## 개인 대화 보호: 현재 확인과 추가 증거

새 conversation은 인증 사용자로 `createdByUserId`, `responsibleUserId`, `conversationUserId`를 구성하고 `visibility:private`를 전달한다. 클라이언트가 책임자를 임의 지정하지 않는다. service는 기존 personal project, privacy root, assignment grant를 사용한다. conversation identity 잠금 후 기존 공개 대화가 발견되면 private 생성 요청을 `409 chat_conversation_privacy_required`로 거부한다.

과거 공개 conversation은 개인 목록에서 제외하고 ensure/send/upload를 차단한다. 일반 historical issue는 남으며 명시적 privacy 변경을 지원한다. 이미 공개된 과거 정보의 노출을 소급해 취소한 것은 아니다. 개인 대화와 공용 specialist의 home/memory 격리는 다른 요구다. 이 단계는 일반 task ACL을 적용하는 첫 수정이며 다중 사용자 전체 데이터 경로를 검증했다는 뜻은 아니다.

추가 운영 수용 증거는 서로 다른 실제 사용자 세션에서 issue detail, 검색, attachment content, work products, run log와 event stream의 비허용 접근 차단을 포함해야 한다. 관리자 break-glass의 기존 정책과 감사 기록을 숨기지 않는다.

## EC2 한 대와 Docker PostgreSQL

배포 계약은 [아키텍처 11절](ARCHITECTURE.ko.md#11-ec2-한-대--docker-postgresql-배포-계약)을 따른다. app와 PostgreSQL을 별도 container/volume로 운영하며 PostgreSQL host port는 공개하지 않는다. upstream Dockerfile의 `production` target, authenticated mode, 명시적 URL/host 정책, health, restart, 90초 stop grace, 지속 저장과 복구 절차가 필요하다. 선택적 Caddy TLS 또는 검증된 외부 TLS termination을 사용한다.

현 upstream local CLI adapter는 app container 내부 실행이다. 별도 DB container는 job별 filesystem/process/credential 격리의 증거가 아니다. 분리 runner service를 Compose에 선언하기만 해서는 실제 execution transport가 연결되지 않는다. Docker socket이나 privileged mode로 우회하지 않는다.

최신 5d2b242 image CI `40744488774`도 인증·초대·private 대화/첨부 ACL·재시작·DB/파일/환경 snapshot·새 프로젝트 복원을 통과했다. [이미지 영수증](image-receipt-5d2b242.json)을 따른다. 다음 문단은 이전 13e 기준선의 성공 이력이다.

현재 상태: **제품 13e image CI `40730054313`의 build·인증·private ACL·재시작·일관된 snapshot·새 환경 복원 검증 통과**. 이미지 ID는 `sha256:99ec1bbf9ae413186563563d245780fc9ddafb741480d19fdfc0d05da5e41b18`이다. 최초 admin·가입·viewer 초대와 실제 서로 다른 로그인 세션의 private 대화/첨부 접근 차단을 검사했다. DB·파일·환경 설정의 일관된 snapshot을 별도 프로젝트와 포트 3119에 복원한 뒤 원본과 복원 환경의 인증·ACL·파일 보존을 확인했다. 이는 CI Docker 환경에서의 배포·복구 증거이며 EC2 실운영 증거는 아니다.

수정 전 실패도 보존한다. 첫 image CI `40703906634`는 unhealthy에서 멈췄다. 익명 authenticated `/api/health`가 내부 `startupRecovery`를 숨기는 정책을 보존하고 Compose probe가 공개된 `status:ok`를 확인하도록 수정했다. `CREWROOM_PUBLIC_URL` 한 값이 공개 URL과 단일 trusted origin에 동일하게 적용된다. 이후 723 후보 image CI `40713387606`는 build와 최초 admin·signup을 통과했지만, 정상 human invite 수락의 HTTP 202를 smoke가 200/201로 기대해 중단됐다. 수정 harness는 202 receipt의 company·human identity·상태를 확인하고 pending인 경우만 같은 request ID를 승인한 뒤 실제 active viewer membership을 검사한다. private 읽기 404와 쓰기 capability false 검사를 유지했으며, offline Node 9개·Python 12개뿐 아니라 위 13e 이미지 CI에서도 실행했다.

이전 로컬 실패는 유지한다. Docker VM 8 GiB에서 Rust runner와 UI 빌드 뒤 server `tsc`가 exit `137`/`ResourceExhausted`로 종료됐고, Node heap 3072→2048 MiB 재시도도 실패했다. 이후 설치된 TypeScript 7 launcher가 native Go compiler를 실행한다는 것을 확인해 build stage에만 `GOMAXPROCS=2`, soft GC target `GOMEMLIMIT=3GiB`를 적용했다. full typecheck는 유지했다. EC2 계정, 실제 domain/TLS, live provider/GitLab 계정이 없는 상태에서 EC2 배포나 실제 업무 실행 성공을 주장하지 않는다.

## 검증 기록과 남은 완료 조건

새 제품 5d2b242의 기본 CI `40744488533`는 3/3 job, 전체 CI `40744488638`는 21/21 job, image CI `40744488774`는 인증·private ACL·재시작·일관된 snapshot·새 프로젝트 복원을 통과했다. [이미지 영수증](image-receipt-5d2b242.json)의 image ID는 `sha256:b301362c35325205371c41e0db6e34685433fede535a1f4943bb1dbe1e41b328`이며 원본 artifact의 해시·CLI 버전과 일치한다. [새 전체 회귀 영수증](regression-receipt-5d2b242.json)은 21개 공식 artifact digest 일치와 43/43 Vitest 호출 완료, 고유 실행 사례 45,761개 통과·실패 0·retry 0을 확인한다. 조건부 skip 100개에는 전체 skip 파일 12개가 포함되며, chat shard 필터 skip 11,123건은 다른 shard에서 실행된 사례의 반복 제외다. 신규 archive ownership 회귀 1개가 기본 경로에서 실제 통과했으며 별도 opt-in Docker proof를 이 수에 합산하지 않는다. qualification `40744500551`은 local 8/8·remote 준비 통과 뒤 remote 단계 실패로 종료됐고, 완료 JSON의 사례별 결과가 없어 실패 수나 timeout을 확정하지 않는다. 최초 소유 프로세스·컨테이너 정리는 통과했지만 private fixture 삭제 완료는 당시 receipt로 확인되지 않았다.

2026-10-29 후속 검증 기준이다. 제품 13e의 기본 CI `40730054272`는 3/3 job, 전체 CI `40730055102`는 21/21 job, image CI `40730054313`는 전체 절차를 통과했다. [집계 영수증](regression-receipt.json)은 21개 job·43개 Vitest 호출 완료, 중복을 제거한 실제 실행 45,760개 통과·실패 0·retry 0을 확인한다. 조건부 skip 100개(전체 skip 파일 12개 포함)는 통과로 세지 않는다. 별도 chat shard의 필터 skip 11,123건은 다른 shard에서 실행된 같은 사례의 반복 제외이며 미실행 테스트 수가 아니다. 별도 qualification `40736309647`는 실제 로컬 프로세스 8/8·skip 0, remote 0/5 통과·5개 실패·skip 0 및 cleanup 실패다. 추가 관측 helper `02314ddbf158b302c73f96942abf10671d2faaa8`를 사용한 같은 제품의 재실행 `40738818450`도 local 8/8·remote 0/5 통과로 종료됐다. 정제된 nested cause는 일반 Error로 남아 remote 다섯 실패의 공통 원인을 확정하지 못했다. cleanup은 stop exit 0 뒤 remove exit 1로 최초 실패했으며, 후속 recovery에서 소유 컨테이너 부재를 확인했다. 초기 실패는 지우지 않는다.

이전 기록: 첫 full CI `40703906698`는 21개 job 중 12개 성공·9개 실패로 종료됐다. 기존 native runner shard는 4 files·107 통과·13 skip이며 새 R5 bwrap bridge 수정의 통과 증거가 아니다. b08 후보(`b08e5947ff45981b939676e7cfa404c2b683264d`)의 기본 CI `40714076506`는 3개 job 모두 통과했다. 집중 job은 server 7 files·228 통과·플랫폼 skip 1개, MCP 16개, UI 17 files·614개를 통과했고 R5의 실제 Linux bwrap 경로도 실행했다. b08 전체 CI `40714076522`의 당시 기록은 21개 중 12개 성공·실패 0개·나머지 진행 중이었다. 현재 판정은 이전 SHA 결과를 승계하지 않고 위 13e 실행을 따른다.

| 증거 | 현재 확인 수준 |
|---|---|
| frozen install | foundation 기록에 36 workspaces 설치 성공. 이 리뷰에서 재실행하지 않음 |
| Backend focused suites | R4 최종 8 files, 278/278, exit 0, worker 1, 37.21초. 실제 PostgreSQL/API 의견 계약 12개와 기존 native/HTTP private handoff를 포함. 별도 MCP transport 16/16. 전체 묶음은 DB와 mocks 혼합 |
| 최종 backend 후속 검증 | R5·OpenAPI·Git portability 관련 5 files, 241 통과·Linux 조건 8개 skip. full server `tsc --noEmit` exit 0. 별도 CLI telemetry는 상위 opt-out=1 환경에서 4/4 통과. 플랫폼 skip은 통과로 세지 않음 |
| Claude probe fixture | foundation 기록에 27/27. 실제 custom endpoint inference 증거가 아님 |
| isolated source startup | foundation 기록에 loopback 3117 API/UI health 및 새 PostgreSQL 55447. public deploy나 authenticated 다중 사용자 증거가 아님 |
| UI focused suites | 10 files, 552/552, worker 1. 기본 native 및 classic composer, TaskChatThread, Crewroom·Avatar·navigation·breadcrumb 회귀. token/module 검사 통과. [별도 UI 기록](UI-VERIFICATION.ko.md) 참조 |
| b08 원격 기본·집중 검사 | 과거 증거: 기본 CI 3개 job 통과. server 228 통과·플랫폼 skip 1개, MCP 16개, UI 614개. 현재 제품의 판정은 아래 13e 실행 기준 |
| 새 보안 후보의 로컬 검증 | 의존성 집중 12 files·179 통과·skip 0, MCP 16개, 실제 legacy transformer 3개, 관련 UI/shared/MCP/Cursor typecheck 통과. 0396까지 포함한 최신 인증 이전은 별도 실제 PostgreSQL 4 files·15 통과·skip 0. DB 생성·migration 검사·typecheck 및 full server typecheck 통과. 이 묶음들은 일부 중복되므로 합산하지 않음 |
| 13e 보안 수정 제품의 전체 typecheck/build/test | 기본 CI 3/3·전체 CI 21/21 job 통과. production image 인증·재시작·복원도 통과. [집계 영수증](regression-receipt.json): 실제 실행 45,760개 통과·실패 0·retry 0, 조건부 skip 100개 별도. 21개 job·43개 Vitest 호출 완료 |
| 신규 capability 및 R1–R3 회귀 | 위 focused 결과로 해당 수정 확인. live event 및 다중 로그인 전체 경로는 별도 |
| 현재 UI visual review | 원본 캐릭터·대화 CTA·실제 paused 상태·명시적 scene preview를 확인. 최신 `media/team-1440x900.png`, `private-chat.png`, `task-opinion.png`, `task-revision.png`와 receipt가 실제 로컬 화면을 기록. 오류·빈 데이터·read-only 대체 응답은 `*.fixture.png`로 구분. [최종 시각 리뷰](UI-REVIEW.ko.md) 참조 |
| Docker build/auth/restart/data persistence | 13e image CI 전체 통과: 실제 admin/viewer 인증·private 대화/첨부 ACL·재시작·DB/파일/환경 snapshot·새 프로젝트 복원·원본/복원 재검사. 첫 health 및 초대 202 harness 실패 이력은 보존 |
| 새 5d2b242 전체 CI·이미지 | 기본 3/3·전체 21/21 job 및 이미지 인증·ACL·재시작·복원 통과. [새 영수증](regression-receipt-5d2b242.json): 실제 고유 사례 45,761개 통과·실패 0·retry 0, 조건부 skip 100개, 43/43 Vitest 호출 완료. 13e 수치를 승계하지 않음 |
| 추가 runtime qualification | 5d2b242 재실행 `40752013695`: local 8/8·remote 준비 통과, 첫 warm 사례 실행 중 host 1,200초 timeout 확인·나머지 4개 미시작. 내부 원인 미확정·stock report 미완결. 프로세스·컨테이너·private·always cleanup 통과. 현재 `40759000007`은 진단 전용이며 최종 stock 13개 통과를 대신하지 않음 |
| 실제 model/tool/resume/stop, GitLab, EC2 | 미검증 |

이전 실패도 유지한다. 잘못된 cwd의 최초 Vitest 호출은 tests를 찾지 못했다. 처음 privacy 회귀 assertion은 기존 403과 404 계약을 혼동했고 수정됐다. 초기 optional Copilot materialization은 실패 후 공식 installer로 회복됐지만 중단 원인은 확정되지 않았다. 최종 통과 일부만으로 이 이력을 지우지 않는다.

R4 첫 확장 서버 실행의 270 통과·8 실패는 테스트 spy가 heartbeat factory 대신 Storage 인자로 전달되고 auth-user fixture가 빠진 문제였다. fixture 수정 후 18개 단독 검사와 278개 전체 집중 검사가 통과했다. MCP 첫 15 통과·1 실패는 기존 create-task 기대값의 schema default 두 필드 누락이었으며 수정 후 16개가 통과했다. 새 false 전달 검사는 두 실행 모두 통과했다. 이 실패 이력과 실제 변경된 제품 오류를 혼동하지 않는다.

첫 full CI의 CLI telemetry 1개 실패는 테스트가 CI 환경 변수만 지우고 상위 `PAPERCLIP_TELEMETRY_DISABLED=1`을 유지한 fixture 격리 문제다. opt-out에 따라 client를 만들지 않는 제품 동작은 올바르다. 수정 소스는 전역 CI 설정을 유지하고, 해당 테스트 안에서 mocked fetch를 먼저 설치한 뒤 `.invalid` endpoint와 opt-out 환경을 격리한다. 두 명시적 opt-out의 client/state/fetch 비생성 검사와 원래 환경·임시 root 복구도 포함한다. 소스 검토와 상위 opt-out=1 환경의 4개 집중 검사를 통과했다.

OpenAPI의 Crewroom capability 명세 누락은 mounted-route manifest와 board-only operation 등록으로 보완했다. optional assignee UUID, 실제 응답 필드·nullable reasonCodes, 400/401/403/404, 힌트의 no-store 및 실제 mutation 재인가 설명이 route 소스와 일치한다. 보안·schema 회귀를 추가했으며 이 명세 추가가 별도 실행 권한을 부여하지 않는다. 소스 검토는 수용한다.

### R5 · P1 · Linux workspace command의 자식 프로세스 종료 확인

원격 general shard에서 detached descendant revocation 검사가 command 반환 직후 읽은 `ticks.txt` 값과 150ms 후 값을 다르게 관찰했다. `runner-bridge-tools.ts`는 바깥 bwrap process group에 SIGKILL을 보낸 뒤 Node `close`를 전체 자식 종료로 취급하여 workspace lane을 해제한다. 그러나 bwrap의 outer monitor는 초기 앱의 종료 정보를 보고 먼저 종료할 수 있다. 따라서 이 경로에는 권한 철회 뒤 쓰기와 다음 명령이 겹치지 않는다는 증명이 없다. 단순 파일 관찰 지연이나 검사 생략으로 수용하지 않는다. [bubblewrap 구현](https://github.com/containers/bubblewrap/blob/main/bubblewrap.c)의 `monitor_child`와 [PID namespace 설명](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)을 근거로 소유한 자식들의 종료 확인이 필요하다.

현재 상태: **소스 수용, 제한 Linux helper proof 및 b08의 실제 Linux bwrap 집중 회귀 통과**. 명령별 subreaper가 자기 자식만 종료·회수하고 `ECHILD`를 확인한 뒤 완료를 알리는 구현이다. Node는 유효한 확인과 helper 종료를 함께 검증하며, 늦게 끝난 authorization callback이 종료한 PID에 신호를 보내지 못하게 한다. 확인 실패는 workspace를 현재 controller 안에서 격리하고, 이미 기다리던 후속 명령도 진입 시 거부한다. controller의 제어 pipe가 닫히면 helper가 자식을 정리한다. 5초 응답 한도를 넘겨도 helper를 먼저 죽여 자식을 버리지 않는다. controller 재시작 이후까지 영구 격리를 제공한다는 뜻은 아니다.

최종 제한 Linux container에서 실제 fork·setsid writer의 정상 완료·timeout·권한 철회를 각각 3회 실행해 ACK 이후 descendant PID 부재와 같은 파일의 후속 쓰기 보존을 확인했고, Node controller 강제 종료 후 EOF cleanup도 통과했다. 최종 harness의 시작 handshake와 실패 시 소유 프로세스 정리도 반영해 다시 통과했으며 container는 정상 종료·제거했다. 이 로컬 proof 자체는 helper의 process lifecycle 검사다. 이후 b08 GitHub Ubuntu 집중 job `122907613908`에서 bridge 17개 중 Linux 실행 대상이 통과했고 macOS 전용 deny-command 사례만 skip됐다. 실제 bwrap 완료·timeout·권한 철회·같은 파일 후속 쓰기와 ACK 누락 시 대기 명령 거부·늦은 authorization 처리를 실행했다. 같은 job의 Linux helper 9개 및 controller 종료 검사도 통과했다. 첫 실패와 수정 후 증거를 따로 보존한다.

같은 suite의 denied-write `exit 2` 대 `exit 1` 실패는 별개다. shell별 실패 코드의 차이는 허용하되 실제 nonzero 종료, 원본 파일 불변, 비밀 내용 미노출을 모두 확인해야 한다. 기존 원격 실패는 수정 후 통과와 함께 보존한다. 이 Linux 검사는 실제 모델 연결 성공 증거가 아니다.

### R6 · P2 · Git의 filesystem-boundary 진단 형식

원격 CI의 workspace-session과 workspace-preparation 실패 두 개는 같은 upstream 구현 결함을 드러냈다. `probeGitWorktreeBase`와 `ensureManagedRepositoriesIgnored`가 non-repository 오류의 고전적인 한 줄 형식만 허용한다. Git이 mount 경계에서 내는 두 줄 형식은 [공식 Git 구현](https://github.com/git/git/blob/master/setup.c)의 별도 정상 진단이다. 이 차이 때문에 실제 non-Git local path의 owner configuration 분류가 누락되고, 명시된 plain task directory의 inert metadata를 허용하는 repository preparation도 실패했다.

현재 상태: **수정 소스·로컬 집중 검사 및 13e Linux 전체 CI 수용**. 공유 classifier는 정확한 두 메시지 형식만 판별하며 추가 stderr와 불완전한 문구를 거부한다. 두 caller의 code 128·signal 없음·C locale·Git 환경 변수 부재 조건을 유지하고, 첫 경로의 조상 metadata 부재 검사도 보존했다. 두 번째 경로의 예외는 기존 provenance가 확인한 `plainTaskDirectory`에만 적용하며 symlink 검사를 유지한다. 전역 `GIT_DISCOVERY_ACROSS_FILESYSTEM` 변경이나 모든 non-repository 오류를 삼키는 우회는 없다. 두 형식·CRLF·공백/괄호 경로 및 잘못된 형식의 classifier 회귀가 추가됐다.

### R7 · P1 · 보안 패치와 기존 인증 스키마의 호환성

Better Auth 1.7.7 설치 후 실제 PostgreSQL 가입 검사가 500으로 실패했다. 1.7.0–1.7.2가 쓰던 필수 `account.issuer`를 새 라이브러리가 더 이상 쓰지 않기 때문이다. 새 `0395` migration은 기존 `0230`을 바꾸지 않고 issuer 컬럼과 값을 보존한 채 nullable로 바꾸며 이전 issuer 인덱스를 제거한다. 계정 identity는 `(provider_id, account_id)`다. migration 때 중복을 검사하는 것만으로 이후 동시 생성을 막지는 못하므로 새 tuple unique 인덱스를 함께 둔다. 이는 같은 계정의 정상 재연결을 기존 행 갱신으로 처리하는 라이브러리 계약과 일치하며, 다른 provider의 같은 account ID는 허용한다.

현재 상태: **소스·schema·snapshot·journal 일치 확인 및 실제 PostgreSQL 3 files·7개 통과**. 하나의 DO block에서 account 테이블을 잠그고 중복 검사와 제약 변경을 원자적으로 처리한다. 중복은 건수만 보고하고 실패하며 계정·사용자를 병합하거나 삭제하지 않는다. 회귀는 기존 계정·password hash·issuer·session 행 보존, signed session 재사용과 기존 로그인, 새 nullable issuer 가입, 다른 provider의 같은 ID, 재실행, 서로 다른 두 DB 연결의 동시 쓰기 중 한 건만 성공함을 확인한다. 이전 라이브러리 바이너리 실행이 아니라 실제 현재 인증 데이터에 역사적 스키마 형태를 재현한 검사다. 새로운 NULL issuer 행이 생긴 뒤 과거 앱만 되돌리거나 NOT NULL을 자동 복원하는 rollback은 지원하지 않는다.

후속 최종 검사에서 공식 모델이 필수로 선언한 `user.email`과 `session.token` unique도 기존 schema에 빠져 있음을 확인했다. 이메일 조회 후 비동기 해시·생성하는 가입 경로에는 이를 대체할 잠금이 없었다. 발행한 0395를 보존하고 새 0396에서 user→session 순서로 잠근 뒤 두 중복 검사를 먼저 수행하고 unique 인덱스를 원자적으로 추가한다. exact text를 보존하며 대소문자 정규화·계정 병합·토큰 회전은 하지 않는다. **0396 포함 최종 PostgreSQL 검사는 4 files·15개 통과·skip 0**이다. 서로 다른 연결의 email/token 동시 쓰기는 각각 하나만 성공하며, 실제 HTTP 동시 가입도 200+422와 user 1개·credential account 1개·거절 응답 cookie 없음·정상 재로그인을 확인했다. 기존 user/account/session 행과 signed session을 보존하고, 기존 중복 발견 시 행·인덱스·migration journal이 변하지 않는 것도 검사했다. schema·snapshot·journal과 DB/full server typecheck를 확인해 이 인증 수정 범위를 수용한다. 이후 13e의 전체 CI와 production 이미지에서도 실제 인증·재시작·snapshot 복원 검증을 통과했다.

### 의존성 보안과 선택적 런타임 qualification

새 보안 후보의 frozen 설치 후 원본 audit 수치는 113개에서 2개(critical 0·high 1·moderate 0·low 1)로 줄었다. 남은 MSAL high는 실제 전이 의존성 경고이며 현재 Teams 호출은 advisory의 auth-code 흐름 대신 client credentials를 사용한다. low는 pnpm 9.15.4가 workspace 경로 `cli`를 npm 패키지 이름으로 보내는 충돌로 소스에서 확인했다. 원본 수치를 유지하고 ignore·allowlist를 추가하지 않았다. Zod 4.6.6 안의 v3 호환 파서는 여전히 과대 배열 전체를 검사하므로 Cursor provider 응답 경계까지 자원 증폭이 해결됐다고 주장하지 않는다. [보안 검토와 제한](DEPENDENCY-SECURITY.ko.md), [로컬 검증 영수증](dependency-remediation-receipt.json)을 따른다.

[선택적 런타임 qualification](RUNTIME-QUALIFICATION.ko.md)은 dispatch 전용 추가 CI다. workflow/helper SHA와 검사할 40자리 제품 SHA를 별도 checkout하고 각각 검증한다. 실제 선택된 debug runner와 fake provider binary의 hash를 기록하며 기존 recovery의 실제 프로세스 8개와 remote continuity 5개가 누락·중복·실패·skip 없이 통과해야 한다. 권한은 contents read이고 container는 고유 owner label/ID로만 정리한다. raw DB·세션·TLS key·test 로그는 공개하지 않으며 allowlist receipt만 artifact로 남긴다. 실제 OS 프로세스·PostgreSQL·Docker/TLS 검사가 통과하더라도 provider는 fake이므로 실제 모델 실행 증거가 아니다.

첫 실제 1afaaed 후보 qualification `40721425314`는 로컬 8개 중 **5개 통과·3개 실패**, remote 5개는 미수행, cleanup은 통과했다. 기존 공개 receipt만으로 세 실패의 원인은 확정하지 못했으며 제품 runtime이 수정됐다고 주장하지 않는다. 후속 CI helper는 고정된 사례 이름·상태, 고정 error-class enum, 허용된 회귀 파일 하나의 줄·열, 제한된 boolean/정수 또는 collection 길이 비교값만 공개한다. 문자열·객체 내용, 임의 경로와 원문 stack은 내보내지 않는다. 로컬 선택 사례가 모두 진입했고 소유 프로세스 정리가 확인된 경우에는 독립 remote 검사도 수행하되 로컬 실패는 최종 실패로 유지한다. 준비 실패·누락·skip·정리 불확실은 후속 실행을 막는다. 공개 Rust dependency cache는 제품 binary·DB/session/TLS fixture를 포함하지 않는다. 당시 helper 수정은 **소스 검토 및 offline 19개 검사 통과**였으며, 이후 실행 결과는 아래에 별도로 기록한다.

234 후보 재실행도 5개 통과·3개 실패였으며 세 실패는 모두 provider 종료 대기에서 발생했다. CI helper가 subreaper로 입양한 종료 자식을 suite가 끝날 때까지 회수하지 않아 좀비도 `kill(pid, 0)`에 살아 있다고 응답하는 조건을 작은 Linux fixture에서 재현했다. CI 전용 수정은 각 Popen 생성 후 해당 PID를 보호한 회수 thread를 시작해 자기 자식만 개별 nonblocking wait로 회수하고, 다음 spawn·최종 cleanup 전에 thread 종료를 확인한다. 살아 있는 자식에는 신호를 보내지 않는다. 256 MiB·1 CPU·네트워크 없는 실제 Linux proof에서 좀비 소멸, 직접 명령 exit 7 보존, 살아 있는 입양 자식과 다른 worker의 sibling 보존, 정상·예외 경로의 join·cleanup을 확인했고 offline 검사는 24개 통과했다. 이후 고정 operation·exit code·도구 누락 여부를 추가해 원격 준비 실패 위치를 구분했다. 고정 Node 이미지의 필수 도구 5개는 실제 확인했으므로 이미지 교체나 timeout·skip 완화는 하지 않았다. 동일 제품 234의 controlled 재실행 `40730091748`에서 local 8/8·skip 0, 입양 자식 5개 회수·cleanup 통과를 확인했다. 따라서 앞선 local 세 실패는 helper의 좀비 회수 문제였으며 제품 runtime 수리는 필요하지 않았다. 234에는 이후 공식 generator로 고친 stale catalog hash가 있었으므로 그 제품의 remote 5개 통과를 최종 조건으로 요구하지 않는다. 최종 13개 수용 기준은 유효한 generated metadata를 포함한 제품 13e다. 이미지 CI는 측정된 cache export 지연 때문에 `cache-to`만 제거하고 `cache-from`과 기능 검사를 유지한다.

후속 remote 준비 실패는 capability 없는 root가 복사된 바이너리를 chmod하는 단계에서 발생했다. 작은 Linux proof에서 호스트 UID 501·mode 0700을 유지한 복사본에 같은 실패를 재현했다. 이 UID는 로컬 proof 값이며 CI의 실제 UID로 주장하지 않는다. 원제품 바이너리의 mode/hash를 보존하고 private staging copy만 0555로 만든 뒤 실제 실행 UID의 읽기·실행 권한과 원본·복사본·컨테이너 SHA를 확인하도록 수정했다. capability나 privileged 실행은 추가하지 않았다. 234 control `40733514766`과 유효 제품 13e의 `40736309647`에서 local 8개와 remote 준비가 통과했다. 그러나 13e에서도 remote 5개 모두 실행 후 실패했고 cleanup도 실패했다. stock Vitest JSON은 fixture가 감싼 Error의 cause를 생략하므로 wrapper 위치만으로 제품 결함의 원인을 확정할 수 없다.

**현재 열린 수용 조건은 후속 제품 SHA의 remote 5개 및 소유 프로세스·컨테이너 cleanup 성공이다.** 추가 helper `02314dd`는 공식 Vitest reporter API로 최대 8단계 cause를 읽되 고정 title·오류 분류·fixture 위치·제한된 primitive만 기록한다. private 0600 sidecar를 Python에서 다시 검증하며 stock JSON의 검사 수·skip·실패 gate를 바꾸지 않는다. 초기 cleanup과 재시도 cleanup을 별도 기록하고 소유·ID·단계·종료 코드만 공개한다. Python 35개·Node 5개 및 작은 실제 Vitest의 단독/병용 실패 보존 검사를 통과했다. 제품·fixture·timeout 변경 없이 같은 13e를 검사한 `40738818450`에서도 local 8개 통과·remote 5개 실패가 유지됐다. nested 일반 Error를 보존했지만 remote 실패 원인을 특정하지 못했다. 초기 cleanup의 stop exit 0·remove exit 1과 recovery의 소유 컨테이너 부재를 구분해 기록했다. 후속 CI helper는 자동 제거 경합을 없애기 위해 `--rm`을 제거했으며 소유 확인과 명시적 제거·최종 부재 검증은 유지한다. 별도 실제 staging 함수로 재현한 소유권 결함은 아래 R9에서 수리했다. 이를 기존 다섯 실패의 확정 원인이나 remote qualification 완료로 주장하지 않는다.

### R8 · P2 · Zod 보안 패치 뒤 댓글 길이 계약

1afaaed 후보의 전체 CI에서 `agent-commentary`의 초과 본문 요청이 기존 400 대신 idempotency 충돌 409에 도달했다. Zod 4.6의 문자열 `max`가 Unicode code point를 세면서 기존 API·runner의 JavaScript UTF-16 길이 제한과 달라진 것이 원인이다. 공유 schema에 명시적인 `body.length` 검사를 추가하고 기존 `too_big` 오류 metadata와 OpenAPI `maxLength`를 보존했다. 동일 오류를 중복 추가하지 않으며 idempotency 정책은 바꾸지 않는다.

현재 상태: **수정 소스 수용, shared·실제 PostgreSQL integration 2 files·32개 및 OpenAPI 28개·shared typecheck 통과**. surrogate pair·ASCII·혼합 문자열의 경계와 초과를 검사하고, HTTP의 기존/새 idempotency key 및 native 경로에서 초과 본문이 prior retry 조회보다 먼저 거절되는 것을 확인했다. 이후 13e 원격 전체 CI 21개 job도 통과했다. 이 수정의 범위는 agent commentary이며 다른 문자열 정책을 함께 변경한 것으로 해석하지 않는다.

뒤따른 metadata 검사에서 도구 description에 연결된 generated JSON 갱신 누락도 보완했다. 공식 generator가 두 description, seeded catalog hash, fixture manifest hash의 세 파일을 재생성했고 관련 10개 check가 통과했다. source diff도 해당 설명·hash 연결만 바뀐 것을 확인했으며 Rust 실행이나 runtime 동작 변경의 증거로 세지 않는다.

### R9 · P2 · 원격 archive staging의 호스트 소유권 복원

`stageRemoteRunnerDirectory`의 command fallback은 호스트 archive의 UID/GID까지 복원하려 했다. 실제 exported 함수를 외래 UID/GID의 inert flat payload와 capability 없는 root 컨테이너에서 실행해 수정 전 `runner_remote_directory_staging_failed`를 재현했다. 공통 tar 인수에 `--no-same-owner`를 추가한 뒤 같은 함수·행렬이 통과했다. staging은 실행 사용자 소유로 파일을 만들며 GNU `--delay-directory-restore`, archive 내용, 기존 root/non-root mode·umask 정책, exclude·syncIn·symlink guard와 immutable 비교는 유지한다. 제품 변경은 이 인수 한 줄이다.

현재 상태: **소스·실제 owner의 수정 전 실패→수정 후 성공 및 5d2b242 기본/전체/이미지 CI 수용**. 추가 runtime qualification은 아래 별도 미해결 기록을 따른다. 최신 실제 GNU proof는 9.62초에 통과했고 flat mutable/immutable cold·dedup·변조·symlink·원본 hash/mode 보존을 검사했다. 변조 뒤 결과는 내용 변경 없는 `open(r+)`/close를 먼저 측정해 쓰기 불가면 거부·변조 보존, 기존 privileged writer이면 repair·원내용 복원을 기대한다. 결과를 본 뒤 둘 중 하나를 허용하는 검사가 아니다. 로컬 BSD 관련 선택 4/4, Python helper 35개, Node 진단 7개, 실제 Vitest cause API smoke 및 full server typecheck도 통과했다. 실제 remote recovery 13개의 fixture·root UID·cap-drop·timeout·성공 gate는 바꾸지 않았다.

GNU tar를 capability 없는 UID 0으로 실행할 때 중첩 read-only directory 안에 파일을 만들지 못하는 별도 제한은 해결하지 않았다. 해당 경로는 명시적 음성 회귀로 실패와 파일 미생성을 확인했고, 기존 BSD/non-root 회귀와 보조 GNU UID 1000의 nested cold·dedup은 통과했다. 보조 UID는 inert proof에만 적용했다. 새 extractor·recursive chmod/chown·`-p`·`--no-same-permissions`·capability 확대는 없다. 이 독립 소유권 수리를 기존 remote 5개 실패 전체의 원인이나 해결 증거로 확대하지 않는다.

동일 후보의 CI helper는 자동 `--rm`만 제거하고 owner label/full ID 확인·stop·명시적 remove·최종 부재 확인을 유지한다. 진단은 기존 fixture 외 정확한 owner 소스 두 파일의 위치와 고정 error-code enum만 추가하며 임의 suffix·오류 원문을 공개하지 않는다. 이 관측 보강도 stock JSON의 검사 수·skip·실패 판정을 완화하지 않는다.

### 5d2b242 후속 qualification 관측과 private fixture 정리

`40744500551`의 remote receipt에는 사례별 완료 결과가 없다. 약 1200초의 경과만으로 `TimeoutExpired`라고 판정하지 않으며 현재는 원인 미확정 단계 실패다. 소유 label/full ID 확인·stop exit 0·remove exit 0·최종 컨테이너 부재와 ECHILD 정리는 통과했다. 그러나 private fixture 삭제는 별도 검증하지 않았고 always cleanup도 실패했으므로 모든 정리가 완료됐다고 주장하지 않는다.

독립적인 non-root read-only fixture에서는 기존 `shutil.rmtree`의 PermissionError를 재현했다. 후속 CI-only helper는 프로세스·컨테이너 종료 확인 후에만 정확한 임시 경로를 FD/O_NOFOLLOW로 열고, root와 부모 및 하위 디렉터리의 소유 UID·device·mount identity를 확인한다. 소유한 디렉터리만 owner 권한을 보완하며 symlink는 대상에 접근하지 않고 link만 제거한다. owner marker는 마지막에 정리하고 `privateCleanup` 성공/실패를 receipt에 남긴다. 이 재현은 별도 helper 결함의 증거이며 원래 remote 단계 실패의 원인이라는 뜻은 아니다.

같은 helper는 공식 Vitest start/end·case·hook 이벤트마다 private 0600 atomic snapshot을 저장한다. 실행 중 중단한 작은 실제 Vitest에서 첫 사례 완료·둘째 실행 중·셋째 미시작을 보존했고 stock JSON의 실패 수는 바꾸지 않았다. Python이 필드를 다시 제한하며 부분 결과는 진단 전용으로만 사용한다. 누락된 stock report를 통과 사례 수로 대신하지 않으며 13개 gate·1,200초 제한·제품 fixture는 유지한다. 고정된 stage failure enum으로 host timeout·누락/잘못된 report·그 밖의 실패를 구분한다. Python 43개·Node 8개·실제 cause/partial API smoke·YAML·diff 검사를 통과해 helper 소스를 수용했다.

helper `4dceaa4432b3c9802befb20e8a0818c688f50626`로 같은 제품 5d2b242를 검사한 `40752013695`는 `host_command_timeout`으로 종료됐다. 이번에는 1,200초 host timeout이 확인됐다. 부분 snapshot에서 beforeAll은 약 14.4초, beforeEach는 약 14.5초에 끝났고 첫 warm 사례만 약 14.5초부터 실행 중이었다. 나머지 4개는 미시작이며 후속 hook·case 종료·cause frame은 없다. 따라서 다섯 사례가 각각 실패했다고 세거나 event loop 정지·checkpoint 결함 중 하나를 확정하지 않는다. 최초 프로세스·컨테이너·private fixture 정리와 always 단계의 이미 부재 확인은 모두 통과했다. 이 결과를 앞선 `40744500551`의 미관측 예외에 소급 적용하지 않는다.

CI 전용 helper `cf0b624`의 opt-in phase overlay를 소스 검토했다. Python 46개·Node 11개와 작은 실제 Vitest의 stock 2/2·overlay 2/2 비교에서 설정·기존 setup·canonical cwd·원 Promise와 예외 보존을 확인했다. 고정 함수 단계·Docker 호출 순번·sync tar/ps·실제 timer pulse만 private 0600 sidecar에 기록하며 제품·fixture·시간 제한·13개 gate는 바꾸지 않는다. 같은 제품의 진단 전용 실행 `40759000007`은 host의 1,200초 제한으로 종료됐다. 세 번의 `execute_session`은 각각 약 15.7초·17.7초·19.8초에 반환했고, 두 번의 finalize도 끝났다. 약 19.9초에 진입한 첫 `close_idle`만 반환하지 않았다. 마지막 Docker exit 45→1→0은 소스상 process 부재 확인·선택적 stderr 읽기·durable state 읽기에 해당한다. 이 값들을 인증 실패로 해석하지 않는다. pulse는 약 20.1초에 멎었으나 그 사실만으로 구체적인 event-loop 결함을 확정하지 않는다. 프로세스·컨테이너·private·always 정리는 모두 통과했다. 이 관측은 최종 수용을 대신하지 않으며 overlay를 끈 원래 8+5 검사가 필요하다.

후속 inspector helper `7393040`의 첫 실행 `40767981367`은 제품 checkout·Rust build·DB·컨테이너 실행 전에 offline fixture 검사에서 실패했다. 선택적 binary export 환경값이 mock pipeline에 상속되어 50개 중 5개에서 예상한 후속 stage가 만들어지지 않았다. 제품의 remote 실패로 합산하지 않으며, 미생성 fixture에 대한 always cleanup/export 실패도 실제 자원 정리 실패의 증거로 해석하지 않는다. 기본 fixture 환경을 명시적으로 격리하고 별도 diagnostic/export 경로는 inert 두 파일로 실제 export owner를 실행하도록 수정했다. 기본 환경과 동일한 job 입력 1/1에서 각각 53/53 검사가 통과했다. 13개 mock 결과가 모두 통과해도 진단 실행은 비성공·diagnostic-only로 유지하는 검사를 포함하며, 실제 제품 13개 통과 증거로 합산하지 않는다.

helper `0e2b7311aafbc45a33a04648ac3367e6aa86d5e2`의 [진단 실행 `40768558880`](https://github.com/benny1020/crewroom-platform/actions/runs/40768558880)은 local 8/8과 원격 준비를 통과했으나 첫 warm 종료에서 다시 host 1,200초 제한에 도달했다. 세 번째 실행은 약 18.9초에 반환했고 첫 `close_idle`은 약 19.1초에 진입해 반환하지 않았다. inspector는 `capture_unconfirmed`, `paused:false`, `resumeConfirmed:false`, `disconnectConfirmed:true`, frame 0으로 확인되지 않았다. CPU 반복·native 대기·500ms 관측 budget 중 원인을 이 결과만으로 확정하지 않는다. 최초/복구 프로세스·컨테이너·private 정리는 모두 통과했다.

선택적으로 보존한 공개 테스트 실행파일 두 개는 공식 artifact ZIP digest, manifest SHA, 제품/helper revision, toolchain, Cargo.lock, 원본/복사 SHA, Linux amd64 ELF 형식 및 MIT·제3자 고지를 확인한 뒤에만 로컬 재현에 사용했다. 재컴파일이나 모델 호출은 하지 않았다. Mac Node 24.14.0 controller·독립 Mac PostgreSQL·동일 Linux 실행파일을 사용한 제한 컨테이너에서 원본 warm 한 사례는 진단 overlay를 켰을 때 실제 1개 통과·50개 필터 제외로 정상 종료했다. 이어 overlay 없는 stock 한 사례는 90초 로컬 관측 제한으로 중단되어 완료 결과가 없었다. 같은 시점의 소유 Vitest worker CPU 100%는 관측했지만 구체적인 반복 위치를 증명하지 않는다. 두 실행 모두 전체 소유 프로세스/그룹·PG·컨테이너·임시 파일 정리를 통과했다. 따라서 Linux에만 발생하는 문제라고 단정하지 않으며, 이 로컬 비교를 원본 Linux 13개 qualification 통과로 세지 않는다.

공식 upstream `25f1070fbdabd96b26cdf199e624a77905f3ca37`의 canonical checkpoint bootstrap 수정은 조사 후보이며 적용하지 않았다. `820c458465fa40137c81fe510f3e6dc573b4f895`의 remote per-turn 복원과 `a2fbce9305c48f5242e6bafb19d049d29edc1d72`의 plugin task/directory 재사용도 채택하지 않았다. 기본 Claude `runner:auto`는 지원 호스트에서 ACPX Claude·per-turn으로 정규화되지만 환경 미설정 시 local이므로 두 수정의 원격/plugin 조건과 다르다. 새 실행 증거 없이 이 커밋들을 현재 정지의 원인이나 해결책으로 단정하지 않는다.

### R10 · P1 · 버퍼 메시지의 동기 전달과 연결 소유권 초기화 순서

Mac의 원본 stock warm 사례를 별도로 재현해 90초 관측 제한에 도달한 뒤 소유 프로세스를 정리했다. 정확한 Vitest worker의 native sample은 main thread의 Promise microtask 반복을 관측했다. 이어 같은 Node 24.14.0의 V8 profiler로 원본 warm 한 사례를 진단했다. 동일 worker의 두 isolate 로그를 개별 분석한 결과 `durable-prp-control-plane.ts`의 `drainPendingConnectionProcessing`이 가장 많은 JavaScript sample을 차지했다. 원문 profile·native sample·처리문은 비공개 자료이며 이 수치를 테스트 통과 수나 성능 보장으로 사용하지 않는다.

`WsJsonWireConnection.onJson`은 이미 받은 버퍼를 listener 등록 시 동기로 전달할 수 있다. 기존 `AuthorityConnection` constructor가 이 구독을 시작하면 `attachWireConnection`의 `connection` 대입 전에 processing Map이 `undefined` 키로 기록된다. 나중에 처리 완료 callback은 실제 connection 키를 조회하므로 해당 항목을 지우지 못하고, drain이 이미 완료한 Promise를 계속 기다리며 timer를 굶길 수 있다. 이미 닫힌 wire의 동기 close 전달도 삭제 후 stale connection 재등록을 만들 수 있었다.

수리는 객체 생성, 소유 Set 등록, wire listener 활성화의 순서로 한정했다. drain의 Map을 강제로 비우거나 반복문에 yield를 넣지 않았으며 기존 정지·인증·lease·checkpoint·처리 완료 검사를 유지한다. 실제 export와 동기 buffered wire를 사용한 독립 child 재현은 수정 전 5초 상한에서 중단됐고, 같은 재현이 수정 후 약 0.12초에 drain·retirement·정상 종료를 완료했다. 한 연결·두 연결의 buffered frame과 이미 닫힌 wire 세 회귀를 추가했다. held commit/rejection·auth revocation·ingress gate를 포함한 집중 8개, 해당 owner 파일 전체 171개(skip 0), runner 전체 타입 검사가 통과했다. 새 제품 SHA의 실제 warm 및 원본 Linux 8+5·기본/전체/이미지 수용은 후속 결과로 별도 기록한다.

## 공개 소스 점검 범위

원본 import commit의 tree는 기준 upstream tree `0433c5e7cebb9f2cfe20435a472bb72c49568cef`와 동일함을 별도 확인했다. 이는 source provenance 증거이며 자격증명이 없다는 증거는 아니다. Gitleaks 8.30.1의 redacted import scan 201개 finding을 원문 값 노출 없이 파일·행·문맥으로 분류했다.

| 분류 | 개수 |
|---|---:|
| source/snapshot SHA digest | 107 |
| Git revision | 6 |
| token/secret record의 UUID | 3 |
| idempotency/operation identifier | 18 |
| 일반 설명·setting·skill identifier | 4 |
| 일반 test fixture 또는 test identifier | 34 |
| PEM parsing/redaction/key test fixture | 21 |
| JWT redaction test fixture | 5 |
| 잘못된 인증을 보내는 negative-auth fixture | 2 |
| PEM header/footer 검증 정규식 | 1 |

이 finding 집합에서 추가 공개 차단이 필요한 운영 자격증명을 식별하지 못했다. 시험용 key 문자열이 있다는 사실은 숨기지 않으며 해당 자격증명의 실서비스 유효성을 네트워크로 시험하지 않았다. 전체 저장소의 무비밀 보장으로 해석하지 않는다. 새 Crewroom 변경의 staged scan은 import scan과 별도로 수행하고, 공개 보고서에는 raw scan·환경·인증 응답·snapshot을 넣지 않는다.

## 최종 사용자 흐름별 수용 판단

아래는 ‘기능 소스가 존재함’, ‘이 변경에서 검증함’, ‘실제 연결로 사용할 수 있음’을 구분한 판단이다. upstream이 이미 제공하는 기능을 새 미구현 목록으로 다시 분류하지 않는다.

| 사용자 흐름 | 현재 구현과 재사용 | 현재 수용 한계 |
|---|---|---|
| 팀원을 찾고 누구에게 요청할지 선택 | Crewroom 팀 명부·부서 표시·기본 비서, 기존 agent 상태·capability, 원본 캐릭터와 실제 run 기반 모션 | 집중 UI 회귀 및 최신 로컬 브라우저 캡처 확인. paused 표시와 장면 샘플을 실제 실행 증거로 해석하지 않음 |
| 비서에게 질문하거나 일을 요청 | 기존 Agent Chat·private issue·사용자 comment·normal wake, 명확 실행 요청과 질문을 구분하는 directive | 모델 미연결 상태에서는 응답·의도 판단·도구 실행 완료를 수용할 수 없음 |
| 대화에서 업무를 나누고 결과를 받기 | native/MCP/HTTP task creation, initial plan, source provenance, idempotency, 기존 assignment/wake와 chat completion delivery가 존재 | 신규 회귀는 생성·비공개·중복 방지 경계. 실제 모델을 통한 생성→실행→산출물→원 대화 결과 회신은 별도 E2E 증거 필요 |
| 업무별 의견·수정·재요청 | 기존 task comment·queued steering·interrupt·reopen·workspace 복구와 문서 revision을 재사용. Crewroom 업무 링크로 진입 | R4 서버/API/MCP 및 기본·classic UI 회귀 통과. 실제 기본 UI의 same-task 의견 저장·재개 상태 전이 확인. 실제 agent 재수정 산출물은 미검증 |
| 여러 사용자가 권한 안에서 협업 | authenticated mode·membership·grant·private task ACL은 core 기능. Crewroom은 개인 대화 creation/admission과 capability projection을 보강 | 13e image CI에서 admin/viewer의 실제 로그인과 private 대화·첨부 ACL 확인. 검색·work products·전체 run log/event stream 등 모든 데이터 경로의 증거로 확대하지 않음 |
| EC2에서 지속 운영하고 복구 | production Docker target, 앱/DB 지속 볼륨, 최초 인증, quiesced DB+파일 snapshot 및 새 프로젝트 restore 도구 구현 | 13e CI Docker 환경의 인증·private ACL·재시작·DB/파일/환경 snapshot·새 프로젝트 복원 통과. 실제 EC2·도메인·TLS 운영은 미검증 |
| 재사용 스킬로 업무 시작 | 기존 skill catalog/version/assignment를 사용하고 Crewroom 요청에 선택한 skill/version을 기록 | 이번 UI 선택이 실제 실행 시 immutable snapshot으로 적용됐다는 증거는 아직 없음 |

별도 설계 목표 중 **추가 구현이 필요한 것**은 사용자별 독립 비서 identity/home/memory binding, Crewroom 부서 ACL, source revision 철회에 따른 누적 context 폐기, exact proposal 승인에 묶인 GitLab publisher다. 기존 core의 task/workspace lease·session·approval·versioned skill 기능이 없다는 뜻이 아니다. 현재 배포의 local CLI가 앱과 같은 컨테이너에서 실행되므로 신뢰할 수 없는 작업의 OS/process/credential 격리는 이 배포만으로 제공하지 않는다. 모델 endpoint·GitLab·EC2의 실제 자격증명과 운영 대상이 없는 항목은 **실연결 미검증**이며, 단순 UI 완료로 그 증거를 대신하지 않는다.
