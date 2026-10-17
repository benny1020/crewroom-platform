import { isTeamLead, membership } from "./team-domain.js";
import { RUNTIMES } from "./domain.js";

const deptOptions = (state, selected, esc) =>
  state.team.departments
    .map(
      (d) =>
        `<option value="${d.id}" ${selected === d.id ? "selected" : ""}>${esc(d.name)}</option>`,
    )
    .join("");
const deptName = (state, id) =>
  state.team.departments.find((d) => d.id === id)?.name || "미지정";
const dateText = (date) =>
  new Date(date).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const formError = '<p class="g-error" data-team-error role="alert"></p>';

export function renderRolePage(view, state, h) {
  if (view === "signup") return signupPage(state, h);
  if (view === "home") return memberPage(state, h);
  if (view === "admin") return adminPage(state, h);
  return "";
}

function signupPage(state, { esc, icon, button, avatar }) {
  const v = state.signupDraft,
    lead = v.isLead === "on";
  return `<div class="g-signup-shell"><header class="g-signup-top"><div class="g-brand"><span class="g-brand-mark" aria-hidden="true">C</span><span class="g-brand-name">크루룸</span><span class="g-team-name">${esc(state.team.name)}</span></div>${button("데모로 돌아가기", "exit-signup", "", false, "arrow-left")}</header><main class="g-signup-layout"><section class="g-signup-story"><span class="g-signup-mark">함께 일하는 AI 동료의 공간</span><h1>우리 팀의 일을,<br>함께 이어가는 동료.</h1><p>반복하는 일은 맡기고,<br>팀의 맥락은 다음 업무로 이어가세요.</p><div class="g-signup-scene" aria-label="개인 비서와 공용 동료"><div class="g-signup-personal">${avatar("루미", "blue", true, "roopre")}<span>나만의 비서<strong>필요한 맥락은 제가 챙길게요.</strong></span><span class="g-signup-orbit">${icon("bookmark-check")}</span></div><div class="g-signup-connection">${icon("network")} 같은 팀의 동료와 이어져요</div><div class="g-signup-coworkers">${[
    "dev",
    "ops",
    "qa",
  ]
    .map((id) => {
      const a = state.agents.find((a) => a.id === id);
      return `<div>${avatar(a.name, a.color, true, id)}<strong>${esc(a.name)}</strong><span>${esc(deptName(state, a.department))}</span></div>`;
    })
    .join(
      "",
    )}</div></div><div class="g-signup-footnote">${icon("lock-keyhole")} 개인 대화와 기억은 나의 공간에 남아요.</div></section><section class="g-signup-form-panel" aria-labelledby="g-signup-heading"><div class="g-signup-form-heading"><span class="g-pill">${esc(state.team.name)}</span><h2 id="g-signup-heading">우리 팀 오피스에 참여하기</h2><p>공용 동료와 업무를 공유하고, 개인 비서도 준비하세요.</p></div><form data-form="signup" class="g-signup-form"><div class="g-fields-two"><label class="g-field" for="g-signup-name"><span>이름</span><input id="g-signup-name" class="g-input" name="name" required maxlength="30" autocomplete="off" placeholder="홍길동" value="${esc(v.name || "")}"></label><label class="g-field" for="g-signup-department"><span>소속 부서</span><select id="g-signup-department" aria-label="소속 부서" class="g-input" name="department">${deptOptions(state, v.department || "development", esc)}</select></label></div><label class="g-field" for="g-signup-email"><span>이메일</span><input id="g-signup-email" class="g-input" name="email" type="email" required maxlength="100" autocomplete="off" placeholder="name@example.com" value="${esc(v.email || "")}"></label><label class="g-field" for="g-signup-assistant"><span>나의 비서 이름</span><input id="g-signup-assistant" aria-label="나의 비서 이름" class="g-input" name="assistant" required maxlength="16" autocomplete="off" placeholder="예: 루미, 모아" value="${esc(v.assistant || "")}"><span class="g-field-help">이름과 캐릭터는 언제든 바꿀 수 있어요.</span></label><label class="g-signup-role ${lead ? "is-lead" : ""}" for="g-signup-lead"><input id="g-signup-lead" type="checkbox" name="isLead" ${lead ? "checked" : ""}><span><strong>팀장 권한을 요청할게요</strong><small>기존 팀장이 확인한 뒤 관리 권한이 부여돼요.</small></span>${icon("sliders-horizontal")}</label><div class="g-signup-role-preview" aria-live="polite">${icon(lead ? "users-round" : "notebook-pen")}<span>${lead ? "팀원으로 시작하고 팀장의 권한 확인을 기다려요." : "팀 오피스에서 공유 업무를 시작하고 이어가요."}</span></div>${formError}<button type="submit" class="g-button g-primary g-signup-submit">${lead ? "참여하고 권한 요청" : "팀원으로 시작하기"}${icon("arrow-right")}</button><p class="g-signup-demo-note">${icon("flask-conical")} 회원가입 화면 체험이에요. 실제 계정·이메일 인증은 연결 전이며, 입력은 이 브라우저에 저장됩니다.</p></form></section></main></div>`;
}

