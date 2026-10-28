# Crewroom UI 검증 · 2026-10-28

애플리케이션 소스는 원래 봉제 캐릭터 12개 stable ID, 실제 상태에 따른 작업 장면, 기존 개인 대화 진입, 같은 업무의 의견·수정 요청까지 구현했습니다. 제공자 자격 증명이 없어 실제 AI 답변, 자연어 의도 판단 품질, 모델 실행 성공을 검증한 결과는 아닙니다.

## 로컬 focused 검사

최종 단일 worker 실행은 10개 파일, **552/552 통과**, 10.35초였습니다. native `TaskChatComposer`와 classic `IssueChatThread`, `TaskChatThread` 전체, Crewroom 상태/장면/아틀라스, 업로드 우선 Avatar, private chat actor/company 전환 및 늦은 응답, Breadcrumb을 포함합니다. 여러 검사 명령을 동시에 실행하지 않았으며 종료 후 Vitest/worker 프로세스가 남지 않음을 확인했습니다.

- `pnpm check:token-gates`: clean.
- `pnpm check:module-boundaries`: pass.
- Impeccable의 Crewroom 대상 검사에서 변경된 제품 UI의 신규 경고는 없었습니다. 공통 CSS의 기존 3개 경고(다른 표면의 side border, gradient text, typing bounce)는 [impeccable-detect.json](impeccable-detect.json)에 남겼습니다. 세 선언은 foundation 기준 커밋에도 존재합니다.
- 후속 static-avatar leaf 범위는 [impeccable-avatar-detect.json](impeccable-avatar-detect.json)에서 0개입니다. 사용자 custom avatar가 있으면 우선하며 metadata 없는 upstream 에이전트는 기존 렌더러를 씁니다.

첫 focused 실행에서는 한국어 기능 문구 변경에 맞지 않은 기존 기대 문자열 3개가 실패했습니다. 해당 기대값을 수정한 뒤 동일 범위가 통과했습니다. 이후 native 기본 경로까지 확장한 최종 552개 검사도 통과했습니다.

## 실제 로컬 브라우저/API

공식 `scripts/crewroom-dev.mjs`로 격리된 3117 API/UI와 55447 PostgreSQL을 사용했습니다. Heartbeat 스케줄러와 텔레메트리를 끄고 기존 isolated DB를 재사용했습니다. bootstrap을 두 번 실행해 같은 회사와 8명 동료가 유지됨을 확인했습니다. 설정용 동료는 paused 상태이며 작업 성공이나 실제 가동을 나타내지 않습니다.

[capture-receipt.json](media/capture-receipt.json)에 화면별 경로·크기를 기록했습니다. 1280/1440/1600 desktop 및 1440×900, 부서, 워크룸, 기본 비서, 스킬 화면에서 가로 넘침이 없었습니다. 1440×900에 초기 동료 8명이 모두 들어옵니다. 장식용 환영 배너를 제거해 명부가 바로 시작하며, 원본 캐릭터 크기는 유지했습니다.

상단 ‘대화로 요청하기’가 기존 `/chats/` 경로로 이동하고 실제 native/classic thread가 마운트될 때까지 기다려 캡처했습니다. motion off는 재로드 후에도 유지됐고, reduced motion의 캐릭터 실행 애니메이션은 0개였습니다. 브라우저 page error는 없었습니다.

빈 데이터·503·생성 권한 거절 화면은 **브라우저 응답 대체 fixture**입니다. `*.fixture.png`와 receipt에 별도로 기록했으며 서버의 실제 접근 권한 증거로 취급하지 않습니다. 서버 권한과 wake 횟수는 별도 서버 회귀 결과를 참조해야 합니다.

## 같은 업무에서 의견과 수정 요청

[feedback-receipt.json](media/feedback-receipt.json)은 명시적인 로컬 검증용 업무의 실제 UI/API 전송을 기록합니다. 제목은 ‘검증용 업무 · 실제 모델 실행 아님’이고 담당자는 paused입니다.

- ‘고마워’ 의견: UI가 `reopen:false`를 전송했고 같은 task ID의 `done` 상태가 유지됐습니다.
- 명시적인 ‘수정 요청 · 같은 업무 다시 시작’: UI가 `reopen:true`를 전송했고 같은 task ID가 `todo`로 바뀌었습니다.
- 해당 업무의 live run은 0개였습니다. raw wakeup queue를 읽는 공식 API가 없어 여기서 wake 횟수를 주장하지 않습니다.
- 종료 시 검증 업무를 `done`으로 복구했으며 담당자 paused 상태를 보존했습니다.

기본 streamlined 표면은 `TaskChatThread → TaskChatComposer`이며, classic 옵션은 `IssueChatThread`입니다. 두 composer 모두 같은 명시적 선택과 false 전달을 구현했습니다. 첫 브라우저 smoke는 classic 전용 test id를 기본 표면에서 기다리다 시간 초과됐으며 댓글이나 모델 실행을 시작하지 않았습니다. 실제 기본 경로로 수정해 위 결과를 확인했습니다.

## 미디어와 한계

[MEDIA.ko.md](MEDIA.ko.md)의 캐릭터 미디어는 원본 이미지의 CSS crop입니다. GIF는 **명시된 12장면 샘플 갤러리**이며 실제 실행 영상이 아닙니다. 최초 FFmpeg 인코딩은 호스트 x265 공유 라이브러리가 없어 실패했습니다. 시스템 패키지를 바꾸지 않고 bundled Python/Pillow로 같은 브라우저 프레임을 저장했습니다. 임시 프레임은 제거했습니다.

전체 workspace typecheck/build와 광범위 테스트는 16GB 로컬 RAM 및 Docker OOM 제약 때문에 이 UI 검사에서 반복하지 않았습니다. GitHub의 `crewroom.yml` 및 21 shard `crewroom-full-regression.yml`로 검증하도록 준비했으며, CI 성공은 해당 원격 결과를 확인한 뒤에만 주장할 수 있습니다. 캡처 당시 health의 커밋은 foundation SHA와 local changes를 함께 표시하므로 최종 배포 SHA의 증명이 아닙니다.
