# 선택적 런타임 qualification

`Crewroom runtime qualification`은 `workflow_dispatch`로만 실행하는 추가 검사다. 배포, 실제 모델 응답이나 제공자 API 연결을 검증하지 않는다. `source_revision`에 검사할 제품 commit의 40자리 SHA를 입력한다. 보안 의존성이 바뀌었다면 이전 제품 SHA의 통과 결과를 새 제품의 증거로 쓰지 않는다.

Workflow가 있는 commit은 `qualification-infra`, 입력한 제품 commit은 `qualification-product`에 별도로 checkout한다. CI helper는 제품 checkout 밖에서 실행하며 두 HEAD를 검증한다. 공개 receipt는 `productRevision`과 `helperRevision`을 구분한다. 제품 소스 수정 없이 기존 `native-runner-restart-recovery.integration.test.ts`와 기존 Docker command runner/TLS tunnel을 재사용한다.

Ubuntu 24.04 x64에서 Node 24.14.0, pnpm 9.15.4, Rust 1.97.1을 사용한다. Frozen install 뒤 두 debug binary인 `paperclip-runnerd`와 `fake-codex-app-server`를 cargo jobs 2로 먼저 빌드한다. 실제 `defaultCapabilityRunnerdBinary()`가 선택한 경로도 확인하므로 다른 staged binary로 조용히 대체할 수 없다. SHA-256을 receipt에 기록한다.

검사는 한 job에서 단일 Vitest worker로 순차 실행한다.

1. Recovery 파일을 실행하고 `realProcessIt`의 확장된 이름 8개가 각각 정확히 한 번 `passed`인지 확인한다. 실제 PostgreSQL checkpoint 쓰기, controller 파일 유실, hot/hard restart, prompt 호환성, 격리된 이전 journal 복구를 다룬다.
2. 자격증명 없는 fake provider를 담은 disposable Node 24.14.0 trixie amd64 container에서 remote `warm`, `hard`, `legacy`, `changed`, `same-server` 5개를 실행한다. 이미지 digest를 고정하고 localhost에 자동 할당한 포트만 게시한다. 테스트용 TLS 인증서와 키는 임시 생성한다.
3. 선택한 사례가 누락·중복·실패·skip되면 실패한다. 로컬 8개가 모두 실제 진입했고 개별 검사 실패가 있는 경우에는 소유 프로세스 정리를 확인한 뒤 독립 원격 5개도 실행해 결과를 수집한다. 준비 실패·누락·skip 또는 정리 불확실이면 후속 검사를 시작하지 않는다. 로컬 실패는 원격 성공으로 덮어쓰지 않는다. 두 번째 `-t` 실행에서 선택하지 않아 pending인 다른 사례는 `unselectedSkipped`로 별도 기록하며 13개 qualification 성공에 포함하지 않는다.

컨테이너는 2 GiB/2 CPU/256 PID 제한, `--init`, capability 전체 제거와 `no-new-privileges`를 사용한다. 호스트 디렉터리나 Docker socket을 mount하지 않고 privileged 실행이나 호스트 sysctl 변경도 하지 않는다. Docker 제어는 호스트의 기존 테스트 helper가 수행한다. 임시 fake provider, TLS 키, PostgreSQL, 세션 상태와 원문 Vitest JSON은 공개 artifact에 넣지 않는다.

종료·실패 시 helper가 추적한 프로세스와 고유 owner label/ID를 가진 컨테이너만 정리한다. `always()` 단계가 컨테이너 정리를 다시 확인한다. 정리 실패도 실패 receipt가 되며, 확인되지 않은 정리를 성공으로 기록하지 않는다. 볼륨·캐시·다른 서비스는 삭제하지 않는다. 공개 artifact는 `receipt.json` 하나다. SHA, toolchain, binary hash, 단계 상태·exit code·테스트 수 외에 고정된 13개 사례의 이름·상태를 기록한다. 실패 진단은 고정 error-class enum, 명시적으로 허용된 공개 소스 파일의 상대 경로·줄·열, 형식이 확인된 boolean 또는 짧은 정수 비교값으로 제한한다. 원문 오류 메시지·stack 전체·임의 파일 경로·문자열/객체 비교값·환경 변수·인증 정보는 복사하지 않는다. Vitest의 선언 위치도 허용된 동일 파일로만 기록한다.

