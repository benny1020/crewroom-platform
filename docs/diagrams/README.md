# 아키텍처 그림 모음

README와 구조 문서에는 미리 렌더링한 PNG를 표시한다. 그림을 누르면 확대 가능한 SVG를 연다. [읽는 순서·조사 근거·디자인 규칙](DESIGN_NOTES.md)에서 핵심 도식 9종을 먼저 볼 수 있다. 아래 도표는 실행 중인 0.7 구조와 이전 설계 기록을 해당 문서의 범위에 따라 구분한다.

| 그림                                                                           | 설명 문서                                                                | 확대                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------- |
| [만드는 이유](team-agents.png)                                                 | [README.md](../../README.md)                                             | [SVG](team-agents.svg)                   |
| [함께 일하는 흐름](task-lifecycle.png)                                         | [README.md](../../README.md)                                             | [SVG](task-lifecycle.svg)                |
| [구현 구조](platform-architecture.png)                                         | [README.md](../../README.md)                                             | [SVG](platform-architecture.svg)         |
| [기억·스킬·권한](agent-context.png)                                            | [README.md](../../README.md)                                             | [SVG](agent-context.svg)                 |
| [2. 현재 실행 구조와 소스 지도](architecture-1.png)                            | [docs/ARCHITECTURE.md](../ARCHITECTURE.md)                               | [SVG](architecture-1.svg)                |
| [3. 현재 데이터 모델](architecture-2.png)                                      | [docs/ARCHITECTURE.md](../ARCHITECTURE.md)                               | [SVG](architecture-2.svg)                |
| [입력과 렌더링](architecture-3.png)                                            | [docs/ARCHITECTURE.md](../ARCHITECTURE.md)                               | [SVG](architecture-3.svg)                |
| [일반 업무의 한 번의 흐름](architecture-4.png)                                 | [docs/ARCHITECTURE.md](../ARCHITECTURE.md)                               | [SVG](architecture-4.svg)                |
| [검사와 공개 배포](architecture-5.png)                                         | [docs/ARCHITECTURE.md](../ARCHITECTURE.md)                               | [SVG](architecture-5.svg)                |
| [11. 다음 단계의 서버 아키텍처 — 설계안](architecture-6.png)                   | [docs/ARCHITECTURE.md](../ARCHITECTURE.md)                               | [SVG](architecture-6.svg)                |
| [1. 업무 대상을 넣으면 기존 업무와 담당을 안내한다](astra-product-ideas-1.png) | [docs/ASTRA_PRODUCT_IDEAS.md](../ASTRA_PRODUCT_IDEAS.md)                 | [SVG](astra-product-ideas-1.svg)         |
| [1. 첫 업무의 인계 관계를 명시한다](astra-review-1.png)                        | [docs/ASTRA_REVIEW.md](../ASTRA_REVIEW.md)                               | [SVG](astra-review-1.svg)                |
| [전체 구조](execution-architecture.png)                                        | [docs/CODE_EXECUTION.md](../CODE_EXECUTION.md)                           | [SVG](execution-architecture.svg)        |
| [실제 업무 흐름](development-qa-sequence.png)                                  | [docs/CODE_EXECUTION.md](../CODE_EXECUTION.md)                           | [SVG](development-qa-sequence.svg)       |
| [검사 결과를 믿는 기준](verification-gates.png)                                | [docs/CODE_EXECUTION.md](../CODE_EXECUTION.md)                           | [SVG](verification-gates.svg)            |
| [커스텀 모델·저장소 연결](custom-endpoints.png)                                | [docs/CONFIGURATION.md](../CONFIGURATION.md)                             | [SVG](custom-endpoints.svg)              |
| [첫 배포의 기본 구성](deployment-1.png)                                        | [docs/DEPLOYMENT.md](../DEPLOYMENT.md)                                   | [SVG](deployment-1.svg)                  |
| [사용자 여정과 화면](design-implementation-1.png)                              | [docs/DESIGN_IMPLEMENTATION.md](../DESIGN_IMPLEMENTATION.md)             | [SVG](design-implementation-1.svg)       |
| [데이터와 기준 저장소](design-implementation-2.png)                            | [docs/DESIGN_IMPLEMENTATION.md](../DESIGN_IMPLEMENTATION.md)             | [SVG](design-implementation-2.svg)       |
| [상태 소유와 전이](design-implementation-3.png)                                | [docs/DESIGN_IMPLEMENTATION.md](../DESIGN_IMPLEMENTATION.md)             | [SVG](design-implementation-3.svg)       |
| [Run 격리와 기억](design-implementation-4.png)                                 | [docs/DESIGN_IMPLEMENTATION.md](../DESIGN_IMPLEMENTATION.md)             | [SVG](design-implementation-4.svg)       |
| [서버 배포와 복구의 확정 계약](design-implementation-5.png)                    | [docs/DESIGN_IMPLEMENTATION.md](../DESIGN_IMPLEMENTATION.md)             | [SVG](design-implementation-5.svg)       |
| [9. 크루룸에 제안하는 실제 구조](open-source-code-research-1.png)              | [docs/OPEN_SOURCE_CODE_RESEARCH.md](../OPEN_SOURCE_CODE_RESEARCH.md)     | [SVG](open-source-code-research-1.svg)   |
| [설정과 확인 순서](pilot-workflow.png)                                         | [docs/PILOT_GUIDE.md](../PILOT_GUIDE.md)                                 | [SVG](pilot-workflow.svg)                |
| [구성과 데이터 소유권](server-components.png)                                  | [docs/SERVER_ARCHITECTURE.md](../SERVER_ARCHITECTURE.md)                 | [SVG](server-components.svg)             |
| [구성과 데이터 소유권](server-data-model.png)                                  | [docs/SERVER_ARCHITECTURE.md](../SERVER_ARCHITECTURE.md)                 | [SVG](server-data-model.svg)             |
| [실행 계약](run-sequence.png)                                                  | [docs/SERVER_ARCHITECTURE.md](../SERVER_ARCHITECTURE.md)                 | [SVG](run-sequence.svg)                  |
| [권장하는 최소 실행 계약](team-standardization-review-1.png)                   | [docs/TEAM_STANDARDIZATION_REVIEW.md](../TEAM_STANDARDIZATION_REVIEW.md) | [SVG](team-standardization-review-1.svg) |
| [장기 기억 흐름](memory-retrieval.png)                                         | [docs/MEMORY_ARCHITECTURE.md](../MEMORY_ARCHITECTURE.md)                 | [SVG](memory-retrieval.svg)              |

