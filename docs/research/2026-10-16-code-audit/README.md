# 2026-10-16 공개 코드 조사 자료

최종 판단과 제품 설계는 [OPEN_SOURCE_CODE_RESEARCH.md](../../OPEN_SOURCE_CODE_RESEARCH.md)에 정리했다.

공개 저장소에는 manifest·증거 인덱스·보고서와 수집 보조 도구를 포함한다. 용량이 큰 `sources/`, upstream Git 메타데이터와 전체 트리 목록은 로컬 조사 자료이며 Git에서 제외한다. 원문이 필요하면 프로젝트 루트에서 `npm run research:fetch`로 고정 커밋의 122개 파일을 받아 해시를 확인할 수 있다. 다운로드한 코드는 실행하지 않는다.

- `manifest.json`: 고정 저장소·브랜치·커밋, 확보한 파일 URL·크기·줄 수·SHA-256, 일부 릴리스 메타데이터.
- `evidence.json`: 보고서의 판단에 사용한 선택 범위·심볼과 코드 근거. 확보한 파일 전체를 감사한 것으로 계산하지 않는다.
- `sources/<slug>/...`: 고정 커밋에서 내려받은 원문. 해당 프로젝트의 라이선스 파일을 함께 보존했다.
- `<slug>-tree.txt`: 구현 위치를 찾기 위해 확보한 Git 트리 목록.
- `upstream/`: shallow/no-checkout Git 메타데이터. 외부 소스의 설치·빌드·실행은 하지 않았다.
- `collect.py`, `fetch-selected.py`: 이번 조사에서 쓴 수집 보조 스크립트. 갱신 조사는 별도 날짜 디렉터리에서 수행한다. 기존 결과 위에서 재수집하면 원래 HEAD와 목록을 덮어쓸 수 있으므로 실행하지 않는다.
- `index_evidence.py`: 이미 있는 원문으로 증거 인덱스와 보고서의 고정 링크를 다시 생성한다. 네트워크 호출이나 외부 코드 실행이 없다.
- `validation.json`: 문서 참조·파일 해시·줄 범위의 정합성 검사 결과. 에이전트의 실제 기능 검증 결과가 아니다.

```sh
python3 team-agent-demo/docs/research/2026-10-16-code-audit/index_evidence.py
```

원문 확보와 코드 관찰, 제품의 채택 판단, 실제 통합·실행 검증을 구분한다. 조사 당시 기본 브랜치의 기능이 정식 릴리스나 Cloud/자체 호스팅의 모든 구성에서 같다는 뜻은 아니다. 개인정보나 실계정 키를 수집하지 않았다.
