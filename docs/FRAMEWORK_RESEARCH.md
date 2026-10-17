# 크루룸 — 에이전트 실행기와 하네스 선정 재검토

조사일: 2026-10-16. 범위: 공식 문서, 공개 저장소 메타데이터, 주요 소스 일부. 같은 과제를 실행한 성능·복구 비교 실험은 수행하지 않았다. 현재 제품은 에이전트 프레임워크 의존성이 없는 Vite/JavaScript 웹 목업이다. 로컬 구현 범위는 [반영 내역](IMPLEMENTATION.md)에 있다.

**후속 코드 조사로 우선순위를 수정했다.** 11개 프로젝트·13개 저장소의 고정 커밋에서 조직·업무·실행·기억·스킬 경로를 비교한 현재 판단은 [공개 코드 상세 조사](OPEN_SOURCE_CODE_RESEARCH.md)를 기준으로 한다. 확보한 자료 122개 중 60개 파일의 선택 범위를 근거로 사용했다. 아래의 문서 중심 비교는 후보 범위를 설명하는 자료로 유지한다.

## 결론과 결정 상태

이전의 “LangGraph를 추천 시작점으로 한다”는 결론은 비교 범위에 비해 강했다. LangGraph의 적합한 기능을 확인한 것과, 다른 후보보다 이 제품에 적합하다고 입증한 것은 다르다. **기존의 기본 채택 추천을 철회하고 실행기 선정은 미확정으로 바꾼다.**

이번 비교에 따른 우선순위는 다음과 같다. 이는 문서와 소스에 근거한 제품 적합성 판단이며 실행 검증 결과가 아니다.

1. **제품 기반: Paperclip의 조직·업무·실행 관리 재사용을 우선 검증.** Agent/Task/Run과 native session을 구분하고, 업무 점유·실행 기록·스킬 버전·어댑터가 이미 코드에 있다. 부서·개인 비서의 권한을 검증하고 크루룸의 UI와 확장 객체를 연결한다. 전체 포크나 프로덕션 채택을 확정한 상태는 아니다.
2. **비서 하네스: 기존 Paperclip–Hermes 연결을 격리 환경에서 먼저 검증하고 Letta Code를 비교한다.** Hermes 어댑터에는 승인 프롬프트를 우회하는 `--yolo`와 기본 홈 공유 가능성이 있어, 에이전트별 홈·실행 환경·도구 권한 분리가 채택 조건이다. Letta는 기억 파일의 범위와 백그라운드 변경 통합을 참고하며, Cloud와 local 기능을 동일하게 간주하지 않는다.
3. **남은 실행 요구: 직접 실행기를 작성할 때 Mastra, 복잡한 단계 제어가 필요할 때 LangGraph를 검증한다.** 새 팀 웹 서비스라는 이유로 Mastra를 먼저 선택하던 추천을 이 순서로 바꾼다. 두 실행기를 기본으로 중첩하지 않는다.

