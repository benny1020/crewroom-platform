# EC2 한 대에 Crewroom과 PostgreSQL 배포

`deploy/crewroom/compose.yaml`은 전체 Paperclip 기반 앱을 upstream Dockerfile의 **production** target으로 빌드하고 PostgreSQL 17 컨테이너와 함께 실행한다. 별도의 Crewroom worker나 task DB는 만들지 않는다. 선택한 Caddy 프로필이 HTTPS를 제공한다.

이 구성의 기본 프로젝트 이름은 `crewroom-next`, HTTP 포트는 `127.0.0.1:3118`이다. 기존 Compose 프로젝트와 볼륨을 재사용하지 않는다. PostgreSQL에는 host port가 없고 내부 network에서만 접근한다.

## 준비와 첫 실행

Linux EC2에 Docker Engine과 Compose v2, Python 3, Git을 준비한다. 전체 소스·CLI·Rust runner를 빌드하므로 여유 디스크와 메모리가 필요하다. 처음에는 4 vCPU/16 GiB 메모리와 40 GiB 이상의 여유 디스크를 확보하고 실제 사용량에 따라 조정한다. 이는 부하 시험으로 보장한 최소 사양이 아니다.

이미지 빌드는 기본적으로 Rust compiler job을 1개, server Node heap을 2048 MiB로 제한한다. `CARGO_BUILD_JOBS`, `BUILD_NODE_HEAP_MB` build ARG로 명시적으로 바꿀 수 있다. host 여유 메모리와 Docker VM의 메모리 한도는 다르다. 8 GiB Docker VM에서 3072 MiB heap으로 수행한 로컬 빌드는 server TypeScript 단계에서 exit 137로 중단됐으며, 빌드 성공 증거로 취급하지 않는다. 소스의 전체 타입 검사를 생략하는 옵션은 추가하지 않는다. 이후 의존성 확인에서 TypeScript 7.0.2의 `tsc`가 native Go 실행 파일로 전환됨을 확인했다. 따라서 Node heap ARG 변경은 이 compiler의 메모리를 제한한 검사가 아니었다.

