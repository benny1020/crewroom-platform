# Astra · 0.15.2 르르르 리뷰

2026-10-21. 기존 캐릭터·모션 리뷰어에게 르르르의 전용 atlas, 기본값·저장 선택, 정적/서버 렌더러, 모션 키 격리, escape와 Task/Run 근거 판정을 읽기 전용으로 검토받았다. 집중 코드 범위에서 **필수 P0/P1/P2 발견 없음**이며, 독립 실행한 단위 **10/10 통과**, 실패·skip 0이다.

기존 수달·legacy ID·다른 초상 fallback을 유지하고, 정적·서버에서 canonical 캐릭터 ID를 전용 장면에 전달한다. 모션 키에 캐릭터가 들어가므로 이전 캐릭터의 노드를 새 캐릭터에 재사용하지 않는다. 전용 이미지 크기와 viewport 정의를 대조했다. Task/Run의 검사 통과 판정은 바꾸지 않았다.

최종 동결 파일 34개를 전후 대조해 승인했다. bundle `77048d67a705c0444132e0c6113f21efb43b39424a6d9dc76a0f1a49eb969e7c`는 path 정렬 후 `path + NUL + sha256 + LF`로 계산한다. 최초 bundle 직렬화 표기 차이를 수정했으며 파일별 SHA는 변경하지 않았다. 최종 결합 확인의 추가 테스트는 0개다.

최초 코드 리뷰 뒤 작성자가 브라우저 사례에 르르르의 실제 animation-play-state 확인을 추가했다. 새로고침 뒤 멈춘 시연을 재개하고 모션 버튼 상태를 확인하도록 검사 전제도 명시했다. 최종 코드·문서·asset·캡처·검증 영수증은 [동결 파일 목록](../evidence/0.15.2/reviewed-files.json)으로 대조한다.

리뷰어는 브라우저·배포·복원 검사, GIF 전체 프레임, 실모델 품질을 독립 검증하지 않았다. 공개 시연은 합성 업무 목업이며 서버용 캐릭터 선택기는 추가하지 않았다. 정확한 커밋의 전체 Linux CI·Pages 결과는 [GitHub Actions](https://github.com/benny1020/crewroom-platform/actions/workflows/verify-and-deploy.yml)에서 확인한다.
