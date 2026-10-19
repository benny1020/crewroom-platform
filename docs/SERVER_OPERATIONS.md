# 서버 실행과 운영 · 0.13.1

실제 코드 실행의 이미지·검사·중단 계약은 [실행 운영 안내](CODE_EXECUTION.md)를 함께 따른다. 첫 설치는 `docker compose --profile images build app runner job-image`로 Job 이미지를 먼저 준비한다.

기본 배포는 한 서버의 Docker Compose다. App/Worker/Runner는 같은 release를 사용하고 DB는 PostgreSQL 18을 사용한다. 읽기 전용 분석과 별도 Runner의 격리 코드 실행을 지원한다. [장기 운영·긴 대화·보관 경계](LONG_TERM_OPERATIONS.md)를 함께 따른다.

## 시작·확인·종료

README의 비밀 파일 생성→Compose 기동→첫 팀장 발급 순서로 시작한다.

```bash
docker compose ps
curl --fail http://localhost:4180/api/ready
docker compose logs --tail 100 app worker runner
docker compose stop
```

`health`는 프로세스 응답, `ready`는 DB와 복원 완료 여부다. Worker 상태·heartbeat는 팀 관리 화면에서 확인한다. 모델 URL·모델 ID가 없거나 endpoint에서 요구하는 인증이 없으면 실제 모델 실행은 성공하지 않는다. 인증이 필요 없는 커스텀 endpoint는 빈 키 파일을 사용할 수 있다. 컨테이너 PID만으로 업무 성공을 판단하지 않는다.

DB는 외부 포트를 열지 않는다. App만 기본 loopback에 바인딩한다. App/Worker는 non-root, read-only root filesystem, no-new-privileges, capability 제거로 실행한다. Worker에 Docker socket·호스트 홈·개인 도구 자격증명을 마운트하지 않는다. init-data 작업만 named volume 권한 초기화를 위해 제한된 CHOWN/FOWNER를 가진다. PostgreSQL 18 volume은 `/var/lib/postgresql`에 마운트한다.

## 계정과 역할

초기 첫 팀장은 `bootstrap`, 이후 구성원은 `member` CLI로 발급한다. 비밀번호는 stdin 또는 접근 제한 파일로만 전달한다. 부서는 운영자가 정한다. 공개 가입 API는 403이며 이메일 allowlist만으로 신원을 보장하지 않는다.

팀원은 팀장 권한을 요청할 수 있으나 승인 전에는 일반 팀원이다. 기존 팀장이 구성원의 역할/부서/활성 상태를 바꾼다. 비활성화하면 기존 세션도 폐기한다. 마지막 활성 팀장을 없앨 수 없다. 본인 비밀번호 변경 UI와 운영자 reset-password CLI를 제공하고 변경 시 기존 세션을 폐기한다. 이메일 재설정·SSO·이메일 인증은 후속 기능이다. 데이터 소유권 이전은 별도 운영 작업으로 검토한다.

## 모델 설정과 변경

`.env`의 `MODEL_PROVIDER=anthropic`(Claude Messages) 또는 `openai-compatible`, 전체 `MODEL_ENDPOINT_URL`(또는 API root `MODEL_BASE_URL`), `MODEL_NAME`과 비밀 파일 `model_api_key`를 설정한다. 모델 endpoint·GitLab·HTTPS proxy는 [연결 설정 안내](CONFIGURATION.md)를 따른다. endpoint는 팀이 승인한 제공자여야 한다. 모델은 도구 없는 JSON 응답을 지원해야 한다. 처음에는 작은 실제 업무 하나를 실행하고 receipt·결과 형식·미확인 사항·지출을 직접 확인한다. 로컬 테스트 fixture 통과를 이 검증으로 대체하지 않는다.

진행 중 Run은 provider endpoint/model profile을 고정한다. 설정을 바꾸면 기존 queued Run은 새 endpoint로 자료를 보내지 않고 `PROVIDER_PROFILE_CHANGED`로 실패한다. 책임자가 새 실행을 준비한다. 키 교체 시 비밀 파일을 갱신하고 App/Worker를 재생성한다. 키 값을 로그·Git·채팅에 남기지 않는다.

