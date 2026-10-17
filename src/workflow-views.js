import {
  WORK_TYPES,
  relatedWork,
  canReadTask,
  canOperateTask,
  canInterveneTask,
  visibilityOf,
} from "./workflow-domain.js";

const audience = (value) =>
  ({ team: "팀 공유", department: "내 부서", private: "나만" })[value];
const time = (value) =>
  value
    ? new Date(value).toLocaleString("ko-KR", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "시연 기록";
export const intakeDraft = (state) =>
  (state.intakeDrafts[state.user] ||= {
    workType: "pr-qa",
    target: "",
    targetVersion: "",
    visibility: "team",
    project: "제품 웹",
    goal: "",
    body: "",
    source: "",
  });

export function officeDesk(state, h) {
  const { esc, icon, button } = h;
  const tasks = state.tasks
    .filter((t) => t.workflow && canReadTask(state, t))
    .slice(0, 3);
  return `<section class="cw-desk" aria-label="공용 업무 접수"><div class="cw-desk-intro"><span class="cw-desk-symbol">${icon("git-pull-request")}</span><div><h2>어떤 일을 함께 이어갈까요?</h2><p>업무 대상을 넣으면 담당 동료와 공통 기준을 준비해요.</p></div></div><div class="cw-desk-actions">${button("새 업무 시작", "flow-intake", "", true, "plus")}${button("기존 결과 가져오기", "flow-import", "", false, "file-check-2")}</div></section>${tasks.length ? `<section class="cw-recent" aria-label="이어서 볼 공유 업무"><div class="cw-section-heading"><h2>지금 이어받을 업무</h2><span>같은 업무방에서 근거와 다음 행동을 확인하세요</span></div>${tasks.map((t) => `<button class="cw-recent-row" data-action="open-task" data-id="${t.id}"><span class="cw-work-mark">${icon(WORK_TYPES[t.workType]?.icon || "layers")}</span><span class="cw-recent-title"><strong>${esc(t.title)}</strong><small>${esc(t.targetVersion)} · ${esc(state.members[t.responsible]?.name)} 담당 · ${audience(visibilityOf(t))}</small></span><span class="cw-next-action">${esc(nextAction(t))}</span>${icon("chevron-right")}</button>`).join("")}</section>` : ""}`;
}
function nextAction(task) {
  if (task.status === "result_ready")
    return task.stepIndex < task.steps.length - 1
      ? "검토 결과 확인 · QA로 인계"
      : "결과 수용 또는 재작업";
  return (
    {
      queued: "입력 확인 · 시연 시작",
      running: "샘플 결과 작성 중",
      paused: "책임자의 재개 대기",
      done: "수용한 결과 · 다음 업무에 재사용",
      cancelled: "중단됨 · 재작업 가능",
    }[task.status] || "업무 내용 확인"
  );
}

export function intakePage(state, h) {
  const { esc, icon, button, avatar } = h;
  const draft = intakeDraft(state),
    importing = state.intakeMode === "import",
    type = WORK_TYPES[draft.workType] || WORK_TYPES["pr-qa"];
  const field = (label, name, value, extra = "") =>
    `<label class="g-field"><span>${label}</span><input class="g-input" name="${name}" value="${esc(value)}" ${extra}></label>`;
  const crew = type.steps
    .map((step) => {
      const a = state.agents.find((a) => a.id === step.agentId);
      return `<div class="cw-plan-person">${avatar(a.name, a.color, true, a.id)}<div><strong>${esc(a.name)}</strong><span>${step.name}</span></div></div>`;
    })
    .join(`<span class="cw-plan-arrow">${icon("arrow-right")}</span>`);
  if (state.intakeStep === "review") {
    const related = relatedWork(state, draft);
    return `<div class="g-breadcrumb">팀 오피스 / 업무 접수</div><div class="g-page-head"><div><h1>이 내용으로 함께 시작해요</h1><p class="g-page-sub">대상과 공유 범위를 확인해주세요. 다른 업무와 자동으로 합치지 않아요.</p></div>${button("입력 수정", "flow-edit-intake", "", false, "pencil")}</div><div class="cw-intake-layout"><section class="cw-paper"><div class="cw-section-heading"><h2>${importing ? "선택한 결과 공유" : esc(type.name)}</h2><span class="g-pill">${audience(draft.visibility)}</span></div><dl class="cw-facts"><div><dt>업무 대상</dt><dd>${esc(draft.target)}</dd></div><div><dt>대상 버전</dt><dd>${esc(draft.targetVersion)}</dd></div><div><dt>프로젝트</dt><dd>${esc(draft.project)}</dd></div><div><dt>요청과 완료 기준</dt><dd>${esc(draft.goal || type.done)}</dd></div></dl>${importing ? `<div class="cw-import-preview"><strong>공개될 결과</strong><p>${esc(draft.body)}</p><small>출처: ${esc(draft.source)}</small><p class="cw-notice">외부에서 작성됨 · 크루룸에서 미검증. 개인 대화와 파일 전체는 가져오지 않아요.</p></div>` : ""}<div class="cw-commit-bar"><span>요청자 · 책임자<br><strong>${esc(state.members[state.user].name)}</strong></span>${button(importing ? "공유 업무방 만들기" : "업무 접수하기", "flow-create", "", true, "arrow-right")}</div><p class="g-error" data-flow-error role="alert"></p></section><aside class="cw-intake-aside"><section class="cw-paper"><h2>같은 대상을 다룬 업무</h2><p class="g-small g-muted">목적·버전·공개 범위를 비교하고 직접 선택하세요.</p>${related.map(({ task, same }) => `<button type="button" class="cw-related" data-action="open-task" data-id="${task.id}"><strong>${esc(task.title)}</strong><small>${esc(task.targetVersion)} · ${audience(visibilityOf(task))}</small><span>${same ? "같은 조건 · 기존 업무 이어가기" : "조건이 달라요 · 내용 확인"}</span></button>`).join("") || '<p class="cw-empty-note">접근 가능한 관련 업무가 없어요.<br>새 업무로 시작할 수 있어요.</p>'}</section><div class="cw-guide">${icon("users-round")}<p>같은 업무방에 참여하면 대화·결과·확인할 사항을 함께 봅니다. 실행 조작은 현재 책임자가 맡아요.</p></div></aside></div>`;
  }
  return `<div class="g-breadcrumb">팀 오피스 / ${importing ? "기존 결과 가져오기" : "새 업무"}</div><div class="g-page-head"><div><h1>${importing ? "이 결과부터 함께 이어가요" : "대상을 알려주면, 동료가 이어갈게요"}</h1><p class="g-page-sub">${importing ? "공유할 내용만 선택하세요. 원래 개인 세션은 그대로 남아요." : "필요한 결과를 고르고 업무 대상을 넣어주세요."}</p></div>${button("팀 오피스", "navigate", 'data-view="office"', false, "arrow-left")}</div><div class="cw-intake-layout"><section class="cw-paper"><form data-form="flow-intake"><div class="cw-work-types" role="group" aria-label="필요한 결과">${Object.entries(
    WORK_TYPES,
  )
    .filter(([id]) => !importing || id === "pr-qa")
    .map(
      ([id, value]) =>
        `<label class="cw-work-type ${draft.workType === id ? "is-selected" : ""}"><input type="radio" name="workType" value="${id}" ${draft.workType === id ? "checked" : ""}>${icon(value.icon)}<strong>${value.name}</strong><small>${value.description}</small></label>`,
    )
    .join(
      "",
    )}</div>${field("업무 대상 링크 또는 이름", "target", draft.target, 'required maxlength="500" placeholder="예: https://github.com/example/product/pull/124"')}<div class="g-fields-two">${field("대상 커밋 또는 관측 버전", "targetVersion", draft.targetVersion, 'required maxlength="80" placeholder="예: a81f9c2"')}${field("프로젝트", "project", draft.project, 'required maxlength="80"')}</div><label class="g-field"><span>요청할 내용</span><textarea class="g-input" name="goal" maxlength="500" placeholder="특히 확인할 범위나 완료 기준을 알려주세요.">${esc(draft.goal)}</textarea></label>${importing ? `<label class="g-field"><span>공유할 결과 내용</span><textarea class="g-input cw-import-text" name="body" required maxlength="5000" placeholder="팀에 전달할 결과만 붙여넣어 주세요.">${esc(draft.body)}</textarea></label><label class="cw-file-picker">${icon("file-check-2")} 텍스트·Markdown 파일에서 선택<input type="file" id="cw-import-file" accept=".txt,.md,text/plain,text/markdown"></label>${field("결과 출처", "source", draft.source, 'required maxlength="500" placeholder="예: 개인 검토 결과 · 작성일 / 원문 링크"')}` : ""}<label class="g-field"><span>공개 범위</span><select class="g-input" name="visibility" aria-label="공개 범위">${["team", "department", "private"].map((value) => `<option value="${value}" ${value === draft.visibility ? "selected" : ""}>${audience(value)}</option>`).join("")}</select><small class="g-field-help">요청·대화·산출물에 같은 범위를 적용해요.</small></label>${draft.exampleId ? '<p class="cw-notice">수용한 결과의 완료 기준을 참고해요. 이전 검사 결과와 승인은 복사하지 않아요.</p>' : ""}<p class="g-error" data-flow-error role="alert"></p><div class="cw-form-footer"><span>로컬 목업 · 실제 저장소 연결 전</span><button class="g-button g-primary" type="submit">${importing ? "공유할 내용 확인" : "요청 확인"} ${icon("arrow-right")}</button></div></form></section><aside class="cw-intake-aside"><section class="cw-assignment"><h2>함께할 동료</h2><div class="cw-plan-crew">${crew}</div><p>${esc(type.done)}</p><div class="cw-plan-boundary">${icon("lock-keyhole")} 요청한 업무 안에서 같은 버전과 결과를 이어가요.</div></section><section class="cw-guide">${icon("sparkles")}<div><strong>스킬은 미리 준비돼 있어요</strong><p>공용 업무 기준을 적용합니다. 특정 동료와 직접 대화하는 경로도 그대로 사용할 수 있어요.</p></div></section></aside></div>`;
}

function artifactView(artifact, h) {
  const { esc, button } = h;
  return `<article class="cw-artifact"><div class="cw-section-heading"><h3>${esc(artifact.title)} <small>v${artifact.version}</small></h3><span class="g-pill ${artifact.acceptedBy ? "green" : "amber"}">${artifact.acceptedBy ? "수용됨" : "내용 확인 필요"}</span></div><p class="cw-provenance">${artifact.origin === "external" ? "외부에서 작성됨 · 크루룸에서 미검증" : "시뮬레이션 결과 · 실제 검사 미실행"} · 대상 ${esc(artifact.targetVersion)}</p><p class="cw-artifact-body">${esc(artifact.body)}</p><div class="cw-evidence">${(artifact.evidence || []).map((e) => `<span>${esc(e.label)}</span>`).join("")}<span>구조: ${artifact.structure === "valid" ? "샘플 형식 충족" : "외부 초안"}</span><span>사실 검증: 미확인</span></div>${button("출처와 버전 보기", "flow-source", `data-id="${artifact.taskId}" data-source="${artifact.id}"`, false, "history")}</article>`;
}

export function workflowDetail(state, task, h) {
  const { esc, icon, button, avatar, status, taskDiscussion, executionPanel } =
    h;
  const operator = canOperateTask(state, task),
    manage = operator || canInterveneTask(state, task),
    step = task.steps[task.stepIndex];
  const artifacts = task.artifactIds
    .map((id) => state.artifacts.find((a) => a.id === id))
    .filter(Boolean);
  const latest = artifacts.find((a) => a.id === step.artifactId);
  const members = Object.values(state.members).filter((m) =>
    canReadTask(state, task, m.id),
  );
  const controls = operator
    ? ["queued", "paused"].includes(task.status)
      ? button(
          task.status === "paused"
            ? "저장된 단계부터 재개"
            : `${step.name} 시연 시작`,
          "start-task",
          `data-id="${task.id}"`,
          true,
          "play",
        )
      : task.status === "running"
        ? button(
            "일시정지",
            "pause-task",
            `data-id="${task.id}"`,
            false,
            "pause",
          )
        : task.status === "result_ready"
          ? task.stepIndex < task.steps.length - 1
            ? button(
                "이 결과로 QA에 넘기기",
                "flow-handoff",
                `data-id="${task.id}"`,
                true,
                "corner-down-right",
              )
            : button(
                "샘플 결과 수용",
                "flow-accept",
                `data-id="${task.id}"`,
                true,
                "check",
              )
          : ""
    : `<span class="cw-owner-note">${esc(state.members[task.responsible]?.name)}님의 확인을 기다려요.</span>`;
  const next = `<section class="cw-next"><div><span class="cw-small-label">다음 행동</span><strong>${esc(nextAction(task))}</strong><span>${esc(state.members[task.responsible]?.name)} 책임 · ${esc(state.agents.find((a) => a.id === step.agentId)?.name)} 담당</span></div><div class="cw-actions">${controls}${!operator && !task.claims.includes(state.user) ? button("업무 인수 요청", "flow-claim", `data-id="${task.id}"`, false, "users-round") : !operator ? '<span class="g-pill">인수 요청됨</span>' : ""}${operator && ["result_ready", "done", "cancelled"].includes(task.status) ? button("재작업 요청", "flow-rework", `data-id="${task.id}"`, false, "rotate-ccw") : ""}</div></section>`;
  const ownerForm = manage
    ? `<details class="cw-owner"><summary>담당 변경${task.claims.length ? ` · 인수 요청 ${task.claims.length}건` : ""}</summary><form data-form="flow-assign" data-id="${task.id}"><label class="g-field"><span>현재 책임자</span><select name="responsible" class="g-input">${members.map((m) => `<option value="${m.id}" ${task.responsible === m.id ? "selected" : ""}>${esc(m.name)}${task.claims.includes(m.id) ? " · 인수 요청" : ""}</option>`).join("")}</select></label><button type="submit" class="g-button">담당 변경 기록</button><p class="g-error" data-flow-error role="alert"></p></form></details>`
    : "";
  const timeline = `<div class="cw-step-line">${task.steps
    .map((s, i) => {
      const a = state.agents.find((a) => a.id === s.agentId);
      return `<div class="cw-step ${i === task.stepIndex ? "is-current" : ""}">${avatar(a.name, a.color, false, a.id)}<span><strong>${esc(s.name)}</strong><small>${esc(a.name)} · ${s.status === "handed_off" ? "인계됨" : i === task.stepIndex ? "현재 단계" : "대기"}</small></span></div>`;
    })
    .join(`<span>${icon("arrow-right")}</span>`)}</div>`;
  const since = state.visitBefore?.[task.id];
  const changes = since ? task.events.filter((e) => e.at && e.at > since) : [];
  const brief = `<div class="cw-brief"><div class="cw-section-heading"><h3>지금 이어받을 내용</h3><div class="cw-actions"><span class="g-tiny g-muted">요약 v${task.brief.version}</span>${operator ? button("요약 바로잡기", "flow-brief", `data-id="${task.id}"`, false, "pencil") : ""}</div></div>${changes.length ? `<p class="cw-change-note">마지막 방문 이후 변경 ${changes.length}건 · ${esc(changes.at(-1).text)}</p>` : ""}<p class="cw-brief-text">${esc(task.brief.text)}</p>${button("요약의 근거", "flow-source", `data-id="${task.id}" data-source="${esc(task.brief.source)}"`, false, "book-open")}<dl class="cw-brief-grid"><div><dt>목표·완료 기준</dt><dd>${esc(task.doneCriteria)}</dd></div><div><dt>대상 버전</dt><dd>${esc(task.targetVersion)}<small>다른 커밋에는 이 결과를 적용하지 않아요.</small></dd></div><div><dt>현재 결과</dt><dd>${latest ? `${esc(latest.title)} v${latest.version}` : "현재 단계의 결과를 기다려요."}<small>${task.acceptedArtifactId ? "선택한 버전을 사람이 수용했어요." : "아직 수용한 최종 결과가 없어요."}</small></dd></div><div><dt>미확인 사항</dt><dd>실제 코드·테스트·서비스 상태<small>샘플 결과나 외부 초안으로 통과를 판정하지 않아요.</small></dd></div></dl></div><div class="cw-decisions"><h3>사람의 결정과 인계</h3>${task.events
    .filter((e) => e.type && e.type !== "run")
    .slice(-6)
    .reverse()
    .map(
      (e) =>
        `<div><span>${esc(state.members[e.actor]?.name || "시연")}</span><p>${esc(e.text)}</p><time>${time(e.at)}</time></div>`,
    )
    .join("")}</div>`;
  const results = artifacts.length
    ? artifacts
        .slice()
        .reverse()
        .map((a) => artifactView(a, h))
        .join("")
    : '<div class="cw-empty-note">아직 결과가 없어요. 현재 단계의 시연을 시작하면 버전 있는 샘플 결과가 남아요.</div>';
  return `<section class="g-task-detail cw-task" aria-label="선택한 작업"><header class="g-detail-head"><div class="g-row g-between"><span class="g-tiny g-muted">${task.id} · ${audience(visibilityOf(task))}</span>${status(task)}</div><h2>${esc(task.title)}</h2><p class="cw-target">${esc(task.target)}</p><div class="cw-task-meta"><span>요청 ${esc(state.members[task.owner]?.name)}</span><span>책임 ${esc(state.members[task.responsible]?.name)}</span><span>${esc(task.project)}</span>${button("업무 링크 복사", "flow-copy", `data-id="${task.id}"`, false, "arrow-up-right")}</div>${timeline}</header><div class="g-detail-content">${next}${ownerForm}<div class="g-segments cw-task-tabs" aria-label="작업 상세 보기">${[
    ["progress", "현재 업무 요약"],
    ["discussion", "함께 남긴 맥락"],
    ["result", `결과 ${artifacts.length}`],
    ["execution", "실행 기록"],
  ]
    .map(
      ([id, name]) =>
        `<button type="button" class="g-segment" data-action="task-tab" data-value="${id}" aria-pressed="${state.taskTab === id}">${name}</button>`,
    )
    .join(
      "",
    )}</div>${state.taskTab === "discussion" ? taskDiscussion(task) : state.taskTab === "result" ? results : state.taskTab === "execution" ? executionPanel(task) : brief}${task.status === "done" ? `<div class="cw-reuse">${icon("bookmark-check")}<div><strong>좋은 결과를 다음 업무의 기준으로</strong><p>완료 기준과 형식을 참고하고 새 대상에서 시작해요.</p></div>${button("이 기준으로 다음 업무 시작", "flow-reuse", `data-id="${task.id}"`, false, "plus")}</div>` : ""}${(operator || canInterveneTask(state, task)) && ["running", "paused", "queued"].includes(task.status) ? `<div class="cw-stop">${button("업무 중단", "cancel-task", `data-id="${task.id}"`, false, "square")}</div>` : ""}</div></section>`;
}

export function workflowModal(state, modal, h) {
  const { esc } = h,
    task = state.tasks.find((t) => t.id === modal.id);
  if (modal.type === "flow-brief" && task)
    return {
      title: "업무 요약 바로잡기",
      sub: "원문과 이전 요약을 보존하고 변경 이유를 남겨요.",
      form: "flow-brief",
      body: `<input type="hidden" name="taskId" value="${task.id}"><label class="g-field"><span>현재 업무 요약</span><textarea class="g-input" name="text" maxlength="1500" required>${esc(task.brief.text)}</textarea></label><label class="g-field"><span>정정 이유</span><input class="g-input" name="reason" maxlength="300" required></label><label class="g-field"><span>요약의 근거</span><select class="g-input" name="source"><option value="request">원래 요청과 완료 기준</option>${task.artifactIds
        .map((id) => {
          const a = state.artifacts.find((a) => a.id === id);
          return `<option value="${id}" ${task.brief.source === id ? "selected" : ""}>${esc(a.title)} v${a.version}</option>`;
        })
        .join("")}</select></label>`,
      submit: "정정 이력 남기기",
    };
  if (modal.type === "flow-rework" && task)
    return {
      title: "같은 업무에서 재작업",
      sub: "기존 결과를 남기고 새 실행을 준비해요.",
      form: "flow-rework",
      body: `<input type="hidden" name="taskId" value="${task.id}"><label class="g-field"><span>재작업 이유</span><textarea class="g-input" name="reason" maxlength="500" required></textarea></label><label class="g-field"><span>대상 커밋 또는 관측 버전</span><input class="g-input" name="targetVersion" maxlength="80" required value="${esc(task.targetVersion)}"></label><p class="cw-notice">재작업은 첫 단계부터 다시 시작합니다. 요약과 이후 단계의 현재 근거도 새로 준비해요. 이전 결과와 승인을 새 버전에 복사하지 않아요.</p>`,
      submit: "새 실행 준비",
    };
  if (modal.type === "flow-source" && task) {
    const a = state.artifacts.find(
      (a) => a.id === modal.source && a.taskId === task.id,
    );
    return {
      title: a ? `${a.title} · v${a.version}` : "요약의 근거와 정정 이력",
      sub: `${task.id} · ${audience(visibilityOf(task))}`,
      body: a
        ? `${artifactView(a, { ...h, button: () => "" })}<dl class="cw-facts"><div><dt>만든 실행</dt><dd>${esc(a.runId || "외부에서 가져온 결과 · 실행 없음")}</dd></div><div><dt>작성 주체</dt><dd>${esc(a.origin === "external" ? "원작성자 미확인 · 가져온 사람: " + (state.members[a.importedByUserId]?.name || "미상") : state.agents.find((x) => x.id === a.agentId)?.name || "시연")}</dd></div><div><dt>인계 입력</dt><dd>${esc(a.inputArtifactId ? state.artifacts.find((x) => x.id === a.inputArtifactId)?.title : "원래 요청")}</dd></div></dl>`
        : `<p class="cw-brief-text">${esc(task.goal)}</p><p>${esc(task.target)} · ${esc(task.targetVersion)}</p><h3>요약 정정 이력</h3>${task.brief.history.map((v) => `<div class="cw-history"><strong>v${v.version} · ${esc(v.reason)}</strong><p>${esc(v.text)}</p><small>${time(v.at)}</small></div>`).join("") || '<p class="g-muted">아직 정정 이력이 없어요.</p>'}`,
    };
  }
  return null;
}

export function stewardshipPanel(state, h) {
  const { esc, button } = h;
  return `<section class="g-role-section cw-stewardship"><header><div><h2>공용 스킬 관리 담당</h2><p>담당 스킬의 새 버전을 게시할 수 있어요. Agent 설정·외부 도구 권한은 별도입니다.</p></div></header>${[
    "review",
    "regression",
    "ops-check",
  ]
    .map(
      (id) =>
        `<form data-form="flow-steward" data-skill="${id}" class="cw-steward-row"><strong>${esc(h.skillBy(id).name)}</strong><label><span class="g-sr-only">${esc(h.skillBy(id).name)} 관리 담당</span><select class="g-input" name="member" aria-label="${esc(h.skillBy(id).name)} 관리 담당"><option value="">팀장 관리</option>${Object.values(
          state.members,
        )
          .map(
            (m) =>
              `<option value="${m.id}" ${state.skillStewards[id] === m.id ? "selected" : ""}>${esc(m.name)}</option>`,
          )
          .join(
            "",
          )}</select></label><button type="submit" class="g-button">담당 저장</button><p class="g-error" data-flow-error role="alert"></p></form>`,
    )
    .join(
      "",
    )}<div class="cw-ops-boundary"><strong>서버 연결 전 · 실행 정책</strong><p>같은 Agent의 활성 Run 1개 · 실행별 불변 스킬·설정 · 외부 쓰기는 미연결</p><p>제품 DB가 기억·권한의 기준이며, 하네스의 별도 공통 기억 검색은 첫 운영에서 사용하지 않습니다.</p></div></section>`;
}
