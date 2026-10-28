# 선택적 런타임 qualification

`Crewroom runtime qualification`은 `workflow_dispatch`로만 실행하는 추가 검사다. 배포, 실제 모델 응답이나 제공자 API 연결을 검증하지 않는다. `source_revision`에 검사할 제품 commit의 40자리 SHA를 입력한다. 보안 의존성이 바뀌었다면 이전 제품 SHA의 통과 결과를 새 제품의 증거로 쓰지 않는다.

Workflow가 있는 commit은 `qualification-infra`, 입력한 제품 commit은 `qualification-product`에 별도로 checkout한다. CI helper는 제품 checkout 밖에서 실행하며 두 HEAD를 검증한다. 공개 receipt는 `productRevision`과 `helperRevision`을 구분한다. 제품 소스 수정 없이 기존 `native-runner-restart-recovery.integration.test.ts`와 기존 Docker command runner/TLS tunnel을 재사용한다.

Ubuntu 24.04 x64에서 Node 24.14.0, pnpm 9.15.4, Rust 1.97.1을 사용한다. Frozen install 뒤 두 debug binary인 `paperclip-runnerd`와 `fake-codex-app-server`를 cargo jobs 2로 먼저 빌드한다. 실제 `defaultCapabilityRunnerdBinary()`가 선택한 경로도 확인하므로 다른 staged binary로 조용히 대체할 수 없다. SHA-256을 receipt에 기록한다.

검사는 한 job에서 단일 Vitest worker로 순차 실행한다.

1. Recovery 파일을 실행하고 `realProcessIt`의 확장된 이름 8개가 각각 정확히 한 번 `passed`인지 확인한다. 실제 PostgreSQL checkpoint 쓰기, controller 파일 유실, hot/hard restart, prompt 호환성, 격리된 이전 journal 복구를 다룬다.
2. 자격증명 없는 fake provider를 담은 disposable Node 24.14.0 trixie amd64 container에서 remote `warm`, `hard`, `legacy`, `changed`, `same-server` 5개를 실행한다. 이미지 digest를 고정하고 localhost에 자동 할당한 포트만 게시한다. 테스트용 TLS 인증서와 키는 임시 생성한다.
3. 선택한 사례가 누락·중복·실패·skip되면 실패한다. 로컬 8개가 모두 실제 진입했고 개별 검사 실패가 있는 경우에는 소유 프로세스 정리를 확인한 뒤 독립 원격 5개도 실행해 결과를 수집한다. 준비 실패·누락·skip 또는 정리 불확실이면 후속 검사를 시작하지 않는다. 로컬 실패는 원격 성공으로 덮어쓰지 않는다. 두 번째 `-t` 실행에서 선택하지 않아 pending인 다른 사례는 `unselectedSkipped`로 별도 기록하며 13개 qualification 성공에 포함하지 않는다.

컨테이너는 2 GiB/2 CPU/256 PID 제한, `--init`, capability 전체 제거와 `no-new-privileges`를 사용한다. 호스트 디렉터리나 Docker socket을 mount하지 않고 privileged 실행이나 호스트 sysctl 변경도 하지 않는다. Docker 제어는 호스트의 기존 테스트 helper가 수행한다. 임시 fake provider, TLS 키, PostgreSQL, 세션 상태와 원문 Vitest JSON은 공개 artifact에 넣지 않는다.

종료·실패 시 helper가 추적한 프로세스와 고유 owner label/ID를 가진 컨테이너만 정리한다. `always()` 단계가 컨테이너 정리를 다시 확인한다. 정리 실패도 실패 receipt가 되며, 확인되지 않은 정리를 성공으로 기록하지 않는다. 볼륨·캐시·다른 서비스는 삭제하지 않는다. 공개 artifact는 `receipt.json` 하나다. SHA, toolchain, binary hash, 단계 상태·exit code·테스트 수 외에 고정된 13개 사례의 이름·상태를 기록한다. 실패 진단은 고정 error-class enum, 허용된 회귀 파일 하나의 소스 상대 경로·줄·열, 형식이 확인된 boolean 또는 짧은 정수 비교값으로 제한한다. 원문 오류 메시지·stack 전체·임의 파일 경로·문자열/객체 비교값·환경 변수·인증 정보는 복사하지 않는다. Vitest의 선언 위치도 허용된 동일 파일로만 기록한다.

Rust 재실행은 기존 SHA로 고정된 rust-cache action으로 공개 dependency cache를 재사용한다. Workspace crate·제품 실행 binary·테스트 상태·TLS/DB/session fixture는 캐시 대상에서 제외한다. 테스트 실패 뒤에도 dependency cache만 저장할 수 있으며 테스트 통과 판정에는 영향을 주지 않는다.

로컬에서는 이 CI를 대신하는 무거운 실행을 하지 않았다. Python gate/cleanup의 offline 검사와 workflow 구문 검사는 런타임 13개 통과 증거가 아니며, 실제 결과는 해당 제품 SHA의 GitHub Actions receipt로 확인한다.


