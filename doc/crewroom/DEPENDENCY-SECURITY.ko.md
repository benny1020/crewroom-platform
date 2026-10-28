# 의존성 보안 수리와 남은 범위

2026-10-29 로컬 검증 기록입니다. 원본 `pnpm audit --prod`는 critical 3, high 47, moderate 48, low 15를 보고했습니다. 실제 설치와 frozen lock으로 재감사한 결과는 critical 0, high 1, moderate 0, low 1입니다. 최종 수치와 검사 결과는 [검증 영수증](./dependency-remediation-receipt.json)에 기록합니다. 원시 감사 JSON은 비공개 `.paperclip/`에 보관합니다. 경고를 숨기는 ignore·allowlist나 워크스페이스 이름·버전 조작은 추가하지 않았습니다.

직접 의존성은 검토한 최소 보안 버전을 정확히 고정했습니다. 전이 의존성은 해당 major의 취약 범위 또는 특정 부모 패키지만 override했습니다. Better Auth 1.7.7, DOMPurify 3.4.17, proxy-addr 2.0.8을 적용하고, 공개 JSON 입력을 파싱하는 body-parser를 2.4.0으로 올렸습니다. Cursor SDK 1.0.38은 Zod 4 peer를 공식 지원하므로 어댑터에 Zod 4.6.6을 명시했습니다. Svix 1.92.2와 Mermaid 12.2.0은 각각 이전 uuid·KaTeX 의존 경로를 교체합니다. 기존 vendored CLI 버전과 패치 해시는 보존합니다.

| 항목 | 관측한 사용 경로와 판단 |
| --- | --- |
| Better Auth 1.7.7 | 이메일·비밀번호 및 workspace handoff를 사용합니다. Magic Link·social/OAuth proxy 기능은 현재 first-party 설정에 없습니다. 보안 패치를 설치한 실제 DB 가입 검사에서 기존 필수 `account.issuer`와의 불일치를 발견해 별도 스키마 이전을 검증합니다. |
| DOMPurify 3.4.17 | 서버 asset·announcement 문자열 sanitize에 사용합니다. 해당 critical의 `SAFE_FOR_TEMPLATES` 조건은 현재 호출에 없지만 라이브러리를 패치합니다. |
| proxy-addr 2.0.8 | Express의 설정 가능한 trust-proxy 경로입니다. 기본 미설정만으로 안전을 일반화하지 않고 패치합니다. |
| MSAL Node 5.6.0, high | Teams SDK의 전이 의존성입니다. 현재 first-party 경로는 `ClientCredential`이며 advisory의 authorization-code 전제는 관측하지 못했습니다. 경고 자체는 실제로 남습니다. major 7 강제 교체나 별도 포크를 적용하지 않았으며 Teams 사용 경로가 늘어나면 다시 검토해야 합니다. |
| `cli` 0.3.1, low | pnpm 9.15.4가 workspace importer 경로 `cli`와 로컬 버전을 registry audit 이름으로 보내는 충돌입니다. lock에 registry `cli` 패키지가 없고 finding의 dependency path도 비어 있습니다. 원시 결과의 low 1은 유지하며 로컬 CLI를 advisory의 다른 npm 패키지로 오인해 이름·버전을 바꾸지 않습니다. |

## Zod의 감사 수치와 실제 한계

Zod 4.6.6 패키지로 통일하면 취약한 Zod 3 패키지의 감사 경고는 사라집니다. 그러나 그 패키지가 제공하는 `zod/v3` 호환 진입점은 길이 제한을 초과한 배열의 전체 요소를 계속 검사합니다. 공식 수정은 v4/core·compile에 적용됐으며, Cursor SDK도 일부 provider 응답을 v3 스키마로 파싱합니다. 따라서 **Cursor 경로의 v3 자원 증폭까지 해결됐다는 뜻은 아닙니다.** 최대 길이 1에 100개 문자열을 넣은 작은 검사에서 두 진입점 모두 입력을 거절했지만 v3는 요소 100개를, v4는 0개를 검사했습니다. 대형 입력이나 OOM 검사는 실행하지 않습니다. 현재 first-party 공개 API에서 이 SDK 스키마를 직접 호출하는 경로는 확인하지 못했지만 provider 응답 경계의 잔여 위험은 남습니다.

## 검증 범위

실제 설치 버전과 lock을 대조하고 frozen install을 확인합니다. 실제 PostgreSQL의 가입·이전 검사는 스키마 호환성을, Cursor SDK의 실제 import·스키마 검사는 Zod peer 호환성을 확인합니다. asset sanitize·AgentMail 서명·MCP·Markdown 회귀와 실제 Mermaid·KaTeX SVG 생성도 검사합니다. Mermaid 테스트는 jsdom의 SVG 측정값만 보충하므로 실제 브라우저의 기하·시각 품질 증거로 사용하지 않습니다. 레거시 Drizzle loader의 esbuild 교체는 정확히 그 부모 경로만 변경하고 동기·비동기 transform과 typed ESM import로 확인합니다.

이 기록은 의존성 수리 및 제한된 로컬 회귀 증거입니다. 전체 원격 회귀·빌드와 새 production 이미지의 인증·기동 스모크는 해당 후보 CI 결과로 따로 확인해야 합니다. 실제 모델 또는 외부 계정 실행 증거는 포함하지 않습니다. 잔여 경고와 v3 한계가 있으므로 ‘취약점 0개’로 표현하지 않습니다.

## 근거

- [Better Auth 1.7 이전 가이드](https://www.better-auth.com/docs/guides/1-7-upgrade-guide)
- [Cursor SDK 1.0.38 릴리스](https://prod.cursor.com/docs/release-notes/sdk#1038)
- [Svix 변경 기록](https://github.com/svix/svix-webhooks/blob/main/ChangeLog.md)
- [Mermaid 릴리스](https://github.com/mermaid-js/mermaid/releases)
- [Zod 배열 제한 수정](https://github.com/colinhacks/zod/commit/a0ebf97)
- [pnpm 9.15.4의 audit tree 생성](https://github.com/pnpm/pnpm/blob/v9.15.4/lockfile/audit/src/lockfileToAuditTree.ts#L35-L44)