function memberPage(state, h) {
  const {
    esc,
    icon,
    button,
    avatar,
    status,
    taskSkill,
    taskAssignee,
    quickSkill,
    skillBy,
  } = h;
  const member = membership(state),
    p = state.profiles[state.user];
  const mine = state.tasks.filter(
    (t) => t.owner === state.user || t.responsible === state.user,
  );
  const waiting = mine.filter((t) => t.status === "needs_input");
  const ongoing = mine.filter((t) => !["done", "cancelled"].includes(t.status));
  const priority = {
    needs_input: 0,
    running: 1,
    paused: 2,
    queued: 3,
    done: 4,
    cancelled: 5,
  };
  const tasks = [...mine]
    .sort((a, b) => priority[a.status] - priority[b.status])
    .slice(0, 5);
  const coworkers = state.agents
    .filter((a) => a.department === member.department || a.id === "chief")
    .slice(0, 3);
  return `<div class="g-breadcrumb">개인 공간 / 내 업무 공간</div><div class="g-page-head"><div><div class="g-row"><h1>내 업무 공간</h1><span class="g-role-badge">${esc(deptName(state, member.department))} ${isTeamLead(state) ? "팀장" : "팀원"}</span></div><p class="g-page-sub">${esc(member.name)}님, 동료에게 맡긴 일과 다음 할 일을 모았어요.</p></div>${button("업무 맡기기", "new-request", `data-agent="${state.user}"`, true, "plus")}</div><div class="g-personal-summary"><span>${icon("circle-help")} 내 답변 대기 <strong>${waiting.length}</strong></span><span>${icon("activity")} 이어갈 업무 <strong>${ongoing.length}</strong></span><span>${icon("file-check-2")} 준비된 결과 <strong>${mine.filter((t) => t.status === "done").length}</strong></span></div><div class="g-member-layout"><div><section class="g-role-section"><header><div><h2>이어서 할 일</h2><p>확인할 일부터 보고, 동료가 멈춘 곳에서 이어가세요.</p></div>${button("내 업무 전체", "my-work", "", false, "arrow-up-right")}</header><div class="g-personal-tasks">${
    tasks
      .map((t) => {
        const a = taskAssignee(t);
        return `<button type="button" class="g-personal-task" data-action="open-task" data-id="${t.id}"><span class="g-personal-task-avatar">${avatar(a?.name || p.name, a?.color || p.color, false, a?.id || state.user)}</span><span><span class="g-tiny g-muted">${esc(a?.name || p.name)} · ${esc(taskSkill(t).name)}</span><strong>${esc(t.title)}</strong><small>${t.status === "needs_input" ? "검증 범위를 답변하면 업무가 이어져요." : t.status === "done" ? "결과와 실행 기록을 확인할 수 있어요." : "진행 상태와 남은 맥락을 확인하세요."}</small></span>${status(t)}${icon("chevron-right")}</button>`;
      })
      .join("") ||
    `<div class="g-role-empty">${icon("notebook-pen")}<h3>첫 업무를 맡겨보세요</h3><p>반복하는 정리나 확인부터 비서와 시작해보세요.</p>${button("첫 업무 맡기기", "new-request", `data-agent="${state.user}"`, true, "plus")}</div>`
  }</div></section><section class="g-role-section"><header><div><h2>우리 부서의 동료</h2><p>필요한 담당자와 대화하거나 업무를 맡겨보세요.</p></div>${button("팀 오피스", "navigate", 'data-view="office"', false, "arrow-up-right")}</header><div class="g-member-coworkers">${coworkers.map((a) => `<button type="button" data-action="agent" data-id="${a.id}">${avatar(a.name, a.color, true, a.id)}<span><strong>${esc(a.name)}</strong><small>${esc(a.role)}</small></span>${icon("chevron-right")}</button>`).join("")}</div></section></div><aside class="g-personal-rail"><section class="g-my-assistant"><div class="g-row g-between"><span class="g-small">나만의 비서</span>${icon("lock-keyhole")}</div><div class="g-my-assistant-portrait">${avatar(p.name, p.color, true, state.user)}</div><h2>${esc(p.name)}</h2><p>${esc(p.catchphrase)}</p>${button("비서에게 말 걸기", "navigate", 'data-view="assistant"', true, "message-circle")}<button type="button" class="g-text-button" data-action="settings">이름·역할 커스텀 ${icon("sliders-horizontal")}</button></section><section class="g-role-section g-personal-skills"><header><h2>자주 맡기는 일</h2></header>${p.skills
    .slice(0, 3)
    .map((id) => quickSkill(skillBy(id), state.user))
    .join(
      "",
    )}${button("스킬 라이브러리", "navigate", 'data-view="skills"', false, "blocks")}</section></aside></div>`;
}