같은 로컬 VM의 2048 MiB 재시도도 같은 단계에서 exit 137로 중단됐다. 새 compiler 근거에 따라 build stage에만 `BUILD_GOMAXPROCS=2`, `BUILD_GOMEMLIMIT=3GiB`를 추가했다. 이 값은 [Go runtime](https://pkg.go.dev/runtime#hdr-Environment_Variables)의 병렬 실행과 soft GC memory target을 조정하며 hard RAM 한도를 보장하지 않는다. runtime app 환경에는 적용하지 않는다. 이 변경 후의 검증은 아래 기록과 CI 실행 결과로 구분한다. `Crewroom production image` workflow가 native Ubuntu runner에서 4096 MiB heap과 전체 타입 검사를 사용해 이미지를 만들고 아래 authenticated 스모크를 수행한다. 이 CI가 통과하기 전에는 이미지 빌드·Docker 기동·복구가 검증됐다고 보지 않는다. CI 컨테이너 검증과 EC2/domain/TLS 실배포는 다른 증거다.

저장소 루트에서 실행한다.

```sh
python3 deploy/crewroom/setup.py
docker compose --env-file deploy/crewroom/.env -f deploy/crewroom/compose.yaml config --quiet
docker compose --env-file deploy/crewroom/.env -f deploy/crewroom/compose.yaml build --build-arg BUILD_NODE_HEAP_MB=4096 app
docker compose --env-file deploy/crewroom/.env -f deploy/crewroom/compose.yaml up -d --wait app
```

setup은 서로 독립된 DB 암호·세션/agent JWT/tool-action 서명 키를 owner-only `.env` 파일에 작성한다. 기존 파일은 덮어쓰지 않는다. `.env`를 Git에 추가하거나 채팅/로그에 붙여 넣지 않는다. 재시작과 복원에서 같은 키를 유지한다. `config`를 확인할 때에는 secret이 펼쳐지는 일반 출력 대신 `config --quiet`를 사용한다.

앱은 `authenticated`로 실행된다. 기본 private 노출에서는 SSH tunnel을 열고 `http://localhost:3118`에서 가입·로그인 후 화면의 첫 관리자 claim을 완료한다.

```sh
ssh -L 3118:127.0.0.1:3118 operator@your-ec2-host
```

서버의 최초 관리자 claim은 bootstrap 조건을 검사한다. 팀 구성원을 추가할 때에는 앱의 사람 초대 기능을 사용한다. 가입 허용 자체가 회사 membership이나 관리자 권한을 부여하지 않는다. 별도 공개 가입을 막으려면 초기 관리자 생성 후 `.env`의 `CREWROOM_DISABLE_SIGN_UP=true`를 설정하고 앱을 다시 생성한다. 초대받은 신규 계정의 가입도 이 설정의 영향을 받으므로 계정 생성/초대 흐름을 운영 정책과 함께 확인한다.

## 도메인과 HTTPS

도메인의 DNS를 EC2로 향하게 하고 security group에서 HTTPS용 80/443을 허용한다. 앱의 3118이나 DB 5432를 인터넷에 열 필요는 없다. `.env`에 다음을 반영한다.

```dotenv
CREWROOM_DOMAIN=crewroom.example.com
CREWROOM_PUBLIC_URL=https://crewroom.example.com
CREWROOM_EXPOSURE=public
```

public 모드에서는 private 모드의 브라우저 bootstrap claim이 꺼진다. 먼저 private+SSH tunnel에서 최초 관리자를 claim한 뒤 public으로 전환하는 경로를 권장한다. 처음부터 public으로 실행하면 upstream CLI의 일회용 bootstrap invite를 사용한다.

```sh
docker compose --env-file deploy/crewroom/.env -f deploy/crewroom/compose.yaml exec app pnpm paperclipai auth bootstrap-ceo
```

이 명령이 출력하는 일회용 URL은 소유권 부여 수단이므로 본인에게만 보이는 터미널에서 사용한다. 앱과 proxy를 시작한다.

```sh
docker compose --env-file deploy/crewroom/.env -f deploy/crewroom/compose.yaml --profile https up -d --wait
```

기본 loopback HTTP 포트는 SSH 진단용으로 유지된다. Caddy의 `/data`와 `/config`는 별도 named volume으로 지속된다. 도메인·TLS 인증서·EC2 실배포는 실제 대상에서 별도 확인해야 한다.

## 저장과 정상 종료

`<project>_postgres`에는 DB가, `<project>_appdata`에는 `/paperclip` 전체가 저장된다. 후자는 암호화 secret master key, 설정, 업로드, agent home, 세션 및 workspace 파일을 포함한다. DB만 복원해서는 전체 작업 상태를 복원했다고 할 수 없다. DB와 앱 데이터 및 signing secrets를 함께 보존한다.

앱은 image의 tini와 upstream shutdown을 사용한다. Compose는 앱 PID 한도 2048, 90초 종료 유예, health check와 `unless-stopped` 재시작을 설정한다. health의 `startupRecovery.phase=ready`는 API startup 완료를 뜻하며 Claude 연결이나 작업 성공의 증거가 아니다.

```sh
docker compose --env-file deploy/crewroom/.env -f deploy/crewroom/compose.yaml ps
curl --fail http://localhost:3118/api/health
docker compose --env-file deploy/crewroom/.env -f deploy/crewroom/compose.yaml restart app
```

`down`은 컨테이너/network만 제거한다. **`down -v`는 영속 데이터를 삭제**하므로 정상 재시작/업데이트 명령으로 사용하지 않는다. 소스를 업데이트하기 전에는 snapshot을 만들고 기존 image tag/digest를 기록한다. schema migration 이후 예전 image로만 되돌리는 방식은 호환성을 보장하지 않는다.

## 일관된 백업과 새 프로젝트로 복원

snapshot 도구는 앱을 정상 종료해 쓰기를 멈추고 PG custom dump, `/paperclip` archive, 배포 secret 파일과 SHA-256 manifest를 생성한 뒤 원래 실행 중이었던 앱을 다시 시작한다. 백업 디렉터리는 owner-only다. 외부 agent/runtime가 `/paperclip`에 직접 쓰는 별도 구성을 추가했다면 그것도 먼저 멈춰야 한다. 진행 중인 외부 서비스 작업까지 스냅샷이 원자적으로 되돌리는 것은 아니다.

```sh
python3 deploy/crewroom/snapshot.py backup ./backups/crewroom-20261028 --project crewroom-next
```

완성된 백업은 암호화하여 별도 저장장치나 접근 제한된 object storage에 복사한다. 백업 자체에 개인 대화·파일·키가 들어 있다. 같은 EC2 디스크의 복사본만으로 디스크 손실에 대비했다고 볼 수 없다. 정기 실행은 운영자가 정한 주기와 저장 정책으로 이 명령을 예약한다. 샘플에서는 DB-only 자동 백업을 꺼 두어 전체 snapshot과 혼동하지 않게 했다.

복원은 **새 Compose 프로젝트와 빈 볼륨**만 허용한다. 원본 프로젝트와 기존 대상 볼륨은 변경하지 않는다. snapshot의 `.env`를 새 owner-only 파일로 복사하고 port/URL만 바꾼다. DB 암호와 signing secrets는 보존한다.

```sh
cp ./backups/crewroom-20261028/deployment.env ./deploy/crewroom/.env.restore
chmod 600 ./deploy/crewroom/.env.restore
# .env.restore: CREWROOM_PORT=3119, CREWROOM_PUBLIC_URL=http://localhost:3119
python3 deploy/crewroom/snapshot.py restore ./backups/crewroom-20261028 \
  --env-file ./deploy/crewroom/.env.restore --project crewroom-restored
curl --fail http://localhost:3119/api/health
```

복원된 계정으로 로그인하고 같은 agent/task/chat IDs, private 접근 권한, 파일 다운로드와 secret 해독을 확인한 후 실제 작업을 재개한다. 외부 발행·원격 작업이 있었다면 remote receipt와 실행 상태를 먼저 대조한다. 일반적인 DB 복원만으로 중복 외부 작업 방지까지 증명하지 않는다.

## 검증 전용 authenticated 스모크

`smoke.py`는 **새로 만든 검증 인스턴스**에서만 사용한다. `seed`는 테스트 계정 두 개, 최초 관리자, 검증 팀과 실행을 끈 process agent, private 대화와 파일 marker를 만든다. 초대는 로컬 API로 수락하며 실제 메일이나 모델을 호출하지 않는다. 테스트용 암호와 식별자는 지정한 owner-only state 파일에 저장한다. 기존 인스턴스나 실제 사용 팀에 실행하지 않는다.

```sh
python3 deploy/crewroom/smoke.py seed --state-file .paperclip/container-smoke.json
# app 재시작 후 또는 새 프로젝트로 snapshot 복원 후
python3 deploy/crewroom/smoke.py check --state-file .paperclip/container-smoke.json
python3 deploy/crewroom/smoke.py check --base http://localhost:3119 --state-file .paperclip/container-smoke.json
```

두 사용자의 실제 인증 세션으로 개인 대화 상세·목록·첨부 파일과 viewer 쓰기 제한을 확인하고 파일 checksum을 대조한다. state 파일, snapshot, 환경 파일, 인증 응답과 원문 앱 로그는 공개 CI artifact에 포함하지 않는다. 이 검사는 실제 모델 추론이나 독립 사용자별 런타임 격리 검사가 아니다.

## Claude custom endpoint 설정

agent의 기존 runtime/connection 설정과 secret binding을 사용한다. Claude adapter env에서 `ANTHROPIC_BASE_URL`에 endpoint origin을, `ANTHROPIC_API_KEY` 또는 `ANTHROPIC_AUTH_TOKEN`에는 secret reference를 지정하고 서버가 허용한 model alias를 선택한다. API key를 agent metadata·홈 화면·Git·브라우저 localStorage에 복사하지 않는다. 컨테이너의 `localhost`는 EC2 host가 아니라 해당 컨테이너이므로 실제 접근 가능한 endpoint를 사용한다.

설정 저장/환경 probe 성공은 실제 추론 호환성의 증거가 아니다. 별도 테스트 작업으로 streaming, tool loop, 파일 산출물, cancel/resume, timeout/error/usage를 확인한 뒤 연결 완료로 취급한다. 자격증명 없는 현재 설치는 추론 검증 전 상태다.

## 현재 실행 격리의 한계

이 구성의 local CLI adapter는 앱 컨테이너 안에서 실행된다. 따라서 agent runtime와 control-plane DB 연결/secret 저장소가 같은 OS/container 신뢰 경계를 공유한다. **신뢰할 수 없는 코드의 job 격리나 사용자별 독립 파일/기억 격리를 제공하는 배포가 아니다.** 같은 이미지에 이름만 runner인 서비스를 추가해도 그 경계가 생기지 않는다. 신뢰할 수 없는 작업을 허용하려면 upstream의 실제 remote sandbox/runner 계약과 credential scope, 파일 전달, 철회·재개 경계를 별도로 구현·검증해야 한다.

GitLab 발행, 실제 provider 추론, 사용자별 독립 비서 memory, policy snapshot 복원 후 외부 실행 재개는 이 Compose 파일의 완료 범위에 포함되지 않는다.