Rust 재실행은 기존 SHA로 고정된 rust-cache action으로 공개 dependency cache를 재사용한다. Workspace crate·제품 실행 binary·테스트 상태·TLS/DB/session fixture는 캐시 대상에서 제외한다. 테스트 실패 뒤에도 dependency cache만 저장할 수 있으며 테스트 통과 판정에는 영향을 주지 않는다.

로컬에서는 이 CI를 대신하는 무거운 실행을 하지 않았다. Python gate/cleanup의 offline 검사와 workflow 구문 검사는 런타임 13개 통과 증거가 아니며, 실제 결과는 해당 제품 SHA의 GitHub Actions receipt로 확인한다.


명령별 자식 회수 helper는 `Popen` 생성이 끝난 뒤 그 PID를 보호한 thread를 시작한다. 명령이 실행 중일 때 helper에 입양된 종료 자식만 `waitpid(pid, WNOHANG)`으로 회수하므로, 실제 종료한 provider를 좀비 상태로 남겨 `kill(pid, 0)` 검사가 살아 있다고 오인하는 것을 막는다. 살아 있는 자식에게 신호를 보내지 않으며 직접 `Popen`의 종료 코드를 소비하지 않는다. 다음 명령·전체 정리 전에 thread stop/join을 확인하고, thread 오류나 종료 불확실은 실패 처리한다. 전역 SIGCHLD handler나 실행 중의 `waitpid(-1)` 회수는 사용하지 않는다.

작은 Linux proof는 회수 전 좀비 재현, 명령 실행 중 소멸, 직접 종료 코드 7 보존, 살아 있는 입양 자식 보존, 예외 정리·thread join, worker 밖 sibling 보존을 검사한다. 원격 준비 receipt는 고정 operation과 exit code, 필요한 다섯 tool의 missing boolean만 남겨 image pull·컨테이너 시작·tool·TLS 준비 중 실패한 지점을 구분한다. Docker 원문 출력이나 준비용 비밀 파일은 공개하지 않는다.

로컬의 작은 Linux 컨테이너 검증은 1 CPU·256 MiB·network none에서 위 child-reaper proof 전체를 통과했다. 최대 개별 child RSS는 18,860 KiB였으며 합산 peak 메모리 측정값은 아니다. 예외·worker 실패 시 외부 proof owner도 자신의 입양 자식을 정리한 뒤 임시 fixture를 제거한다. 고정된 공식 Node 이미지 digest의 별도 동일 제한 probe에서는 Node v24.14.0과 `node`·`ps`·`setsid`·`tar`·`base64` 존재를 확인했다. 이것은 CI의 원격 준비 실패 원인을 확정한 결과가 아니므로 이미지나 package를 바꾸지 않았다. 제품의 8+5 qualification 통과 여부는 수정된 helper로 같은 제품 SHA를 다시 실행한 receipt가 필요하다.


원격 fake provider는 제품의 build artifact 자체를 chmod하지 않고 helper의 private staging copy만 `0555`로 만든 뒤 복사한다. Docker copy가 호스트 UID를 유지하면 capability 없는 컨테이너 root는 다른 UID의 `0700` 파일을 chmod할 수 없다. 동일한 고정 이미지·1 CPU·256 MiB·network none의 dummy artifact probe에서 이 상태를 재현했다(호스트/복사 파일 UID 501, 실행 UID 0, CapEff 0, 기존 chmod exit 1). 정규화한 staging copy는 UID가 달라도 directory/file read+execute, 원본·staged·컨테이너 SHA-256 일치와 dummy 실행 exit 0을 확인했다. 원본 artifact의 mode·hash는 바꾸지 않았으며, 컨테이너 capability 추가·privileged 실행도 사용하지 않았다. 실제 remote 5개는 다음 qualification receipt가 필요하다.


원문을 보존하지 않는 infrastructure cause reporter를 stock JSON reporter와 병용한다. 공식 `onTestCaseResult` API의 `result().errors[].cause`를 최대 8단계·cycle guard로 읽어 root wrapper와 nested cause를 구분한다. 수집 파일도 private `0600`이며 고정 13개 title, enum class, 정확한 회귀 fixture 및 명시한 owner 파일의 상대 경로·줄·열과 제한된 primitive 비교만 저장한다. Python helper가 공개 receipt에 넣기 전에 이 필드를 다시 검증한다. 임의 message·stack·diff·객체·문자열 값·환경 변수는 저장하거나 공개하지 않는다. 파일이 없거나 reporter 수집이 실패하면 `causeDiagnosticsStatus: unavailable`로 표시하며, 기존 stock JSON의 검사 수·결과·성공 gate를 바꾸지 않는다.

