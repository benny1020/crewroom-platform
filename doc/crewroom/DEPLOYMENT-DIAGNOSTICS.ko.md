# 익명 readiness와 안전한 배포 실패 진단

인증 모드의 익명 `/api/health` 응답은 내부 `startupRecovery`를 숨깁니다. 서버는 recovery가 ready이면 공개 `status: "ok"`, 그 외에는 `status: "starting"`을 반환합니다. Compose probe는 HTTP 성공과 이 공개 `status === "ok"`를 함께 요구합니다. 내부 정보를 공개하거나 health 판정을 완화하지 않았습니다. smoke도 같은 공개 readiness를 확인한 뒤 exact commit과 인증·권한·지속성 계약을 검사합니다.

production image run 40703906634는 이미지 빌드/typecheck/CLI 검증 뒤 app unhealthy로 멈췄습니다. 이전 probe가 익명 응답에 없는 `startupRecovery.phase`를 요구했다는 정적 증거를 확인했습니다. 원래 실패는 보존하며, 수정 후 실제 이미지 성공은 새 CI 결과로 확인해야 합니다.

`deploy/crewroom/diagnostics.py`는 실패 후 컨테이너 정리 **전에** 실행합니다. app/db의 상태 enum, exit code, OOM 여부, restart count, healthcheck exit code와 고정된 오류 분류·시작 단계 boolean만 JSON으로 남깁니다. 앱 로그는 메모리에서 고정 allowlist pattern과 비교한 뒤 폐기합니다. 원문 줄·예외 메시지·환경 전체·컨테이너 command·bootstrap URL·토큰·healthcheck Output을 출력하거나 artifact에 저장하지 않습니다. 익명 health 진단도 HTTP 코드와 허용된 공개 status만 남깁니다.

수집이 불가능하면 고정된 `collectionErrors`로 기록합니다. 진단이 성공했다고 원래 배포 실패가 성공으로 바뀌지 않습니다. JSON 두 개만 기존 공개 증거 allowlist에 추가했으며 Buildx/cache, production target, 전체 TypeScript 검사와 registry 권한은 유지했습니다.

로컬 검증은 Docker/API/네트워크를 실행하지 않는 검사입니다. 실제 Compose의 Node probe를 fetch stub으로 실행한 7가지 상태(익명 ready, starting, unhealthy, status 누락, invalid JSON, non-2xx, 연결 실패)와 cleanup 이전 진단·artifact allowlist까지 Node 9/9 통과했습니다. Python은 sentinel 비밀이 섞인 원본 로그·state·health·수집 실패에서 비밀이 출력되지 않는 4/4 검사를 통과했습니다.

컨테이너는 내부 3100을 호스트 3118(복원 시 3119)에 매핑합니다. upstream은 loopback public URL의 포트를 내부 listen port로 다시 쓸 수 있으므로, compose는 `BETTER_AUTH_TRUSTED_ORIGINS`에도 동일한 `CREWROOM_PUBLIC_URL` 하나를 명시합니다. 실제 설정한 public origin을 유지하며 wildcard, origin 검사 해제 또는 CSRF 검사 해제를 추가하지 않습니다. 원래 origin 검사는 그대로 적용됩니다.
