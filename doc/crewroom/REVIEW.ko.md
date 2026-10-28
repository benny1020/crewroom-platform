# Crewroom 첫 구현 리뷰

2026-10-28 · Astra 설계·코드 리뷰 · Sol 제품 구현

**판정: Paperclip 기반 제품의 첫 단면이며, 전체 Crewroom 요구의 완료나 운영 배포 승인은 아니다.** 이 문서는 현재 소스에서 확인한 구현, 회귀 수정 요청, 실제 검증의 한계를 분리한다. 구현과 테스트가 진행 중이므로 아래 미해결 항목은 후속 증거로만 완료 처리한다.

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

업무별 의견·재요청은 기존 issue comment와 완료 업무의 `reopen` 흐름을 재사용한다. task/result를 확인하고 같은 업무의 산출물 revision을 이어간다. 단순 감사·평가를 재실행 요청으로 해석하지 않는다. 원 대화의 완료 알림은 새 작업의 허가가 아니다. UI의 ‘고마워’와 명시적 수정 요청을 구별하는 component 회귀는 통과했지만, 아래 R4 때문에 이 시점의 end-to-end 의견 저장은 아직 수용하지 않는다. 이 directive는 사용자 의도를 모델에 안내하는 정책이며 한국어 의도 인식의 실제 품질을 입증한 결과가 아니다.

### R4 · P1 · 의견만 저장하는 선택과 서버의 암묵적 재실행

active composer의 체크박스를 끈 채 `reopen`을 생략해도 서버 `shouldImplicitlyMoveCommentedIssueToTodo`가 human+closed+agent 조건으로 업무를 다시 연다. POST comment와 PATCH comment 경로에 모두 존재하며 기존 route 테스트도 이를 명시한다. 따라서 UI mock에서 `reopen:undefined`를 확인하는 것만으로 ‘의견만 저장’ 동작을 증명할 수 없다.

좁은 수정 계약은 명시적인 `reopen:false`가 암묵적 재실행보다 우선하도록 하고, 필드가 없는 기존 client 동작은 유지하는 것이다. UI·API client·PATCH/POST 두 경로를 동기화한다. 완료·취소 업무에 의견을 남겼을 때 comment는 저장되고 status와 wake는 변하지 않아야 하며, 실행 의도가 없는 의견 저장 때문에 닫힌 workspace를 복구하지 않아야 한다. 체크한 수정 요청은 기존 권한·pause·workspace 복구 gate를 따른다. 현재 상태: **수정 요청 및 실제 route 회귀 검증 대기**. 아래 기존 248/128 통과 수는 R4 서버 수정 전 증거다.

private source 보호는 기존 `issueService.create`의 run provenance 상속으로 확인했다. native/HTTP task 생성에 visibility 필드가 없다는 사실만으로 공개 유출이라고 판단해서는 안 된다. source run으로 찾은 issue가 private이면 top-level task여도 private root와 access edge를 상속한다. public project 선택과 structural parent 제거는 이 보호를 해제하지 않는다. 신규 회귀는 실제 PostgreSQL에서 두 생성 경로의 owner/source/privacy 유지, 비허용 사용자 읽기 거부, 재시도 중복 방지를 검증한다. 모델 호출·실제 dispatch·전체 private 데이터 경로 수용과는 별도 증거다.

## 개인 대화 보호: 현재 확인과 추가 증거

새 conversation은 인증 사용자로 `createdByUserId`, `responsibleUserId`, `conversationUserId`를 구성하고 `visibility:private`를 전달한다. 클라이언트가 책임자를 임의 지정하지 않는다. service는 기존 personal project, privacy root, assignment grant를 사용한다. conversation identity 잠금 후 기존 공개 대화가 발견되면 private 생성 요청을 `409 chat_conversation_privacy_required`로 거부한다.