**LangChain 전체 도입은 필수 조건이 아니다.** LangGraph 자체도 LangChain 없이 사용할 수 있다고 공식 문서에 명시한다. 반대로 Deep Agents를 선택하면 LangChain 구성 요소와 LangGraph 위의 하네스를 선택하는 것이므로 “LangChain을 안 쓴다”는 목표만으로 유리하다고 볼 수 없다. [LangGraph 공식 설명](https://docs.langchain.com/oss/python/langgraph/overview), [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview)

## 요구사항을 기준으로 비교한 이유

크루룸의 핵심은 “여러 역할의 LLM을 한 번 호출”하는 데서 끝나지 않는다.

- 공용 동료와 개인 비서가 안정적인 ID·기억·설정을 유지한다.
- 에이전트마다 스킬과 실행 방식을 관리한다.
- 대화가 계속되는 동안 작업을 수행하고 입력·판단을 기다린다.
- 작업자를 재시작해도 상태를 회복하고 외부 동작을 중복 실행하지 않는다.
- 팀·부서·개인 범위의 기억과 대화를 구분한다.
- 웹에서 진행 상황을 관찰하고 중단·재개·추가 지시를 할 수 있다.

부서 구분과 캐릭터는 제품의 정보 구조다. 그것만으로 특정 멀티 에이전트 프레임워크를 선택할 근거가 되지는 않는다.

## 같은 층의 도구로 오해하지 않기

| 층 | 책임 | 후보 예시 |
| --- | --- | --- |
| 제품 제어 영역 | 사용자·부서·에이전트 ID, 공유 대화, 접근 권한, 작업·스킬 버전 | Paperclip 재사용 PoC + 크루룸의 서비스와 확장 DB |
| 작업 실행기 | 순서·분기·대기·체크포인트·복구 | LangGraph, Mastra Workflows, Temporal |
| 에이전트 하네스 | 모델·도구 반복 호출, 작업 환경, 권한 요청, 컨텍스트 관리 | Letta, Deep Agents, OpenAI Agents SDK, 외부 코딩 하네스 |
| 장기 기억 | 원문·기억 항목·공유 범위·출처·정정·삭제 | 제품의 Memory Service와 각 후보의 기억 기능 |
| 웹 연결 | 스트리밍, 진행 이벤트, 대화 UI 연결 | 제품 API, Mastra, AI SDK |

이 표는 개념적인 역할 구분이다. 한 제품이 여러 층을 제공할 수 있다. Temporal과 기억 저장소, LangGraph와 개인 비서 플랫폼을 단순한 대체재로 비교하지 않는다.

## 후보 비교

| 후보 | 공식 자료에서 확인한 것 | 크루룸에서의 판단·남은 조건 |
| --- | --- | --- |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) | 낮은 수준의 상태 기반 실행기. 결정적인 단계와 모델 판단을 섞을 수 있다. [체크포인터와 store](https://docs.langchain.com/oss/python/langgraph/persistence)를 구분한다. | 단계 제어가 핵심일 때 강한 후보. “영속적인 팀 동료” 제품 전체를 제공하는 것은 아니므로 직접 만들 부분이 많다. |
| [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) | 파일 작업, 컨텍스트 관리, 기억, 스킬, 하위 에이전트와 사람 개입을 갖춘 하네스. LangGraph 실행기를 사용한다. | LangGraph로 하네스를 처음부터 만들기 전에 비교할 후보. 영속 저장 backend와 제품 권한은 따로 구성해야 한다. |
| [Paperclip](https://github.com/paperclipai/paperclip) | 고정 커밋에서 조직·Agent·Task·Run, 원자적인 업무 점유, native session 매핑, 스킬 버전·적용 상태와 하네스 어댑터를 확인했다. | 현재 제품 기반의 첫 PoC. 부서와 개인 비서 권한·격리 및 미필터 API 우회 가능성을 검증해야 한다. [코드 근거](OPEN_SOURCE_CODE_RESEARCH.md). |
| [Mastra](https://mastra.ai/docs/harness/overview) | 목표·일정·신호·백그라운드 작업과 장기 실행 기능. [Memory](https://mastra.ai/docs/memory/overview)는 resource/thread를 구분하며 공유와 격리 방식을 설명한다. [외부 SDK 연결](https://mastra.ai/docs/connections/sdk-agents)도 제공한다. | 직접 실행 서버를 작성해야 할 때의 후보. durable agent는 베타이고, 외부 SDK 연결이 그 SDK의 기억·권한 의미까지 자동 통합한다는 뜻은 아니다. |
| [Letta 현재 App Server](https://docs.letta.com/self-hosting) | 자체 호스팅한 서버에 에이전트 상태와 실행 환경을 두고 여러 클라이언트에서 연결한다. 개별 MemFS와 스킬을 유지한다. | “서버에 비서 한 명씩”에 가까운 재사용 후보. 팀 권한과 동시 접근, 사용자별 실행 격리의 자체 호스팅 동작을 검증해야 한다. |
| [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk) | 애플리케이션 안에서 에이전트 루프·도구·인계를 실행한다. 배포·저장소·승인과 제품 통합은 애플리케이션이 소유한다. | 가벼운 실행 어댑터 후보. SDK를 사용한다고 장기 업무 스케줄러나 팀 기억 정책이 완성되는 것은 아니다. OpenAI 공식 문서 기준으로 확인했다. |
| [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) | OpenAI가 Codex 하네스, 세션, 컨텍스트 압축과 복구를 관리하는 서비스다. | 서버 운영 일부를 위임하는 대안. 자체 호스팅 라이브러리와 다른 배포 선택이며 공급자·상태 소유 범위를 먼저 정해야 한다. |
| [Pydantic AI](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/) | 영속 실행 엔진과 결합할 수 있다. 실행 복구와 대화 저장은 다른 문제라고 문서가 구분한다. | Python 코드와 타입 중심 설계가 맞을 때 후보. 실행 엔진 한 개와 장기 기억 정책을 명시적으로 선택해야 한다. |
| [Vercel AI SDK](https://ai-sdk.dev/docs/agents/overview) | ToolLoopAgent와 웹 스트리밍 연결을 제공한다. [HarnessAgent](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview)는 기존 하네스를 별도 추상화로 연결하지만 관련 패키지는 실험 단계다. | UI 스트리밍과 모델·하네스 연결에 유용한 후보. 이 계층만으로 업무 복구나 팀 권한이 완성된다고 보지 않는다. |
| [CrewAI Flows](https://docs.crewai.com/en/concepts/flows) | 역할 중심 agent/crew 외에 상태 저장과 재개를 위한 Flow persistence가 있다. 기본 저장 구현과 사용자 정의 구현을 설명한다. | “역할별”이라는 표면적 유사성만으로 채택하지 않는다. 지속적인 대화·다중 사용자 상태의 소유 관계를 별도로 검증할 후보. |
| [Temporal](https://docs.temporal.io/ai) | 장기 작업, 장애 후 재개, 사람의 입력 대기, worker/task queue를 제공한다. | 작업 복구가 큰 운영 요구가 될 때 유력하다. 기억·대화 UI·에이전트 하네스를 대체하지 않으며 첫 목업부터 다른 실행기와 중복 도입할 이유는 없다. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 에이전트 기억, 스킬 학습, 세션 검색, 일정과 메시징 gateway를 제공한다. | 개인 비서의 운영·스킬 구조를 참고하거나 실행 어댑터로 검증할 후보. 팀용 격리와 공유 권한을 제공한다고 가정하지 않는다. |
| [OpenClaw](https://github.com/openclaw/openclaw) | 개인 에이전트·채널·기억 운영 구조를 제공한다. [보안 정책](https://github.com/openclaw/openclaw/blob/main/SECURITY.md)은 신뢰된 운영자용 모델을 명시한다. | 개인 에이전트 운영 참고로 유용하다. 한 gateway의 세션 구분을 사용자 간 보안 경계로 취급하지 않는다고 명시하므로 팀 권한 시스템의 대체재로 채택하지 않는다. |

## 실제로 판단을 바꾼 세부 사항

### Mastra의 “durable”에는 설정 조건이 있다

[공식 durable agents 문서](https://mastra.ai/docs/harness/durable-agents)는 베타 상태를 명시한다. 기본 이벤트 캐시는 프로세스 메모리에 있고, 프로덕션 재접속에는 영속 캐시 등이 필요하다. 실행 중 체크포인트와 서버 시작 시 자동 복구도 설정에 따라 달라진다.

관련 소스도 확인했다. [`create-durable-agent.ts`](https://github.com/mastra-ai/mastra/blob/0a4037f30fd0d712a6de4c167c6420fc2822a6a5/packages/core/src/agent/durable/create-durable-agent.ts)는 기본 실행 중 스냅샷 저장과 복구 설정의 관계를 설명한다. [`run-recovery.md`](https://github.com/mastra-ai/mastra/blob/0a4037f30fd0d712a6de4c167c6420fc2822a6a5/packages/core/src/agent/durable/run-recovery.md)와 [`execution-fence.ts`](https://github.com/mastra-ai/mastra/blob/0a4037f30fd0d712a6de4c167c6420fc2822a6a5/packages/core/src/agent/durable/execution-fence.ts)에서는 소유권·실행 세대·이전 작업자의 쓰기 차단을 확인했다. 기능 이름만 보고 장애 복구가 기본 설정에서 완성된다고 판단하면 안 된다.

Mastra 저장소의 [라이선스 파일](https://github.com/mastra-ai/mastra/blob/0a4037f30fd0d712a6de4c167c6420fc2822a6a5/LICENSE.md)은 일반 소스와 enterprise/별도 라이선스 영역을 구분한다. 저장소 전체에 단일 라이선스가 적용된다고 기재하지 않았다.

### Letta는 과거 V1 예제로만 평가하면 안 된다

현재 [자체 호스팅](https://docs.letta.com/self-hosting)은 App Server와 현재 Agent SDK를 안내한다. [공유 기억](https://docs.letta.com/concepts/shared-memory)은 Cloud에서 조직 소유 Git 저장소를 여러 에이전트에 연결하며, 옛 shared block 방식과 구분한다. 공유 저장소에서 스킬을 제공할 수도 있다.

[조직 권한 문서](https://docs.letta.com/teams/permissions)는 비공개 에이전트와 조직 공유, 역할에 따른 가시성을 설명한다. 다만 이 문서의 Cloud 조직 기능을 자체 호스팅 토큰 기반 App Server에서도 동일하게 제공한다고 추정하지 않는다. 이 구분이 팀 제품 채택의 주요 검증 사항이다.

### 하네스 교체와 기억 이식은 다른 기능이다

외부 SDK의 출력 스트림을 공통 형태로 만드는 것과, 해당 SDK의 세션·도구 권한·파일 상태·기억을 다른 하네스로 옮기는 것은 다르다. 크루룸의 agent_id와 출처 있는 기억은 제품에 두고, 각 하네스의 네이티브 세션 ID와 실행 환경은 별도로 매핑하는 설계가 필요하다.

“하네스별로 같은 도구 이름이 있으니 동일하게 재개할 수 있다”는 가정은 하지 않는다. 하네스를 바꿀 때는 새 실행을 만들고 필요한 업무 맥락을 전달한다. 진행 중인 네이티브 실행을 통째로 이식하는 기능은 별도 요구사항이다.

## 제품 구조에서 지금 정할 것

실행기보다 먼저 다음 계약을 제품 소유로 고정한다.

```text
Agent = 안정적인 ID + 공개 범위 + 캐릭터 + 역할 + skill bindings + harness config
Conversation = 참여자/공유 범위 + 원문 메시지 + 출처
Task = 업무 목표 + 상태 + 담당 + 실행 ID + 대기 이유 + 결과
Memory = 저장 범위 + 내용/버전 + 출처 + 유효 상태 + 정정/삭제 기록
Run = harness adapter + native session + 실행 환경 + 재개 상태 + 이벤트 순번
```

실행 어댑터의 공통 기능은 `start`, `sendInput`, `streamEvents`, `pause`, `resume`, `cancel`, `getStatus`로 잡는다. 구현체별 지원 여부를 capability로 노출한다. 지원하지 않는 pause/resume을 성공한 것처럼 흉내 내지 않는다.

이 계약에 따라 LangGraph·Mastra·Letta를 바꿔도 부서와 사용자, 기억과 스킬 버전, 감사 가능한 작업 기록이 특정 엔진 내부 ID에 종속되지 않게 한다. 이는 설계 제안이며 현재 목업에 서버 어댑터를 구현한 상태는 아니다.

## 채택 전에 같은 시나리오로 확인할 항목

1. 개인 비서 A와 B를 만들고 A만의 고유 기억이 B·공용 동료의 검색과 인용에 나타나지 않는지 확인한다.
2. 공용 개발 → QA 인계 도중 사람의 입력을 기다리고, 앱 서버와 작업자를 재시작한 뒤 같은 업무를 이어간다.
3. 도구가 결과를 외부에 기록한 직후 작업자를 강제 종료한다. 복구 때 같은 동작을 중복 수행하지 않는지 고유 동작 ID로 확인한다.
4. 같은 에이전트에 두 팀원이 동시에 입력한다. 입력 유실·순서·이전 작업자의 지연된 쓰기를 확인한다.
5. 두 웹 클라이언트가 동일한 실행을 관찰한다. 재접속 후 누락·중복 이벤트와 최종 상태를 확인한다.
6. 기억을 정정·삭제한 다음 요약과 색인을 다시 만들고, 오래된 내용의 재등장 여부를 확인한다.
7. 스킬 버전을 실행 중 변경해도 기존 실행은 원래 버전을 사용하고 새 실행은 새 버전을 사용하는지 확인한다.
8. 하네스를 바꿔 새 실행을 시작해도 agent_id·공개 범위·기억 출처가 유지되는지 확인한다.

합격 기준은 각 항목의 출력·DB 상태·도구 호출 기록으로 판단한다. 후보의 문서상 기능과 이 실험의 통과 여부를 같은 “검증 완료”로 표시하지 않는다. **이번 턴에서는 이 비교 실험을 실행하지 않았다.**

## 조사 증거와 제한

- 8개 공개 저장소의 기본 브랜치·커밋 SHA·파일 트리를 조회했다. 그중 주요 구현과 설계 파일 일부를 읽었다. 전체 소스 감사를 수행한 것은 아니다.
- [조사 시점 저장소·소스 기록](research/2026-10-16-framework-sources.json)에 경로, 고정 커밋, 읽은 코드의 위치와 실패한 조회를 남겼다.
- 초기 Mastra `LICENSE` 경로 조회는 실패했고, 트리에서 실제 `LICENSE.md`를 확인해 다시 읽었다. GitHub API의 `NOASSERTION`을 실제 라이선스 결론으로 사용하지 않았다.
- OpenAI는 official OpenAI documentation에서 SDK와 관리형 Agents API의 책임 범위를 별도로 확인했다.
- 이 문서의 초기 조사 단계에서는 패키지 설치, 계정 연결, 실제 모델 호출, 새로운 서버 구현·배포를 하지 않았다.
- 당시 단일 HTML 목업을 이후 Vite/JavaScript 웹 앱으로 분리하고 GitHub Pages에 정적 배포했다. 현재 의존성·모듈·저장·검증 구조는 [기술스택·아키텍처](ARCHITECTURE.md)를 기준으로 한다. LangChain/LangGraph와 실제 에이전트 서버는 연결하지 않았다.