function adminPage(state, h) {
  if (!isTeamLead(state)) return "";
  const { esc, icon, button } = h;
  const tabs = [
    ["overview", "운영 현황"],
    ["members", "구성원·부서"],
    ["agents", "공용 에이전트"],
    ["stewardship", "스킬 담당"],
    ["settings", "설정·기록"],
  ];
  const tab = tabs.some(([id]) => id === state.adminTab)
    ? state.adminTab
    : "overview";
  const pages = {
    overview: adminOverview,
    members: adminMembers,
    agents: adminAgents,
    settings: adminSettings,
    stewardship: (_state, helpers) => helpers.stewardshipPanel(),
  };
  return `<div class="g-breadcrumb">${esc(state.team.name)} / 팀장 공간</div><div class="g-page-head"><div><div class="g-row"><h1>팀 관리</h1><span class="g-role-badge is-lead">팀장</span></div><p class="g-page-sub">막힌 업무와 권한 요청을 확인하고, 스킬 관리는 담당자에게 맡기세요.</p></div>${button("팀원 화면 보기", "navigate", 'data-view="home"', false, "notebook-pen")}</div><div class="g-admin-tabs" role="tablist" aria-label="팀 관리"><span class="g-admin-team-icon">${icon("users-round")}</span>${tabs.map(([id, label]) => `<button type="button" role="tab" aria-selected="${id === tab}" aria-controls="g-admin-panel" id="g-admin-tab-${id}" data-action="admin-tab" data-value="${id}">${label}</button>`).join("")}</div><div id="g-admin-panel" role="tabpanel" aria-labelledby="g-admin-tab-${tab}">${pages[tab](state, h)}</div>`;
}

