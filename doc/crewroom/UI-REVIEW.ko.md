disposition: fix

검토 방식: generic spawn_agent로 독립 Astra finish-reviewer 역할을 수행했다. 승인 comp가 없는 기존 Paperclip 확장이다. 전용 QUALITY BAR 카드와 concept-seed 계약은 제공되지 않았으며 신규 시각 세계의 재설계 기준으로 적용하지 않았다. 필수 데스크톱 캡처와 소스를 검토했고 브라우저·모델 실행·GitLab·EC2·CI는 검증하지 않았다. DESIGN.md는 기본 원칙과 Crewroom 확장부를 읽었으며 다른 기능의 상세 절은 읽지 않았다. 추가 파일 private-chat.png는 팀 화면을 보여 대화 증거에서 제외했다.

## persistence

pass — PRODUCT.md, DESIGN.md의 Crewroom 확장, .impeccable/surfaces/crewroom.md가 현재 구현의 Operate·한국어·기존 Paperclip 소유권·plush 캐릭터·실제 상태·선택적 샘플 요구를 기록한다. code-led 기존 시스템 확장이므로 comp 재현 파일과 신규 concept-seed를 요구하지 않는다.

필수 team-1440.png, team-1280.png, team-1600.png, team-reduced-motion.png, development.png, workroom.png, personal.png, skills.png, mimi-scenes-preview.png, mimi-motion-preview.gif와 capture-receipt.json을 확인했다. 추가 team-1440x900.png도 정상 뷰포트 캡처다. 문서 상단과 화면 내용이 일치하며 가로 잘림·검은 영역은 없다. 모바일은 명시적 범위 밖이다. 900 높이의 세로 밀림은 캡처 오류가 아닌 구현 결함이다.

실제 로컬 API의 일시 정지 동료와 browser response replacement로 만든 empty/error/read-only fixture를 구분한다. GIF는 샘플 문구를 포함한다. reducedMotionRunningAnimations=0, motionPreferenceSurvivesReload=true는 캡처 영수증의 계측이며 정지 PNG만으로 동작 여부를 단정하지 않는다.

## fidelity

| 요소 | 판정 | 근거 |
|---|---|---|
| TYPE | match | 기존 Paperclip의 한국어 운영 화면, 명확한 제목/행/상태 크기 구분을 유지한다. 독자적 장식 display font를 요구하는 화면이 아니다. |
| MATERIAL | match | 미미와 기존 plush 동료를 실제 비트맵과 아틀라스로 표시한다. 배너와 우측 맥락 영역에도 실제 인물성이 유지된다. CSS로 대체한 가짜 봉제 소재는 없다. |
| GROUND | match | 기존 중립 화면 위에 DESIGN.md가 명시한 제한된 따뜻한 welcome 표면을 사용한다. 자체적으로 더 따뜻한 전체 배경을 요구할 근거는 없다. |
| 전체 팀 한눈에 보기 | contradicted | 1440×900에서 명부가 y530부터 시작한다. 마지막 QA 두 명의 이름·상태는 뷰포트 아래에 있고, y288–446 welcome과 상단 간격이 공간을 소비한다. 1000 높이도 마지막 행이 하단에 붙는다. |
| 고정 부서·워크룸 | match | 직속/개발/운영/QA 탐색, 부서 필터, 동료별 업무와 상세 이동이 존재한다. 부서는 권한 경계로 표현되지 않는다. |
| 대화 중심 요청 | match | 대화로 요청하기가 헤더의 유일한 채움 primary action이다. 개인 비서 및 워크룸 개인 대화가 기존 AgentChat 경로를 사용한다. 새 업무는 헤더에서 보조 행동이다. |
| 실제 상태와 동작 | match | 실제 캡처의 일시 정지를 휴식 pose와 상태 문구로 표현한다. work-scene.ts는 실제 running 및 currentToolName에 따라 작업 장면을 선택하며 성공을 추정하지 않는다. 12개 샘플은 별개로 표시한다. |
| 워크룸 로딩/오류 | contradicted | ui/src/pages/Crewroom.tsx의 selectedAgent → agentId 분기는 agents 조회 대기와 실패에서도 곧바로 찾을 수 없거나 접근할 수 없다고 표시한다. 정상적인 로딩/서버 오류를 부재·권한 문제로 오인시킨다. |
| 대화 오류 복구 | contradicted | 동일 파일의 chatError ReadError는 다시 불러오기 버튼에 setChatError(null)만 연결한다. 실제 재시도가 발생하지 않는다. |
| 기본 비서·스킬 | match | 공유 에이전트의 사용자별 기본 선택, 대화 보존, 최소 입력으로 스킬 사용 요청 업무 생성 흐름을 유지한다. 실행 시 선택 버전 적용까지 입증한 것으로 취급하지 않는다. |
| 업무 의견·수정 요청 | match | 기존 task thread에 의견과 명시적 동일 업무 재시작 선택을 둔다. 캡처와 소스로 진입·컨트롤을 확인한 범위이며 실제 재시작의 서버 검증은 별도다. |

이전 office.png와 personal-assistant.png도 확인했다. 현재 구현의 승인 plush 소재를 바꾸거나 과거 목업의 가상 진행 수치를 복제할 근거는 없다. 비교에서 지킬 것은 동료가 중심인 작업 공간, 명확한 현재 상태, 대화와 업무 맥락이다.

## ceiling

Operate 완성도 7/10. 상단 소개보다 팀 명부가 먼저 읽혀야 한다는 약속이 미달이다. 재료·캐릭터를 재생성할 이유는 없다. 동작 샘플은 코딩/검사/검토/대기/휴식을 구별하고, 실행 증거가 없는 현재 환경에서 강제로 바쁜 동료를 만들지 않는 것이 맞다. 캐릭터 크기와 상태 가독성을 유지한 채 배너·상단 간격을 줄이는 것으로 목표에 도달할 수 있다.

## material_fixes

1. [P1 · 전체 팀] ui/src/pages/Crewroom.tsx의 crewroom-welcome과 ui/src/index.css의 crewroom-page/간격을 압축하거나 소개를 접어 1440×900 첫 화면에 현재 8명 모두의 이름·역할·상태가 온전히 보이게 한다. 미미의 큰 반복 초상과 일반 소개가 운영 정보보다 위계상 우선하지 않도록 한다. 명부 글자·캐릭터를 작게 만들어 해결하지 않는다. 같은 team-1440x900.png, team-1280.png, team-1440.png, team-1600.png로 확인한다.
2. [P2 · 상태 진실성] ui/src/pages/Crewroom.tsx의 agentId 워크룸 분기에 agents.isPending용 로딩과 agents.error용 오류/실제 refetch를 먼저 처리하고, 조회 성공 후에만 없는 에이전트를 표시한다. 직접 워크룸 진입의 지연 및 실패 상태를 분리해서 확인한다.
3. [P2 · 복구 행동] ui/src/pages/Crewroom.tsx의 chatError 재시도를 실패했던 에이전트의 startChat 재호출에 연결한다. 단순 오류 지우기를 유지한다면 다시 불러오기로 부르지 말고 별도 실제 재시도 행동을 제공한다. 클릭 후 기존 AgentChat 열기 흐름이 다시 실행되는지 확인한다.

## keep

승인된 plush 동료와 미미, 충분한 캐릭터 크기, 실제 상태/샘플의 구분, 대화 중심 primary action, 기존 Paperclip task·chat·권한 소유권, reduced motion과 동작 정지를 희석하지 않는다.
