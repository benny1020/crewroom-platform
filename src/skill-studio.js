const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (n) =>
  `<i class="g-icon" data-lucide="${n}" aria-hidden="true"></i>`;
const text = (value) =>
  String(value || "")
    .split("\n")
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)/),
        bullet = line.match(/^\s*[-*]\s+(.+)/);
      return heading
        ? `<h3>${esc(heading[1])}</h3>`
        : bullet
          ? `<p class="cr-studio-bullet">${esc(bullet[1])}</p>`
          : `<p>${esc(line) || "<br>"}</p>`;
    })
    .join("");
const examples = [
  "매주 업무를 성과·장애·다음 계획으로 짧게 정리해줘",
  "PR을 검토할 때 위험한 변경과 빠진 테스트를 찾아줘",
  "장애 기록에서 원인·영향·후속 조치를 같은 형식으로 정리해줘",
];
export function currentStudioDraft(task, local) {
  return local && task && local.taskId === task.id
    ? local.draft
    : task?.skill_design?.draft || null;
}
export function studioView({ task, workspace, draft, seed = {} }) {
  const latest = task?.artifacts?.find(
      (a) => a.id === task.steps?.[0]?.current_artifact_id,
    ),
    result = latest?.result,
    configured = workspace.runtime.modelConfigured,
    run = task?.runs?.find((r) => r.id === task.current_run_id),
    pending =
      !!task &&
      (["queued", "running", "paused"].includes(run?.status) ||
        !!run?.lease_owner),
    base = workspace.skills.find(
      (s) => s.id === (task?.skill_design?.baseSkillId || seed.baseSkillId),
    ),
    saved = task?.skill_design?.saved,
    baseChanged =
      !!base &&
      !!task &&
      base.current_version !== task.skill_design.baseVersion,
    sameSaved =
      !!saved &&
      draft?.name === workspace.skills.find((s) => s.id === saved.id)?.name &&
      draft?.instructions ===
        workspace.skills.find((s) => s.id === saved.id)?.instructions &&
      draft?.doneCriteria ===
        workspace.skills.find((s) => s.id === saved.id)?.done_criteria,
    sameSample =
      !!result?.sampleOutput &&
      typeof result.sampleInput === "string" &&
      latest.run_id === task.current_run_id &&
      !!draft &&
      ["name", "instructions", "doneCriteria"].every(
        (k) => result.skillDraft?.[k] === draft[k],
      ),
    chat = [
      ...(task?.messages || []).map((m) => ({ ...m, type: "user" })),
      ...(task?.artifacts || []).map((a) => ({ ...a, type: "assistant" })),
    ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    scope = task?.skill_design?.scope || "private",
    manage = workspace.agents.filter(
      (a) =>
        a.owner_id === workspace.user.id ||
        (!a.owner_id && workspace.user.role === "lead"),
    ),
    previewState = sameSaved
      ? "저장됨"
      : draft
        ? "검토할 초안"
        : "아직 초안이 없어요";
  return `<div class="cr-studio-heading"><div><a class="g-text-button" href="#/skills">${icon("arrow-left")} 스킬 라이브러리</a><h1>${base ? esc(base.name) + " 다듬기" : "AI와 스킬 만들기"}</h1><p>하고 싶은 일을 설명하면 지침과 완료 기준을 함께 정리해요.</p></div><span class="g-pill">${icon("lock-keyhole")} 작성 대화는 나만</span></div>
  <ol class="cr-studio-steps" aria-label="스킬 만들기 단계"><li class="${!draft ? "current" : "complete"}">${icon("message-circle")} 업무 설명</li><li class="${draft && !sameSaved ? "current" : sameSaved ? "complete" : ""}">${icon("notebook-pen")} 초안 다듬기</li><li class="${sameSaved ? "current" : ""}">${icon("check-check")} 저장·동료 적용</li></ol>
  ${!configured ? '<div class="cr-studio-alert" role="status">AI 모델 연결이 필요해요. 운영 담당자가 모델 주소와 이름을 설정하면 대화로 만들 수 있습니다. <button class="g-text-button" type="button" data-action="new-skill">직접 작성하기</button></div>' : ""}
  ${workspace.runtime.fixture ? '<p class="cr-studio-fixture">시연 모드 · 아래 AI 응답과 예시는 결정적 테스트 fixture이며 실제 모델 결과가 아닙니다.</p>' : ""}
  ${task?.skill_design?.sourceExample ? `<p class="cr-note">참고한 수용 결과: <a href="#/tasks/${esc(task.skill_design.sourceExample.taskId)}">W-${esc(task.skill_design.sourceExample.taskNumber)} · 결과 v${esc(task.skill_design.sourceExample.artifactVersion)}</a>. 결과 형식을 참고하며 과거 검사를 새 업무의 승인으로 사용하지 않습니다.</p>` : ""}
  ${baseChanged ? `<div class="cr-studio-alert" role="alert"><strong>다른 사람이 v${base.current_version}을 게시했어요.</strong><p>작성하던 초안은 보관되어 있습니다. 최신 버전과 함께 새 대화에서 다듬어주세요.</p><details><summary>최신 게시 내용 확인</summary><div>${text(base.instructions)}</div><strong>완료 기준</strong><div>${text(base.done_criteria)}</div></details><button class="g-button" type="button" data-action="studio-rebase">최신 버전과 함께 다듬기</button></div>` : ""}
  <div class="cr-studio"><section class="cr-studio-conversation" aria-label="스킬 설계 대화"><header><span class="cr-studio-avatar">${icon("sparkles")}</span><div><h2>스킬 설계 도우미</h2><p>${base ? "기존 버전을 바탕으로 새 버전을 준비해요." : "완성된 문서 없이, 한두 문장으로 시작하세요."}</p></div></header>
  <div class="cr-studio-thread" data-studio-thread aria-live="polite"><div class="cr-studio-reply"><strong>어떤 일을 자주 반복하나요?</strong><p>언제 쓰는지, 어떤 결과를 받고 싶은지만 알려주세요. 필요한 입력과 완료 기준은 함께 정리할게요.</p></div>${chat.map((m) => (m.type === "user" ? `<div class="cr-studio-user"><span>나</span><p>${esc(m.body)}</p></div>` : `<div class="cr-studio-reply"><span>${m.origin === "fixture" ? "도우미 · 시연" : "도우미"}</span><p>${esc(m.result.summary)}</p>${m.result.changeSummary?.length ? `<ul>${m.result.changeSummary.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}${m.result.clarifyingQuestions?.length ? `<div class="cr-studio-questions"><strong>함께 정하면 좋아요</strong>${m.result.clarifyingQuestions.map((q) => `<p>${esc(q)}</p>`).join("")}</div>` : ""}</div>`)).join("")}${pending ? `<div class="cr-studio-working" role="status">${icon("activity")} ${run?.lease_owner && task.status === "failed" ? "이전 실행의 종료 확인이 필요해요" : run?.status === "queued" ? "도우미의 응답을 기다리고 있어요" : "초안과 완료 기준을 정리하고 있어요"}<small>화면을 나가도 서버에서 기록을 이어갑니다.</small></div>` : ""}${task?.status === "failed" ? `<div class="cr-studio-alert" role="alert"><strong>답변을 완료하지 못했어요</strong><p>${esc(run?.error_message || "실행 기록을 확인해주세요.")}</p></div>` : ""}</div>
  ${!task ? `<div class="cr-studio-starters"><span>이런 일부터 시작해보세요</span>${examples.map((v, i) => `<button type="button" data-action="studio-example" data-index="${i}">${esc(v)} ${icon("corner-down-right")}</button>`).join("")}</div>` : `<div class="cr-studio-tweaks">${["결과를 표 형식으로 바꿔줘", "빠진 자료가 있으면 먼저 질문하도록 해줘", "완료 기준을 더 구체적으로 써줘"].map((v) => `<button type="button" data-action="studio-suggestion" data-value="${esc(v)}" ${pending ? "disabled" : ""}>${esc(v)}</button>`).join("")}</div>`}
  <form class="cr-studio-composer" data-form="studio-message" data-context="${task?.id || "new-" + (seed.baseSkillId || seed.sourceTaskId || "blank")}"><label class="g-field"><span>${task ? "추가로 바꾸고 싶은 점" : "만들고 싶은 업무"}</span><textarea class="g-input" name="message" aria-label="${task ? "추가로 바꾸고 싶은 점" : "만들고 싶은 업무"}" rows="3" maxlength="4000" required placeholder="예: 매주 금요일, 이번 주 한 일을 팀에 공유할 요약으로 만들어줘" ${!configured || pending ? "disabled" : ""}></textarea></label><div><small>${task ? "현재 초안에 요청을 반영합니다." : "Markdown 형식은 신경 쓰지 않아도 돼요."}</small><button class="g-button g-primary" type="submit" ${!configured || pending ? "disabled" : ""}>${icon("send")} ${task ? "수정 요청" : "초안 만들기"}</button></div><p class="g-error" data-error role="alert"></p></form></section>
  <aside class="cr-studio-preview" aria-label="스킬 초안"><header><h2>만들어지는 스킬</h2><span class="g-pill ${sameSaved ? "green" : ""}">${previewState}</span></header>${
    draft
      ? `<section class="cr-studio-document"><span class="cr-studio-doc-icon">${icon("blocks")}</span><h2>${esc(draft.name)}</h2>${result?.suggestedTrigger ? `<p class="cr-studio-trigger">이렇게 요청해요 <q>${esc(result.suggestedTrigger)}</q></p>` : ""}<div class="cr-studio-instructions">${text(draft.instructions)}</div><div class="cr-studio-criteria"><h3>${icon("list-checks")} 완료 기준</h3>${text(draft.doneCriteria)}</div></section>
  <details class="cr-studio-manual"><summary>${icon("pencil")} 직접 다듬기</summary><form data-form="studio-edit" data-context="${task.id}"><label class="g-field"><span>스킬 이름</span><input class="g-input" name="name" maxlength="80" required ${pending ? "disabled" : ""} value="${esc(draft.name)}"></label><label class="g-field"><span>스킬 지침</span><textarea class="g-input" name="instructions" aria-label="스킬 지침" rows="8" maxlength="12000" required ${pending ? "disabled" : ""}>${esc(draft.instructions)}</textarea></label><label class="g-field"><span>완료 기준</span><textarea class="g-input" name="doneCriteria" aria-label="완료 기준" rows="3" maxlength="2000" required ${pending ? "disabled" : ""}>${esc(draft.doneCriteria)}</textarea></label><small>편하게 고치세요. AI에 요청하거나 스킬을 저장할 때 서버에 보관됩니다.</small><button class="g-button" type="submit" ${pending ? "disabled" : ""}>초안에 반영</button></form></details>
  <details class="cr-studio-sample" ${sameSample ? "open" : ""}><summary>${icon("flask-conical")} 예시로 확인하기 <span>${sameSample ? "예시 생성됨" : "게시 전에 결과 모양을 살펴보세요"}</span></summary><p>현재 초안으로 AI 응답 예시를 만듭니다. 실제 업무·코드·도구는 실행하지 않습니다.</p><form data-form="studio-sample" data-context="${task.id}"><label class="g-field"><span>예시 입력</span><textarea class="g-input" name="sample" aria-label="예시 입력" rows="3" maxlength="2000" required ${pending ? "disabled" : ""}>${esc(sameSample ? result.sampleInput : task.skill_design.mode === "try" ? task.skill_design.sample : result?.sampleRequest || "")}</textarea></label><button class="g-button" type="submit" ${pending || !configured ? "disabled" : ""}>${icon("play")} 예시 결과 만들기</button><p class="g-error" data-error role="alert"></p></form>${sameSample ? `<div class="cr-studio-sample-output"><strong>${latest.origin === "fixture" ? "테스트 fixture 예시" : "AI가 만든 응답 예시 · 실무 검증 전"}</strong><div>${text(result.sampleOutput)}</div>${result.unknowns?.length ? `<p class="cr-note">${esc(result.unknowns.join("\n"))}</p>` : ""}</div>` : result?.sampleOutput ? '<p class="cr-note">이전 요청의 예시입니다. 현재 초안으로 새 예시를 확인하세요.</p>' : ""}</details>
  <section class="cr-studio-save"><h3>${icon("check-check")} 준비되면 저장하세요</h3><p>${base ? `현재 v${base.current_version}을 바탕으로 다음 버전을 게시합니다. 진행 중인 업무의 버전은 바뀌지 않아요.` : "작성 대화는 비공개로 남고, 선택한 범위로 스킬만 저장합니다."}</p><form data-form="studio-save" data-context="${task.id}"><label class="g-field"><span>스킬 공개 대상</span><select class="g-input" name="scope" aria-label="스킬 공개 대상" ${pending ? "disabled" : ""}>${(base ? [[scope, scope === "private" ? "나의 비서 전용" : "팀 공용"]] : [["private", "나의 비서 전용"], ...(workspace.user.role === "lead" ? [["team", "팀 공용"]] : [])]).map(([v, n]) => `<option value="${v}" ${scope === v ? "selected" : ""}>${n}</option>`).join("")}</select></label><label class="g-field"><span>저장 후 적용할 동료</span><select class="g-input" name="agentId" aria-label="저장 후 적용할 동료" ${pending ? "disabled" : ""}><option value="">저장만 하기</option>${manage.map((a) => `<option value="${esc(a.id)}" data-shared="${!a.owner_id}" ${scope === "private" && !a.owner_id ? "hidden disabled" : ""} ${!base && a.owner_id === workspace.user.id ? "selected" : ""}>${esc(a.name)}${a.owner_id ? " · 내 비서" : " · 공용"}</option>`).join("")}</select></label><p class="g-error" data-error role="alert"></p><button class="g-button g-primary" type="submit" ${pending || baseChanged ? "disabled" : ""}>${icon("check")} ${base ? "새 버전 저장" : "스킬 저장"}</button></form>${saved ? `<div class="cr-studio-saved" role="status"><strong>${sameSaved ? "저장 완료" : "마지막 저장"} · v${saved.version}</strong>${saved.agentId ? `<button class="g-text-button" type="button" data-action="use-skill" data-agent="${esc(saved.agentId)}" data-skill="${esc(saved.id)}">이 스킬로 업무 시작 ${icon("arrow-up-right")}</button>` : '<a class="g-text-button" href="#/skills">라이브러리에서 동료에 적용</a>'}</div>` : ""}</section>`
      : `<div class="cr-studio-blank">${icon("notebook-pen")}<h3>첫 설명이 스킬의 시작이에요</h3><p>사용할 때·입력·진행 방법·결과 형식·완료 기준을 한 장으로 정리해드려요.</p><div><span>${icon("message-circle")} 업무를 설명하고</span><span>${icon("pencil")} 대화로 다듬고</span><span>${icon("users-round")} 동료에게 적용하세요</span></div></div>`
  }
  ${task ? `<details class="cr-studio-run-history"><summary>실행 기록 ${task.runs.length}개</summary>${task.runs.map((r) => `<p><strong>${esc(r.status)}</strong> · ${esc(r.snapshot.model)}${r.error_message ? `<br>${esc(r.error_message)}` : ""}<small>${esc(r.id)}</small></p>`).join("")}<a href="#/tasks/${task.id}">업무 기록 열기</a></details>` : ""}</aside></div>`;
}
export const studioExamples = examples;