function adminOverview(state, h) {
  const { esc, icon, button, avatar, status, taskAssignee } = h;
  const shared = state.tasks.filter((t) => t.shared);
  const active = shared.filter((t) =>
    ["running", "paused", "queued", "needs_input"].includes(t.status),
  );
  const waiting = shared.filter((t) => t.status === "needs_input");
  return `<div class="g-admin-overview-line"><div><strong>${Object.keys(state.members).length}</strong><span>구성원</span></div><div><strong>${state.agents.length}</strong><span>공용 동료</span></div><div><strong>${active.length}</strong><span>이어가는 팀 업무</span></div><div class="${waiting.length ? "has-attention" : ""}"><strong>${waiting.length}</strong><span>확인 필요</span></div><span class="g-admin-data-note">공유된 업무 기준<br>개인 대화·기억 제외</span></div><div class="g-admin-overview-layout"><div><section class="g-role-section"><header><div><h2>부서별로 함께 일해요</h2><p>사람과 공용 동료, 진행 중인 업무를 한눈에 살펴보세요.</p></div>${button("부서 관리", "admin-tab", 'data-value="members"', false, "sliders-horizontal")}</header><div class="g-department-overview-heading"><span>부서</span><span>구성원</span><span>공용 동료</span><span>진행 / 확인</span></div>${state.team.departments
    .map((d) => {
      const agents = state.agents.filter((a) => a.department === d.id);
      const tasks = active.filter((t) => taskAssignee(t)?.department === d.id);
      return `<button type="button" class="g-department-overview-row" data-action="department" data-id="${d.id}"><span class="g-row"><span class="g-department-symbol">${icon(d.icon)}</span><span><strong>${esc(d.name)}</strong><small>${esc(d.description)}</small></span></span><span>${Object.values(state.members).filter((m) => m.department === d.id).length}명</span><span class="g-department-avatars">${agents.map((a) => avatar(a.name, a.color, false, a.id)).join("") || "—"}</span><span>${tasks.length}건 <small>${tasks.filter((t) => t.status === "needs_input").length ? "· 확인 " + tasks.filter((t) => t.status === "needs_input").length : ""}</small>${icon("chevron-right")}</span></button>`;
    })
    .join(
      "",
    )}</section><section class="g-role-section"><header><div><h2>지금 확인이 필요한 일</h2><p>팀원이 남긴 요청과 인계 지점을 확인하세요.</p></div>${button("업무 전체", "navigate", 'data-view="work"', false, "arrow-up-right")}</header>${
    waiting
      .slice(0, 4)
      .map(
        (t) =>
          `<button type="button" class="g-admin-attention-row" data-action="open-task" data-id="${t.id}">${icon("circle-help")}<span><strong>${esc(t.title)}</strong><small>${esc(state.members[t.owner]?.name || "팀원")} 요청 · ${t.id}</small></span>${status(t)}${icon("chevron-right")}</button>`,
      )
      .join("") ||
    '<div class="g-role-empty"><p>팀원의 답변을 기다리는 업무가 없어요.</p></div>'
  }</section></div><aside class="g-admin-guide"><div class="g-admin-guide-crew">${avatar("아리", "blue", true, "chief")}${avatar("루미", "blue", true, state.user)}</div><h2>동료가 일할 환경을<br>차근차근 정리해요.</h2><p>역할과 부서, 공용 스킬을 관리하면 팀원은 자신의 업무에 집중할 수 있어요.</p>${[
    ["members", "users-round", "구성원의 역할·부서 정하기"],
    ["agents", "sliders-horizontal", "공용 동료와 스킬 살피기"],
    ["stewardship", "blocks", "스킬별 관리 담당 정하기"],
  ]
    .map(
      ([id, glyph, text]) =>
        `<button type="button" data-action="admin-tab" data-value="${id}">${icon(glyph)}<span>${text}</span>${icon("chevron-right")}</button>`,
    )
    .join(
      "",
    )}<p class="g-admin-privacy-note">${icon("lock-keyhole")} 팀장도 다른 사람의 개인 대화와 기억을 열람할 수 없어요.</p></aside></div>`;
}

function adminMembers(state, { esc, icon, button }) {
  return `<section class="g-role-section"><header><div><h2>함께하는 구성원</h2><p>역할과 소속 부서를 저장하면 화면과 관리 권한에 반영돼요.</p></div><span class="g-pill">${Object.keys(state.members).length}명</span></header><div class="g-member-table-heading"><span>구성원</span><span>역할</span><span>소속 부서</span><span></span></div>${Object.values(
    state.members,
  )
    .map(
      (member) =>
        `<form class="g-member-table-row" data-form="team-member" data-id="${member.id}"><span class="g-member-identity"><span class="g-human-avatar">${esc(member.name.slice(0, 1))}</span><span><strong>${esc(member.name)}${member.id === state.user ? '<small class="g-current-user">나</small>' : ""}</strong><small>${esc(member.email)}</small>${member.leadRequested ? '<small class="cw-role-request">팀장 권한 요청 · 역할을 확인해주세요</small>' : ""}</span></span><label><span class="g-sr-only">${esc(member.name)}의 역할</span><select class="g-input" name="role" aria-label="${esc(member.name)}의 역할"><option value="member" ${member.role === "member" ? "selected" : ""}>팀원</option><option value="lead" ${member.role === "lead" ? "selected" : ""}>팀장</option></select></label><label><span class="g-sr-only">${esc(member.name)}의 부서</span><select class="g-input" name="department" aria-label="${esc(member.name)}의 부서">${deptOptions(state, member.department, esc)}</select></label>${button("저장", "submit-form")}${formError}</form>`,
    )
    .join(
      "",
    )}</section><section class="g-role-section"><header><div><h2>부서 구성</h2><p>이름과 담당 영역을 수정하면 오피스와 메뉴에도 반영돼요.</p></div><span class="g-tiny g-muted">${state.team.departments.length}개 부서</span></header>${state.team.departments.map((d) => `<form class="g-department-edit-row" data-form="department" data-id="${d.id}"><span class="g-department-symbol">${icon(d.icon)}</span><input class="g-input" name="name" aria-label="${esc(d.name)} 부서 이름" maxlength="20" required value="${esc(d.name)}"><input class="g-input" name="description" aria-label="${esc(d.name)} 부서 설명" maxlength="80" value="${esc(d.description)}">${button("저장", "submit-form")}${formError}</form>`).join("")}<form class="g-department-edit-row is-new" data-form="department"><span class="g-department-symbol">${icon("plus")}</span><input class="g-input" name="name" aria-label="새 부서 이름" maxlength="20" required placeholder="새 부서 이름"><input class="g-input" name="description" aria-label="새 부서 설명" maxlength="80" placeholder="담당하는 일을 적어주세요">${button("추가", "submit-form")}${formError}</form></section>`;
}