## HTTPS 운영 배포

도메인의 DNS를 운영 서버에 연결하고 `.env`에 다음 값을 설정한다. 모델 키와 DB/백업 키는 서버에서 별도로 준비한다.

```dotenv
NODE_ENV=production
PUBLIC_ORIGIN=https://crewroom.example.com
SITE_ADDRESS=crewroom.example.com
```

```bash
docker compose -f compose.yaml -f deploy/compose.production.yaml up -d --build
```

Caddy가 80/443을 사용한다. 방화벽에서 80/443만 팀 정책에 맞게 허용하고 DB·App 내부 포트를 직접 공개하지 않는다. 운영 origin은 trailing slash 없는 정확한 HTTPS origin이어야 한다. 실제 도메인·공인 서버·TLS 발급·실사용 계정은 이번 로컬 검증 범위가 아니다.

## 백업

저장 대상은 DB와 Run 입력을 포함한 runtime volume이다. Runner의 별도 state volume은 백업·복원하지 않으며, 종료된 Job의 checkpoint는 DB/runtime에 보존한다. `backup_key`는 32-byte key의 64자리 hex 파일이다. 키를 잃으면 복원할 수 없다. DB/모델 비밀은 백업 archive에 포함하지 않으므로 별도 보관한다.

```bash
node scripts/backup.mjs /secure-backups/crewroom-20261017 .local/secrets/backup_key
```

현재 Compose 프로젝트의 App/Worker를 정상 정지하고 Job 종료/checkpoint를 확인한 뒤 Runner도 정지한다. DB dump + runtime tar를 만든다. AES-256-GCM으로 암호화한 파일과 SHA-256 manifest를 남기고 평문 임시 파일을 제거한다. 기존 실행 중이던 서비스만 다시 시작한다. 목적지는 새 디렉터리여야 한다. 완성된 백업과 키를 서로 분리해 서버 밖으로 옮기고 복원 훈련을 반복한다. 자동 외부 백업 업로드·스케줄링은 이번 구현에 포함하지 않는다.

업무량에 따른 RPO/RTO는 운영 실측으로 정한다. App/Worker가 중단된 동안 요청을 받지 못한다. 대용량 무중단 백업·WAL/PITR은 제공하지 않는다.

## 빈 서버 복원

원래 서버의 Worker가 종료됐는지 먼저 확인한다. 백업 manifest가 지원하는 release의 코드와 새 Compose project·빈 DB/새 runtime volume을 사용한다. 이 명령은 기존 테이블이 있거나 App/Worker가 실행 중이면 거부한다.

```bash
# .env 및 비밀 파일을 준비한 새 checkout/서버에서 실행
COMPOSE_PROJECT_NAME=crewroom-restored docker compose up -d db init-data
COMPOSE_PROJECT_NAME=crewroom-restored node scripts/restore.mjs /secure-backups/crewroom-20261017 .local/secrets/backup_key --confirm-empty
COMPOSE_PROJECT_NAME=crewroom-restored docker compose up -d
```

복원 전에 checksum·GCM 인증을 검사한다. DB import·모든 세션 폐기·미완료 Run 격리를 하나의 DB transaction으로 커밋한다. runtime 파일 복원까지 성공해야 `restore_blocked`를 해제한다. 파일 복원이 실패하면 App/Worker startup과 API를 차단한다. 실패한 훈련용 target은 제거하고 **새 빈 target에 다시 복원**한다. 운영 volume을 임의로 삭제하지 않는다.

복원한 queued/running/paused Run은 `RESTORE_CONFIRMATION_REQUIRED`로 남는다. 웹의 일반 종료 확인으로 풀 수 없다. source Worker의 종료와 외부 요청 상태를 확인한 운영자가 다음 CLI를 사용한다.

```bash
docker compose run --rm --no-deps -v "$PWD/.local/operator-evidence.txt:/run/operator-evidence.txt:ro" worker node server/cli.js confirm-stopped RUN_UUID /run/operator-evidence.txt
```