## 도표 수정

핵심 구조·조직·흐름 그림의 편집 원본은 `source/*.json`이고, ERD·시퀀스·이전 설계 기록은 `source/*.mmd`다. 문서 연결은 `diagrams.json`, 생성 결과의 크기·해시는 `manifest.json`에 보관한다. 문서 본문에는 Mermaid 코드 블록을 넣지 않는다. 아이콘 도식은 `scripts/illustrated-diagrams.mjs`에서 기존 Lucide 패키지로 생성한다. Mermaid는 문서 생성에만 사용하고 앱 의존성에는 추가하지 않는다. README와 서버 문서의 전체 구조는 같은 JSON 원본을 사용한다.

한글 폰트(Apple SD Gothic Neo 또는 Noto Sans KR)가 설치된 환경에서 다음을 실행한다.

```bash
npm ci --ignore-scripts
npm install --prefix .local/diagram-tools --ignore-scripts --no-audit --no-fund --save-exact mermaid@11.17.2
npx playwright install chromium
npm run docs:diagrams
node scripts/validate-docs.mjs
```

다른 위치의 Mermaid 배포 파일을 사용할 때는 `MERMAID_DIST`를 해당 `dist` 경로로 설정한다. PNG는 흰 배경과 2배 해상도로 생성하며, SVG에도 흰 배경을 지정한다. 도표 원본을 변경하면 이미지를 다시 생성해야 문서 검사가 통과한다.

아이콘의 [라이선스와 고지](../../public/licenses/lucide.txt)를 각 SVG metadata에 포함한다. 렌더러·라이선스·의존성 lock 파일을 바꾼 경우에도 다시 생성해야 한다. 기본 글꼴은 Apple SD Gothic Neo → Noto Sans KR → Arial 순서다. 한글 글꼴이 다른 운영체제에서는 PNG의 모양이 달라질 수 있으므로 다시 육안으로 확인한다.

[기억 제안·적용 기간·스킬 초안](memory-learning.png)은 0.8의 실제 데이터/검토 흐름입니다.