function adminAgents(state, { esc, icon, button, avatar, specialistState }) {
  return `<section class="g-role-section"><header><div><h2>공용 에이전트와 스킬</h2><p>역할·부서·하네스와 장착할 스킬을 동료별로 관리하세요.</p></div>${button("스킬 라이브러리", "navigate", 'data-view="skills"', false, "blocks")}</header><div class="g-admin-agent-heading"><span>동료 / 역할</span><span>부서 / 하네스</span><span>현재 상태</span><span>관리</span></div>${state.agents
    .map((a) => {
      const activity = specialistState(a);
      return `<div class="g-admin-agent-row"><button type="button" class="g-admin-agent-identity" data-action="agent" data-id="${a.id}">${avatar(a.name, a.color, false, a.id)}<span><strong>${esc(a.name)}</strong><small>${esc(a.role)}</small></span></button><span><strong>${esc(deptName(state, a.department))}</strong><small>${RUNTIMES[a.runtime]?.name || "Hermes"} · 스킬 ${a.skills.length}개</small></span><span class="g-status-inline ${activity.color}"><span class="g-dot"></span>${esc(activity.text)}</span><div class="g-row">${button("설정", "agent-settings", `data-id="${a.id}"`, false, "sliders-horizontal")}${button("스킬", "manage-skills", `data-agent="${a.id}"`, false, "blocks")}</div></div>`;
    })
    .join(
      "",
    )}</section><div class="g-role-explanation">${icon("history")} 바꾼 설정과 스킬은 다음 실행에 반영돼요. 이미 진행 중인 Run의 버전은 유지됩니다. 실제 하네스 연결 전의 예시 설정입니다.</div>`;
}

function adminSettings(state, { esc, icon, button }) {
  return `<div class="g-team-settings-layout"><section class="g-role-section"><header><div><h2>공용 팀 설정</h2><p>팀 소개와 공용 스킬의 편집 범위를 정하세요.</p></div></header><form class="g-team-settings-form" data-form="team-settings"><label class="g-field"><span>팀 이름</span><input class="g-input" name="name" aria-label="팀 이름" maxlength="30" required value="${esc(state.team.name)}"></label><label class="g-field"><span>팀 소개</span><textarea class="g-input" name="description" aria-label="팀 소개" maxlength="120">${esc(state.team.description)}</textarea></label><label class="g-team-policy"><input type="checkbox" name="memberTeamSkills" ${state.team.memberTeamSkills ? "checked" : ""}><span><strong>팀원의 공용 스킬 편집 허용</strong><small>허용하면 팀원도 공용 스킬을 게시하고 동료에게 장착할 수 있어요. 동료의 역할·하네스 설정은 팀장이 관리해요.</small></span></label><div class="g-role-explanation">${icon("lock-keyhole")} 개인 대화와 기억의 열람 범위는 역할과 별도로 유지돼요.</div>${formError}${button("팀 설정 저장", "submit-form", "", true)}</form></section><section class="g-role-section"><header><div><h2>관리 변경 기록</h2><p>가입·역할·부서·설정 변경을 남겨요.</p></div></header><div class="g-team-audit">${
    state.team.audit
      .slice(0, 20)
      .map(
        (event) =>
          `<article><span class="g-audit-dot"></span><div><strong>${esc(event.type)}</strong><p>${esc(event.detail)}</p><small>${esc(event.actor)} · ${esc(dateText(event.at))}</small></div></article>`,
      )
      .join("") ||
    '<div class="g-role-empty"><p>아직 관리 변경 기록이 없어요.<br>역할이나 설정을 바꾸면 여기에 남아요.</p></div>'
  }</div></section></div>`;
}
