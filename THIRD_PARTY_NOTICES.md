# 출처와 권리 고지

크루룸의 애플리케이션 코드는 이 저장소의 MIT 라이선스로 제공한다. 의존 패키지의 라이선스는 각각의 권리자에게 있다.

- **Lucide**: ISC License. 아이콘 패키지의 [라이선스와 고지](public/licenses/lucide.txt)를 소스와 정적 배포에 함께 포함한다. 아키텍처 도식에도 같은 아이콘을 사용하며 standalone SVG의 metadata에 전체 고지를 보존한다. [Lucide source](https://github.com/lucide-icons/lucide).
- **캐릭터 atlas**: 0.15.0의 봉제 초상 10종과 개발 일지 12장면은 제공된 참고 시트의 질감·동물 구성을 바탕으로 내장 이미지 생성 도구로 제작했다. 참고 시트 원본은 공개 소스에 포함하지 않는다. [현행 생성 명세·프롬프트](assets/plush-generation.md), [이전 일러스트 명세](assets/gyeot-crew-generation.txt)를 보존한다. 특정 오픈소스 프로젝트의 마스코트나 UI 이미지를 가져오지 않았다.
- **제품·구조 연구**: Paperclip, LobeHub, Hermes, Letta Code, OpenHands SDK, Mastra, LangGraph, Dify, OpenClaw, Hindsight, Mem0의 공개 코드를 비교했다. 구현에 반영한 것은 자체 제품 계약과 인터페이스 패턴이다. 해당 프로젝트의 실행 코드를 이 앱에 복사하거나 연결한 상태가 아니다. 각 소스의 고정 커밋과 라이선스 차이는 [코드 조사 보고서](docs/OPEN_SOURCE_CODE_RESEARCH.md)에 있다.
- 연구용 원문과 upstream Git 메타데이터는 이 공개 저장소에 포함하지 않는다. 보고서와 manifest의 원본 GitHub 링크로 추적할 수 있다.

0.6 Runner 이미지는 Docker CLI, Git, Alpine/BusyBox를 각각의 upstream 라이선스에 따라 컨테이너 실행 도구로 사용한다. 이 도구의 소스를 Crewroom MIT 코드로 재라이선스하지 않는다. 이미지 재배포 시 사용하는 base image의 고지와 소스 제공 조건도 함께 보존한다.

스크린샷·GIF는 Chromium에서 UI를 조작해 캡처했다. `docs/media`는 정적 목업, `docs/media/server`는 실제 서버의 결정적 fixture, `docs/media/execution`은 실제 PostgreSQL/Docker 검사와 합성 모델 프로토콜 응답을 사용한다. 실제 모델 추론으로 표시하지 않는다.

0.7 장기 기억 설계는 Muse/Grok Bot의 공개 문서와 고정 버전 Hindsight·Mem0·Letta Code의 선택 파일을 비교했다. 자체 검색·출처 검사·캐시 구현이며 해당 런타임의 실행 코드를 복사하거나 의존성으로 추가하지 않았다. [조사 근거와 원문 manifest](docs/MEMORY_ARCHITECTURE.md)를 제공한다.
