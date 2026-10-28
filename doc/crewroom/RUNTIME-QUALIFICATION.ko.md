# 선택적 런타임 qualification

`Crewroom runtime qualification`은 `workflow_dispatch`로만 실행하는 추가 검사다. 배포, 실제 모델 응답이나 제공자 API 연결을 검증하지 않는다. `source_revision`에 검사할 제품 commit의 40자리 SHA를 입력한다. 보안 의존성이 바뀌었다면 이전 제품 SHA의 통과 결과를 새 제품의 증거로 쓰지 않는다.

Workflow가 있는 commit은 `qualification-infra`, 입력한 제품 commit은 `qualification-product`에 별도로 checkout한다. CI helper는 제품 checkout 밖에서 실행하며 두 HEAD를 검증한다. 공개 receipt는 `productRevision`과 `helperRevision`을 구분한다. 제품 소스 수정 없이 기존 `native-runner-restart-recovery.integration.test.ts`와 기존 Docker command runner/TLS tunnel을 재사용한다.

Ubuntu 24.04 x64에서 Node 24.14.0, pnpm 9.15.4, Rust 1.97.1을 사용한다. Frozen install 뒤 두 debug binary인 `paperclip-runnerd`와 `fake-codex-app-server`를 cargo jobs 2로 먼저 빌드한다. 실제 `defaultCapabilityRunnerdBinary()`가 선택한 경로도 확인하므로 다른 staged binary로 조용히 대체할 수 없다. SHA-256을 receipt에 기록한다.

검사는 한 job에서 단일 Vitest worker로 순차 실행한다.

1. Recovery 파일을 실행하고 `realProcessIt`의 확장된 이름 8개가 각각 정확히 한 번 `passed`인지 확인한다. 실제 PostgreSQL checkpoint 쓰기, controller 파일 유실, hot/hard restart, prompt 호환성, 격리된 이전 journal 복구를 다룬다.
2. 자격증명 없는 fake provider를 담은 disposable Node 24.14.0 trixie amd64 container에서 remote `warm`, `hard`, `legacy`, `changed`, `same-server` 5개를 실행한다. 이미지 digest를 고정하고 localhost에 자동 할당한 포트만 게시한다. 테스트용 TLS 인증서와 키는 임시 생성한다.
3. 선택한 사례가 누락·중복·실패·skip되면 실패한다. 두 번째 `-t` 실행에서 선택하지 않아 pending인 다른 사례는 `unselectedSkipped`로 별도 기록하며 13개 qualification 성공에 포함하지 않는다.

컨테이너는 2 GiB/2 CPU/256 PID 제한, `--init`, capability 전체 제거와 `no-new-privileges`를 사용한다. 호스트 디렉터리나 Docker socket을 mount하지 않고 privileged 실행이나 호스트 sysctl 변경도 하지 않는다. Docker 제어는 호스트의 기존 테스트 helper가 수행한다. 임시 fake provider, TLS 키, PostgreSQL, 세션 상태와 원문 Vitest JSON은 공개 artifact에 넣지 않는다.

종료·실패 시 helper가 추적한 프로세스와 고유 owner label/ID를 가진 컨테이너만 정리한다. `always()` 단계가 컨테이너 정리를 다시 확인한다. 정리 실패도 실패 receipt가 되며, 확인되지 않은 정리를 성공으로 기록하지 않는다. 볼륨·캐시·다른 서비스는 삭제하지 않는다. 공개 artifact는 SHA, toolchain, binary hash, 단계 상태와 테스트 수만 포함한 `receipt.json` 하나다.

로컬에서는 이 CI를 대신하는 무거운 실행을 하지 않았다. Python gate/cleanup의 offline 검사와 workflow 구문 검사는 런타임 13개 통과 증거가 아니며, 실제 결과는 해당 제품 SHA의 GitHub Actions receipt로 확인한다.