과거 공개 conversation은 개인 목록에서 제외하고 ensure/send/upload를 차단한다. 일반 historical issue는 남으며 명시적 privacy 변경을 지원한다. 이미 공개된 과거 정보의 노출을 소급해 취소한 것은 아니다. 개인 대화와 공용 specialist의 home/memory 격리는 다른 요구다. 이 단계는 일반 task ACL을 적용하는 첫 수정이며 다중 사용자 전체 데이터 경로를 검증했다는 뜻은 아니다.

추가 운영 수용 증거는 서로 다른 실제 사용자 세션에서 issue detail, 검색, attachment content, work products, run log와 event stream의 비허용 접근 차단을 포함해야 한다. 관리자 break-glass의 기존 정책과 감사 기록을 숨기지 않는다.

## EC2 한 대와 Docker PostgreSQL

배포 계약은 [아키텍처 11절](ARCHITECTURE.ko.md#11-ec2-한-대--docker-postgresql-배포-계약)을 따른다. app와 PostgreSQL을 별도 container/volume로 운영하며 PostgreSQL host port는 공개하지 않는다. upstream Dockerfile의 `production` target, authenticated mode, 명시적 URL/host 정책, health, restart, 90초 stop grace, 지속 저장과 복구 절차가 필요하다. 선택적 Caddy TLS 또는 검증된 외부 TLS termination을 사용한다.

현 upstream local CLI adapter는 app container 내부 실행이다. 별도 DB container는 job별 filesystem/process/credential 격리의 증거가 아니다. 분리 runner service를 Compose에 선언하기만 해서는 실제 execution transport가 연결되지 않는다. Docker socket이나 privileged mode로 우회하지 않는다.

현재 상태: **배포 파일 구현, local Docker build 메모리 실패; 별도 CI 검증 대기**. Rust runner와 UI 빌드 뒤 server `tsc` 단계가 exit `137`과 `ResourceExhausted: cannot allocate memory`로 종료됐다. 해당 실행은 Docker VM 8 GiB, Node heap 상한 3072 MiB였다. heap 2048 MiB로 제한한 한 번의 재시도도 같은 단계에서 137로 종료돼 로컬 반복을 멈췄다. 완성된 production image의 health/auth/persistence 검증으로 이어지지 못했다. typecheck를 생략하지 않고 별도 GitHub production-image workflow에 build와 authenticated privacy/restart/snapshot/restore 검증을 연결했으며 실제 결과는 아직 없다. EC2 계정, 실제 domain/TLS, live provider/GitLab 계정이 없는 상태에서 EC2 배포나 실제 업무 실행 성공을 주장하지 않는다.

## 검증 기록과 남은 완료 조건

| 증거 | 현재 확인 수준 |
|---|---|
| frozen install | foundation 기록에 36 workspaces 설치 성공. 이 리뷰에서 재실행하지 않음 |
| Backend focused suites | 7 files, 248/248, exit 0, worker 1, 35.41초. 대화 43개·capability 6개 포함. native/HTTP private handoff 2개는 disposable PostgreSQL에서 owner/source/privacy와 비허용 읽기·중복 방지 검증. 전체 묶음은 DB와 mocks 혼합 |
| Claude probe fixture | foundation 기록에 27/27. 실제 custom endpoint inference 증거가 아님 |
| isolated source startup | foundation 기록에 loopback 3117 API/UI health 및 새 PostgreSQL 55447. public deploy나 authenticated 다중 사용자 증거가 아님 |
| UI focused suites | 7 files, 128/128, worker 1. IssueChatThread 101개와 Crewroom·navigation·breadcrumb 회귀. token/module 검사 통과. 실제 모델·브라우저 E2E와 별도 |
| 전체 typecheck/build/test | 최종 후속 변경 전 `pnpm -r typecheck` exit 0 기록. 이전 build는 ui/server/cli 완료 로그가 있으나 전체 종료 receipt 없음. 전체 test:run은 중단돼 최종 결과 없음. 최종 revision 전체 검사/CI는 대기 |
| 신규 capability 및 R1–R3 회귀 | 위 focused 결과로 해당 수정 확인. live event 및 다중 로그인 전체 경로는 별도 |
| 현재 UI visual review | `media/team-1440.png`, `media/workroom.png`, `media/mimi-scenes-preview.png` 1차 캡처를 확인. 원본 캐릭터·대화 CTA·실제 paused 상태·명시적 scene preview를 확인. 최종 반응형/권한/오류 상태 시각 리뷰는 별도 |
| Docker build/auth/restart/data persistence | build의 server tsc에서 exit 137/메모리 할당 실패. image 완료·auth/restart/persistence 검증 전 |
| 실제 model/tool/resume/stop, GitLab, EC2 | 미검증 |

이전 실패도 유지한다. 잘못된 cwd의 최초 Vitest 호출은 tests를 찾지 못했다. 처음 privacy 회귀 assertion은 기존 403과 404 계약을 혼동했고 수정됐다. 초기 optional Copilot materialization은 실패 후 공식 installer로 회복됐지만 중단 원인은 확정되지 않았다. 최종 통과 일부만으로 이 이력을 지우지 않는다.

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
| 팀원을 찾고 누구에게 요청할지 선택 | Crewroom 팀 명부·부서 표시·기본 비서, 기존 agent 상태·capability, 원본 캐릭터와 실제 run 기반 모션 | 좁은 UI 회귀 통과. 최신 브라우저 화면 검토 대기 |
| 비서에게 질문하거나 일을 요청 | 기존 Agent Chat·private issue·사용자 comment·normal wake, 명확 실행 요청과 질문을 구분하는 directive | 모델 미연결 상태에서는 응답·의도 판단·도구 실행 완료를 수용할 수 없음 |
| 대화에서 업무를 나누고 결과를 받기 | native/MCP/HTTP task creation, initial plan, source provenance, idempotency, 기존 assignment/wake와 chat completion delivery가 존재 | 신규 회귀는 생성·비공개·중복 방지 경계. 실제 모델을 통한 생성→실행→산출물→원 대화 결과 회신은 별도 E2E 증거 필요 |
| 업무별 의견·수정·재요청 | 기존 task comment·queued steering·interrupt·reopen·workspace 복구와 문서 revision을 재사용. Crewroom 업무 링크로 진입 | 의견만 저장 UI는 component 회귀 통과했지만 서버 암묵적 reopen과 충돌하는 R4 해결 전 수용 불가. 실제 agent 재수정 결과도 미검증 |
| 여러 사용자가 권한 안에서 협업 | authenticated mode·membership·grant·private task ACL은 core 기능. Crewroom은 개인 대화 creation/admission과 capability projection을 보강 | disposable DB 검증과 실제 서로 다른 로그인 세션의 전체 데이터 경로 검증은 구별 |
| EC2에서 지속 운영하고 복구 | production Docker target, 앱/DB 지속 볼륨, 최초 인증, quiesced DB+파일 snapshot 및 새 프로젝트 restore 도구 구현 | Docker build/기동/인증/재시작/복원 결과와 실제 EC2·TLS 운영 증거 대기 |
| 재사용 스킬로 업무 시작 | 기존 skill catalog/version/assignment를 사용하고 Crewroom 요청에 선택한 skill/version을 기록 | 이번 UI 선택이 실제 실행 시 immutable snapshot으로 적용됐다는 증거는 아직 없음 |

별도 설계 목표 중 **추가 구현이 필요한 것**은 사용자별 독립 비서 identity/home/memory binding, Crewroom 부서 ACL, source revision 철회에 따른 누적 context 폐기, exact proposal 승인에 묶인 GitLab publisher다. 기존 core의 task/workspace lease·session·approval·versioned skill 기능이 없다는 뜻이 아니다. 현재 배포의 local CLI가 앱과 같은 컨테이너에서 실행되므로 신뢰할 수 없는 작업의 OS/process/credential 격리는 이 배포만으로 제공하지 않는다. 모델 endpoint·GitLab·EC2의 실제 자격증명과 운영 대상이 없는 항목은 **실연결 미검증**이며, 단순 UI 완료로 그 증거를 대신하지 않는다.
