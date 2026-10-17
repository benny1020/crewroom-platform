# ADR 001 · 실행 제어면의 단일 소유자

상태: 0.5 채택, 2026-10-17. 독립 Astra 아키텍처 리뷰 반영.

## 결정

Crewroom Fastify App과 PostgreSQL Task/Run 큐가 업무·실행의 유일한 소유자다. 상주 Worker가 읽기 전용 모델 adapter를 실행한다. Paperclip 직접 통합과 Hermes 도구 실행은 유보한다. LangChain/LangGraph는 현재의 작은 상태 전이에 필요하지 않아 사용하지 않는다.

## 확인한 코드

0.4의 우선안은 Paperclip 일반 issue와 heartbeat queue의 직접 재사용이었다. 실제 개발 전 최신 소스를 고정해 내부 경계를 다시 확인했다.

| 검토 소스 | 확인한 사실 | 구현 영향 |
| --- | --- | --- |
| [Paperclip package.json · 669d329](https://github.com/paperclipai/paperclip/blob/669d329f257805ff3c171341ee6942d681cc6a0e/server/package.json) | 공개 server entry는 index/startServer. 독립 queue SDK가 아니다 | 내부 서비스 몇 개를 가져오는 형태의 채택을 피함 |
| [heartbeat.ts](https://github.com/paperclipai/paperclip/blob/669d329f257805ff3c171341ee6942d681cc6a0e/server/src/services/heartbeat.ts) | issue/heartbeat/service 계층과 다수 의존성이 연결됨 | 전체 upstream fork와 모든 일반 경로의 인증·권한 확장이 필요 |
| [Hermes adapter execute.ts](https://github.com/paperclipai/paperclip/blob/669d329f257805ff3c171341ee6942d681cc6a0e/packages/adapters/hermes/src/server/execute.ts) | `--yolo`, process 환경 상속 및 직접 업무 완료 API 지시 경로 | Crewroom의 최소 권한·비밀 분리·사람 수용 계약과 충돌 |
| [Hermes stream_json.py · bebe448](https://github.com/NousResearch/hermes-agent/blob/bebe448a2bdb57043ca8ebd820807bf7eed6320d/hermes_cli/stream_json.py) | 최신 CLI에 구조화 스트림 경로가 있음 | 로컬 설치 버전과 기능을 별도로 확인해야 하며 단순 설치 존재로 연동 완료라 할 수 없음 |

기존 [2026-10-16 고정 코드 감사](research/2026-10-16-code-audit/README.md)도 보존한다. 위 사실을 근거로 본 제품에 대한 채택 비용을 판단한 것이며, 해당 프로젝트의 일반적 품질 평가가 아니다.

## 고려한 대안

1. Paperclip 전체를 고정 fork하고 인증·ACL·산출물·공유 방을 내부 확장: 기존 운영 기능은 얻지만 작은 단일 팀 서비스에 권한 표면과 유지보수 범위가 커진다.
2. Paperclip 옆에 별도 Crewroom Task/Run 큐: 두 소유자가 생기므로 배제한다.
3. Crewroom의 작은 단일 DB 큐: 초기 읽기 전용 기능에 필요한 상태·임대·복구·권한을 직접 테스트할 수 있다. 이번 릴리스에서 선택했다.

## 결과와 재검토 조건

우리는 자체 queue/recovery의 책임을 진다. Worker 종료·lock 대기 중 lease 만료·오래된 결과·발송 불명·복원 격리를 독립 리뷰와 회귀 검사에 포함했다. 자율 코드 수정·브라우저·원격 실행을 추가할 때는 별도 OS/컨테이너 격리·허용 도구·비밀 전달·외부 쓰기 승인·프로세스 종료 증거가 필요하다. 그때 Hermes/다른 하네스를 새 adapter 계약으로 재검토한다. 현재 Docker Worker를 비신뢰 코드 샌드박스라고 부르지 않는다.