별도의 작은 synthetic fixture로 실제 Vitest 5에서 stock JSON 단독/병용 모두 2개 실패를 유지하면서 두 단계 cause·소스 frame·boolean/정수 비교가 정제되는지 확인했다. 실제 제품 recovery fixture·timeout·8+5 gate는 이 smoke에서 실행하거나 수정하지 않는다.

정리 진단은 `initialCleanup`의 `reaperJoined`·`childrenCleanup`·`containerCleanup`을 구분한다. 컨테이너는 inventory·inspect·owner/ID 확인·stop·후속 inventory·remove·최종 inventory의 고정 operation, exit code, 상태 enum과 boolean만 기록한다. 자식 정리는 ECHILD·deadline·read/wait/signal error의 고정 이유와 제한된 수만 기록한다. `always()` 재시도는 `recoveryCleanup`으로 별도 기록해 최초 실패를 덮어쓰지 않는다. 이전 helper의 자식 종료가 확인되지 않았다면 새 정리 프로세스는 그 사실을 성공으로 바꾸거나 private fixture를 삭제하지 않는다.


추가 진단은 정확한 두 공개 owner source 파일(`native-session-executor.ts`, `runnerd-codex-transport.ts`)의 상대 stack 위치와 소스에서 확인한 고정 runner error-code enum만 허용한다. 알려진 code 뒤의 설명·경로·값은 버리고, 알 수 없는 code는 공개하지 않는다. 검사 사례 자체의 수집 대상은 기존 정확한 recovery fixture와 13개 title을 유지한다.

컨테이너는 자동 `--rm`과 명시적 정리를 중복 사용하지 않는다. 명시적 owner label/full ID 확인 뒤 `stop`·`rm` exit 0과 최종 부재 확인을 끝까지 수행한다. 관측된 자동 삭제 경합 때문에 실제 remove 실패를 일반 retry나 무조건 성공으로 바꾸지 않는다.


원격 command fallback의 tar 추출은 `--no-same-owner`로 archive UID/GID를 복원하지 않고 실행 사용자 소유로 staging한다. GNU의 `--delay-directory-restore`, 원래 archive 내용·mode 및 non-root `umask 077` 정책은 유지한다. 실제 exported owner 함수의 같은 inert flat payload 회귀에서 cap-drop ALL root의 수정 전 실패→수정 후 성공을 확인했으며 mutable/immutable cold, dedup, capless root/non-root의 변조된 immutable target·target 심볼릭 링크 거부, 원본 hash·mode 보존을 검사했다. 이는 remote 5개 완료 증거가 아니며 새 제품 SHA의 qualification이 필요하다.

GNU tar를 UID 0으로 capability 없이 실행할 때 중첩된 읽기 전용 archive directory 안의 파일 생성은 여전히 실패할 수 있다. 이 범위는 명시적 음성 회귀로 남기고 실패를 완료로 처리하지 않는다. 기존 BSD/non-root nested 회귀와 보조 GNU UID 1000 nested cold·dedup 실검증은 통과했다. 보조 사용자는 inert owner proof에만 적용하며 실제 recovery 13개 fixture의 root UID·cap-drop·timeout·gate는 바꾸지 않는다. 이 변경에 새 extractor, recursive chmod/chown, `-p`, `--no-same-permissions`, capability 추가는 포함하지 않는다.

일반 privileged root가 기존 읽기 전용 target을 덮어써 복구할 수 있는 기존 동작은 이 변경으로 강화하거나 막지 않는다. 새 회귀의 변조 거부 기대는 증명한 capless root와 non-root 맥락에 적용하며, 쓰기 권한이 실제로 있는 맥락에는 기존 repair 성공·내용 복원을 기대한다. 회귀는 UID만으로 권한을 추정하지 않고, 내용 변경 없는 `open(r+)`/close의 성공 또는 EACCES·EPERM을 먼저 측정해 기대 결과를 정한다.


관측이 없는 stage 실패를 시간만으로 timeout이라고 분류하지 않는다. Helper는 실제 `TimeoutExpired`에만 `host_command_timeout`과 기존 command 제한을 기록하며, stock 보고서 누락·JSON 오류·shape 오류·기타 실패를 별도 고정 enum으로 기록한다. Recovery fixture와 1,200초 제한은 바꾸지 않는다.

