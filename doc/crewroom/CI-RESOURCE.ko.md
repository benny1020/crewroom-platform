# 이미지 CI 자원 정책

2026-10-29 확인한 완료 작업 두 개의 Buildx 로그를 비교했습니다. production 이미지 빌드와 타입 검사는 성공했고, 이후 초대 수락 스모크가 실제 HTTP `202`를 허용하지 않아 실패했습니다. 그 스모크 계약은 별도로 수정했습니다. 아래 수치는 이미지 검증 전체의 성공을 뜻하지 않습니다.

| 완료 후보 | Build 단계 전체 | 빌드·준비 잔여 시간 | 이미지 export/load | GHA 캐시 내보내기 | `CACHED` |
| --- | ---: | ---: | ---: | ---: | ---: |
| 723bdeb, run 40713387606 | 44:03 | 15:07 | 4:20 | 24:36 (55.8%) | 0회 |
| 1afaaed, run 40721201042 | 37:10 | 9:19 | 4:52 | 22:59 (61.8%) | 24회 |

빌드·준비는 전체 시간에서 두 export 구간을 뺀 값입니다. 첫 실행은 콜드 빌드였으며 Rust 의존성 컴파일 410.7초, native 컴파일 71.3초가 포함됐습니다. 두 번째는 Rust 중간 단계에 실제 캐시가 적중했습니다. Docker load 103.4초·103.9초는 이미지 export/load에 포함된 시간이므로 다시 합산하지 않습니다.

현재 정책은 기존 `cache-from: type=gha,scope=crewroom-production`을 유지하고 `cache-to`만 생략합니다. 관측된 22–25분의 캐시 수출 비용을 제거해 전체 검증을 완료하는 것이 우선입니다. 기존 캐시를 삭제하거나 새로운 registry·서비스를 추가하지 않습니다. 캐시 적중이 없으면 정상적으로 전체 빌드를 수행합니다. 새 캐시를 쓰지 않으므로 시간이 지나 캐시가 만료되면 콜드 빌드 비용이 다시 발생할 수 있습니다.

production target, 전체 타입 검사·빌드, 정확한 commit과 이미지 identity, 인증·권한·재시작·복원 검증은 유지합니다. 이미지 workflow는 같은 branch에서 실행 중인 작업을 끝내고 최신 후속 작업을 대기시키며, 기본·전체 회귀 CI의 이전 작업 취소 정책은 별도입니다.

`mode=min`은 최종 이미지 층만 저장하고 Rust 중간 층은 저장하지 않으므로, 수출 비용과 재빌드 비용을 합친 최선의 정책이라고 아직 확정하지 않았습니다. 자동으로 `min`으로 전환하지 않습니다. `ignore-error`는 캐시 실패 처리만 바꾸며 성공한 업로드 시간을 줄이지 않습니다. 기본 cache timeout이 있는 실행도 수출에 22–25분 걸렸으므로 해당 옵션을 전체 수출 시간의 하드 상한으로 해석하지 않습니다.

조회 시 저장소 캐시는 10.646 GB(9.915 GiB), 79개였고 BuildKit blob 74개가 9.294 GB였습니다. scope index 완성은 확인했지만 실제 설정 한도나 eviction 발생 자체는 확인하지 못했습니다. 이 수치만으로 cache thrashing을 확정하지 않습니다. 원문 job 로그·URL·환경 출력은 비공개 임시 파일에만 보관하며, 이 문서는 숫자와 검증 범위만 기록합니다. 후속 완료 CI의 측정 결과를 바탕으로 정책을 다시 판단합니다.

근거: [Docker cache mode](https://docs.docker.com/build/cache/backends/#cache-mode), [GHA cache 옵션](https://docs.docker.com/build/cache/backends/gha/), [GitHub cache 한도와 eviction 정책](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy).