근거 파일을 컨테이너에 임시 read-only 마운트해 실행하거나 로컬 CLI에 `DATABASE_URL_FILE`을 설정한다. 본문·비밀이 없는 종료 증거를 기록한다. CLI 출력은 불투명 Run ID와 cleared 여부뿐이며 감사 이벤트에는 근거 파일의 해시를 저장한다. 운영자라도 다른 사람의 개인 업무 본문 접근 권한은 생기지 않는다.

## 장애와 재개

| 상태                                                                                            | 조치                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `MODEL_NOT_CONFIGURED` / `MODEL_AUTH_REJECTED` / `MODEL_RATE_LIMITED` / `MODEL_ENDPOINT_FAILED` | 설정·키·지원 형식을 확인하고 책임자가 다시 요청                 |
| `CONTEXT_REVOKED`                                                                               | 기억 정정·삭제·소속 변경을 반영한 새 실행 준비                  |
| `LEASE_EXPIRED`                                                                                 | 이전 Worker 종료 확인. 자동 재발송하지 않음                     |
| `DISPATCH_UNKNOWN` / 미해결 intent                                                              | 외부 제공자의 요청 처리 상태와 Worker 종료를 확인한 뒤 운영 CLI |
| `RESTORE_CONFIRMATION_REQUIRED`                                                                 | 원래 실행 종료 확인 후 운영 CLI                                 |
| `RESTORE_INCOMPLETE`                                                                            | 파일 복원 실패 원인 확인, 새 빈 target에서 전체 복원            |
| migration hash 불일치                                                                           | 적용한 SQL 수정 금지. 새 migration 작성·일치한 release 사용     |

일시정지·취소는 이미 외부에 보낸 내용을 회수하지 않는다. 중지 이후 결과 게시를 막고 발송 불명 상태를 보존한다. 외부 요청과 DB 사이의 exactly-once는 보장하지 않는다.

## 릴리스

백업→동일 release App/Worker 정지→이미지 빌드→migration→기동→ready/Worker heartbeat→작은 업무 검증 순으로 배포한다. DB migration은 advisory lock과 적용 파일 hash로 보호한다. 이전 이미지로 되돌리기만 해서 DB가 역변환되지는 않는다. 되돌리기는 호환성을 검토하거나 새 빈 DB에 백업을 복원한다. CI에는 모델 키를 넣지 않는다.

GitLab adapter를 포함한 코드로 기존 설치를 업데이트할 때는 빌드 전에 `npm run secrets:init`를 다시 실행한다. 기존 DB/모델/백업 비밀값은 보존하고 새 `gitlab_token` 빈 파일만 추가한다. Compose가 파일을 마운트하므로 GitLab을 사용하지 않는 설치에도 이 단계가 필요하다. GitLab을 쓸 때만 해당 파일에 접근 token을 설정한다.

비밀번호는 상단 메뉴에서 변경한다. 운영자 초기화는 다음처럼 파일/stdin으로 전달한다. 모든 세션이 폐기된다.

```bash
docker compose exec -T app node server/cli.js reset-password member@example.com - < .local/secrets/member_password
npm run doctor
```

백업은 App/Worker를 먼저 정지하고 Worker 권한으로 남은 Job의 checkpoint를 DB에 저장한 뒤 Runner를 정지한다. namespace의 살아 있는 Job이 하나라도 남으면 백업을 거절한다. 수동 갱신도 Worker→Runner 순으로 정지하고 Runner→Worker 순으로 시작한다.

0.6은 `init-secrets`가 호스트의 0600 파일을 서비스별 읽기 전용 비밀 볼륨으로 복사한다. 키 파일 변경 후에는 `docker compose run --rm --no-deps init-secrets`로 다시 준비하고 해당 서비스를 재시작한다. App에는 Runner token을 넣지 않는다.

`npm run doctor`는 App의 현재 release/ready, migration hash, 최근 정상 Worker tick과 모델 설정을 검사한다. GitLab·Runner는 기본 진단에 필요 없다. 코드 실행을 쓸 때 `npm run doctor -- --code`로 두 구성의 준비도 추가 검사한다. 모델 추론·저장소 접근권은 직접 호출하지 않으며 URL·키·제공자 오류 본문을 출력하지 않는다. 실제 호출·평가·첫 업무 순서는 [사용 준비 안내](READINESS.md)를 따른다.