공식 reporter의 case ready/result·module·hook start/end마다 atomic `0600` sidecar를 갱신한다. 부분 snapshot과 최종 snapshot을 구분하며, 관측된 사례를 미시작·실행 중·종료로 나눈다. Host 제한이나 보고서 오류 때 이 부분 진단을 공개 receipt의 `partialDiagnostics`로 정제해 넣는다. 이것은 마지막 snapshot의 관측이며 OS 프로세스의 현재 상태나 작업 완료 증명이 아니다. Stock JSON이 불완전하면 부분 snapshot에 passed가 있어도 qualification PASS로 세지 않는다. 실제 tiny Vitest의 실행 종료 전 중단으로 failed/running/미시작 보존과 비밀 sentinel 미포함을 확인했다.

읽기 전용 asset directory가 있는 non-root private fixture에서 기존 `shutil.rmtree`의 PermissionError를 독립 재현했다. 이는 5d의 cleanup 관측 형태와 일치하는 메커니즘이며, 원본 CI의 예외 이름이 기록되지 않아 당시 원격 stage의 정확한 원인까지 확정하지 않는다. 새 private 정리는 reaper join·ECHILD·container 부재가 모두 확인된 뒤에만 수행한다. 예상 경로와 own UID, `O_DIRECTORY|O_NOFOLLOW` dirfd, root-parent/child device 및 Linux mount ID를 검증하고, 실제 소유 directory에만 owner 접근권을 추가한다. 파일은 chmod하지 않고 symlink는 link만 제거하며 외부 target을 따라가지 않는다. 미확인 owner·mount·경로·OS 오류는 고정 실패로 남긴다.

`privateCleanup` 결과를 기록한 뒤 receipt를 쓰므로 정리 실패도 관측된다. 가능한 한 root `owner.json`은 마지막에 제거한다. 예전 실패가 marker를 먼저 지웠거나 private 경로가 이미 없으면, 신뢰할 수 있는 최초 process/container settlement가 있을 때만 멱등 복구를 허용한다. 미확인 상태를 성공으로 바꾸지 않으며, `recoveryCleanup`은 최초 실패와 원격 실패 이력을 덮어쓰지 않는다.

수동 실행의 `diagnostic_phases`는 기본 false다. true일 때에만 별도 infrastructure setup을 private config에 추가하여 고정 5개 원격 사례의 TLS·asset·실행·finalize·후속 준비·종료, Docker 호출 순번과 sync tar/ps의 진입·반환을 관측한다. 원문 인자·명령·출력·경로·오류를 기록하지 않고 고정 phase/edge enum, 제한된 순번·시간·exit code·boolean만 `0600` atomic sidecar에 쓴다. Worker의 실제 `node:timers` unref pulse는 대기와 timer 진행 중단을 구분하는 보조 관측이며, 단독 원인 판정이나 종료 증명이 아니다.

제품 checkout과 fixture는 수정하지 않는다. 원래 server config의 root·alias·setup·pool·isolation·timeout·hooks·worker 설정과 실제 worker cwd를 보존한다. 작은 실제 Vitest stock/overlay 비교에서 setup 한 번 실행, 설정 동등성, product root cwd, 원래 Promise·인자·예외 identity, 타 검사 무관측 및 sentinel 미포함을 검증한다. 설정/config/setup/core SHA와 helper/product revision을 구분한다. 관측 wrapper 자체가 timing에 영향을 줄 수 있으므로 이 실행은 `diagnosticOnly: true`, `stockQualification: false`이고, 모든 검사가 통과해도 최종 상태는 `diagnostic_only` 및 비성공 exit다. 최종 수용에는 overlay를 끈 원래 8+5 gate의 통과가 필요하며 180초/1,200초 제한은 그대로다.

Python helper는 1,000줄을 넘지만 단일 Popen·command-scoped subreaper·owner state·최초/복구 cleanup의 실패 이력과 정리 순서를 한 흐름에서 검토하도록 유지한다. 이 상태 전이를 임의의 줄 수에 맞춰 분리하면 spawn/reaper 등록·join·ECHILD와 정리의 경계가 흩어진다. Phase wrapper와 실제 Vitest proof는 별도 작은 JavaScript 모듈로 분리했고, 추가 기능을 이유로 제품 코드나 기존 정리 흐름을 재구성하지 않는다.