명령별 자식 회수 helper는 `Popen` 생성이 끝난 뒤 그 PID를 보호한 thread를 시작한다. 명령이 실행 중일 때 helper에 입양된 종료 자식만 `waitpid(pid, WNOHANG)`으로 회수하므로, 실제 종료한 provider를 좀비 상태로 남겨 `kill(pid, 0)` 검사가 살아 있다고 오인하는 것을 막는다. 살아 있는 자식에게 신호를 보내지 않으며 직접 `Popen`의 종료 코드를 소비하지 않는다. 다음 명령·전체 정리 전에 thread stop/join을 확인하고, thread 오류나 종료 불확실은 실패 처리한다. 전역 SIGCHLD handler나 실행 중의 `waitpid(-1)` 회수는 사용하지 않는다.

작은 Linux proof는 회수 전 좀비 재현, 명령 실행 중 소멸, 직접 종료 코드 7 보존, 살아 있는 입양 자식 보존, 예외 정리·thread join, worker 밖 sibling 보존을 검사한다. 원격 준비 receipt는 고정 operation과 exit code, 필요한 다섯 tool의 missing boolean만 남겨 image pull·컨테이너 시작·tool·TLS 준비 중 실패한 지점을 구분한다. Docker 원문 출력이나 준비용 비밀 파일은 공개하지 않는다.

로컬의 작은 Linux 컨테이너 검증은 1 CPU·256 MiB·network none에서 위 child-reaper proof 전체를 통과했다. 최대 개별 child RSS는 18,860 KiB였으며 합산 peak 메모리 측정값은 아니다. 예외·worker 실패 시 외부 proof owner도 자신의 입양 자식을 정리한 뒤 임시 fixture를 제거한다. 고정된 공식 Node 이미지 digest의 별도 동일 제한 probe에서는 Node v24.14.0과 `node`·`ps`·`setsid`·`tar`·`base64` 존재를 확인했다. 이것은 CI의 원격 준비 실패 원인을 확정한 결과가 아니므로 이미지나 package를 바꾸지 않았다. 제품의 8+5 qualification 통과 여부는 수정된 helper로 같은 제품 SHA를 다시 실행한 receipt가 필요하다.


원격 fake provider는 제품의 build artifact 자체를 chmod하지 않고 helper의 private staging copy만 `0555`로 만든 뒤 복사한다. Docker copy가 호스트 UID를 유지하면 capability 없는 컨테이너 root는 다른 UID의 `0700` 파일을 chmod할 수 없다. 동일한 고정 이미지·1 CPU·256 MiB·network none의 dummy artifact probe에서 이 상태를 재현했다(호스트/복사 파일 UID 501, 실행 UID 0, CapEff 0, 기존 chmod exit 1). 정규화한 staging copy는 UID가 달라도 directory/file read+execute, 원본·staged·컨테이너 SHA-256 일치와 dummy 실행 exit 0을 확인했다. 원본 artifact의 mode·hash는 바꾸지 않았으며, 컨테이너 capability 추가·privileged 실행도 사용하지 않았다. 실제 remote 5개는 다음 qualification receipt가 필요하다.


원문을 보존하지 않는 infrastructure cause reporter를 stock JSON reporter와 병용한다. 공식 `onTestCaseResult` API의 `result().errors[].cause`를 최대 8단계·cycle guard로 읽어 root wrapper와 nested cause를 구분한다. 수집 파일도 private `0600`이며 고정 13개 title, enum class, 정확한 회귀 fixture의 상대 경로·줄·열과 제한된 primitive 비교만 저장한다. Python helper가 공개 receipt에 넣기 전에 이 필드를 다시 검증한다. 임의 message·stack·diff·객체·문자열 값·환경 변수는 저장하거나 공개하지 않는다. 파일이 없거나 reporter 수집이 실패하면 `causeDiagnosticsStatus: unavailable`로 표시하며, 기존 stock JSON의 검사 수·결과·성공 gate를 바꾸지 않는다.

별도의 작은 synthetic fixture로 실제 Vitest 5에서 stock JSON 단독/병용 모두 2개 실패를 유지하면서 두 단계 cause·소스 frame·boolean/정수 비교가 정제되는지 확인했다. 실제 제품 recovery fixture·timeout·8+5 gate는 이 smoke에서 실행하거나 수정하지 않는다.

정리 진단은 `initialCleanup`의 `reaperJoined`·`childrenCleanup`·`containerCleanup`을 구분한다. 컨테이너는 inventory·inspect·owner/ID 확인·stop·후속 inventory·remove·최종 inventory의 고정 operation, exit code, 상태 enum과 boolean만 기록한다. 자식 정리는 ECHILD·deadline·read/wait/signal error의 고정 이유와 제한된 수만 기록한다. `always()` 재시도는 `recoveryCleanup`으로 별도 기록해 최초 실패를 덮어쓰지 않는다. 이전 helper의 자식 종료가 확인되지 않았다면 새 정리 프로세스는 그 사실을 성공으로 바꾸거나 private fixture를 삭제하지 않는다.
