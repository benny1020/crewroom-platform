import { officeStation as sharedOfficeStation } from "./office-station.js";
import { workDiary, diaryState, developerDiaryEnabled } from "./work-diary.js";
import { characterIllustration } from "./plush-sprites.js";
import "./styles.css";
import "./refinements.css";
import "./team.css";
import "./workflow.css";
import "./plush.css";
import {
  WORK_TYPES,
  initializeWorkflows,
  canReadTask,
  canOperateTask,
  canInterveneTask,
  requireOperator,
  createWorkflow,
  startWorkflowRun,
  completeWorkflowRun,
  handoffWorkflow,
  acceptWorkflow,
  reworkWorkflow,
  reassignWorkflow,
  correctBrief,
  importResult,
  workflowEvent,
  visibilityOf,
} from "./workflow-domain.js";
import {
  officeDesk,
  intakePage,
  intakeDraft,
  workflowDetail,
  workflowModal,
  stewardshipPanel,
} from "./workflow-views.js";
import {
  baseSkills,
  characters,
  characterById,
  defaultPersonas,
  defaultAgents,
  memoryKinds,
  memorySeeds,
  initial,
} from "./data.js";
import {
  RUNTIMES,
  canReadConversation as readConversation,
  memoryScopeForConversation as memoryScope,
  runtimeSupportsSkill,
  skillBindingStatus,
  createRunSnapshot,
  appendRunEvent,
  recoverInterruptedRuns,
  nextVersion,
} from "./domain.js";
import { createIcons } from "lucide";
import { appIcons as lucideIcons } from "./icons.js";
import {
  initializeTeam,
  membership,
  isTeamLead,
  canEditTeamSkills,
  canManageActor,
  canEditBinding,
  canPublishSkill,
  registerMember,
  switchMember,
  updateMember,
  saveDepartment,
  saveTeamSettings,
  auditTeam,
} from "./team-domain.js";
import { renderRolePage } from "./team-views.js";

(() => {
  "use strict";
  const root = document.getElementById("gyeot-demo");
  const frame = root.querySelector("#gyeot-frame");
  const modalLayer = root.querySelector("#gyeot-modal");
  const notice = root.querySelector("#gyeot-notice");
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const icon = (name) =>
    `<i class="g-icon" data-lucide="${name}" aria-hidden="true"></i>`;
  const button = (text, action, extra = "", primary = false, glyph = "") =>
    `<button type="button" class="g-button cursor-interaction ${primary ? "g-primary" : ""}" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ""}${text}</button>`;
  const clock = () =>
    new Date().toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  let state = initializeTeam(initial());
  let departments = state.team.departments;
  const canReadConversation = (conversation, userId) =>
    readConversation(conversation, userId, state.members);
  const memoryScopeForConversation = (conversation, userId, sharedAgent) =>
    memoryScope(conversation, userId, sharedAgent, state.members);
  const timers = new Map();
  let modal = null,
    modalFocus = null,
    toastTimer = null,
    recallResult = null,
    memorySessionOnly = false;
  let paletteItems = [],
    paletteIndex = 0,
    forgottenItem = null,
    toastAction = null;
  const design = { density: "편안하게", context: true };
  const STORAGE_KEY = "gyeot-prototype-v1";
  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (
        ![8, 9, 10].includes(saved.schema) ||
        !Array.isArray(saved.tasks) ||
        !saved.profiles?.roopre ||
        !saved.profiles?.minji
      )
        return;
      state = initializeTeam({
        ...initial(),
        ...saved,
        search: "",
        memoryQuery: "",
      });
      departments = state.team.departments;
      state.office = { ...initial().office, ...saved.office, playing: false };
      state.tasks.forEach((task) => {
        if (task.status === "running") task.status = "paused";
      });
      state.runs = recoverInterruptedRuns(saved.runs || []);
    } catch {
      memorySessionOnly = true;
    }
  }
  restore();
  function persist() {
    try {
      const snapshot = JSON.parse(JSON.stringify(state));
      // Keep runs referenced by artifacts and handoffs; never trim their evidence.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      memorySessionOnly = false;
    } catch {
      memorySessionOnly = true;
    }
    reportMemoryStorage();
  }
  function reportMemoryStorage() {
    const banner = frame.querySelector("#g-local-storage-state");
    if (banner)
      banner.textContent = memorySessionOnly
        ? "저장 공간 확인 필요 · 현재 화면에만 보관"
        : "이 브라우저에 저장";
    const label = frame.querySelector("#g-memory-storage-state");
    if (label)
      label.textContent = memorySessionOnly
        ? "현재 화면에만 보관 중 · 브라우저 저장 공간 확인 필요"
        : "이 브라우저에 저장됨 · 샘플 기억";
  }
  const profile = () => state.profiles[state.user];
  const allSkills = () => [
    ...baseSkills.map((skill) => ({
      ...skill,
      ...state.skillOverrides?.[skill.id],
    })),
    ...state.customSkills
      .filter((skill) => skill.scope === "team" || skill.owner === state.user)
      .map((skill) => ({ ...skill, ...state.skillOverrides?.[skill.id] })),
  ];
  const skillsFor = (key) =>
    allSkills().filter((s) => key === state.user || s.scope === "team");
  const skillTarget = () =>
    state.agents.some((a) => a.id === state.skillTarget)
      ? state.skillTarget
      : state.user;
  const actorOptions = (selected) =>
    `<option value="${state.user}" ${selected === state.user ? "selected" : ""}>${esc(profile().name)} · 내 비서 (개인)</option>${departments
      .map(
        (d) =>
          `<optgroup label="${d.name}">${departmentAgents(d.id)
            .map(
              (a) =>
                `<option value="${a.id}" ${selected === a.id ? "selected" : ""}>${esc(a.name)} · ${esc(a.role)}</option>`,
            )
            .join("")}</optgroup>`,
      )
      .join("")}`;
  const skillBy = (id) => allSkills().find((s) => s.id === id) || baseSkills[0];
  const taskSkill = (t) => {
    const skill =
      [...baseSkills, ...state.customSkills].find((s) => s.id === t.skill) ||
      baseSkills[0];
    const run = state.runs?.find((r) => r.id === t.runId);
    const resolved = run
      ? { ...skill, ...run.snapshot, version: run.skillVersion }
      : skill;
    return t.officeScenario
      ? {
          ...resolved,
          stages: t.officeStages || resolved.stages,
          ask: t.id === "O-105",
        }
      : resolved;
  };
  const currentAgent = () =>
    state.agents.find((a) => a.id === state.agent) || state.agents[0];
  const departmentOf = (agent) =>
    departments.find((d) => d.id === agent.department) || departments[0];
  const departmentAgents = (id) =>
    state.agents.filter((a) => a.department === id);
  const visibleTasks = () => state.tasks.filter((t) => canReadTask(state, t));
  const myMemories = () =>
    state.memories.filter(
      (m) => m.scope === "personal" && m.owner === state.user,
    );
  const canReadMemory = (m) =>
    !!m &&
    (m.scope === "personal"
      ? m.owner === state.user
      : m.scope === "department"
        ? m.owner === membership(state).department
        : true);
  function memoriesFor(key) {
    const a = state.agents.find((a) => a.id === key);
    return state.memories.filter(
      (m) =>
        canReadMemory(m) &&
        (m.scope === "team" ||
          (a
            ? (m.scope === "agent" && m.owner === key) ||
              (m.scope === "department" && m.owner === a.department) ||
              (m.scope === "personal" &&
                m.owner === state.user &&
                m.agentId === key &&
                m.conversationId === conversationFor(key)?.id &&
                conversationFor(key)?.visibility === "private")
            : m.scope === "personal" &&
              m.owner === state.user &&
              key === state.user)),
    );
  }
  function memoryAudience(m) {
    if (m.scope === "personal")
      return (
        (m.agentId && state.agents.some((a) => a.id === m.agentId)
          ? actorBy(m.agentId).name + " 대화"
          : state.profiles[m.owner]?.name || "내 비서") + " · 개인"
      );
    if (m.scope === "team") return "팀 공통";
    if (m.scope === "department")
      return (
        (departments.find((d) => d.id === m.owner)?.name || "부서") + " 공통"
      );
    return (actorBy(m.owner)?.name || "에이전트") + "의 기억";
  }
  const scopeForTaskMemory = (task) =>
    visibilityOf(task) === "private" ? "personal" : visibilityOf(task);
  const memoryActor = () =>
    state.memoryAgent === state.user ? state.user : state.memoryAgent;
  function recallMemories(key, query) {
    const normalized = String(query).toLowerCase(),
      words = normalized.match(/[가-힣a-z0-9]{2,}/g) || [];
    const groups = [
      ["세션", "토큰", "로그인", "401", "인증", "refresh"],
      ["결제", "payment", "체크아웃"],
      ["배포", "릴리스", "release", "복구"],
      ["보고", "정리", "요약", "결과"],
      ["인계", "전달", "넘길"],
      ["리뷰", "코드", "수정"],
    ];
    const terms = [
      ...new Set([
        ...words,
        ...groups.filter((g) => g.some((t) => normalized.includes(t))).flat(),
      ]),
    ];
    const visible = memoriesFor(key);
    const ranked = visible
      .map((m) => {
        const body = (m.title + " " + m.text).toLowerCase();
        return {
          m,
          score: terms.reduce(
            (n, t) =>
              n +
              (body.includes(t)
                ? m.title.toLowerCase().includes(t)
                  ? 4
                  : 2
                : 0),
            0,
          ),
        };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.at.localeCompare(a.m.at));
    const selected = [];
    let chars = 0;
    for (const { m } of ranked) {
      if (selected.length === 3) break;
      const cost = m.title.length + m.text.length;
      if (chars + cost <= 1800) {
        selected.push(m);
        chars += cost;
      }
    }
    return {
      key,
      query,
      ids: selected.map((m) => m.id),
      refs: selected.map((m) => ({ id: m.id, version: m.version })),
      visible: visible.length,
      chars,
    };
  }
  function recallSources(result) {
    return (result?.ids || [])
      .map((id) => {
        const m = state.memories.find((m) => m.id === id);
        if (!m || !memoriesFor(result.key).some((x) => x.id === id))
          return null;
        const version = result.refs?.find((r) => r.id === id)?.version,
          h = m.history.find((h) => h.version === version);
        return h
          ? {
              ...m,
              ...h,
              evidence: h.evidence || h.text,
              history: [],
              historical: true,
            }
          : m;
      })
      .filter(Boolean);
  }
  function recallText(result) {
    const found = recallSources(result);
    return found.length
      ? found
          .map((m) => `[${result.ids.indexOf(m.id) + 1}] ${m.text}`)
          .join("\n\n")
      : "관련 기억을 찾지 못했어요. 필요한 맥락을 더 알려주세요.";
  }
  function newMemory(data) {
    const m = {
      id: "m-" + Date.now() + "-" + Math.random().toString(36).slice(2, 5),
      version: 1,
      history: [],
      updated: profile().owner,
      at: new Date().toLocaleDateString("sv-SE"),
      kind: "fact",
      ...data,
    };
    state.memories.unshift(m);
    return m;
  }
  const taskBy = (id) => visibleTasks().find((t) => t.id === id);
  const currentTask = () => taskBy(state.task);
  function taskAssignee(t, stage = t.stage) {
    if (t.workflow)
      return state.agents.find((a) => a.id === t.steps[t.stepIndex].agentId);
    const skill = taskSkill(t),
      caller = state.agents.find((a) => a.id === t.requesterAgent);
    const find = (id) => state.agents.find((a) => a.id === id);
    if (t.officeAssignees) return find(t.officeAssignees[Math.min(stage, 4)]);
    if (t.officeAssignee) return find(t.officeAssignee);
    if (stage === 0 || stage >= 4 || skill.role === "personal")
      return caller || null;
    if (skill.role === "ops")
      return caller?.department === "operations" ? caller : find("ops");
    if (skill.role === "research")
      return caller?.department === "direct" ? caller : find("research");
    if (skill.role === "coordination")
      return caller?.department === "direct" ? caller : find("chief");
    if (skill.role === "review") return find("review");
    if (stage === 3) return caller?.department === "qa" ? caller : find("qa");
    return find("dev");
  }
  function specialistState(a) {
    const t = visibleTasks().find(
      (t) =>
        ["running", "needs_input", "paused"].includes(t.status) &&
        taskAssignee(t)?.id === a.id,
    );
    return t
      ? {
          text:
            t.status === "needs_input"
              ? "확인 대기"
              : t.status === "paused"
                ? "일시정지"
                : "업무 진행 중",
          color: t.status === "needs_input" ? "amber" : "blue",
          task: t,
        }
      : { text: "업무 대기", color: "", task: null };
  }
  const actorBy = (key) =>
    state.agents.find((a) => a.id === key) || state.profiles[key];
  const actorKey = (actor) =>
    actor.id ||
    Object.keys(state.profiles).find((key) => state.profiles[key] === actor) ||
    state.user;
  const characterBy = characterById;
  function characterPortrait(id, color = "blue", big = false, activity = null) {
    const c = characterBy(id);
    return `<span class="g-avatar g-character g-${color} ${big ? "g-big" : ""}" aria-hidden="true" data-character="${c.id}">${characterIllustration(c)}${activity?.task ? `<span class="g-character-status ${activity.color}"></span>` : ""}</span>`;
  }
  function avatar(name, color = "blue", big = false, key = null) {
    const a =
      key === "human"
        ? null
        : key
          ? actorBy(key)
          : [...state.agents, ...Object.values(state.profiles)].find(
              (a) => a.name === name || String(name).startsWith(a.name + " ·"),
            );
    return a
      ? characterPortrait(
          a.character,
          color,
          big,
          a.id ? specialistState(a) : null,
        )
      : `<span class="g-avatar g-${color} ${big ? "g-big" : ""}" aria-hidden="true">${esc(String(name).slice(0, 1))}</span>`;
  }
  function characterTrigger(a) {
    return `<button type="button" class="g-character-trigger cursor-interaction" data-action="character-settings" data-key="${actorKey(a)}" aria-label="${esc(a.name)} 캐릭터 바꾸기">${avatar(a.name, a.color, true, actorKey(a))}<span class="g-character-edit">${icon("pencil")}</span></button>`;
  }
  function workbenchHeading(a, team) {
    return `<div class="g-breadcrumb">${team ? "공용 에이전트 / " + departmentOf(a).name + " / " + esc(a.name) : "개인 공간 / 내 비서"}</div><div class="g-page-head g-workbench-head"><div class="g-row" style="align-items:flex-start;gap:14px">${characterTrigger(a)}<div><div class="g-row g-wrap"><h1>${esc(a.name)}</h1><span class="g-pill">${team ? esc(a.role) : esc(a.owner) + "님의 비서"}</span></div><div class="g-character-identity"><span>${esc(characterBy(a.character).name)}</span><span class="g-dot"></span><span>${esc(a.personality)}</span></div><p class="g-page-sub">${team ? esc(a.note) : esc(a.role) + " · " + esc(a.style)}</p></div></div><div class="g-row g-wrap">${button("캐릭터", "character-settings", `data-key="${actorKey(a)}"`, false, "palette")}${button(team ? "설정" : "비서 커스텀", team ? "agent-settings" : "settings", team ? `data-id="${a.id}"` : "", false, "sliders-horizontal")}</div></div>`;
  }
  function characterContext(a) {
    return `<section><div class="g-rail-heading"><span>이런 동료예요</span><button type="button" class="g-text-button cursor-interaction" data-action="character-settings" data-key="${actorKey(a)}">편집</button></div><div class="g-character-profile">${avatar(a.name, a.color, false, actorKey(a))}<div><strong>${esc(a.personality)}</strong><span class="g-muted">${esc(a.name)} · ${esc(characterBy(a.character).name)}</span></div></div><p class="g-character-quote">“${esc(a.catchphrase)}”</p></section>`;
  }
  function status(t) {
    const defs = {
      queued: ["실행 대기", ""],
      running: ["진행 중", "blue"],
      needs_input: ["확인 필요", "amber"],
      result_ready: ["결과 확인 대기", "amber"],
      done: ["완료", "green"],
      cancelled: ["중단됨", ""],
      paused: ["재개 대기", ""],
    };
    const [label, color] = defs[t.status] || defs.queued;
    return `<span class="g-pill ${color}"><span class="g-dot"></span>${label}</span>`;
  }
  function nav() {
    const attention = visibleTasks().filter(
      (t) => t.status === "needs_input" && canOperateTask(state, t),
    ).length;
    const items = [
      ["home", "notebook-pen", "내 업무 공간"],
      ["office", "panels-top-left", "팀 오피스"],
      ["conversations", "messages-square", "공유 대화"],
      ["work", "layers", "업무"],
      ["inbox", "inbox", "확인 요청"],
      ["skills", "blocks", "스킬 라이브러리"],
      ["memory", "bookmark", "기억 보관함"],
    ];
    const tree = departments
      .map((d) => {
        const members = departmentAgents(d.id),
          closed = state.collapsedDepartments.includes(d.id);
        const active = state.view === "agents" && state.department === d.id;
        return `<section aria-label="${d.name} 부서"><div class="g-dept-tree-heading"><button type="button" class="g-dept-toggle cursor-interaction" data-action="toggle-department" data-id="${d.id}" aria-label="${d.name} 부서 ${closed ? "펼치기" : "접기"}" aria-expanded="${!closed}" aria-controls="g-dept-${d.id}">${icon(closed ? "chevron-right" : "chevron-down")}</button><button type="button" class="g-dept-name cursor-interaction" data-action="department" data-id="${d.id}" aria-pressed="${active}">${icon(d.icon)}<span>${d.name}</span><span class="g-dept-number">${members.length}</span></button></div><div class="g-dept-children" id="g-dept-${d.id}" ${closed ? "hidden" : ""}>${members.map((a) => `<button type="button" class="g-side-agent cursor-interaction" data-action="agent" data-id="${a.id}" aria-label="${esc(a.name)} · ${esc(a.role)}" aria-current="${state.view === "agent" && state.agent === a.id ? "page" : "false"}">${avatar(a.name, a.color, false, a.id)}<span><span class="g-dept-agent-name">${esc(a.name)}</span><span class="g-dept-agent-role">${esc(a.role)}</span></span></button>`).join("") || '<span class="g-tiny g-muted">소속 에이전트 없음</span>'}</div></section>`;
      })
      .join("");
    return `<aside class="g-sidebar"><nav class="g-nav-group" aria-label="주요 메뉴"><div class="g-nav-label">워크스페이스</div>${items.map(([id, i, label]) => `<button type="button" class="g-nav-button cursor-interaction" data-action="navigate" data-view="${id}" aria-label="${label}" aria-pressed="${state.view === id}">${icon(i)}<span>${label}</span>${id === "inbox" ? `<span class="g-count" data-inbox-count ${attention ? "" : "hidden"}>${attention}</span>` : ""}</button>`).join("")}</nav>${isTeamLead(state) ? `<nav class="g-admin-nav" aria-label="팀장 메뉴"><div class="g-nav-label">팀장 공간</div><button type="button" class="g-nav-button" data-action="navigate" data-view="admin" aria-pressed="${state.view === "admin"}">${icon("users-round")}<span>팀 관리</span><span class="g-role-nav-dot"></span></button></nav>` : ""}<nav class="g-agent-roster" aria-label="부서별 공용 에이전트"><div class="g-roster-label"><span>공용 에이전트 · ${state.agents.length}</span><button type="button" class="cursor-interaction" data-action="navigate" data-view="agents" aria-label="모든 에이전트 보기" data-tooltip="모든 에이전트 보기">${icon("arrow-up-right")}</button></div><div class="g-department-tree">${tree}</div></nav><div class="g-side-footer"><button type="button" class="g-personal-shortcut cursor-interaction" data-action="navigate" data-view="assistant" aria-current="${state.view === "assistant" ? "page" : "false"}">${avatar(profile().name, profile().color, false, state.user)}<span><strong>${esc(profile().name)}</strong><small>나의 개인 비서</small></span>${icon("lock-keyhole")}</button><p class="g-prototype-note">${icon("flask-conical")} 샘플 대화·실행 목업</p></div></aside>`;
  }
  function shell(content) {
    return `<div class="g-shell ${state.view === "office" ? "g-office-shell" : ""} ${!state.office.motion || !state.office.playing ? "g-office-still" : ""}"><header class="g-top"><div class="g-brand"><span class="g-brand-mark" aria-hidden="true">C</span><span class="g-brand-name">크루룸</span><span class="g-team-name">${esc(state.team.name)}</span><span class="g-prototype">목업</span></div><div class="g-top-actions"><button type="button" class="g-quick-find cursor-interaction" data-action="quick-find" aria-label="빠른 찾기">${icon("search")}<span>동료, 업무, 기억 찾기</span><kbd>⌘ K</kbd></button>${button("업무 맡기기", "new-request", "", true, "plus")}<div class="g-account"><select id="g-account-select" aria-label="시연 사용자 전환">${Object.values(
      state.members,
    )
      .map(
        (m) =>
          `<option value="${m.id}" ${m.id === state.user ? "selected" : ""}>${esc(m.name)} / ${m.role === "lead" ? "팀장" : "팀원"}</option>`,
      )
      .join(
        "",
      )}</select></div></div></header><div class="g-local-banner"><span>${icon("flask-conical")} 인터랙티브 프로토타입 <span class="g-banner-divider">/</span> <span id="g-local-storage-state">이 브라우저에 저장</span> · AI·외부 서비스 연결 전</span><span class="g-demo-actions"><button type="button" data-action="start-signup">회원가입 체험</button><button type="button" data-action="reset-demo">시연 초기화</button></span></div>${nav()}<main class="g-main">${content}</main></div>`;
  }
  function pageHead(title, sub, actions = "") {
    return `<div class="g-page-head"><div><h1>${title}</h1><p class="g-page-sub">${sub}</p></div>${actions}</div>`;
  }
  function messagesHTML(key, agentName, color, team = false) {
    const messages = state.messages[conversationIdFor(key)] || [];
    const waiting = visibleTasks().find((t) => t.status === "needs_input");
    const actor = team ? currentAgent() : profile();
    const greet = team
      ? `안녕하세요. ${currentAgent().role} 담당 ${agentName}입니다. ${actor.catchphrase} 아래 스킬로 바로 시작해도 좋아요.`
      : `${profile().owner}님, 안녕하세요. ${actor.catchphrase} ${waiting ? "「" + waiting.title + "」 작업에서 확인을 기다리고 있어요." : "새 업무는 아래 스킬로 시작할 수 있어요."}`;
    state.messageWindows ||= {};
    const windowSize = state.messageWindows[conversationIdFor(key)] || 20;
    const shown = messages.length
      ? messages.slice(-windowSize).map((m, i) => ({
          ...m,
          index: Math.max(0, messages.length - windowSize) + i,
        }))
      : [{ author: agentName, text: greet, kind: "agent" }];
    return (
      (messages.length > windowSize
        ? `<button type="button" class="g-earlier-messages" data-action="load-messages" data-key="${key}">이전 메시지 ${messages.length - windowSize}개 더 보기</button>`
        : "") +
      shown
        .map(
          (m) =>
            `<div class="g-message ${m.kind === "user" ? "user" : ""}">${avatar(m.kind === "user" ? m.author : agentName, m.kind === "user" ? "purple" : color, false, m.kind === "user" ? "human" : key)}<div class="g-message-content"><div class="g-message-name"><span>${esc(m.author)}</span><span class="g-tiny g-muted">${m.kind === "user" ? "" : conversationScope(conversationFor(key))}</span></div><div class="g-message-body">${esc(m.text)}</div>${m.recall ? `<div class="g-message-memory"><span class="g-tiny g-muted">${icon("bookmark-check")} 참고한 기억 ${recallSources(m.recall).length}개</span></div>${memoryLinks(m.recall)}` : ""}${m.memoryId && canReadMemory(state.memories.find((x) => x.id === m.memoryId)) ? `<div class="g-message-memory">${button("저장된 기억 보기", "memory-detail", `data-id="${m.memoryId}"`, false, "bookmark-check")}</div>` : ""}${m.kind === "user" ? `<div class="g-message-memory"><button type="button" class="g-text-button cursor-interaction" data-action="remember-message" data-key="${key}" data-index="${m.index}">${icon("bookmark-plus")} 기억에 남기기</button></div>` : ""}${m.action === "task" ? `<div style="margin-top:9px">${button("이 요청으로 업무 맡기기", "chat-task", `data-key="${key}" data-target="${esc(m.target)}"`, false, "plus")}</div>` : ""}</div></div>`,
        )
        .join("")
    );
  }
  function agentTasksFor(a, team) {
    return visibleTasks().filter((t) =>
      team
        ? t.requesterAgent === a.id ||
          taskSkill(t).stages.some((_, i) => taskAssignee(t, i)?.id === a.id)
        : t.owner === state.user,
    );
  }
  function quickSkill(s, key = state.user) {
    return `<button type="button" class="g-launch cursor-interaction" data-action="run-skill" data-id="${s.id}" data-agent="${key}">${icon(s.icon)}<span>${esc(s.name)}</span>${icon("arrow-up-right")}</button>`;
  }
  function handoffHTML(t) {
    const agents = [taskAssignee(t, 2), taskAssignee(t, 3)].filter(
      (a, i, arr) => a && arr.findIndex((b) => b?.id === a.id) === i,
    );
    return `<div class="g-handoff">${agents.map((a, i) => `${i ? icon("arrow-right") : ""}${avatar(a.name, a.color, false, a.id)}<span>${esc(a.name)}</span>`).join("")}${agents.length ? icon("arrow-right") : ""}<span>결과</span></div>`;
  }
  function awaitingHTML(t) {
    const a = taskAssignee(t);
    return `<div class="g-awaiting"><span class="g-status-inline amber"><span class="g-dot"></span>${esc(a?.name || "비서")}의 확인 요청</span><h3 class="g-awaiting-title">${esc(t.title)}</h3><p class="g-small g-muted">검증 범위를 선택하면 다음 단계로 이어집니다.</p>${handoffHTML(t)}${button("범위 확인하고 재개", "open-task", `data-id="${t.id}"`, true, "corner-down-right")}</div>`;
  }
  function skillRows(skills, key = null) {
    return `<div class="g-skill-list">${
      skills
        .map((skill) => {
          const target = key || skillTarget(),
            actor = actorBy(target),
            attached = actor.skills.includes(skill.id),
            binding = bindingFor(actor, skill);
          return `<article class="g-skill-list-row" data-skill-id="${skill.id}"><span class="g-skill-symbol">${icon(skill.icon)}</span><div><h3>${esc(skill.name)}</h3><p>${esc(skill.desc)}</p><div class="g-skill-row-meta"><span>라이브러리 v${skill.version}</span><span>${skill.scope === "team" ? "팀 공용" : "개인"}</span><span class="g-binding-state is-${binding.id}" data-binding-state="${binding.id}">${binding.label}</span></div>${attached ? `<div class="g-version-pins"><span>장착 v${binding.desired}</span><span>적용 ${binding.effective ? "v" + binding.effective : "대기"}</span>${binding.running ? `<span>진행 실행 v${binding.running}</span>` : ""}</div>` : ""}</div><div class="g-skill-row-actions">${!key ? `<button type="button" class="g-button ${attached ? "g-attached" : ""}" data-action="attach-skill" data-id="${skill.id}" data-agent="${target}" aria-label="${esc(actor.name)}에게 ${esc(skill.name)} ${attached ? "해제" : "장착"}" aria-pressed="${attached}">${icon(attached ? "check" : "plus")}${attached ? "장착됨" : "장착"}</button>` : ""}${button("상세", "skill-detail", `data-id="${skill.id}" data-agent="${target}"`)}<button type="button" class="g-button g-primary" data-action="run-skill" data-id="${skill.id}" data-agent="${target}" ${binding.id === "unsupported" ? "disabled" : ""}>${icon("play")} 실행</button></div></article>`;
        })
        .join("") ||
      '<div class="g-empty">아직 장착한 스킬이 없어요. 스킬 관리에서 반복할 업무를 골라보세요.</div>'
    }</div>`;
  }
  function workbenchContext(a, team, tasks) {
    const waiting = tasks.find(
      (t) =>
        t.status === "needs_input" && (!team || taskAssignee(t)?.id === a.id),
    );
    const current = tasks.find((t) =>
      ["running", "needs_input", "paused", "queued"].includes(t.status),
    );
    const memories = memoriesFor(team ? a.id : state.user);
    return `<aside class="g-agent-context" aria-label="에이전트 업무 맥락"><section><div class="g-rail-heading"><span>지금 하는 일</span><span class="g-tiny g-muted">${tasks.filter((t) => !["done", "cancelled"].includes(t.status)).length}건</span></div>${waiting ? awaitingHTML(waiting) : current ? `<div class="g-awaiting">${status(current)}<h3 class="g-awaiting-title">${esc(current.title)}</h3><p class="g-small g-muted">${esc(taskSkill(current).stages[Math.min(current.stage, 4)])} 단계</p>${handoffHTML(current)}${button("업무 열기", "open-task", `data-id="${current.id}"`, false, "arrow-up-right")}</div>` : `<p class="g-small g-muted">새 업무를 시작할 수 있어요.</p><div class="g-mt">${button("업무 맡기기", "new-request", `data-agent="${team ? a.id : state.user}"`, false, "plus")}</div>`}</section><section><div class="g-rail-heading"><span>참고하는 기억</span><button type="button" class="g-text-button cursor-interaction" data-action="agent-tab" data-value="memory">${memories.length}개 보기</button></div>${
      memories
        .slice(0, 3)
        .map(
          (m) =>
            `<button type="button" class="g-context-memory-link cursor-interaction" data-action="memory-detail" data-id="${m.id}">${icon("bookmark")}<span>${esc(m.title)}<small>${esc(memoryAudience(m))} · v${m.version}</small></span></button>`,
        )
        .join("") ||
      '<p class="g-small g-muted">기억 탭에서 업무 규칙을 알려주세요.</p>'
    }</section><section><div class="g-rail-heading"><span>업무 방식</span></div><dl class="g-context-dl"><dt>실행 하네스</dt><dd>${RUNTIMES[a.runtime]?.name || a.runtime} <small class="g-muted">· 예시</small></dd><dt>업무 방식</dt><dd>${esc(a.harness)}</dd><dt>스킬</dt><dd><button type="button" class="g-text-button cursor-interaction" data-action="agent-tab" data-value="skills">${a.skills.length}개 장착</button></dd><dt>이 대화</dt><dd>${conversationScope(conversationFor(team ? a.id : state.user))}</dd></dl></section><section><div class="g-rail-heading">${team ? "같은 부서 동료" : "함께 일하는 동료"}</div><div class="g-related-team">${(team ? departmentAgents(a.department).filter((x) => x.id !== a.id) : state.agents.filter((x) => ["chief", "dev", "qa"].includes(x.id))).map((x) => `<button type="button" class="g-agent-chip cursor-interaction" data-action="agent" data-id="${x.id}">${avatar(x.name, x.color, false, x.id)}${esc(x.name)}</button>`).join("") || '<span class="g-tiny g-muted">소속 동료가 없어요.</span>'}</div></section></aside>`;
  }

  function initializeModel() {
    state.skillOverrides ||= {};
    state.runs ||= [];
    state.conversations ||= [];
    state.activeConversations ||= {};
    [...state.agents, ...Object.values(state.profiles)].forEach((actor) => {
      actor.runtime ||=
        actor.id === "research"
          ? "letta"
          : ["dev", "review"].includes(actor.id)
            ? "openhands"
            : "hermes";
      actor.configVersion ||= 1;
      actor.skillPins ||= Object.fromEntries(
        actor.skills.map((id) => [id, skillBy(id).version]),
      );
      actor.effectiveSkills ||= { ...actor.skillPins };
    });
    if (!state.conversations.length) {
      const titles = {
        dev: "로그인 세션 오류 수정",
        qa: "로그인 회귀 검증",
        review: "인증 변경 리뷰",
        chief: "금요일 릴리스 준비",
        research: "팀 에이전트 도구 조사",
        ops: "API 오류 현황",
        "release-ops": "배포 순서와 복구 계획",
        "test-design": "결제 경계 조건",
      };
      state.agents.forEach((actor) => {
        const id = `c-${actor.id}-shared`;
        state.conversations.push({
          id,
          actorId: actor.id,
          owner: actor.id === "qa" ? "minji" : "roopre",
          title: titles[actor.id],
          visibility: "team",
          department: actor.department,
          createdAt: new Date().toISOString(),
          taskId: actor.id === "qa" ? "T-108" : null,
        });
        state.messages[id] = [
          {
            author: actor.name,
            kind: "agent",
            text:
              actor.id === "qa"
                ? "로그인 30분 후 만료와 여러 탭의 동시 요청을 확인할 준비가 됐어요. T-108에서 검증 범위를 정해주시면 이어갈게요. (샘플 대화)"
                : "업무별로 대화를 나누고, 필요한 맥락과 결과를 이곳에 모아요. 아래 스킬로 시작할 수 있어요. (샘플 대화)",
          },
        ];
      });
      for (const [owner, actor] of Object.entries(state.profiles)) {
        const id = `c-${owner}-personal`;
        state.conversations.push({
          id,
          actorId: owner,
          owner,
          title: "이번 주 업무 정리",
          visibility: "private",
          department: state.members[owner]?.department || "development",
          createdAt: new Date().toISOString(),
        });
        state.messages[id] = [
          {
            author: actor.name,
            kind: "agent",
            text: `${actor.owner}님, ${actor.catchphrase} 대화와 개인 기억은 각각의 범위로 관리해요. (샘플 대화)`,
          },
        ];
      }
      state.conversations.push({
        id: "c-dev-planning",
        actorId: "dev",
        owner: "roopre",
        title: "다음 스프린트 구상",
        visibility: "private",
        department: "development",
        createdAt: new Date().toISOString(),
      });
      state.messages["c-dev-planning"] = [
        {
          author: "로프레",
          kind: "user",
          text: "캐시 정리 아이디어는 아직 개인 초안으로 남겨줘.",
        },
        {
          author: "카이",
          kind: "agent",
          text: "이 대화는 로프레님만 보는 개인 초안이에요. 팀 대화와 분리해 두었습니다. (샘플 대화)",
        },
      ];
    }
    state.tasks.forEach((task) => {
      task.conversationId ||=
        task.requesterAgent === "dev"
          ? "c-dev-shared"
          : task.requesterAgent === "roopre"
            ? "c-roopre-personal"
            : null;
    });
  }
  function conversationFor(key) {
    const visible = state.conversations.filter(
      (c) => c.actorId === key && canReadConversation(c, state.user),
    );
    const selection = `${state.user}:${key}`;
    let conversation =
      visible.find((c) => c.id === state.activeConversations[selection]) ||
      visible[0];
    if (!conversation) {
      if (!state.agents.some((a) => a.id === key) && key !== state.user)
        return null;
      conversation = createConversation(key, "새 대화");
    }
    state.activeConversations[selection] = conversation.id;
    return conversation;
  }
  function createConversation(key, title) {
    const actor = actorBy(key);
    const conversation = {
      id: `c-${crypto.randomUUID()}`,
      actorId: key,
      owner: state.user,
      title,
      visibility: "private",
      department: actor?.department || membership(state).department,
      createdAt: new Date().toISOString(),
    };
    state.conversations.unshift(conversation);
    state.activeConversations[`${state.user}:${key}`] = conversation.id;
    state.messages[conversation.id] = [];
    return conversation;
  }
  const conversationIdFor = (key) => conversationFor(key)?.id;
  const conversationScope = (c) =>
    ({
      private: "나만",
      department:
        (departments.find((d) => d.id === c?.department)?.name || "부서") +
        " 부서",
      team: "팀 공유",
    })[c?.visibility] || "나만";
  function conversationToolbar(key) {
    const current = conversationFor(key);
    const visible = state.conversations.filter(
      (c) => c.actorId === key && canReadConversation(c, state.user),
    );
    return `<div class="g-thread-toolbar"><label for="g-conversation-select"><span class="g-tiny g-muted">대화</span><select id="g-conversation-select" data-key="${key}" aria-label="대화 선택">${visible.map((c) => `<option value="${c.id}" ${c.id === current.id ? "selected" : ""}>${esc(c.title)}</option>`).join("")}</select></label><div class="g-row">${button("새 대화", "new-conversation", `data-key="${key}"`, false, "plus")}${button(conversationScope(current), "conversation-access", `data-id="${current.id}"`, false, current.visibility === "private" ? "lock-keyhole" : "users-round")}</div></div>${current.taskId && taskBy(current.taskId) ? `<button type="button" class="g-thread-task" data-action="open-task" data-id="${current.taskId}">${icon("layers")} 연결된 업무 · ${esc(taskBy(current.taskId).title)} ${icon("arrow-up-right")}</button>` : ""}`;
  }
  function sharedConversationsPage() {
    const visible = state.conversations.filter(
      (c) => c.visibility !== "private" && canReadConversation(c, state.user),
    );
    return `${pageHead("함께 이어가는 대화", "공유된 맥락을 찾고, 같은 업무를 이어서 이야기하세요.")}<div class="g-shared-list">${
      visible
        .map((c) => {
          const actor = actorBy(c.actorId),
            messages = state.messages[c.id] || [];
          return `<button type="button" class="g-shared-thread" data-action="open-conversation" data-id="${c.id}">${avatar(actor.name, actor.color, false, c.actorId)}<span><strong>${esc(c.title)}</strong><small>${esc(actor.name)} · ${conversationScope(c)} · 메시지 ${messages.length}개</small><p>${esc(messages.at(-1)?.text || "아직 메시지가 없어요.")}</p></span>${icon("arrow-up-right")}</button>`;
        })
        .join("") ||
      '<div class="g-empty">공유된 대화가 없어요. 대화 상단에서 공개 범위를 바꿀 수 있어요.</div>'
    }</div>`;
  }
  function sharedThreadPage() {
    const c = state.conversations.find(
      (c) =>
        c.id === state.selectedConversation &&
        canReadConversation(c, state.user),
    );
    if (!c) return sharedConversationsPage();
    if (c.taskId && taskBy(c.taskId)?.workflow)
      return workflowDetail(state, taskBy(c.taskId), flowHelpers());
    const actor = actorBy(c.actorId);
    return `${pageHead(esc(c.title), `${actor.name} · ${conversationScope(c)} · 공유한 대화만 열람`, button("공유 대화 목록", "navigate", 'data-view="conversations"', false, "arrow-left"))}<div class="g-readonly-note">${icon("lock-keyhole")} 공유된 메시지를 보고 있어요. 이 비서의 개인 기억과 다른 대화는 포함되지 않아요.</div><section class="g-conversation"><div class="g-messages">${(state.messages[c.id] || []).map((m) => `<div class="g-message">${avatar(m.author, actor.color, false, m.kind === "user" ? "human" : c.actorId)}<div class="g-message-content"><div class="g-message-name">${esc(m.author)}</div><p class="g-message-body">${esc(m.text)}</p></div></div>`).join("")}</div></section>`;
  }
  function runFor(task) {
    return state.runs.find((run) => run.id === task.runId);
  }
  function ensureRun(task, fresh = false) {
    if (task.workflow) return runFor(task);
    let run = runFor(task);
    if (!run || fresh) {
      const actor = actorBy(task.requesterAgent) || state.profiles[task.owner];
      const skill =
        [...baseSkills, ...state.customSkills].find(
          (s) => s.id === task.skill,
        ) || baseSkills[0];
      const current = { ...skill, ...state.skillOverrides[skill.id] };
      if (!runtimeSupportsSkill(actor.runtime, current.id)) {
        task.profileMismatch = true;
        task.status = "paused";
        return run;
      }
      delete task.profileMismatch;
      run = createRunSnapshot(task, actor, current, state.runs);
      task.runId = run.id;
      task.version = run.skillVersion;
      task.harness = run.snapshot.harness;
      actor.effectiveSkills[skill.id] = run.skillVersion;
      state.runs.push(run);
      appendRunEvent(run, {
        type: "snapshot",
        text: `${RUNTIMES[run.runtime].name} 예시 프로필 · ${current.name} v${run.skillVersion} · 설정 v${run.configVersion} 고정`,
      });
    }
    return run;
  }
  function recordRun(task, text, type = "state") {
    const run = ensureRun(task);
    if (!run || task.profileMismatch) return;
    run.status = task.status;
    appendRunEvent(run, { type, text });
  }
  function executionPanel(task) {
    const run = runFor(task);
    if (!run)
      return '<div class="g-empty">실행을 시작하면 버전과 이벤트 기록이 남아요.</div>';
    const history = state.runs.filter((r) => r.taskId === task.id);
    return `<div class="g-run-head"><div><h3>실행의 근거</h3><p>업무와 별도의 실행 ID로 상태와 버전을 남겨요.</p></div><span class="g-pill">로컬 시뮬레이션</span></div><dl class="g-run-facts"><div><dt>업무 / 실행</dt><dd>${esc(task.id)} / <strong>${esc(run.id)}</strong></dd></div><div><dt>실행 프로필</dt><dd>${RUNTIMES[run.runtime]?.name || run.runtime} · 설정 v${run.configVersion}</dd></div><div><dt>고정된 스킬</dt><dd>${esc(run.snapshot.name)} <strong>v${run.skillVersion}</strong></dd></div><div><dt>실행 소유권</dt><dd>generation ${run.generation} · ${run.recoveryReason ? "새로고침 후 재개 대기" : "브라우저 시연"}</dd></div></dl><p class="g-run-boundary">실제 하네스 프로세스·격리 환경은 연결 전입니다. 이 화면의 ID와 이벤트는 브라우저가 생성합니다.</p><div class="g-event-table"><div class="g-event-row g-event-heading"><span>순서</span><span>시각</span><span>이벤트</span></div>${run.events.map((e) => `<div class="g-event-row"><span>#${e.sequence}</span><time>${new Date(e.at).toLocaleTimeString("ko-KR", { hour12: false })}</time><span><small>${esc(e.type)}</small>${esc(e.text)}</span></div>`).join("")}</div>${history.length > 1 ? `<p class="g-small g-muted g-mt">이 업무에 ${history.length}개 실행 기록이 있어요. 이전 실행의 버전도 유지됩니다.</p>` : ""}`;
  }
  function bindingFor(actor, skill) {
    const desired = actor.skillPins[skill.id] || skill.version;
    const effective = actor.effectiveSkills[skill.id];
    const running = state.runs.findLast(
      (r) =>
        r.agentId === actorKey(actor) &&
        r.skillId === skill.id &&
        ["running", "paused", "needs_input"].includes(r.status),
    );
    return {
      ...skillBindingStatus({
        attached: actor.skills.includes(skill.id),
        desired,
        effective,
        running: running?.skillVersion,
        supported: runtimeSupportsSkill(actor.runtime, skill.id),
      }),
      desired,
      effective,
      running: running?.skillVersion,
    };
  }
  function workspaceSummary() {
    const tasks = visibleTasks();
    return `<div class="g-workspace-summary" aria-label="업무 요약">${[
      [
        "activity",
        "진행 중",
        tasks.filter((t) => t.status === "running").length,
        "work",
      ],
      [
        "circle-help",
        "내 답변 대기",
        tasks.filter(
          (t) => t.status === "needs_input" && canOperateTask(state, t),
        ).length,
        "inbox",
      ],
      [
        "file-check-2",
        "준비된 결과",
        tasks.filter((t) => ["done", "result_ready"].includes(t.status)).length,
        "results",
      ],
    ]
      .map(
        ([glyph, label, n, view]) =>
          `<button type="button" data-action="${view === "results" ? "view-results" : "navigate"}" data-view="${view}">${icon(glyph)}<span>${label}</span><strong>${n}</strong>${icon("chevron-right")}</button>`,
      )
      .join("")}</div>`;
  }

  function workbenchPage(team = false) {
    const a = team ? currentAgent() : profile(),
      key = team ? a.id : state.user,
      tasks = agentTasksFor(a, team);
    const memories = memoriesFor(key);
    const active = ["chat", "tasks", "skills", "memory"].includes(
      state.agentTab,
    )
      ? state.agentTab
      : "chat";
    const tabs = [
      ["chat", "message-circle", "대화", ""],
      ["tasks", "layers", "작업", tasks.length],
      ["skills", "blocks", "스킬", a.skills.length],
      ["memory", "bookmark", "기억", memories.length],
    ];
    let content = "";
    if (active === "chat")
      content = `<section class="g-conversation" aria-label="${team ? "팀 공유" : "개인 비서"} 대화">${conversationToolbar(key)}<div class="g-conversation-top"><span class="g-row g-small g-muted">${icon(conversationFor(key)?.visibility === "private" ? "lock-keyhole" : "users-round")}${conversationScope(conversationFor(key))} · 선택한 대화의 공개 범위</span><span class="g-tiny g-muted">샘플 응답</span></div><div class="g-messages" aria-live="polite">${messagesHTML(key, a.name, a.color, team)}</div><div class="g-launches"><div class="g-row g-between"><span class="g-tiny g-muted">바로 실행</span><button type="button" class="g-text-button cursor-interaction" data-action="agent-tab" data-value="skills">스킬 ${a.skills.length}개</button></div><div class="g-skill-buttons">${a.skills
        .slice(0, 4)
        .map((id) => quickSkill(skillBy(id), key))
        .join(
          "",
        )}</div></div><form class="g-composer" data-form="chat" data-key="${key}"><label for="g-chat" class="g-small g-muted" style="display:block;margin-bottom:5px">${esc(a.name)}에게 말 걸기</label><textarea id="g-chat" name="message" maxlength="700" required placeholder="업무를 맡기거나, 이어서 궁금한 점을 물어보세요.">${esc(state.drafts[conversationIdFor(key)] || "")}</textarea><div class="g-composer-bottom"><span class="g-tiny g-muted">${conversationScope(conversationFor(key))} · ⌘ Enter로 보내기</span><button type="button" class="g-button g-primary cursor-interaction" data-action="submit-form">보내기 ${icon("arrow-up")}</button></div></form></section>`;
    else if (active === "tasks")
      content = `<div><div class="g-toolbar"><span class="g-small g-muted">${team ? esc(a.name) + "가 참여한 작업" : "내가 맡긴 작업"}</span>${button("새 업무", "run-skill", `data-id="${a.skills[0] || "release"}" data-agent="${key}"`, true, "plus")}</div>${tasks.map((t) => `<button type="button" class="g-agent-task-row cursor-interaction" data-action="open-task" data-id="${t.id}"><div><span class="g-tiny g-muted">${t.id} · ${esc(t.project)}</span><h3>${esc(t.title)}</h3><span class="g-tiny g-muted">${esc(state.profiles[t.owner]?.owner || "팀원")} 요청 · ${esc(taskSkill(t).name)}</span></div>${status(t)}${icon("chevron-right")}</button>`).join("") || '<div class="g-empty">아직 참여한 작업이 없어요. 새 업무를 맡겨보세요.</div>'}</div>`;
    else if (active === "skills")
      content = `<div><div class="g-toolbar"><span class="g-small g-muted">버튼 하나로 반복 업무를 시작하세요.</span>${button("스킬 관리", "manage-skills", `data-agent="${key}"`, false, "plus")}</div>${skillRows(a.skills.map(skillBy), key)}</div>`;
    else content = memoryWorkbench(key);
    return `${workbenchHeading(a, team)}<div class="g-workbench-tabs" role="tablist" aria-label="에이전트 작업실">${tabs.map(([id, glyph, label, count]) => `<button type="button" id="g-agent-tab-${id}" class="g-workbench-tab cursor-interaction" role="tab" aria-selected="${active === id}" aria-controls="g-agent-panel" data-action="agent-tab" data-value="${id}">${icon(glyph)}${label}${count !== "" ? `<span class="g-tab-count">${count}</span>` : ""}</button>`).join("")}</div><div class="g-agent-workspace"><div id="g-agent-panel" role="tabpanel" aria-labelledby="g-agent-tab-${active}" style="min-width:0">${content}</div>${workbenchContext(a, team, tasks)}</div>`;
  }
  let officeTimer = null;
  const officeDefinitions = [
    {
      id: "O-101",
      title: "금요일 배포 업무 정리",
      agent: "chief",
      skill: "triage",
      offset: 0,
    },
    {
      id: "O-102",
      title: "에이전트 도구 비교 조사",
      agent: "research",
      skill: "research",
      offset: 2,
    },
    {
      id: "O-103",
      title: "API 응답 상태 점검",
      agent: "ops",
      skill: "ops-check",
      offset: 1,
    },
    {
      id: "O-104",
      title: "결제 회귀 시나리오 설계",
      agent: "test-design",
      skill: "regression",
      offset: 3,
      stages: [
        "요구사항 확인",
        "경계 조건 분석",
        "시나리오 작성",
        "커버리지 검토",
        "결과 정리",
      ],
    },
    {
      id: "O-105",
      title: "로그인 수정부터 배포 준비까지",
      agent: "dev",
      skill: "release",
      stages: ["요청 정리", "수정 구현", "코드 리뷰", "QA 검증", "배포 준비"],
      assignees: ["chief", "dev", "review", "qa", "release-ops"],
    },
  ];
  function ensureOfficeJobs() {
    const jobs = officeDefinitions
      .filter((d) => !state.tasks.some((t) => t.id === d.id))
      .map((d) => ({
        id: d.id,
        title: d.title,
        owner: "roopre",
        skill: d.skill,
        shared: true,
        status: "queued",
        stage: 0,
        decision: "",
        target: d.title,
        project: "제품 웹",
        env: "staging",
        harness: actorBy(d.agent)?.harness || "균형",
        version: skillBy(d.skill).version,
        requesterAgent: d.agent,
        officeScenario: true,
        officeAssignee: d.assignees ? null : d.agent,
        officeAssignees: d.assignees,
        officeStages: d.stages,
        discussion: [
          {
            author: "팀 오피스",
            text: "캐릭터와 업무 인계를 보여주는 반복 시연입니다. 실제 도구는 실행하지 않아요.",
          },
        ],
        events: [],
      }));
    state.tasks = [...jobs, ...state.tasks];
  }
  function syncOfficeJobs(record = false) {
    ensureOfficeJobs();
    const o = state.office;
    officeDefinitions.forEach((d) => {
      const t = state.tasks.find((t) => t.id === d.id),
        oldStage = t.stage,
        oldStatus = t.status;
      if (["done", "result_ready"].includes(t.status)) return;
      if (t.profileMismatch) {
        const actor = actorBy(t.requesterAgent);
        if (!runtimeSupportsSkill(actor.runtime, t.skill)) {
          t.status = "paused";
          return;
        }
        ensureRun(t, true);
      }
      if (o.cancelled.includes(t.id)) {
        t.status = "cancelled";
        return;
      }
      if (d.id === "O-105") {
        const f = o.flow;
        t.decision = o.decision || "";
        t.stage = f < 3 ? 1 : f < 5 ? 2 : f < 8 ? 3 : f < 10 ? 4 : 5;
        t.status =
          f === 5 && !o.approved
            ? "needs_input"
            : f >= 10
              ? "result_ready"
              : o.playing
                ? "running"
                : "paused";
      } else {
        const phase = (o.tick + d.offset) % 18;
        t.stage = Math.min(5, Math.floor(phase / 3));
        t.status =
          t.stage >= 5 ? "result_ready" : o.playing ? "running" : "paused";
      }
      if (t.stage < oldStage && ["done", "cancelled"].includes(oldStatus))
        ensureRun(t, true);
      if (record && (oldStage !== t.stage || oldStatus !== t.status)) {
        const a = taskAssignee(t),
          stage = taskSkill(t).stages[Math.min(t.stage, 4)];
        const text =
          t.status === "needs_input"
            ? `${a?.name || "QA"} · 검증 범위 확인 대기`
            : t.status === "done"
              ? `${a?.name || "비서"} · 샘플 결과 정리 완료`
              : `${a?.name || "비서"} · ${stage}`;
        log(t, text);
        t.events = t.events.slice(-6);
      }
    });
    state.tasks
      .filter((t) => t.officeScenario)
      .forEach((t) => {
        const run = ensureRun(t);
        if (run && !t.profileMismatch)
          run.status = ["done", "result_ready"].includes(t.status)
            ? "succeeded"
            : t.status;
      });
    if (o.follow) {
      const main = state.tasks.find((t) => t.id === "O-105");
      o.selected = taskAssignee(main)?.id || "dev";
      o.focusTask = "O-105";
    }
  }
  function scheduleOffice() {
    clearTimeout(officeTimer);
    if (!state.office.playing) return;
    officeTimer = setTimeout(() => {
      if (!modal && !document.hidden) {
        state.office.tick++;
        if (!(state.office.flow === 5 && !state.office.approved))
          state.office.flow++;
        if (state.office.flow > 12) {
          state.office.flow = 0;
          state.office.approved = false;
          state.office.decision = "";
        }
        syncOfficeJobs(true);
        persist();
        if (state.view === "office") renderOfficeUpdate();
        else if (
          !["skills", "memory"].includes(state.view) &&
          !document.activeElement?.closest("form")
        )
          render();
      }
      scheduleOffice();
    }, 4000);
  }
  function resetOffice() {
    state.office = {
      ...state.office,
      playing: true,
      tick: 0,
      flow: 0,
      follow: true,
      approved: false,
      decision: "",
      cancelled: [],
    };
    state.tasks
      .filter((t) => t.officeScenario)
      .forEach((t) => {
        t.events = [];
        t.decision = "";
      });
    syncOfficeJobs(true);
    render();
    persist();
    scheduleOffice();
  }
  function officeActivity(a, respectFocus = false) {
    const rank = {
      result_ready: 0,
      needs_input: 0,
      running: 1,
      paused: 2,
      queued: 3,
      done: 4,
      cancelled: 5,
    };
    const participated = (task) =>
      taskSkill(task).stages.some(
        (_, stage) => taskAssignee(task, stage)?.id === a.id,
      );
    const tasks = visibleTasks()
      .filter(
        (t) =>
          taskAssignee(t)?.id === a.id ||
          (t.status === "done" && participated(t)),
      )
      .sort((x, y) => (rank[x.status] ?? 9) - (rank[y.status] ?? 9));
    const focused =
      respectFocus &&
      visibleTasks().find(
        (task) => task.id === state.office.focusTask && participated(task),
      );
    const t = focused || tasks[0];
    if (!t || t.status === "cancelled")
      return {
        mode: "idle",
        label: "업무 대기",
        task: null,
        stage: "새 업무를 기다려요",
      };
    const modes = {
      running: "working",
      needs_input: "waiting",
      paused: "paused",
      queued: "idle",
      result_ready: "waiting",
      done: "done",
    };
    return {
      mode: modes[t.status],
      label: {
        running: "작업 중",
        needs_input: "확인 대기",
        paused: "일시정지",
        queued: "실행 대기",
        result_ready: "결과 확인 대기",
        done: "완료",
      }[t.status],
      task: t,
      stage:
        t.status === "done"
          ? "결과 정리 완료"
          : taskSkill(t).stages[Math.min(t.stage, 4)],
    };
  }
  function officeStation(a) {
    const activity = officeActivity(a),
      reading = ["chief", "research", "review"].includes(a.id);
    return sharedOfficeStation({
      id: a.id,
      name: a.name,
      role: a.role,
      portrait: characterPortrait(a.character, a.color),
      mode: activity.mode,
      label: activity.label,
      stage: activity.stage,
      taskTitle: activity.task?.title || a.personality,
      selected: state.office.selected === a.id,
      motion: reading ? "read" : "type",
      diaryEnabled: developerDiaryEnabled(a),
      diaryPhase: diaryState({
        task: activity.task && {
          ...activity.task,
          work_type: a.id === "dev" ? "code-qa" : activity.task.workType,
        },
        sample: true,
      }).phase,
    });
  }

  function officeSide() {
    const a = actorBy(state.office.selected) || actorBy("dev"),
      activity = officeActivity(a, true),
      t = activity.task;
    const pending = visibleTasks()
      .filter((x) => x.status === "needs_input" && x.id !== t?.id)
      .slice(0, 1);
    const events = state.tasks
      .filter((t) => t.officeScenario)
      .flatMap((t) => t.events)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 2);
    const progress = t
      ? t.status === "done"
        ? 100
        : t.status === "queued"
          ? 0
          : Math.min(90, t.stage * 20 + 10)
      : 0;
    return `<div class="g-rail-heading g-muted">선택한 동료 <span class="g-tiny">${state.office.playing ? "샘플 재생 중" : "상태 보관 중"}</span></div><div class="g-office-person-head">${characterTrigger(a, false)}<div><h2>${esc(a.name)}</h2><p>${departmentOf(a).name} · ${esc(a.role)}</p></div></div>${workDiary({ agent: a, task: t && { ...t, work_type: a.id === "dev" ? "code-qa" : t.workType }, portrait: characterPortrait(a.character, a.color, true), sample: true, showTask: false })}<div class="g-office-task">${t ? `${status(t)}<h3>${esc(t.title)}</h3><p>${esc(activity.stage)} · ${esc(t.env)}</p><progress class="g-office-progress" value="${progress}" max="100" aria-label="샘플 업무 단계 진행률"></progress><div class="g-row g-between g-tiny g-muted"><span>${t.id}</span><span>${t.status === "done" ? "모든 단계 완료" : `${Math.min(t.stage + 1, 5)} / 5 단계`}</span></div>${t.status === "needs_input" && canOperateTask(state, t) ? `<form class="g-office-answer" data-form="resume" data-id="${t.id}"><label class="g-field"><span>검증 범위를 골라주세요</span><select class="g-input" name="decision"><option>핵심 흐름 · 로그인 + 결제</option><option>전체 회귀 · 주요 사용자 흐름</option><option>변경 범위 · 로그인과 세션 갱신</option></select></label><button type="button" class="g-button g-primary cursor-interaction" data-action="submit-form">답변하고 재개 ${icon("play")}</button></form>` : `<div style="margin-top:12px">${button(["done", "result_ready"].includes(t.status) ? "결과 확인" : "업무 자세히", "open-task", `data-id="${t.id}"`, false, "arrow-up-right")}</div>`}` : `<span class="g-status-inline"><span class="g-dot"></span>업무 대기</span><h3>새 업무를 맡길 수 있어요</h3><p>${esc(a.catchphrase)}</p>${button("업무 맡기기", "new-request", `data-agent="${a.id}"`, true, "plus")}`}</div>${t ? `<button type="button" class="g-run-link" data-action="open-execution" data-id="${t.id}">${icon("radio")} ${esc(t.runId || "실행 준비")} · 기록 보기 ${icon("arrow-up-right")}</button>` : ""}<div class="g-office-actions">${button("대화", "agent", `data-id="${a.id}"`, false, "message-circle")}${button("기억", "open-memory", `data-key="${a.id}"`, false, "bookmark")}${button("스킬", "agent-area", `data-id="${a.id}" data-value="skills"`, false, "blocks")}</div>${
      pending.length
        ? `<section class="g-office-attention"><div class="g-rail-heading"><span>다른 확인 요청</span></div>${pending
            .map((x) => {
              const owner = taskAssignee(x);
              return `<button type="button" class="cursor-interaction" data-action="office-select" data-id="${owner?.id || "qa"}" data-task="${x.id}">${avatar(owner?.name || "QA", owner?.color, false, owner?.id)}<span><strong>${esc(owner?.name || "QA")} · 검증 범위 확인</strong>${esc(x.title)}</span></button>`;
            })
            .join("")}</section>`
        : ""
    }<section class="g-office-feed"><div class="g-rail-heading">최근 활동</div>${events.map((e) => `<div class="g-office-event"><span class="g-num">${esc(e.time)}</span><span>${esc(e.text)}</span></div>`).join("") || '<p class="g-tiny g-muted">샘플 업무가 시작됐어요.</p>'}</section>`;
  }
  function officeFlow() {
    const t = state.tasks.find((t) => t.id === "O-105");
    if (!t) return "";
    const ids = ["dev", "review", "qa", "release-ops"],
      active = t.status === "done" ? 4 : Math.max(0, t.stage - 1);
    const people = ids
      .map((id, i) => {
        const a = actorBy(id),
          delivering = active === i && t.status === "running";
        const connector = i
          ? `<span class="g-flow-connector ${delivering ? "is-delivering" : ""} ${t.status === "done" ? "completed" : ""}" aria-hidden="true">${delivering ? '<span class="g-flow-packet"></span>' : ""}</span>`
          : "";
        return `${connector}<button type="button" class="g-flow-person cursor-interaction ${t.status === "done" ? "completed" : active === i ? (t.status === "needs_input" ? "waiting" : "current") : ""}" data-action="open-task" data-id="${t.id}" aria-label="${esc(a.name)} 인계 기록 보기">${avatar(a.name, a.color, false, a.id)}<span><strong>${esc(a.name)}</strong><span>${["개발", "리뷰", "QA", "배포"][i]}</span></span></button>`;
      })
      .join("");
    return `<div class="g-office-flow-head"><strong>지금 이어지는 일 · 로그인 수정</strong><button type="button" class="g-text-button cursor-interaction" data-action="office-follow" aria-pressed="${state.office.follow}">${state.office.follow ? "인계 따라보는 중" : "인계 따라보기"}</button></div><div class="g-office-flow-track">${people}</div>`;
  }
  function officeLegend() {
    const activity = state.agents.map((a) => officeActivity(a));
    return `<span><span class="g-dot" style="color:var(--g-blue)"></span>작업 중 ${activity.filter((a) => a.mode === "working").length}</span><span><span class="g-dot" style="color:var(--g-amber)"></span>확인 대기 ${activity.filter((a) => a.mode === "waiting").length}</span><span><span class="g-dot" style="color:var(--g-green)"></span>완료 ${activity.filter((a) => a.mode === "done").length}</span><span>${departments.length}개 부서 · ${state.agents.length}명</span>`;
  }
  function attentionStrip() {
    const waiting = visibleTasks().filter((t) => t.status === "needs_input");
    return waiting.length
      ? `<div class="g-attention-strip">${icon("circle-help")}<span><strong>확인 요청 ${waiting.length}건</strong> · 검증 범위를 정하면 업무가 이어져요.</span><button type="button" class="cursor-interaction" data-action="navigate" data-view="inbox">지금 답변하기 ${icon("arrow-right")}</button></div>`
      : `<div class="g-attention-strip is-clear">${icon("circle-check")}<span>동료들이 업무를 이어가고 있어요. 지금 답변할 요청은 없어요.</span><button type="button" class="cursor-interaction" data-action="navigate" data-view="work">업무 보기 ${icon("arrow-right")}</button></div>`;
  }
  function officePage() {
    return `<div class="g-page-head g-office-head"><div><h1>함께 일하는 오피스</h1><p class="g-page-sub">네 부서의 동료들, 지금 하는 일을 한눈에.</p></div><div class="g-office-head-actions">${button(state.office.motion ? "모션 켜짐" : "모션 꺼짐", "office-motion", `aria-pressed="${state.office.motion}"`, false, "sparkles")}${button(state.office.playing ? "시연 멈추기" : "시연 이어보기", "office-play", "", false, state.office.playing ? "pause" : "play")}${button("처음부터", "office-reset", "", false, "rotate-ccw")}</div></div>${officeDesk(state, flowHelpers())}${workspaceSummary()}<div class="g-office-layout"><div class="g-office-floor"><div class="g-office-legend" id="g-office-legend">${officeLegend()}</div><div class="g-office-grid">${departments.map((d) => `<section class="g-office-room" aria-label="${d.name} 부서 오피스"><header class="g-office-room-head"><h2>${icon(d.icon)}${d.name}</h2><span>${d.description}</span></header><div class="g-office-desks" data-room="${d.id}">${departmentAgents(d.id).map(officeStation).join("")}</div></section>`).join("")}</div><section class="g-office-flow" id="g-office-flow" aria-label="부서 간 업무 인계">${officeFlow()}</section><div class="g-office-footnote"><span>동료를 선택해 대화·기억·스킬을 열어보세요.</span><button type="button" class="g-text-button cursor-interaction" data-action="navigate" data-view="agents">전체 보기 ${icon("arrow-up-right")}</button></div></div><aside class="g-office-side" id="g-office-side" aria-label="선택한 에이전트 업무">${officeSide()}</aside></div>`;
  }
  function renderOfficeUpdate() {
    if (state.view !== "office" || modal) return;
    const active = document.activeElement;
    if (frame.contains(active) && active.closest("form")) return;
    const previous = new Map(
      [...frame.querySelectorAll(".g-office-station")].map((el) => [
        el.dataset.id,
        el,
      ]),
    );
    state.agents.forEach((a) => {
      const old = previous.get(a.id);
      if (!old) return;
      const holder = document.createElement("div");
      holder.innerHTML = officeStation(a);
      const next = holder.firstElementChild;
      if (
        old.className !== next.className ||
        old.getAttribute("aria-pressed") !==
          next.getAttribute("aria-pressed") ||
        old.querySelector(".g-station-state").textContent !==
          next.querySelector(".g-station-state").textContent ||
        old.querySelector(".g-station-task").textContent !==
          next.querySelector(".g-station-task").textContent
      )
        old.replaceWith(next);
    });
    const summary = frame.querySelector(".g-workspace-summary");
    if (summary) summary.outerHTML = workspaceSummary();
    frame.querySelector("#g-office-legend").innerHTML = officeLegend();
    frame.querySelector("#g-office-flow").innerHTML = officeFlow();
    frame.querySelector("#g-office-side").innerHTML = officeSide();
    const waiting = visibleTasks().filter(
      (t) => t.status === "needs_input" && canOperateTask(state, t),
    ).length;
    frame.querySelectorAll("[data-inbox-count]").forEach((el) => {
      el.hidden = !waiting;
      el.textContent = waiting;
    });
    icons();
  }
  function rosterPage() {
    const selected = departments.find((d) => d.id === state.department),
      shown = selected ? [selected] : departments;
    const waiting = visibleTasks().find((t) => t.status === "needs_input");
    const running = visibleTasks().filter((t) => t.status === "running").length;
    const filters = [{ id: "all", name: "전체" }, ...departments]
      .map(
        (d) =>
          `<button type="button" class="g-segment cursor-interaction" data-action="department" data-id="${d.id}" aria-pressed="${state.department === d.id}">${d.name}</button>`,
      )
      .join("");
    const sections = shown
      .map(
        (d) =>
          `<section class="g-roster-section" aria-label="${d.name} 부서 에이전트"><header class="g-roster-department">${icon(d.icon)}<h2>${d.name}</h2><span class="g-tiny g-muted">${departmentAgents(d.id).length}</span><button type="button" class="g-text-button cursor-interaction" data-action="department" data-id="${d.id}" aria-label="${d.name} 부서 보기">부서 보기 ${icon("chevron-right")}</button></header>${
            departmentAgents(d.id)
              .map((a) => {
                const activity = specialistState(a);
                return `<button type="button" class="g-roster-agent cursor-interaction" data-action="agent" data-id="${a.id}" aria-label="${d.name} 부서 ${esc(a.name)} · ${esc(a.role)}"><span class="g-roster-identity">${avatar(a.name, a.color, false, a.id)}<span><strong>${esc(a.name)}</strong><span class="g-roster-role">${esc(a.role)}</span><span class="g-character-trait">${esc(a.personality)}</span></span></span><span class="g-roster-work"><span class="g-status-inline ${activity.color}"><span class="g-dot"></span>${activity.text}</span><span>${activity.task ? esc(activity.task.title) : esc(a.harness) + " · 스킬 " + a.skills.length + "개"}</span></span><i class="g-icon g-roster-arrow" data-lucide="chevron-right" aria-hidden="true"></i></button>`;
              })
              .join("") || '<div class="g-empty">소속 에이전트가 없어요.</div>'
          }</section>`,
      )
      .join("");
    const recent = visibleTasks()
      .flatMap((t) => t.events.slice(-1).map((e) => ({ ...e, task: t })))
      .slice(0, 3);
    return `<div class="g-breadcrumb">${esc(state.team.name)} / 공용 에이전트${selected ? " / " + selected.name : ""}</div>${pageHead(selected ? selected.name + " 에이전트" : "함께 일하는 에이전트", selected ? selected.description : "부서별 담당을 찾고, 대화와 작업을 이어가세요.", button("업무 맡기기", "run-skill", 'data-id="triage" data-agent="chief"', true, "plus"))}<div class="g-toolbar"><div class="g-segments" aria-label="부서 선택">${filters}</div><span class="g-tiny g-muted">${selected ? departmentAgents(selected.id).length + "명" : state.agents.length + "명 · " + departments.length + "개 부서"}</span></div><div class="g-roster-layout"><div class="g-roster-main"><div class="g-roster-summary"><span>${icon("users-round")} 부서별 에이전트</span><span>${running ? "진행 중 " + running + "건" : "진행 중인 실행 없음"}${waiting ? " · 확인 대기 있음" : ""}</span></div>${sections}</div><aside class="g-overview-context" aria-label="팀 작업 현황"><section><div class="g-rail-heading"><span>지금 확인할 일</span><span class="g-pill amber">${visibleTasks().filter((t) => t.status === "needs_input").length}</span></div>${waiting ? awaitingHTML(waiting) : '<p class="g-small g-muted">기다리는 확인 요청이 없어요.</p>'}</section><section><div class="g-rail-heading"><span>자주 맡기는 업무</span>${icon("zap")}</div><div class="g-quick-list">${["release", "bug", "meeting"].map((id) => quickSkill(skillBy(id))).join("")}</div><button type="button" class="g-text-button cursor-interaction g-mt" data-action="navigate" data-view="skills">스킬 모두 보기 ${icon("chevron-right")}</button></section><section><div class="g-rail-heading">최근 팀 기록</div>${recent.map((e) => `<div class="g-activity-item"><span class="g-dot"></span><span><strong>${esc(e.text)}</strong><br>${esc(e.time)} · ${e.task.id}</span></div>`).join("")}</section></aside></div>`;
  }
  function inboxPage() {
    const pending = visibleTasks().filter(
      (t) => t.status === "needs_input" && canOperateTask(state, t),
    );
    return `<div class="g-breadcrumb">워크스페이스 / 확인 요청</div>${pageHead("답변이 필요한 일", "여기서 결정하면 동료가 멈춘 단계부터 이어가요.", `<span class="g-pill ${pending.length ? "amber" : "green"}">${pending.length}건 대기</span>`)}<div class="g-inbox-layout"><section aria-label="확인 요청 목록">${pending.map((t) => `<article class="g-inbox-row"><div class="g-row g-between"><span class="g-row">${avatar(taskAssignee(t)?.name || "비서", taskAssignee(t)?.color, false, taskAssignee(t)?.id)}<span class="g-small">${esc(taskAssignee(t)?.name || "비서")} · 검증 범위 확인</span></span><span class="g-tiny g-muted">${t.id}</span></div><h2>${esc(t.title)}</h2><p class="g-small g-muted">${esc(state.profiles[t.owner]?.owner || "팀원")} 요청 · ${esc(t.project)} / ${esc(t.env)} · ${t.shared ? "팀 공유" : "개인"}</p>${decisionForm(t)}<div class="g-mt"><button type="button" class="g-text-button cursor-interaction" data-action="open-task" data-id="${t.id}">진행 기록과 대화 보기 ${icon("arrow-up-right")}</button></div></article>`).join("") || `<div class="g-empty">${icon("check-check")}<h2 style="margin-top:12px">모두 답변했어요</h2><p style="margin-top:8px">동료들이 이어서 진행하고 있어요.<br>완료되면 업무에서 결과를 확인할 수 있어요.</p><div class="g-mt">${button("진행 중인 업무 보기", "navigate", 'data-view="work"', true, "arrow-right")}</div></div>`}</section><aside class="g-inbox-hint"><h3>내가 결정할 것만 모았어요</h3><p>요청한 범위를 고르면 답변이 업무 대화에 남고, 담당 에이전트가 이어받아요.</p><p class="g-mt">현재 책임자가 답변해요. 열람자는 업무 인수를 요청할 수 있어요.</p><div class="g-divider"></div><span class="g-tiny">샘플 업무 흐름을 시연합니다.</span></aside></div>`;
  }
  function decisionForm(t) {
    if (!canOperateTask(state, t))
      return `<p class="g-readonly-note">현재 책임자의 답변을 기다리고 있어요.</p>`;
    const a = taskAssignee(t),
      choices = [
        "핵심 흐름 · 로그인 + 결제",
        "전체 회귀 · 주요 사용자 흐름",
        "변경 범위 · 로그인과 세션 갱신",
      ];
    return `<form class="g-decision" data-form="resume" data-id="${t.id}"><h3>${esc(a?.name || "담당 동료")}이 검증 범위를 기다려요</h3><p>지금까지의 진행은 저장되어 있어요. 이번에 확인할 범위를 선택해주세요.</p><fieldset class="g-decision-options" aria-label="이번에 확인할 범위">${choices.map((v, i) => `<label class="g-decision-option cursor-interaction"><input type="radio" name="decision" value="${v}" ${i === 0 ? "checked" : ""}><span>${v}</span>${i === 0 ? "<small>추천</small>" : ""}</label>`).join("")}</fieldset>${button("이 범위로 답변하고 재개", "submit-form", "", true, "play")}</form>`;
  }
  function skillLibraryPage() {
    const q = state.search.trim().toLowerCase(),
      key = skillTarget(),
      a = actorBy(key),
      skills = skillsFor(key).filter((s) =>
        (s.name + " " + s.desc).toLowerCase().includes(q),
      );
    return `<div class="g-breadcrumb">팀 라이브러리 / 스킬</div>${pageHead("반복하는 일은 스킬로", "사용할 동료를 고르고, 자주 하는 업무를 장착하세요.", button("스킬 만들기", "create-skill", "", false, "plus"))}<div class="g-toolbar"><label class="g-target-picker" for="g-skill-target">${avatar(a.name, a.color, false, key)}<span>사용할 동료</span><select id="g-skill-target" class="g-input">${actorOptions(key)}</select></label><label class="g-field" style="margin:0"><input class="g-input g-search" id="g-skill-search" aria-label="스킬 검색" type="search" value="${esc(state.search)}" placeholder="스킬 이름으로 찾기"></label></div><p class="g-small g-muted" style="margin-bottom:18px">${esc(a.name)}에게 ${a.skills.length}개 장착 · ${key === state.user ? "개인 스킬과 팀 공용 스킬을 사용할 수 있어요." : "팀 공용 스킬을 장착하고 실행할 수 있어요."}</p>${skillRows(skills)}`;
  }
  function workPage() {
    const priority = {
      result_ready: 0,
      needs_input: 0,
      running: 1,
      paused: 2,
      queued: 3,
      done: 4,
      cancelled: 5,
    };
    const tasks = visibleTasks()
      .filter((t) =>
        state.filter === "mine"
          ? t.owner === state.user
          : state.filter === "attention"
            ? t.status === "needs_input"
            : state.filter === "results"
              ? ["done", "result_ready"].includes(t.status)
              : true,
      )
      .sort((a, b) => priority[a.status] - priority[b.status]);
    if (!tasks.find((t) => t.id === state.task))
      state.task = tasks[0]?.id || "";
    const t = tasks.find((t) => t.id === state.task);
    return `<div class="g-breadcrumb">워크스페이스 / 업무</div>${pageHead("업무와 결과", "확인할 일부터 살펴보고, 맡긴 업무를 끝까지 이어가세요.")}<div class="g-toolbar"><div class="g-segments" aria-label="작업 범위">${[
      ["all", "전체 업무"],
      ["mine", "내가 맡긴 일"],
      ["attention", "확인 필요"],
      ["results", "준비된 결과"],
    ]
      .map(
        ([v, label]) =>
          `<button type="button" class="g-segment cursor-interaction" data-action="task-filter" data-value="${v}" aria-pressed="${state.filter === v}">${label}${v === "attention" ? ` ${visibleTasks().filter((t) => t.status === "needs_input").length}` : ""}</button>`,
      )
      .join(
        "",
      )}</div><span class="g-tiny g-muted">${tasks.length}개 · 확인 필요 → 진행 중 → 완료 순</span></div><div class="g-work-layout"><div class="g-task-list" aria-label="작업 목록">${tasks.map((x) => `<button type="button" class="g-task-item cursor-interaction" data-action="select-task" data-id="${x.id}" aria-pressed="${x.id === state.task}"><div class="g-row g-between"><span class="g-tiny g-muted">${x.id}</span>${status(x)}</div><h3>${esc(x.title)}</h3><div class="g-row g-between"><span class="g-tiny g-muted">${esc(state.profiles[x.owner]?.owner || "팀원")} 요청</span><span class="g-tiny g-muted">${{ team: "팀 공유", department: "부서 공유", private: "개인" }[visibilityOf(x)]}</span></div></button>`).join("") || '<div class="g-empty">이 범위의 업무가 없어요.<br>전체 업무를 선택하거나 새 업무를 맡겨보세요.</div>'}</div>${t ? taskDetail(t) : `<div class="g-task-detail g-empty"><p>새 업무를 맡겨보세요.</p><div class="g-mt">${button("업무 맡기기", "new-request", "", true, "plus")}</div></div>`}</div>`;
  }
  function taskDetail(t) {
    if (t.workflow) return workflowDetail(state, t, flowHelpers());
    const s = taskSkill(t);
    return `<section class="g-task-detail" aria-label="선택한 작업"><header class="g-detail-head"><div class="g-row g-between"><span class="g-tiny g-muted">${t.id} / ${t.shared ? "팀 공유 작업" : "개인 작업"}</span>${status(t)}</div><h2>${esc(t.title)}</h2><div class="g-detail-meta"><span>요청 ${esc(state.profiles[t.owner]?.owner || "팀원")}</span><span>${esc(t.project)}</span><span>${esc(t.env)}</span><span>${esc(s.name)} v${esc(t.version)}</span><span>실행 ${RUNTIMES[runFor(t)?.runtime]?.name || "프로필 준비"}</span><span>업무 방식 ${esc(t.harness)}</span></div></header><div class="g-detail-content"><div class="g-segments" aria-label="작업 상세 보기">${[
      ["progress", "진행"],
      ["discussion", t.shared ? "팀 대화" : "업무 메모"],
      ["result", "결과"],
      ["execution", "실행 기록"],
    ]
      .map(
        ([v, label]) =>
          `<button type="button" class="g-segment cursor-interaction" data-action="task-tab" data-value="${v}" aria-pressed="${state.taskTab === v}">${label}${v === "discussion" && t.discussion.length ? ` ${t.discussion.length}` : ""}</button>`,
      )
      .join(
        "",
      )}</div>${state.taskTab === "progress" ? taskProgress(t, s) : state.taskTab === "discussion" ? taskDiscussion(t) : state.taskTab === "execution" ? executionPanel(t) : taskResult(t, s)}</div></section>`;
  }
  function taskProgress(t, s) {
    const who = s.stages.map((_, i) => {
      const agent = taskAssignee(t, i);
      return agent
        ? `${agent.name} · ${departmentOf(agent).name}`
        : state.profiles[t.owner]?.name || "개인 비서";
    });
    const notes = [
      "업무 대상과 완료 기준을 정리했어요.",
      "대상 범위와 관련 맥락을 확인해요.",
      "변경과 검증할 항목을 정리해요.",
      "선택한 범위를 확인하고 결과를 남겨요.",
      "결과와 다음 할 일을 한곳에 모아요.",
    ];
    const timeline = s.stages
      .map((label, i) => {
        const complete = t.status === "done" || i < t.stage,
          active =
            i === t.stage && t.status !== "done" && t.status !== "cancelled";
        return `<div class="g-stage ${complete ? "completed" : active ? "current" : ""}"><span class="g-stage-marker">${complete ? "✓" : i + 1}</span><div><div class="g-stage-title">${esc(label)}</div><div class="g-stage-note">${complete ? "샘플 단계 완료" : active ? notes[i] : "앞 단계가 끝나면 이어집니다."}</div></div><span class="g-pill">${esc(who[i])}</span></div>`;
      })
      .join("");
    const question = t.status === "needs_input" ? decisionForm(t) : "";
    const controls = ["queued", "paused"].includes(t.status)
      ? `<div class="g-mt">${button(t.status === "queued" ? "시연 시작" : "저장된 단계부터 재개", "start-task", `data-id="${t.id}"`, true, "play")}</div>`
      : t.status === "running"
        ? `<div class="g-row g-wrap g-mt"><span class="g-small g-muted">샘플 업무 흐름을 실행하고 있어요.</span>${button("일시정지", "pause-task", `data-id="${t.id}"`, false, "pause")}</div>`
        : t.status === "cancelled"
          ? `<div class="g-mt">${button("처음부터 다시 실행", "restart-task", `data-id="${t.id}"`, false, "rotate-ccw")}</div>`
          : ["done", "result_ready"].includes(t.status)
            ? `<div class="g-mt">${button("결과 보기", "show-result", "", true, "file-check-2")}</div>`
            : "";
    return `${question}${controls}<div class="g-mt">${timeline}</div><details><summary class="cursor-interaction">요청 내용과 완료 기준</summary><div class="g-context-text">대상: ${esc(t.target)}<br>프로젝트: ${esc(t.project)} / ${esc(t.env)}<br>완료 기준: ${esc(s.done)}<br>검증 범위: ${esc(t.decision || "선택 대기")}<br>이 기록은 목업 시연용입니다.</div></details><div class="g-divider"></div><h3 class="g-small">활동 기록</h3><div class="g-log" aria-live="polite">${t.events
      .slice(-5)
      .map(
        (e) =>
          `<div class="g-log-row"><span class="g-num">${esc(e.time)}</span><span>${esc(e.text)}</span></div>`,
      )
      .join(
        "",
      )}</div>${["running", "needs_input", "paused"].includes(t.status) ? `<div class="g-mt">${button("업무 중단", "cancel-task", `data-id="${t.id}"`, false, "square")}</div>` : ""}`;
  }
  function taskDiscussion(t) {
    return `<div class="g-log g-mt">${t.discussion.map((m) => `<div class="g-message">${avatar(m.author, "blue")}<div class="g-message-content"><div class="g-message-name">${esc(m.author)}</div><p class="g-message-body">${esc(m.text)}</p></div></div>`).join("") || '<div class="g-small g-muted">재현 조건이나 추가 요청을 남겨보세요. 팀원이 같은 작업방에서 확인할 수 있어요.</div>'}</div><form class="g-composer g-mt" data-form="task-comment" data-id="${t.id}" style="margin:20px 0 0"><label for="g-comment" class="g-small g-muted">${t.shared ? "팀에 남길 맥락" : "작업 메모"}</label><textarea id="g-comment" name="comment" maxlength="600" required placeholder="예: 세션 만료 후 다시 로그인하는 흐름도 확인해주세요."></textarea><div class="g-composer-bottom"><span class="g-tiny g-muted">${esc(profile().owner)} 이름으로 남겨요</span><button type="button" class="g-button g-primary cursor-interaction" data-action="submit-form">남기기</button></div></form>`;
  }
  function taskResult(t, s) {
    if (!["done", "result_ready"].includes(t.status))
      return `<div class="g-empty">${icon("file-clock")}<p style="margin-top:9px">${t.status === "cancelled" ? "작업이 중단됐어요. 다시 실행하면 결과를 만들 수 있어요." : "업무가 완료되면 결과와 확인 근거가 여기에 모여요."}</p>${t.status === "needs_input" ? '<p style="margin-top:8px">진행 탭에서 검증 범위를 선택해주세요.</p>' : ""}</div>`;
    const rows =
      t.skill === "meeting"
        ? [
            "결정 사항: 다음 배포는 금요일 진행",
            "민지: 로그인 QA 확인",
            "로프레: 배포 준비 및 결과 공유",
          ]
        : t.skill === "weekly"
          ? [
              "완료: 로그인 오류 수정안 준비",
              "진행: 배포 전 검증",
              "다음 할 일: QA 범위 결정 및 검증 결과 확인",
            ]
          : s.role === "ops"
            ? [
                "대상 서비스와 점검 범위를 정리했어요.",
                "샘플 현황과 후속 확인 항목을 모았어요.",
                "실제 서비스 조회와 배포는 수행하지 않았어요.",
              ]
            : s.role === "research"
              ? [
                  "요청한 주제의 샘플 자료를 정리했어요.",
                  "주요 내용과 추가로 확인할 점을 구분했어요.",
                  "실제 외부 자료 수집은 연결하지 않았어요.",
                ]
              : s.role === "coordination"
                ? [
                    "개발·운영·QA 부서별 할 일을 정리했어요.",
                    "담당과 인계할 내용을 샘플로 제안했어요.",
                    "실제 외부 시스템에는 업무를 등록하지 않았어요.",
                  ]
                : [
                    "변경 범위와 요구사항 검토 완료",
                    "선택한 범위의 샘플 시나리오 7개 통과",
                    "확인하지 않은 범위: 실제 서비스 연결과 운영 환경",
                  ];
    return `<div class="g-row g-between g-mt"><h3>결과가 준비됐어요</h3><span class="g-pill green">시뮬레이션 결과</span></div><p class="g-context-text">실제 저장소나 서버를 검사하지 않은 샘플 보고서입니다.</p>${rows.map((x) => `<div class="g-result-line">${icon("circle-check")}<span>${esc(x)}</span></div>`).join("")}<div class="g-context-box g-mt"><span class="g-small">완료 기준</span><p class="g-context-text" style="margin-bottom:0">${esc(s.done)}</p></div><div class="g-row g-wrap g-mt">${t.status === "result_ready" && canOperateTask(state, t) ? button("샘플 결과 수용", "flow-legacy-accept", `data-id="${t.id}"`, true, "check") : ""}${button("결과를 팀 기억으로", "remember-task", `data-id="${t.id}"`, false, "bookmark-plus")}${button("이 흐름을 스킬로", "skill-from-task", `data-id="${t.id}"`, false, "blocks")}</div>`;
  }
  function memoryEntry(m) {
    const [kind, glyph] = memoryKinds[m.kind] || memoryKinds.fact;
    return `<article class="g-memory-entry"><div class="g-memory-entry-head"><button type="button" class="g-memory-entry-title cursor-interaction" data-action="memory-detail" data-id="${m.id}">${icon(glyph)}<span>${esc(m.title)}</span></button><span class="g-memory-kind">v${m.version}</span></div><p>${esc(m.text)}</p><div class="g-memory-meta"><span>${kind}</span><span>${esc(memoryAudience(m))}</span><span>${esc(m.at)}</span><button type="button" class="g-text-button cursor-interaction" data-action="memory-detail" data-id="${m.id}">출처 보기 ${icon("arrow-up-right")}</button></div></article>`;
  }
  function memoryLinks(result) {
    return recallSources(result)
      .map(
        (m) =>
          `<button type="button" class="g-recall-source cursor-interaction" data-action="memory-detail" data-id="${m.id}" data-version="${m.version}"><span>[${result.ids.indexOf(m.id) + 1}]</span><span>${esc(m.title)}<br>${esc(memoryAudience(m))} · v${m.version}${m.historical ? " · 이전 버전" : ""}</span>${icon("arrow-up-right")}</button>`,
      )
      .join("");
  }
  function recallPanel(key) {
    const a = actorBy(key),
      result = recallResult?.key === key ? recallResult : null;
    return `<div class="g-recall-box"><h3>${icon("scan-search")} 기억 꺼내보기</h3><form data-form="memory-recall" data-key="${key}"><label class="g-field" for="g-recall-query"><span class="g-field-help">${esc(a.name)}에게 물어보세요</span><textarea id="g-recall-query" class="g-input" name="question" required maxlength="300">${esc(state.recallQuery)}</textarea></label>${button("기억 찾아보기", "submit-form", "", true, "search")}</form>${result ? `<div class="g-recall-answer" aria-live="polite"><div class="g-row g-between"><strong>${recallSources(result).length}개 기억 참고</strong><span class="g-tiny g-muted">접근 가능한 ${result.visible}개 중</span></div><p>${esc(recallText(result))}</p>${memoryLinks(result)}<div class="g-field-help g-mt">키워드 검색 시연 · 선택한 기억만 답변에 반영</div></div>` : `<p class="g-field-help g-mt">자기 기억과 허용된 공통 기억에서 찾아요.</p>`}</div>`;
  }
  function memoryWorkbench(key) {
    const memories = memoriesFor(key),
      a = actorBy(key),
      own = memories.filter(
        (m) => m.scope === (a.id ? "agent" : "personal") && m.owner === key,
      );
    return `<div class="g-memory-workbench"><div class="g-toolbar"><span class="g-small g-muted">${esc(a.name)}의 기억 ${own.length}개 · 공통 기억 ${memories.length - own.length}개</span>${button("기억 추가", "add-memory", `data-key="${key}" data-scope="${a.id ? "agent" : "personal"}"`, false, "plus")}</div><div class="g-memory-banner">${icon("database")} 출처와 이력을 남기고, 필요한 기억을 찾아 사용해요.</div>${memories.map(memoryEntry).join("") || '<div class="g-empty">아직 저장된 기억이 없어요.</div>'}<div class="g-row g-wrap g-mt">${button("기억 보관함 열기", "open-memory", `data-key="${key}"`, true, "scan-search")}</div></div>`;
  }
  function memoryPage() {
    const key = memoryActor(),
      a = actorBy(key),
      isPersonal = !a.id,
      dept = isPersonal ? null : departmentOf(a);
    const inherited = memoriesFor(key),
      inScope =
        state.memoryScope === "all"
          ? inherited
          : inherited.filter((m) => m.scope === state.memoryScope);
    const query = state.memoryQuery.toLowerCase();
    const memories = inScope
      .filter(
        (m) =>
          (state.memoryKind === "all" || m.kind === state.memoryKind) &&
          (!query ||
            (m.title + " " + m.text + " " + m.source)
              .toLowerCase()
              .includes(query)),
      )
      .sort((a, b) => b.at.localeCompare(a.at));
    const scopes = isPersonal
      ? [
          ["all", "관련 기억 전체"],
          ["personal", "내 비서만"],
          ["team", "팀 공통"],
        ]
      : [
          ["all", "관련 기억 전체"],
          ["agent", a.name + "의 기억"],
          ["department", dept.name + " 공통"],
          ["team", "팀 공통"],
        ];
    const own = inherited.filter(
      (m) => m.scope === (a.id ? "agent" : "personal") && m.owner === key,
    ).length;
    const addScope =
      state.memoryScope === "all"
        ? isPersonal
          ? "personal"
          : "agent"
        : state.memoryScope;
    return `<div class="g-breadcrumb">팀 라이브러리 / 기억</div>${pageHead("업무의 맥락을 이어가는 기억", "동료가 무엇을 기억하는지 살펴보고, 출처와 함께 바로잡으세요.", button("기억 추가", "add-memory", `data-key="${key}" data-scope="${addScope}"`, false, "plus"))}<div class="g-memory-layout"><section aria-label="기억 목록"><div class="g-memory-tools"><label for="g-memory-agent" class="g-small">기억할 동료</label><select id="g-memory-agent" class="g-input" aria-label="기억을 살펴볼 에이전트">${actorOptions(key)}</select></div><div class="g-memory-heading">${avatar(a.name, a.color, true, key)}<div><h2>${esc(a.name)}의 참고 기억</h2><p>${esc(a.name)}의 기억 ${own}개 · 부서·팀 공통 ${inherited.length - own}개</p></div></div><div class="g-segments" aria-label="기억 공유 범위">${scopes.map(([v, label]) => `<button type="button" class="g-segment cursor-interaction" data-action="memory-scope" data-value="${v}" aria-pressed="${state.memoryScope === v}">${label}</button>`).join("")}</div><div class="g-memory-toolbar"><input id="g-memory-search" class="g-input" aria-label="기억 검색" placeholder="제목, 내용, 출처에서 검색" value="${esc(state.memoryQuery)}"><select class="g-input" id="g-memory-kind" aria-label="기억 종류"><option value="all">모든 종류</option>${Object.entries(
      memoryKinds,
    )
      .map(
        ([v, k]) =>
          `<option value="${v}" ${state.memoryKind === v ? "selected" : ""}>${k[0]}</option>`,
      )
      .join(
        "",
      )}</select></div><div class="g-memory-summary"><span>${memories.length}개 기억</span><span>${isPersonal ? "개인 기억은 나와 내 비서만 참고" : "공용 동료의 기억은 팀에서 공유"}</span></div>${memories.map(memoryEntry).join("") || `<div class="g-empty"><p>조건에 맞는 기억이 없어요.</p><div class="g-mt">${button("검색 조건 지우기", "clear-memory-search", "", false, "rotate-ccw")}</div></div>`}</section><aside class="g-memory-rail" aria-label="기억 검색 시연">${recallPanel(key)}<div class="g-small g-muted"><h3 style="margin-bottom:8px">기억은 바로잡을 수 있어요</h3><p>기억을 열어 출처를 확인하고 수정하세요. 이전 내용은 이력에 남아요.</p><div class="g-mt"><button type="button" class="g-text-button cursor-interaction" data-action="memory-architecture">보관 방식 살펴보기 ${icon("arrow-up-right")}</button></div></div><div class="g-memory-banner">${icon("flask-conical")}<span id="g-memory-storage-state">${memorySessionOnly ? "현재 화면에만 보관 중 · 데모 저장 한도 도달" : "샘플 기억 · 서버 저장소 연결 전"}</span></div></aside></div>`;
  }
  function render() {
    if (state.view === "agent" && state.agentTab === "chat") {
      const c = conversationFor(state.agent),
        task = c?.taskId && taskBy(c.taskId);
      if (task?.workflow) {
        state.view = "work";
        state.filter = "all";
        state.task = task.id;
        state.taskTab = "discussion";
        history.replaceState(null, "", `#/tasks/${task.id}`);
      }
    }
    if (state.view === "admin" && !isTeamLead(state)) state.view = "home";
    if (state.view === "signup") {
      frame.innerHTML = rolePage("signup");
      icons();
      return;
    }
    const active = document.activeElement;
    const focus =
      frame.contains(active) && active.id
        ? {
            id: active.id,
            start: active.selectionStart,
            end: active.selectionEnd,
          }
        : null;
    root.classList.toggle("g-compact", design.density === "촘촘하게");
    root.classList.toggle("g-no-context", !design.context);
    const views = {
      home: () => rolePage("home"),
      admin: () => rolePage("admin"),
      office: officePage,
      intake: () => intakePage(state, flowHelpers()),
      conversations: sharedConversationsPage,
      sharedThread: sharedThreadPage,
      assistant: () => workbenchPage(),
      agent: () => workbenchPage(true),
      inbox: inboxPage,
      work: workPage,
      skills: skillLibraryPage,
      memory: memoryPage,
      agents: rosterPage,
    };
    frame.innerHTML = shell((views[state.view] || views.assistant)());
    applyRoleControls(frame);
    if (modal) frame.inert = true;
    if (focus) {
      const next = frame.querySelector("#" + focus.id);
      if (next) {
        next.focus({ preventScroll: true });
        if (
          typeof next.setSelectionRange === "function" &&
          focus.start !== null
        ) {
          try {
            next.setSelectionRange(focus.start, focus.end);
          } catch (_) {}
        }
      }
    }
    icons();
  }
  function icons() {
    createIcons({ icons: lucideIcons, attrs: { width: 17, height: 17 } });
  }
  function rolePage(view) {
    return renderRolePage(view, state, {
      esc,
      icon,
      button,
      avatar,
      status,
      taskSkill,
      taskAssignee,
      quickSkill,
      skillBy,
      specialistState,
      stewardshipPanel: () => stewardshipPanel(state, flowHelpers()),
    });
  }
  function actionAllowed(action, data = {}) {
    if (["start-task", "pause-task", "restart-task"].includes(action))
      return canOperateTask(state, taskBy(data.id));
    if (action === "cancel-task")
      return (
        canOperateTask(state, taskBy(data.id)) ||
        canInterveneTask(state, taskBy(data.id))
      );
    if (
      action === "admin-tab" ||
      (action === "navigate" && data.view === "admin")
    )
      return isTeamLead(state);
    if (action === "agent-settings") return canManageActor(state, data.id);
    if (action === "character-settings")
      return canManageActor(state, data.key || state.user);
    if (action === "manage-skills" || action === "attach-skill")
      return canEditBinding(state, data.agent || skillTarget());
    if (action === "publish-skill")
      return canPublishSkill(state, skillBy(data.id));
    if (action === "create-skill") return canEditBinding(state, skillTarget());
    return true;
  }
  function applyRoleControls(container) {
    container.querySelectorAll("button[data-action]").forEach((element) => {
      if (actionAllowed(element.dataset.action, element.dataset)) return;
      element.disabled = true;
      element.title = element.dataset.action?.includes("task")
        ? "현재 책임자만 조작할 수 있어요"
        : "이 설정의 관리 권한이 필요해요";
      if (
        [
          "agent-settings",
          "character-settings",
          "manage-skills",
          "publish-skill",
        ].includes(element.dataset.action) &&
        !element.classList.contains("g-character-trigger")
      )
        element.hidden = true;
    });
  }
  function toast(text, action = null) {
    clearTimeout(toastTimer);
    toastAction = action;
    notice.innerHTML = `<div class="g-toast"><span>${esc(memorySessionOnly ? "이번 변경은 현재 화면에서만 유지돼요. " + text : text)}</span>${action ? `<button type="button" class="cursor-interaction" data-action="toast-action">${esc(action.label)}</button>` : ""}</div>`;
    toastTimer = setTimeout(
      () => {
        notice.innerHTML = "";
        toastAction = null;
      },
      action ? 9000 : 3800,
    );
  }
  function closeModal() {
    modal = null;
    modalLayer.innerHTML = "";
    frame.inert = false;
    root.style.minHeight = "";
    if (modalFocus?.isConnected) modalFocus.focus({ preventScroll: true });
    else
      frame
        .querySelector('[data-action="quick-find"]')
        ?.focus({ preventScroll: true });
    modalFocus = null;
  }
  function commandResults(query = "") {
    const q = query.trim().toLowerCase(),
      pages = [
        ["home", "내 업무 공간", "notebook-pen"],
        ["office", "팀 오피스", "panels-top-left"],
        ["work", "업무와 결과", "layers"],
        ["inbox", "확인 요청", "inbox"],
        ["skills", "스킬 라이브러리", "blocks"],
        ["memory", "기억 보관함", "bookmark"],
      ];
    if (isTeamLead(state)) pages.push(["admin", "팀 관리", "users-round"]);
    const entries = [
      {
        kind: "request",
        label: "새 업무 맡기기",
        detail: "대상과 필요한 결과로 시작",
        icon: "plus",
        type: "시작",
      },
      ...[profile(), ...state.agents].map((a) => ({
        kind: "agent",
        id: actorKey(a),
        label: a.name,
        detail: a.id ? `${departmentOf(a).name} · ${a.role}` : "나의 개인 비서",
        actor: a,
        type: "동료",
      })),
      ...visibleTasks().map((t) => ({
        kind: "task",
        id: t.id,
        label: t.title,
        detail: `${t.id} · ${t.project} · ${t.shared ? "팀 공유" : "개인"}`,
        icon: "layers",
        type: "업무",
      })),
      ...allSkills().map((s) => ({
        kind: "skill",
        id: s.id,
        label: s.name,
        detail: `${s.scope === "team" ? "팀 공용" : "개인"} 스킬 · v${s.version}`,
        icon: s.icon,
        type: "스킬",
      })),
      ...state.memories.filter(canReadMemory).map((m) => ({
        kind: "memory",
        id: m.id,
        label: m.title,
        detail: memoryAudience(m),
        icon: "bookmark",
        type: "기억",
      })),
      ...pages.map(([id, label, glyph]) => ({
        kind: "page",
        id,
        label,
        detail: "워크스페이스",
        icon: glyph,
        type: "이동",
      })),
    ];
    paletteItems = (
      q
        ? entries.filter((x) =>
            (x.label + " " + x.detail).toLowerCase().includes(q),
          )
        : entries.filter(
            (x) =>
              x.kind === "request" ||
              x.kind === "page" ||
              (x.kind === "agent" && ["chief", state.user].includes(x.id)),
          )
    ).slice(0, 10);
    paletteIndex = Math.max(0, Math.min(paletteIndex, paletteItems.length - 1));
    return (
      paletteItems
        .map(
          (x, i) =>
            `<button type="button" class="g-command-result cursor-interaction ${i === paletteIndex ? "is-active" : ""}" data-action="command-select" data-id="${i}" aria-current="${i === paletteIndex}" aria-label="${esc(x.label)} · ${x.type}">${x.actor ? avatar(x.actor.name, x.actor.color, false, x.id) : icon(x.icon)}<span><strong>${esc(x.label)}</strong><small>${esc(x.detail)}</small></span><small>${x.type}</small></button>`,
        )
        .join("") ||
      '<div class="g-empty">찾는 항목이 없어요. 동료 이름이나 업무 번호로 찾아보세요.</div>'
    );
  }
  function runCommand(index) {
    const item = paletteItems[index];
    if (!item) return;
    closeModal();
    if (item.kind === "request") {
      handleFlowAction("flow-intake", {});
      return;
    }
    if (item.kind === "agent") {
      if (item.id === state.user) {
        state.view = "assistant";
        state.agentTab = "chat";
      } else {
        state.view = "agent";
        state.agent = item.id;
        state.agentTab = "chat";
        state.department = actorBy(item.id).department;
      }
    } else if (item.kind === "task") {
      goTask(item.id);
      return;
    } else if (item.kind === "skill") {
      openModal("run", {
        id: item.id,
        agent:
          skillBy(item.id).scope === "team" && state.view === "agent"
            ? state.agent
            : state.user,
      });
      return;
    } else if (item.kind === "memory") {
      openModal("memory-detail", { id: item.id });
      return;
    } else state.view = item.id;
    render();
    persist();
  }
  function openModal(type, data = {}) {
    const allowed =
      type === "agent-settings"
        ? canManageActor(state, data.id)
        : type === "character"
          ? canManageActor(state, data.key || state.user)
          : type === "skills-assignment"
            ? canEditBinding(state, data.agent || state.user)
            : type === "publish-skill"
              ? canPublishSkill(state, skillBy(data.id))
              : type === "create-skill"
                ? canEditBinding(state, data.agent || state.user)
                : true;
    if (!allowed) {
      toast("팀장이 관리하는 설정이에요.");
      return;
    }
    modalFocus = document.activeElement;
    modal = { type, ...data };
    if (type === "request") {
      modal.agent =
        data.agent ||
        (state.view === "agent"
          ? state.agent
          : state.view === "assistant"
            ? state.user
            : "chief");
      if (!actorBy(modal.agent)) modal.agent = state.user;
      modal.id = actorBy(modal.agent).skills[0] || skillsFor(modal.agent)[0].id;
      modal.values = {
        target: data.target || "",
        shared: data.target
          ? conversationFor(modal.agent)?.visibility === "team"
            ? "on"
            : ""
          : undefined,
        project: "제품 웹",
        env: "staging",
      };
    }
    renderModal();
    frame.inert = true;
    const first =
      modalLayer.querySelector("#g-command-query,textarea") ||
      modalLayer.querySelector('form input:not([type="hidden"]),form select') ||
      modalLayer.querySelector("button");
    first?.focus({ preventScroll: true });
  }
  const field = (label, name, value = "", opts = {}) =>
    `<label class="g-field"><span>${label}</span>${opts.textarea ? `<textarea class="g-input" aria-label="${esc(label)}" name="${name}" maxlength="${opts.max || 700}" ${opts.required ? "required" : ""}>${esc(value)}</textarea>` : `<input class="g-input" aria-label="${esc(label)}" name="${name}" value="${esc(value)}" maxlength="${opts.max || 140}" ${opts.required ? "required" : ""}>`}${opts.help ? `<span class="g-field-help">${opts.help}</span>` : ""}</label>`;
  const selectField = (label, name, values, current) =>
    `<label class="g-field"><span>${label}</span><select class="g-input" name="${name}">${values.map((v) => `<option ${v === current ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
  function renderModal() {
    let title = "",
      sub = "",
      body = "",
      form = "",
      submit = "저장",
      extra = "";
    const p =
      modal.type === "agent-settings"
        ? ((a) => ({
            ...a,
            instruction: a.note,
            style: a.style || "핵심부터 간결하게",
          }))(state.agents.find((a) => a.id === modal.id))
        : profile();
    const flowDialog = modal.type.startsWith("flow-")
      ? workflowModal(state, modal, flowHelpers())
      : null;
    if (flowDialog) {
      ({ title, sub, body, form = "", submit = "저장" } = flowDialog);
    } else if (modal.type === "command") {
      paletteIndex = 0;
      modalLayer.innerHTML = `<div class="g-overlay"><section class="g-dialog g-command-dialog" role="dialog" aria-modal="true" aria-label="빠른 찾기"><div class="g-command-head">${icon("search")}<input id="g-command-query" type="search" aria-label="빠른 찾기 검색어" placeholder="동료, 업무 번호, 스킬, 기억 검색" autocomplete="off"><button type="button" class="cursor-interaction" data-action="close-modal" aria-label="빠른 찾기 닫기">Esc</button></div><div class="g-command-results" id="g-command-results" aria-live="polite">${commandResults()}</div><div class="g-command-foot"><span><kbd>↑ ↓</kbd> 선택 &nbsp; <kbd>Enter</kbd> 열기</span><span>내가 볼 수 있는 항목만 검색</span></div></section></div>`;
      root.style.minHeight = "790px";
      icons();
      return;
    }
    if (modal.type === "new-conversation") {
      title = "업무별로 새 대화";
      sub = "같은 동료와 다른 맥락으로 이야기해요.";
      form = "new-conversation";
      submit = "대화 만들기";
      body = field("대화 제목", "title", "", {
        required: true,
        max: 70,
        help: "새 대화는 나만 보는 범위로 시작해요. 필요할 때 이 대화만 공유할 수 있어요.",
      });
    } else if (modal.type === "conversation-access") {
      const c = state.conversations.find(
        (c) => c.id === modal.id && canReadConversation(c, state.user),
      );
      if (!c) {
        closeModal();
        return;
      }
      title = "대화의 공개 범위";
      sub = c.title;
      const owner = c.owner === state.user;
      if (owner) {
        form = "conversation-access";
        submit = "공개 범위 저장";
      }
      body = `<div class="g-access-rows"><div><span>동료 사용</span><strong>${state.agents.some((a) => a.id === c.actorId) ? "팀원 모두" : "비서 소유자"}</strong></div><div><span>이 대화 열람</span><select class="g-input" name="visibility" aria-label="이 대화 열람" ${owner ? "" : "disabled"}>${[
        ["private", "나만"],
        [
          "department",
          (departments.find((d) => d.id === c.department)?.name || "소속") +
            " 부서",
        ],
        ["team", "팀원 모두"],
      ]
        .map(
          ([id, label]) =>
            `<option value="${id}" ${id === c.visibility ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select></div><div><span>소유자의 개인 기억</span><strong>${icon("lock-keyhole")} 소유자만</strong></div><div><span>다른 대화</span><strong>각 대화의 공개 범위 유지</strong></div></div><p class="g-field-help g-mt">선택한 대화의 메시지만 공유해요. 개인 기억과 다른 대화는 자동으로 공개되지 않아요. ${owner ? "" : "공개 범위는 대화를 만든 사람이 바꿀 수 있어요."}</p>`;
    } else if (modal.type === "publish-skill") {
      const skill = skillBy(modal.id),
        actor = actorBy(modal.agent);
      title = "스킬의 다음 버전";
      sub = `${skill.name} · v${skill.version} → v${nextVersion(skill.version)}`;
      form = "publish-skill";
      submit = "샘플 버전 게시";
      body = `${field("이 버전에서 할 일", "desc", skill.desc, { required: true, textarea: true, max: 300 })}<div class="g-run-preview">${esc(actor.name)}의 다음 실행에 적용돼요. 이미 시작한 실행의 스킬·설정 버전은 유지합니다.</div><p class="g-field-help g-mt">버전 전환을 보여 주는 목업입니다. 실제 실행 시험이나 조직 배포는 수행하지 않아요.</p>`;
    } else if (modal.type === "reset-demo") {
      title = "처음 상태로 돌아갈까요?";
      sub = "이 브라우저에 저장한 시연 데이터 초기화";
      body =
        "<p>추가한 대화, 기억, 스킬과 설정을 지우고 기본 샘플을 다시 불러옵니다.</p>";
      extra =
        button("취소", "close-modal") +
        button("시연 데이터 초기화", "reset-confirm", "", true, "rotate-ccw");
    } else if (modal.type === "request") {
      const a = actorBy(modal.agent),
        v = modal.values,
        s = skillBy(modal.id),
        available = skillsFor(modal.agent),
        attached = available.filter((s) => a.skills.includes(s.id)),
        others = available.filter((s) => !a.skills.includes(s.id));
      title = "어떤 일을 맡길까요?";
      sub = "동료와 스킬을 정하면 하나의 업무로 이어가요.";
      form = "request";
      submit = "업무 맡기고 시연 시작";
      const opts = (list) =>
        list
          .map(
            (x) =>
              `<option value="${x.id}" ${x.id === modal.id ? "selected" : ""}>${esc(x.name)}</option>`,
          )
          .join("");
      body = `<div class="g-request-person">${avatar(a.name, a.color, false, modal.agent)}<label class="g-field"><span>접수할 동료</span><select class="g-input" id="g-request-agent" name="agent">${actorOptions(modal.agent)}</select></label></div><label class="g-field"><span>무엇을 해주면 되나요?</span><textarea class="g-input" name="target" maxlength="700" required placeholder="예: 로그인 수정 PR #124를 확인하고, QA 검증까지 이어주세요.">${esc(v.target)}</textarea></label><label class="g-field"><span>사용할 스킬</span><select class="g-input" id="g-request-skill" name="skill">${attached.length ? `<optgroup label="${esc(a.name)}에게 장착된 스킬">${opts(attached)}</optgroup>` : ""}${others.length ? `<optgroup label="이번 업무에 사용할 다른 스킬">${opts(others)}</optgroup>` : ""}</select><span class="g-field-help">${esc(s.desc)}</span></label><label class="g-check"><input type="checkbox" name="shared" ${v.shared !== undefined ? (v.shared === "on" ? "checked" : "") : a.id ? "checked" : ""}><span>팀 업무로 공유하기<br><span class="g-field-help">${a.id ? "요청과 결과를 팀원 모두가 이어서 볼 수 있어요." : "기본은 개인 업무예요. 체크하면 요청과 결과를 팀에 공유해요."} 개인 대화와 기억은 포함하지 않아요.</span></span></label><details ${v.details ? "open" : ""}><summary class="cursor-interaction">프로젝트·환경 설정</summary><div class="g-fields-two g-mt">${selectField("프로젝트", "project", ["제품 웹", "팀 운영", "관리자 콘솔"], v.project)}${selectField("대상 환경", "env", ["staging", "개발 환경", "문서 작업"], v.env)}</div></details><div class="g-run-preview g-mt">완료 기준: ${esc(s.done)}<br>${esc(a.name)} · ${RUNTIMES[a.runtime]?.name || a.runtime} 예시 프로필 · ${esc(a.harness)}</div>`;
    } else if (modal.type === "character") {
      const target = actorBy(modal.key) || profile(),
        selected = characterBy(modal.character || target.character).id;
      title = target.name + "의 캐릭터";
      sub = "모습과 성격, 첫 인사를 정해보세요.";
      form = "character";
      submit = "캐릭터 적용";
      body = `<div class="g-character-preview">${characterPortrait(selected, target.color, true)}<div><h3>${esc(target.name)}</h3><p>${esc(characterBy(selected).name)} · ${esc(modal.personality ?? target.personality)}</p></div></div><input type="hidden" name="character" value="${selected}"><div class="g-character-picker" role="group" aria-label="캐릭터 선택">${characters.map((c) => `<button type="button" class="g-character-option cursor-interaction" data-action="select-character" data-id="${c.id}" aria-pressed="${c.id === selected}" aria-label="${c.name} 캐릭터">${characterPortrait(c.id, target.color)}<span>${c.name}</span></button>`).join("")}</div>${field("성격 한 줄", "personality", modal.personality ?? target.personality, { required: true, max: 45 })}${field("첫 인사", "catchphrase", modal.catchphrase ?? target.catchphrase, { required: true, max: 140, textarea: true })}<p class="g-field-help">캐릭터와 인사는 목록·대화창에 함께 적용돼요. 답변은 목업 샘플입니다.</p>`;
    } else if (modal.type === "run") {
      const s = skillBy(modal.id);
      title = s.name;
      sub = `${s.scope === "team" ? "팀 스킬" : "개인 스킬"} v${s.version} / 실행 준비`;
      form = "run";
      submit = "샘플 업무 실행";
      const caller = state.agents.find((a) => a.id === modal.agent);
      body = `<div class="g-run-preview"><div class="g-row">${avatar(caller?.name || p.name, caller?.color || p.color)}<span>${esc(caller?.name || p.name)} · 요청을 접수하고 필요한 담당자에게 이어줘요.</span></div></div>${field(s.input, "target", modal.target || s.example, { required: true, textarea: s.id === "meeting", max: 700 })}<div class="g-fields-two">${selectField("프로젝트", "project", ["제품 웹", "팀 운영", "관리자 콘솔"], "제품 웹")}${selectField("대상 환경", "env", ["staging", "개발 환경", "문서 작업"], s.role === "personal" ? "문서 작업" : "staging")}</div><label class="g-check"><input type="checkbox" name="shared" ${caller ? "checked" : ""}><span>팀 업무로 공유하기<br><span class="g-field-help">${caller ? "요청과 결과를 팀에 공유해요." : "기본은 개인 업무예요. 체크하면 요청과 결과를 팀에 공유해요."} 개인 대화·기억은 포함하지 않아요.</span></span></label><div class="g-run-preview">완료 기준: ${esc(s.done)}<br>실행 프로필: ${RUNTIMES[(caller || p).runtime]?.name || "Hermes"} · ${esc(caller?.harness || p.harness)}<br>실행 시 고정: 스킬 v${esc((caller || p).skillPins?.[s.id] || s.version)}</div>`;
    } else if (modal.type === "skills-assignment") {
      const target =
        state.agents.find((a) => a.id === modal.agent) || profile();
      title = target.name + "의 스킬 관리";
      sub = "장착한 스킬은 대화에서 바로 실행할 수 있어요.";
      form = "skills-assignment";
      submit = "스킬 적용";
      body = allSkills()
        .filter(
          (s) =>
            !state.agents.some((a) => a.id === modal.agent) ||
            s.scope === "team",
        )
        .map(
          (s) =>
            `<label class="g-assignment-check"><input type="checkbox" name="skills" value="${s.id}" ${target.skills.includes(s.id) ? "checked" : ""}><span><strong>${esc(s.name)}</strong><span class="g-tiny g-muted"> v${esc(s.version)}</span><p>${esc(s.desc)}</p></span></label>`,
        )
        .join("");
    } else if (modal.type === "settings" || modal.type === "agent-settings") {
      title =
        modal.type === "agent-settings" ? "팀 에이전트 설정" : "내 비서 커스텀";
      sub =
        modal.type === "agent-settings"
          ? "이 에이전트의 스킬과 하네스에 적용해요."
          : "이름과 업무 방식, 스킬을 나에게 맞춰보세요.";
      form = "settings";
      submit =
        modal.type === "agent-settings"
          ? "에이전트 설정 저장"
          : "비서 설정 저장";
      body = `<div class="g-fields-two">${field("비서 이름", "name", p.name, { required: true, max: 20 })}${field("업무 역할", "role", p.role, { required: true, max: 45 })}</div><div class="g-field"><span>비서 색상</span><div class="g-color-options">${[
        ["blue", "블루"],
        ["green", "그린"],
        ["purple", "퍼플"],
      ]
        .map(
          ([v, label]) =>
            `<label class="g-color-choice"><input type="radio" name="color" value="${v}" ${p.color === v ? "checked" : ""}>${avatar(label, v)}<span class="g-small">${label}</span></label>`,
        )
        .join(
          "",
        )}</div></div>${field("비서에게 알려줄 업무 방식", "instruction", p.instruction, { textarea: true, required: true, max: 400 })}<div class="g-fields-two">${selectField("답변 방식", "style", ["핵심부터 간결하게", "체크리스트로 꼼꼼하게", "배경과 근거를 자세히"], p.style)}${selectField("업무 방식 프리셋", "harness", ["균형", "개발 집중", "검증 중심", "읽기 전용"], p.harness)}</div><div class="g-field"><span>장착할 스킬</span>${allSkills()
        .filter((s) => modal.type !== "agent-settings" || s.scope === "team")
        .map(
          (s) =>
            `<label class="g-check"><input name="skills" type="checkbox" value="${s.id}" ${p.skills.includes(s.id) ? "checked" : ""}><span>${esc(s.name)} <span class="g-field-help">v${s.version}</span></span></label>`,
        )
        .join("")}</div>`;
      body += `<label class="g-field"><span>실행 하네스 · 샘플 프로필</span><select class="g-input" name="runtime">${Object.entries(
        RUNTIMES,
      )
        .map(
          ([id, r]) =>
            `<option value="${id}" ${id === (p.runtime || "hermes") ? "selected" : ""}>${r.name} · ${r.description}</option>`,
        )
        .join(
          "",
        )}</select><span class="g-field-help">실제 엔진은 연결 전입니다. 프로필의 스킬 지원 범위를 시연해요.</span></label>`;
      if (modal.type === "agent-settings")
        body =
          selectField(
            "소속 부서",
            "department",
            departments.map((d) => d.name),
            departmentOf(p).name,
          ) + body;
    } else if (modal.type === "memory-detail") {
      const current = state.memories.find((m) => m.id === modal.id);
      if (!canReadMemory(current)) {
        closeModal();
        return;
      }
      const history = current.history.find((h) => h.version === modal.version),
        m = history
          ? {
              ...current,
              ...history,
              evidence: history.evidence || history.text,
              history: [],
            }
          : current,
        promoted = allSkills().find((s) => s.id === m.skillId);
      title = m.title;
      sub = `${memoryAudience(m)} · ${memoryKinds[m.kind]?.[0] || "사실·결정"} · ${history ? "이전" : "현재"} v${m.version}`;
      body = `<p class="g-small">${esc(m.text)}</p><div class="g-divider"></div><h3>이 기억의 출처</h3><p class="g-field-help g-mt">${esc(m.source)} · ${esc(m.at)} · 샘플 원문</p><blockquote class="g-memory-quote">${esc(m.evidence || m.text)}</blockquote><span class="g-field-help">기억과 원문을 함께 확인하고 바로잡을 수 있어요.</span>${
        m.history.length
          ? `<div class="g-divider"></div><h3>이전 버전 ${m.history.length}개</h3>${[
              ...m.history,
            ]
              .reverse()
              .map(
                (h) =>
                  `<div class="g-memory-version"><span>v${h.version} · ${esc(h.at)} · 이전 내용</span><p>${esc(h.text)}</p><span class="g-field-help">${esc(h.source)}</span></div>`,
              )
              .join("")}`
          : ""
      }`;
      extra = history
        ? button(
            "현재 기억 보기",
            "memory-detail",
            `data-id="${m.id}"`,
            true,
            "arrow-right",
          )
        : `${m.kind === "procedure" ? (promoted ? button("연결된 스킬 보기", "skill-detail", `data-id="${promoted.id}"`, false, "blocks") : button("스킬로 만들기", "skill-from-memory", `data-id="${m.id}"`, false, "blocks")) : ""}${button("기억 지우기", "forget-memory", `data-id="${m.id}"`, false, "trash-2")}${button("내용 바로잡기", "edit-memory", `data-id="${m.id}"`, true, "pencil")}`;
    } else if (modal.type === "memory-architecture") {
      title = "오래 기억하고, 필요한 만큼 읽기";
      sub = "장기 기억 서버 설계 · 목업의 샘플 동작";
      body = `<div class="g-memory-path">${[
        ["archive", "원문 보관", "대화·작업·결과 원본을 출처와 함께 저장"],
        [
          "notebook-pen",
          "기억 정리",
          "사실·결정, 경험, 절차, 진행 중인 약속으로 정리",
        ],
        ["network", "공유 범위", "내 비서 / 에이전트 / 부서 / 팀으로 구분"],
        [
          "scan-search",
          "찾아서 답하기",
          "허용된 기억을 검색하고 필요한 원문을 확인",
        ],
      ]
        .map(
          ([i, t, s]) =>
            `<div><div class="g-memory-path-row"><span>${icon(i)}</span><strong>${t}</strong></div><p class="g-field-help" style="margin:5px 0 0 31px">${s}</p></div>`,
        )
        .join(
          "",
        )}</div><div class="g-divider"></div><p class="g-small">기억의 보관 용량은 서버 저장소를 확장해 늘리고, 한 번의 답변에는 관련된 기억만 넣습니다.</p><p class="g-field-help g-mt">현재는 샘플 데이터와 키워드 검색 시연이에요. 실제 원문 저장, 의미 검색, 자동 정리 작업은 서버 연결 후 구현합니다. 데모 저장 공간에는 한도가 있어요.</p>`;
    } else if (modal.type === "memory") {
      const m = state.memories.find((m) => m.id === modal.id),
        key = modal.key || memoryActor(),
        a = actorBy(key) || profile(),
        isPersonal = !a.id;
      if (m && !canReadMemory(m)) {
        closeModal();
        return;
      }
      title = m ? "기억 바로잡기" : "기억 추가";
      sub = m
        ? "새 버전으로 기록하고 이전 내용은 이력에 남겨요."
        : "기억할 동료와 출처를 함께 남겨요.";
      form = "memory";
      const sourceTask = modal.sourceTaskId ? taskBy(modal.sourceTaskId) : null;
      const choices = sourceTask
        ? [[scopeForTaskMemory(sourceTask), "원본 업무와 같은 범위"]]
        : isPersonal
          ? [
              ["personal", "내 비서만"],
              ["team", "팀 공통"],
            ]
          : [
              ["agent", a.name + "의 기억"],
              ["department", departmentOf(a).name + " 공통"],
              ["team", "팀 공통"],
            ];
      const scope =
        m?.scope || modal.scope || (isPersonal ? "personal" : "agent");
      body = `${field("기억 제목", "title", m?.title || modal.title || "", { required: true, max: 80 })}${field("기억할 내용", "text", m?.text || modal.text || "", { textarea: true, required: true, max: 700 })}<div class="g-fields-two"><label class="g-field"><span>기억 범위</span><select class="g-input" name="scope" ${m ? "disabled" : ""}>${(m ? [[m.scope, memoryAudience(m)]] : choices).map(([v, t]) => `<option value="${v}" ${v === scope ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label><label class="g-field"><span>기억 종류</span><select class="g-input" name="kind">${Object.entries(
        memoryKinds,
      )
        .map(
          ([v, t]) =>
            `<option value="${v}" ${v === (m?.kind || modal.kind || "fact") ? "selected" : ""}>${t[0]}</option>`,
        )
        .join(
          "",
        )}</select></label></div>${field("출처", "source", m ? `${profile().owner} · 기억 정정` : modal.source || `${profile().owner} · 직접 추가`, { required: true, max: 120 })}`;
    } else if (modal.type === "create-skill") {
      title = "반복 업무를 스킬로";
      sub = "입력과 완료 기준을 정해 재사용할 수 있어요.";
      form = "create-skill";
      submit = "스킬 만들고 장착";
      body = `${field("스킬 이름", "name", modal.name || "", { required: true, max: 45 })}${field("어떤 일을 하나요?", "desc", modal.desc || "", { textarea: true, required: true, max: 300 })}<div class="g-fields-two">${field("사용자가 입력할 항목", "input", "업무 대상", { required: true, max: 60 })}${selectField("공유 범위", "scope", modal.agent ? ["팀 공용 스킬"] : canEditTeamSkills(state) ? ["개인 스킬", "팀 공용 스킬"] : ["개인 스킬"], modal.agent ? "팀 공용 스킬" : "개인 스킬")}</div>${field("완료 기준", "done", modal.done || "", { textarea: true, required: true, max: 300 })}<div class="g-run-preview">생성된 스킬은 ${modal.agent ? esc(actorBy(modal.agent).name) : "내 비서"}에게 장착돼요. 목업에서는 공통 샘플 흐름으로 실행됩니다.</div>`;
    } else if (modal.type === "skill-detail") {
      const s = skillBy(modal.id);
      title = s.name;
      sub = `${s.scope === "team" ? "팀 공용" : "개인"} / v${s.version}`;
      body = `<p class="g-small">${esc(s.desc)}</p><div class="g-divider"></div><div class="g-field"><span>필요한 입력</span><span class="g-muted">${esc(s.input)}</span></div><div class="g-field"><span>실행 절차</span><span class="g-muted">${s.stages.map(esc).join(" → ")}</span></div><div class="g-field"><span>필요한 도구·권한</span><span class="g-muted">${esc(s.tools)}</span></div><div class="g-field"><span>완료 기준</span><span class="g-muted">${esc(s.done)}</span></div><div class="g-dialog-actions">${button("닫기", "close-modal")}${button("다음 버전 만들기", "publish-skill", `data-id="${s.id}" data-agent="${modal.agent || state.user}"`, false, "git-branch")}${button("이 스킬 실행", "run-skill", `data-id="${s.id}" data-agent="${modal.agent || state.user}"`, true, "play")}</div>`;
    }
    modalLayer.innerHTML = `<div class="g-overlay"><section class="g-dialog" role="dialog" aria-modal="true" aria-labelledby="g-dialog-title"><header class="g-dialog-header"><div><h2 id="g-dialog-title">${esc(title)}</h2><p class="g-page-sub">${esc(sub)}</p></div><button type="button" class="g-button g-quiet cursor-interaction" data-action="close-modal" aria-label="닫기">${icon("x")}</button></header>${form ? `<form data-form="${form}">${body}<div class="g-error" role="alert" id="g-form-error"></div><div class="g-dialog-actions">${button("취소", "close-modal")}<button type="button" class="g-button g-primary cursor-interaction" data-action="submit-form">${submit}</button></div></form>` : body + (extra ? `<div class="g-dialog-actions g-wrap">${extra}</div>` : "")}</section></div>`;
    root.style.minHeight =
      Math.max(790, modalLayer.querySelector(".g-dialog").offsetHeight + 110) +
      "px";
    icons();
    applyRoleControls(modalLayer);
  }
  function log(t, text) {
    t.events.push({ time: clock(), text, ts: Date.now() });
    recordRun(t, text);
  }
  function finish(t) {
    t.status = "result_ready";
    t.stage = 5;
    log(t, "샘플 결과가 준비됐어요. 결과 탭에서 확인할 수 있어요.");
    t.discussion.push({
      author: state.profiles[t.owner]?.name || "비서",
      text: "작업 흐름이 끝났어요. 결과 탭에 샘플 보고서와 확인 범위를 남겼습니다.",
    });
    const key = t.requesterAgent || t.owner;
    const threadId = t.conversationId;
    if (threadId)
      state.messages[threadId] = [
        ...(state.messages[threadId] || []),
        {
          author:
            state.agents.find((a) => a.id === key)?.name ||
            state.profiles[t.owner]?.name ||
            "비서",
          kind: "agent",
          text: `「${t.title}」의 결과가 준비됐어요. 작업 공간에서 결과와 진행 기록을 확인할 수 있어요.`,
        },
      ];
    timers.delete(t.id);
    if (state.view === "work" && state.task === t.id) state.taskTab = "result";
    render();
    persist();
    toast("업무 시연이 끝났어요. 결과를 확인해보세요.", {
      label: "결과 보기",
      task: t.id,
    });
  }
  function advance(id) {
    const t = state.tasks.find((t) => t.id === id);
    if (!t || t.status !== "running") return;
    const s = taskSkill(t);
    if (s.ask && t.stage === 2 && !t.decision) {
      t.stage = 3;
      t.status = "needs_input";
      log(t, "개발 검토 내용을 QA에게 넘겼어요. 검증 범위를 선택해주세요.");
      timers.delete(id);
      render();
      persist();
      toast("린이 확인을 요청했어요 · 검증 범위를 선택해주세요");
      return;
    }
    if (t.stage >= 4) {
      finish(t);
      return;
    }
    t.stage += 1;
    log(
      t,
      `${s.stages[t.stage - 1]} 단계를 마치고 ${s.stages[t.stage]} 단계로 이어갑니다. (샘플)`,
    );
    render();
    persist();
    timers.set(
      id,
      setTimeout(() => advance(id), 1450),
    );
  }
  function start(t) {
    if (!canOperateTask(state, t)) {
      toast("현재 업무 책임자만 실행할 수 있어요.");
      return;
    }
    if (t.workflow) {
      try {
        const run = startWorkflowRun(state, t, allSkills());
        const generation = run.generation;
        clearTimeout(timers.get(t.id));
        timers.set(
          t.id,
          setTimeout(() => {
            if (!completeWorkflowRun(state, t, run.id, generation)) return;
            timers.delete(t.id);
            render();
            persist();
            toast(
              "샘플 결과가 준비됐어요. 근거를 확인하고 다음 행동을 선택해주세요.",
            );
          }, 2200),
        );
        render();
        persist();
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (t.officeScenario) {
      state.office.cancelled = state.office.cancelled.filter(
        (id) => id !== t.id,
      );
      if (t.id === "O-105" && t.decision) {
        state.office.approved = true;
        state.office.flow = 6;
        state.office.decision = t.decision;
      }
      state.office.playing = true;
      syncOfficeJobs(true);
      render();
      persist();
      scheduleOffice();
      return;
    }
    clearTimeout(timers.get(t.id));
    const actor = actorBy(t.requesterAgent) || state.profiles[t.owner];
    if (!runtimeSupportsSkill(actor.runtime, t.skill)) {
      toast(
        "이 실행 프로필에서 사용할 수 없는 스킬이에요. 동료 설정을 확인해주세요.",
      );
      return;
    }
    const run = ensureRun(t, ["done", "cancelled"].includes(runFor(t)?.status));
    if (t.status === "paused") {
      run.generation += 1;
      delete run.recoveryReason;
    }
    t.status = "running";
    log(t, "샘플 실행을 시작했어요. 진행 상태를 따라가보세요.");
    render();
    persist();
    timers.set(
      t.id,
      setTimeout(() => advance(t.id), 1150),
    );
  }
  function flowHelpers() {
    return {
      esc,
      icon,
      button,
      avatar,
      status,
      taskDiscussion,
      executionPanel,
      skillBy,
    };
  }
  function handleFlowAction(action, data) {
    const task = data.id ? taskBy(data.id) : null;
    try {
      if (["flow-intake", "flow-import"].includes(action)) {
        state.intakeMode = action === "flow-import" ? "import" : "new";
        state.intakeStep = "input";
        if (state.intakeMode === "import")
          intakeDraft(state).workType = "pr-qa";
        state.view = "intake";
        history.pushState(null, "", "#/intake");
      } else if (action === "flow-edit-intake") state.intakeStep = "input";
      else if (action === "flow-create") {
        const draft = intakeDraft(state);
        if (state.intakeStep !== "review") return;
        const created =
          state.intakeMode === "import"
            ? importResult(state, draft)
            : createWorkflow(state, draft);
        delete state.intakeDrafts[state.user];
        goTask(created.id);
        toast("같은 업무방에서 요청·결과·인계를 이어갈 수 있어요.");
        return;
      } else {
        if (!task) throw new Error("이 업무를 찾거나 열람할 수 없어요.");
        if (["flow-brief", "flow-rework"].includes(action)) {
          requireOperator(state, task);
          openModal(action, { id: task.id });
          return;
        }
        if (action === "flow-source") {
          openModal(action, { id: task.id, source: data.source });
          return;
        }
        if (action === "flow-handoff") handoffWorkflow(state, task);
        if (action === "flow-accept") acceptWorkflow(state, task);
        if (action === "flow-legacy-accept") {
          requireOperator(state, task);
          if (task.status !== "result_ready")
            throw new Error("현재 결과를 확인해주세요.");
          task.status = "done";
          task.acceptedBy = state.user;
          task.acceptedAt = new Date().toISOString();
          workflowEvent(
            state,
            task,
            `${profile().owner}가 샘플 결과를 수용했어요. 실제 검증은 수행하지 않았습니다.`,
            "accept",
          );
        }
        if (action === "flow-claim") {
          if (canOperateTask(state, task)) return;
          task.claims ||= [];
          if (!task.claims.includes(state.user)) {
            task.claims.push(state.user);
            workflowEvent(
              state,
              task,
              `${profile().owner}가 업무 인수를 요청했어요.`,
              "claim",
            );
          }
        }
        if (action === "flow-copy") {
          const url = `${location.origin}${location.pathname}#/tasks/${encodeURIComponent(task.id)}`;
          navigator.clipboard
            .writeText(url)
            .then(() =>
              toast(
                "업무 링크를 복사했어요. 현재 목업 데이터는 이 브라우저에만 있어요.",
              ),
            )
            .catch(() => toast("주소창의 업무 링크를 복사해주세요."));
          return;
        }
        if (action === "flow-reuse") {
          if (task.status !== "done" || !task.acceptedArtifactId)
            throw new Error("수용한 결과에서 시작해주세요.");
          state.intakeDrafts[state.user] = {
            workType: task.workType,
            project: task.project,
            goal: task.doneCriteria,
            target: "",
            targetVersion: "",
            visibility: visibilityOf(task),
            exampleId: task.acceptedArtifactId,
          };
          state.intakeMode = "new";
          state.intakeStep = "input";
          state.view = "intake";
          history.pushState(null, "", "#/intake");
        }
      }
      render();
      persist();
    } catch (error) {
      const output = frame.querySelector("[data-flow-error]");
      if (output) output.textContent = error.message;
      else toast(error.message);
    }
  }
  function handleFlowSubmit(kind, form, values) {
    try {
      const task = taskBy(form.dataset.id || values.taskId);
      if (kind === "flow-intake") {
        Object.assign(intakeDraft(state), values);
        state.intakeStep = "review";
      } else if (kind === "flow-steward") {
        if (!isTeamLead(state))
          throw new Error("팀장만 스킬 담당자를 지정할 수 있어요.");
        if (values.member && !state.members[values.member])
          throw new Error("구성원을 확인해주세요.");
        state.skillStewards[form.dataset.skill] = values.member;
        auditTeam(
          state,
          "스킬 담당 변경",
          `${skillBy(form.dataset.skill).name}: ${state.members[values.member]?.name || "팀장 관리"}`,
        );
      } else {
        if (!task) throw new Error("이 업무를 찾거나 열람할 수 없어요.");
        if (kind === "flow-assign")
          reassignWorkflow(state, task, values.responsible);
        if (kind === "flow-brief") correctBrief(state, task, values);
        if (kind === "flow-rework")
          reworkWorkflow(state, task, values.reason, values.targetVersion);
      }
      if (modal?.type.startsWith("flow-")) closeModal();
      render();
      persist();
    } catch (error) {
      const output = form.querySelector("[data-flow-error], #g-form-error");
      if (output) output.textContent = error.message;
      else toast(error.message);
    }
  }
  function goTask(id) {
    const task = taskBy(id);
    if (!task) {
      toast("이 업무를 찾거나 열람할 수 없어요.");
      return;
    }
    state.visitBefore ||= {};
    state.visitBefore[id] = state.visits[id] || null;
    state.visits[id] = new Date().toISOString();
    if (location.hash !== `#/tasks/${encodeURIComponent(id)}`)
      history.pushState(null, "", `#/tasks/${encodeURIComponent(id)}`);
    state.view = "work";
    state.filter = "all";
    state.task = id;
    state.taskTab = "progress";
    render();
    persist();
  }
  function createTask(values) {
    const s = skillBy(modal.id),
      caller = state.agents.find((a) => a.id === modal.agent),
      n = state.counter++;
    const actor = caller || profile();
    if (!runtimeSupportsSkill(actor.runtime, s.id)) {
      modalLayer.querySelector("#g-form-error").textContent =
        "이 예시 프로필에서 지원하지 않는 스킬이에요. 동료나 스킬을 바꿔주세요.";
      return;
    }
    const title =
      modal.type === "request"
        ? values.target
        : s.id === "release"
          ? `${values.target} 배포 전 검증`
          : s.id === "bug"
            ? `${values.target} 수정`
            : s.id === "meeting"
              ? "회의록과 담당자별 할 일 정리"
              : s.name;
    const t = {
      id: `T-${n}`,
      title: title.slice(0, 110),
      owner: state.user,
      skill: s.id,
      shared: values.shared === "on",
      status: "queued",
      stage: 0,
      decision: "",
      target: values.target,
      project: values.project,
      env: values.env,
      harness: caller?.harness || profile().harness,
      version: s.version,
      requesterAgent: modal.agent || state.user,
      discussion: [{ author: profile().owner, text: values.target }],
      events: [
        {
          time: clock(),
          text: `${profile().owner}가 ${s.name} 스킬을 실행했어요. (샘플)`,
        },
      ],
    };
    const source = conversationFor(t.requesterAgent);
    t.visibility =
      values.shared === "on"
        ? "team"
        : source?.visibility === "department"
          ? "department"
          : "private";
    t.department = source?.department || membership(state).department;
    t.responsible = state.user;
    t.claims = [];
    const conversation = createConversation(t.requesterAgent, t.title);
    Object.assign(conversation, {
      visibility: t.visibility,
      department: t.department,
      taskId: t.id,
    });
    t.conversationId = conversation.id;
    state.tasks.unshift(t);
    ensureRun(t);
    closeModal();
    goTask(t.id);
    start(t);
  }
  root.addEventListener("click", (event) => {
    if (event.target.classList.contains("g-overlay")) {
      closeModal();
      return;
    }
    const el = event.target.closest("[data-action]");
    if (!el || !root.contains(el) || el.disabled) return;
    const { action, id, value, view, key, agent } = el.dataset;
    if (action.startsWith("flow-")) {
      handleFlowAction(action, el.dataset);
      return;
    }
    if (!actionAllowed(action, el.dataset)) {
      toast("팀장이 관리하는 설정이에요.");
      return;
    }
    if (action === "start-signup") {
      if (modal) closeModal();
      state.view = "signup";
      render();
      persist();
      return;
    }
    if (action === "exit-signup") {
      state.view = "office";
      history.replaceState(null, "", location.pathname);
      render();
      persist();
      return;
    }
    if (action === "admin-tab") {
      state.view = "admin";
      state.adminTab = value;
      render();
      persist();
      return;
    }
    if (action === "load-messages") {
      state.messageWindows[conversationIdFor(key)] =
        (state.messageWindows[conversationIdFor(key)] || 20) + 20;
      render();
      return;
    }
    if (action === "reset-demo") {
      openModal("reset-demo");
      return;
    }
    if (action === "reset-confirm") {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      clearTimeout(officeTimer);
      closeModal();
      localStorage.removeItem(STORAGE_KEY);
      state = initializeTeam(initial());
      departments = state.team.departments;
      initializeModel();
      initializeWorkflows(state);
      ensureOfficeJobs();
      syncOfficeJobs(true);
      render();
      persist();
      scheduleOffice();
      toast("샘플 상태로 초기화했어요");
      return;
    }
    if (action === "view-results") {
      state.view = "work";
      state.filter = "results";
      state.taskTab = "result";
      render();
      persist();
      return;
    }
    if (action === "open-execution") {
      goTask(id);
      state.taskTab = "execution";
      render();
      persist();
      return;
    }
    if (action === "new-conversation") {
      openModal("new-conversation", { key });
      return;
    }
    if (action === "conversation-access") {
      const c = state.conversations.find(
        (c) => c.id === id && canReadConversation(c, state.user),
      );
      if (c && !taskBy(c.taskId)?.workflow)
        openModal("conversation-access", { id });
      return;
    }
    if (action === "open-conversation") {
      const c = state.conversations.find(
        (c) => c.id === id && canReadConversation(c, state.user),
      );
      if (!c) return;
      if (state.agents.some((a) => a.id === c.actorId)) {
        state.activeConversations[`${state.user}:${c.actorId}`] = c.id;
        state.agent = c.actorId;
        state.agentTab = "chat";
        state.view = "agent";
      } else if (c.actorId === state.user) {
        state.activeConversations[`${state.user}:${state.user}`] = c.id;
        state.agentTab = "chat";
        state.view = "assistant";
      } else {
        state.selectedConversation = c.id;
        state.view = "sharedThread";
      }
      render();
      persist();
      return;
    }
    if (action === "publish-skill") {
      openModal("publish-skill", { id, agent: agent || state.user });
      return;
    }
    if (action === "submit-form") {
      el.closest("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      return;
    }
    if (action === "close-modal") {
      closeModal();
      return;
    }
    if (action === "quick-find") {
      openModal("command");
      return;
    }
    if (action === "command-select") {
      runCommand(Number(id));
      return;
    }
    if (action === "new-request") {
      if (agent || ["assistant", "agent"].includes(state.view))
        openModal("request", { agent });
      else handleFlowAction("flow-intake", {});
      return;
    }
    if (action === "toast-action") {
      const next = toastAction;
      clearTimeout(toastTimer);
      notice.innerHTML = "";
      toastAction = null;
      if (next?.task) {
        goTask(next.task);
        if (taskBy(next.task)?.status === "done") {
          state.taskTab = "result";
          render();
          persist();
        }
      } else if (next?.undo && forgottenItem && canReadMemory(forgottenItem)) {
        const restored = forgottenItem;
        state.memories.unshift(restored);
        state.forgottenMemories = state.forgottenMemories.filter(
          (x) => x !== restored.id,
        );
        forgottenItem = null;
        render();
        persist();
        toast("기억을 되돌렸어요. 다시 참고할 수 있어요.");
      }
      return;
    }
    if (action === "navigate") {
      if (location.hash) history.pushState(null, "", location.pathname);
      state.view = view;
      state.search = "";
      if (view === "agents") state.department = "all";
      if (view === "assistant") state.agentTab = "chat";
      if (view === "office") syncOfficeJobs();
      render();
      persist();
    } else if (action === "office-select") {
      state.office.selected = id;
      state.office.focusTask =
        el.dataset.task || officeActivity(actorBy(id))?.task?.id || "";
      state.office.follow = false;
      renderOfficeUpdate();
      persist();
    } else if (action === "office-follow") {
      state.office.follow = true;
      syncOfficeJobs();
      renderOfficeUpdate();
      persist();
    } else if (action === "office-motion") {
      state.office.motion = !state.office.motion;
      render();
      persist();
    } else if (action === "office-play") {
      state.office.playing = !state.office.playing;
      syncOfficeJobs(true);
      render();
      persist();
      scheduleOffice();
    } else if (action === "office-reset") resetOffice();
    else if (action === "department") {
      state.department = departments.some((d) => d.id === id) ? id : "all";
      state.view = "agents";
      if (id !== "all")
        state.collapsedDepartments = state.collapsedDepartments.filter(
          (d) => d !== id,
        );
      render();
      persist();
    } else if (action === "toggle-department") {
      state.collapsedDepartments = state.collapsedDepartments.includes(id)
        ? state.collapsedDepartments.filter((d) => d !== id)
        : [...state.collapsedDepartments, id];
      render();
      persist();
    } else if (action === "agent") {
      state.agent = id;
      state.agentTab = "chat";
      state.department = departmentOf(currentAgent()).id;
      state.collapsedDepartments = state.collapsedDepartments.filter(
        (d) => d !== state.department,
      );
      state.view = "agent";
      render();
      persist();
    } else if (action === "agent-area") {
      state.agent = id;
      state.agentTab = value;
      state.department = departmentOf(currentAgent()).id;
      state.view = "agent";
      render();
      persist();
    } else if (action === "agent-tab") {
      state.agentTab = value;
      render();
      persist();
    } else if (action === "character-settings")
      openModal("character", { key: key || state.user });
    else if (action === "select-character" && modal?.type === "character") {
      modal.personality = modalLayer.querySelector(
        '[name="personality"]',
      ).value;
      modal.catchphrase = modalLayer.querySelector(
        '[name="catchphrase"]',
      ).value;
      modal.character = id;
      renderModal();
      modalLayer
        .querySelector(`[data-action="select-character"][data-id="${id}"]`)
        ?.focus({ preventScroll: true });
    } else if (action === "manage-skills")
      openModal("skills-assignment", { agent });
    else if (action === "settings") openModal("settings");
    else if (action === "agent-settings") openModal("agent-settings", { id });
    else if (action === "run-skill") {
      if (modal) closeModal();
      openModal("run", {
        id,
        agent:
          skillBy(id).scope === "team"
            ? agent || (state.view === "agent" ? state.agent : state.user)
            : state.user,
      });
    } else if (action === "chat-task")
      openModal("request", { agent: key, target: el.dataset.target });
    else if (action === "open-task") goTask(id);
    else if (action === "my-work") {
      state.view = "work";
      state.filter = "mine";
      render();
      persist();
    } else if (action === "select-task") {
      goTask(id);
    } else if (action === "task-filter") {
      state.filter = value;
      render();
      persist();
    } else if (action === "task-tab") {
      state.taskTab = value;
      render();
      persist();
    } else if (action === "show-result") {
      state.taskTab = "result";
      render();
      persist();
    } else if (action === "start-task") {
      const t = taskBy(id);
      if (t) start(t);
    } else if (action === "pause-task" || action === "cancel-task") {
      const t = taskBy(id);
      if (t) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        if (t.officeScenario) {
          if (action === "pause-task") {
            state.office.playing = false;
            scheduleOffice();
          } else
            state.office.cancelled = [
              ...new Set([...state.office.cancelled, id]),
            ];
        }
        t.status = action === "pause-task" ? "paused" : "cancelled";
        log(
          t,
          action === "pause-task"
            ? "진행을 저장하고 일시정지했어요. 이어서 재개할 수 있어요."
            : "사용자가 작업을 중단했어요.",
        );
        if (t.officeScenario) syncOfficeJobs();
        render();
        persist();
        toast(
          action === "pause-task" ? "진행을 저장했어요" : "작업을 중단했어요",
        );
      }
    } else if (action === "restart-task") {
      const t = taskBy(id);
      if (t) {
        t.stage = 0;
        t.decision = "";
        if (t.officeScenario) {
          if (id === "O-105") {
            state.office.flow = 0;
            state.office.approved = false;
          } else state.office.tick = 0;
        }
        start(t);
      }
    } else if (action === "attach-skill") {
      const target = agent || skillTarget(),
        a = actorBy(target);
      if (!a || !skillsFor(target).some((s) => s.id === id)) return;
      const attached = a.skills.includes(id);
      a.skills = attached
        ? a.skills.filter((x) => x !== id)
        : [...a.skills, id];
      if (!attached) a.skillPins[id] = skillBy(id).version;
      a.configVersion += 1;
      if (a.id)
        auditTeam(
          state,
          "공용 스킬 장착 변경",
          `${a.name}의 ${skillBy(id).name} 장착을 변경했어요.`,
        );
      render();
      persist();
      toast(
        `${a.name}에게 ${skillBy(id).name} 스킬을 ${attached ? "해제" : "장착"}했어요`,
      );
    } else if (action === "skill-detail") {
      if (modal) closeModal();
      openModal("skill-detail", { id, agent: agent || skillTarget() });
    } else if (action === "create-skill")
      openModal("create-skill", {
        agent: state.agents.some((a) => a.id === skillTarget())
          ? skillTarget()
          : undefined,
      });
    else if (action === "memory-scope") {
      state.memoryScope = value;
      state.memoryKind = "all";
      state.memoryQuery = "";
      recallResult = null;
      render();
      persist();
    } else if (action === "memory-kind") {
      state.memoryKind = value;
      render();
      persist();
    } else if (action === "open-memory") {
      state.memoryAgent = key || state.user;
      state.memoryScope = "all";
      state.memoryKind = "all";
      state.memoryQuery = "";
      state.view = "memory";
      recallResult = null;
      render();
      persist();
    } else if (action === "clear-memory-search") {
      state.memoryScope = "all";
      state.memoryKind = "all";
      state.memoryQuery = "";
      render();
      persist();
    } else if (action === "memory-architecture")
      openModal("memory-architecture");
    else if (action === "memory-detail") {
      const m = state.memories.find((m) => m.id === id);
      if (canReadMemory(m))
        openModal("memory-detail", {
          id,
          version: Number(el.dataset.version) || undefined,
        });
    } else if (action === "add-memory")
      openModal("memory", {
        key:
          key ||
          (state.view === "agent"
            ? state.agent
            : state.view === "assistant"
              ? state.user
              : memoryActor()),
        scope: el.dataset.scope,
        returnView: state.view,
      });
    else if (action === "edit-memory") {
      const m = state.memories.find((m) => m.id === id);
      if (canReadMemory(m))
        openModal("memory", {
          id,
          key:
            m.scope === "agent"
              ? m.owner
              : m.scope === "personal"
                ? state.user
                : memoryActor(),
          returnView: state.view,
        });
    } else if (action === "forget-memory" || action === "delete-memory") {
      const m = state.memories.find((m) => m.id === id);
      if (canReadMemory(m)) {
        forgottenItem = m;
        state.forgottenMemories = [
          ...new Set([...state.forgottenMemories, id]),
        ];
        state.memories = state.memories.filter((m) => m.id !== id);
        recallResult = null;
        closeModal();
        render();
        persist();
        toast("기억을 지웠어요. 이후 검색에서 제외돼요.", {
          label: "되돌리기",
          undo: true,
        });
      }
    } else if (action === "remember-message") {
      const message =
        state.messages[conversationIdFor(key)]?.[Number(el.dataset.index)];
      if (
        message &&
        message.kind === "user" &&
        (key === state.user || state.agents.some((a) => a.id === key))
      )
        openModal("memory", {
          key:
            conversationFor(key)?.visibility === "private" ? state.user : key,
          scope: memoryScopeForConversation(
            conversationFor(key),
            state.user,
            state.agents.some((a) => a.id === key),
          ).scope,
          agentMemoryKey: key,
          privateConversationId: conversationFor(key)?.id,
          title: message.text.slice(0, 45),
          text: message.text,
          source: `${actorBy(key).name} · ${profile().owner}의 대화`,
          returnView: state.view,
        });
    } else if (action === "skill-from-memory") {
      const m = state.memories.find((m) => m.id === id);
      if (canReadMemory(m))
        openModal("create-skill", {
          agent: m.scope === "agent" ? m.owner : undefined,
          memoryId: m.id,
          name: m.title,
          desc: m.text,
          done: "기억에 기록한 절차를 수행하고 결과와 근거를 남긴다.",
        });
    } else if (action === "remember-task") {
      const t = taskBy(id);
      if (t)
        openModal("memory", {
          title: t.title + " 결과",
          text: `${t.project} / ${t.env}\n${t.decision || t.target}\n샘플 업무 흐름의 결과입니다. 실제 검증 결과로 사용하지 않습니다.`,
          source: `${t.id} · 시뮬레이션 결과`,
          scope: visibilityOf(t) === "private" ? "personal" : visibilityOf(t),
          sourceTaskId: t.id,
          key: t.requesterAgent,
        });
    } else if (action === "skill-from-task") {
      const t = taskBy(id);
      if (t)
        openModal("create-skill", {
          name: t.title.slice(0, 35) + " 흐름",
          desc: `${t.project}에서 ${t.target} 업무를 반복 수행하는 절차`,
          done: taskSkill(t).done,
        });
    }
  });
  root.addEventListener("change", (event) => {
    if (
      event.target.closest('form[data-form="flow-intake"]') &&
      event.target.name === "workType"
    ) {
      Object.assign(
        intakeDraft(state),
        Object.fromEntries(new FormData(event.target.form)),
      );
      render();
      persist();
      return;
    }
    if (event.target.id === "cw-import-file") {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 50000 || !/\.(txt|md)$/i.test(file.name)) {
        toast("50KB 이하의 텍스트·Markdown 파일을 선택해주세요.");
        return;
      }
      file.text().then((text) => {
        if (text.length > 5000) {
          toast("5,000자 이하의 공유할 부분만 붙여넣어 주세요.");
          return;
        }
        Object.assign(intakeDraft(state), { body: text, source: file.name });
        render();
        persist();
      });
      return;
    }
    if (event.target.id === "g-signup-lead") {
      state.signupDraft = Object.fromEntries(new FormData(event.target.form));
      render();
      persist();
      frame.querySelector("#g-signup-lead")?.focus();
      return;
    }
    if (event.target.id === "g-conversation-select") {
      const c = state.conversations.find(
        (c) =>
          c.id === event.target.value &&
          c.actorId === event.target.dataset.key &&
          canReadConversation(c, state.user),
      );
      if (c) {
        state.activeConversations[`${state.user}:${c.actorId}`] = c.id;
        render();
        persist();
      }
      return;
    }

    if (event.target.id === "g-account-select") {
      closeModal();
      switchMember(state, event.target.value);
      history.replaceState(null, "", location.pathname);
      recallResult = null;
      state.search = "";
      state.skillTarget = state.user;
      forgottenItem = null;
      render();
      persist();
      toast(
        `${membership(state).name}님의 ${isTeamLead(state) ? "팀장" : "팀원"} 화면으로 전환했어요`,
      );
    }
    if (event.target.id === "g-memory-agent") {
      state.memoryAgent = event.target.value;
      state.memoryScope = "all";
      state.memoryKind = "all";
      state.memoryQuery = "";
      recallResult = null;
      render();
      persist();
    }
    if (event.target.id === "g-skill-target") {
      state.skillTarget = event.target.value;
      state.search = "";
      render();
      persist();
    }
    if (event.target.id === "g-memory-kind") {
      state.memoryKind = event.target.value;
      render();
      persist();
    }
    if (
      ["g-request-agent", "g-request-skill"].includes(event.target.id) &&
      modal?.type === "request"
    ) {
      const form = event.target.closest("form"),
        values = Object.fromEntries(new FormData(form));
      values.shared = form.querySelector('[name="shared"]').checked ? "on" : "";
      values.details = form.querySelector("details").open;
      const focusId = event.target.id;
      if (
        !actorBy(values.agent) ||
        (focusId === "g-request-skill" &&
          !skillsFor(values.agent).some((s) => s.id === values.skill))
      )
        return;
      modal.values = values;
      if (focusId === "g-request-agent") {
        modal.agent = values.agent;
        modal.id =
          actorBy(modal.agent).skills[0] || skillsFor(modal.agent)[0].id;
        delete modal.values.shared;
      } else modal.id = values.skill;
      renderModal();
      modalLayer.querySelector("#" + focusId)?.focus({ preventScroll: true });
    }
  });
  root.addEventListener("input", (event) => {
    if (event.target.closest('form[data-form="flow-intake"]')) {
      Object.assign(
        intakeDraft(state),
        Object.fromEntries(new FormData(event.target.form)),
      );
      persist();
    }
    if (event.target.closest('form[data-form="signup"]')) {
      state.signupDraft = Object.fromEntries(new FormData(event.target.form));
      persist();
    }
    if (event.target.id === "g-chat") {
      const key = conversationIdFor(event.target.closest("form").dataset.key);
      state.drafts[key] = event.target.value;
    }
    if (event.target.id === "g-skill-search") {
      state.search = event.target.value;
      render();
    }
    if (event.target.id === "g-memory-search") {
      state.memoryQuery = event.target.value;
      render();
    }
    if (event.target.id === "g-recall-query")
      state.recallQuery = event.target.value;
    if (event.target.id === "g-command-query") {
      paletteIndex = 0;
      modalLayer.querySelector("#g-command-results").innerHTML = commandResults(
        event.target.value,
      );
      icons();
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (
      modal?.type === "command" &&
      ["ArrowDown", "ArrowUp", "Enter"].includes(event.key) &&
      event.target.id === "g-command-query"
    ) {
      event.preventDefault();
      if (event.key === "Enter") {
        runCommand(paletteIndex);
        return;
      }
      paletteIndex = paletteItems.length
        ? (paletteIndex +
            (event.key === "ArrowDown" ? 1 : -1) +
            paletteItems.length) %
          paletteItems.length
        : 0;
      modalLayer.querySelectorAll(".g-command-result").forEach((el, i) => {
        el.classList.toggle("is-active", i === paletteIndex);
        el.setAttribute("aria-current", String(i === paletteIndex));
      });
      return;
    }
    if (modal && event.key === "Tab") {
      const controls = [
        ...modalLayer.querySelectorAll("button,input,select,textarea,a[href]"),
      ].filter((el) => !el.disabled && el.getClientRects().length);
      if (event.shiftKey && event.target === controls[0]) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && event.target === controls.at(-1)) {
        event.preventDefault();
        controls[0]?.focus();
      }
    }
    const form = event.target.closest("form[data-form]");
    if (
      form &&
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey || event.target.tagName === "INPUT")
    ) {
      event.preventDefault();
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "k" &&
      (!modal || modal.type === "command")
    ) {
      event.preventDefault();
      modal ? closeModal() : openModal("command");
    }
  });
  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-form]");
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form),
      values = Object.fromEntries(data.entries());
    for (const [k, v] of Object.entries(values))
      if (typeof v === "string") values[k] = v.trim();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const kind = form.dataset.form;
    if (kind.startsWith("flow-")) {
      handleFlowSubmit(kind, form, values);
      return;
    }
    if (
      ["signup", "team-member", "department", "team-settings"].includes(kind)
    ) {
      try {
        if (kind === "signup") {
          registerMember(state, values);
          initializeModel();
          initializeWorkflows(state);
          history.replaceState(null, "", location.pathname);
        } else if (kind === "team-member")
          updateMember(state, form.dataset.id, values);
        else if (kind === "department")
          saveDepartment(state, form.dataset.id, values);
        else saveTeamSettings(state, values);
        render();
        persist();
        toast(
          kind === "signup"
            ? `${profile().name}와 함께 시작해요. ${isTeamLead(state) ? "팀장" : "팀원"} 화면을 준비했어요.`
            : "변경 내용을 저장했어요.",
        );
      } catch (error) {
        const output = form.querySelector("[data-team-error]");
        if (output) output.textContent = error.message;
      }
      return;
    }
    if (kind === "new-conversation" && modal) {
      createConversation(modal.key, values.title);
      closeModal();
      render();
      persist();
      toast("나만 보는 새 대화를 만들었어요");
      return;
    }
    if (kind === "conversation-access" && modal) {
      const c = state.conversations.find(
        (c) => c.id === modal.id && c.owner === state.user,
      );
      if (
        !c ||
        taskBy(c.taskId)?.workflow ||
        !["private", "department", "team"].includes(values.visibility)
      )
        return;
      c.visibility = values.visibility;
      closeModal();
      render();
      persist();
      toast("이 대화의 공개 범위를 바꿨어요. 개인 기억은 포함되지 않아요.");
      return;
    }
    if (kind === "publish-skill" && modal) {
      const skill = skillBy(modal.id),
        actor = actorBy(modal.agent);
      if (!canPublishSkill(state, skill)) return;
      const version = nextVersion(skill.version);
      state.skillOverrides[skill.id] = {
        ...state.skillOverrides[skill.id],
        version,
        desc: values.desc,
      };
      const apply = canEditBinding(state, actor.id);
      if (apply) {
        actor.skillPins[skill.id] = version;
        actor.configVersion += 1;
      }
      if (skill.scope === "team")
        auditTeam(
          state,
          "공용 스킬 게시",
          `${skill.name} v${version}를 게시했어요.`,
        );
      closeModal();
      render();
      persist();
      toast(
        `v${version}를 게시했어요. ${apply ? actor.name + "의 다음 실행부터 적용돼요." : "에이전트 적용은 설정 담당자가 결정해요."}`,
      );
      return;
    }
    if (kind === "chat") {
      const key = form.dataset.key,
        threadId = conversationIdFor(key),
        message = values.message;
      if (!message) return;
      const linkedTask = taskBy(conversationFor(key)?.taskId);
      if (linkedTask?.workflow) {
        linkedTask.discussion.push({ author: profile().owner, text: message });
        state.drafts[threadId] = "";
        goTask(linkedTask.id);
        state.taskTab = "discussion";
        render();
        persist();
        return;
      }
      const a = state.agents.find((a) => a.id === key),
        name = a?.name || profile().name;
      state.messages[threadId] = [
        ...(state.messages[threadId] || []),
        { author: profile().owner, kind: "user", text: message },
      ];
      state.drafts[threadId] = "";
      const rememberPattern =
        /(?:이건\s*)?기억해(?:\s*(?:주세요|줘|두세요|둬요?|요))?[.!。]*\s*$/;
      if (
        rememberPattern.test(message) &&
        !/[?？]\s*$/.test(message) &&
        message.replace(rememberPattern, "").trim()
      ) {
        const text = message.replace(rememberPattern, "").trim();
        const item = newMemory({
          ...memoryScopeForConversation(
            conversationFor(key),
            state.user,
            Boolean(a),
          ),
          title: text.slice(0, 45),
          text,
          evidence: message,
          source: `${name} · ${profile().owner}의 대화`,
        });
        state.messages[threadId].push({
          author: name,
          kind: "agent",
          text: `${name}의 기억에 남겼어요. 다음에는 이 기억을 찾아서 이어갈 수 있어요. (목업 응답)`,
          memoryId: item.id,
        });
        recallResult = null;
        render();
        persist();
      } else if (
        /기억|전에|지난|어떻게.*했|규칙|선호|기준|보고\s?방식/.test(message)
      ) {
        const recall = recallMemories(key, message);
        state.messages[threadId].push({
          author: name,
          kind: "agent",
          text:
            recallText(recall) + "\n\n(저장된 샘플 기억을 찾아 구성한 응답)",
          recall,
        });
        render();
        persist();
      } else if (/배포|검증|PR\s*#?\d|테스트/i.test(message)) {
        state.messages[threadId].push({
          author: name,
          kind: "agent",
          text: "배포 전 검증 스킬로 준비할게요. 대상과 공유 범위를 확인하면 개발 검토에서 QA까지 이어집니다. (목업 응답)",
        });
        render();
        persist();
        openModal("run", {
          id: a?.id === "dev" ? "bug" : "release",
          agent: key,
          target: message,
        });
      } else if (/안녕|반가워|누구|뭘.*해/.test(message)) {
        state.messages[threadId].push({
          author: name,
          kind: "agent",
          text: `안녕하세요, ${profile().owner}님. 저는 ${name}예요. 장착된 스킬로 업무를 처리하고, 팀 에이전트에게 필요한 일을 이어줄 수 있어요. 아래 업무 버튼을 눌러보세요. (목업 응답)`,
        });
        render();
        persist();
      } else {
        state.messages[threadId].push({
          author: name,
          kind: "agent",
          text: "요청을 작업으로 정리해서 진행할 수 있어요. 아래 버튼에서 업무 대상과 공유 범위를 확인해주세요. (목업 응답)",
          action: "task",
          target: message,
        });
        render();
        persist();
      }
    } else if (kind === "memory-recall") {
      state.recallQuery = values.question;
      recallResult = recallMemories(form.dataset.key, values.question);
      render();
      persist();
    } else if (kind === "request" && modal?.type === "request") {
      if (
        !values.target ||
        !actorBy(values.agent) ||
        !skillsFor(values.agent).some((s) => s.id === values.skill)
      )
        return;
      modal.agent = values.agent;
      modal.id = values.skill;
      createTask(values);
    } else if (kind === "run" && modal) {
      if (!values.target) {
        modalLayer.querySelector("#g-form-error").textContent =
          "업무 대상을 입력해주세요.";
        return;
      }
      createTask(values);
    } else if (kind === "resume") {
      const t = taskBy(form.dataset.id);
      if (!t || t.status !== "needs_input" || !canOperateTask(state, t)) return;
      t.decision = values.decision;
      log(t, `${profile().owner}가 「${values.decision}」 범위를 선택했어요.`);
      t.discussion.push({
        author: profile().owner,
        text: `검증 범위: ${values.decision}. 이 범위로 이어서 진행해주세요.`,
      });
      start(t);
      toast("답변을 남겼어요. 동료가 업무를 이어갑니다.", {
        label: "업무 보기",
        task: t.id,
      });
    } else if (kind === "task-comment") {
      const t = taskBy(form.dataset.id);
      if (!t || !values.comment) return;
      t.discussion.push({ author: profile().owner, text: values.comment });
      log(t, `${profile().owner}가 작업방에 추가 맥락을 남겼어요.`);
      render();
      persist();
      toast("작업방에 맥락을 남겼어요");
    } else if (kind === "character" && modal) {
      if (!canManageActor(state, modal.key)) return;
      const target = actorBy(modal.key);
      if (
        !target ||
        !characters.some((c) => c.id === values.character) ||
        !values.personality ||
        !values.catchphrase
      )
        return;
      Object.assign(target, {
        character: values.character,
        personality: values.personality,
        catchphrase: values.catchphrase,
      });
      closeModal();
      render();
      persist();
      toast("캐릭터와 성격을 적용했어요");
    } else if (kind === "skills-assignment" && modal) {
      if (!canEditBinding(state, modal.agent)) return;
      const target =
        state.agents.find((a) => a.id === modal.agent) || profile();
      target.skills = data.getAll("skills");
      target.skills.forEach((id) => {
        target.skillPins[id] ||= skillBy(id).version;
      });
      target.configVersion += 1;
      if (target.id)
        auditTeam(
          state,
          "공용 스킬 장착 변경",
          `${target.name}의 스킬 구성을 저장했어요.`,
        );
      closeModal();
      render();
      persist();
      toast("장착 스킬을 적용했어요");
    } else if (kind === "settings") {
      if (!values.name || !values.role || !values.instruction) {
        modalLayer.querySelector("#g-form-error").textContent =
          "비서 이름, 업무 역할과 업무 방식을 입력해주세요.";
        return;
      }
      const isTeam = modal?.type === "agent-settings";
      if (isTeam && !canManageActor(state, modal.id)) return;
      const target = isTeam
        ? state.agents.find((a) => a.id === modal.id)
        : profile();
      target.runtime = RUNTIMES[values.runtime]
        ? values.runtime
        : target.runtime;
      target.configVersion += 1;
      Object.assign(target, {
        name: values.name,
        role: values.role,
        color: values.color || "blue",
        style: values.style,
        harness: values.harness,
        instruction: values.instruction,
        skills: data.getAll("skills"),
      });
      target.skills.forEach((id) => {
        target.skillPins[id] ||= skillBy(id).version;
      });
      if (isTeam) {
        target.note = values.instruction;
        target.department =
          departments.find((d) => d.name === values.department)?.id ||
          target.department;
        state.department = target.department;
        state.collapsedDepartments = state.collapsedDepartments.filter(
          (d) => d !== target.department,
        );
        auditTeam(
          state,
          "공용 동료 설정",
          `${target.name}의 역할·부서·실행 프로필을 저장했어요.`,
        );
      }
      closeModal();
      render();
      persist();
      toast(
        isTeam
          ? "팀 에이전트 설정을 저장했어요"
          : "개인 비서 설정을 저장했어요",
      );
    } else if (kind === "memory" && modal) {
      if (!values.title || !values.text || !values.source) {
        modalLayer.querySelector("#g-form-error").textContent =
          "제목, 내용과 출처를 입력해주세요.";
        return;
      }
      const old = state.memories.find((m) => m.id === modal.id),
        key = modal.key || memoryActor(),
        actor = actorBy(key) || profile(),
        sourceTask = modal.sourceTaskId ? taskBy(modal.sourceTaskId) : null,
        scope = sourceTask
          ? scopeForTaskMemory(sourceTask)
          : old?.scope || values.scope;
      if (old && !canReadMemory(old)) return;
      if (!["personal", "agent", "department", "team"].includes(scope)) return;
      if (
        ["agent", "department"].includes(scope) &&
        !actor.id &&
        !old &&
        !sourceTask
      )
        return;
      const data = {
        scope,
        ...(scope === "personal" && modal.agentMemoryKey
          ? {
              agentId: modal.agentMemoryKey,
              conversationId: modal.privateConversationId,
            }
          : {}),
        owner:
          old?.owner ||
          (scope === "team"
            ? "team"
            : scope === "department"
              ? sourceTask?.department || actor.department
              : scope === "agent"
                ? key
                : state.user),
        kind: values.kind,
        title: values.title,
        text: values.text,
        source: values.source,
        evidence: values.text,
        at: new Date().toLocaleDateString("sv-SE"),
        updated: profile().owner,
      };
      const item = old
        ? {
            ...old,
            ...data,
            version: old.version + 1,
            history: [
              ...old.history,
              {
                version: old.version,
                title: old.title,
                text: old.text,
                source: old.source,
                evidence: old.evidence || old.text,
                at: old.at,
              },
            ],
          }
        : newMemory(data);
      const returnView = modal.returnView;
      if (old)
        state.memories = state.memories.map((m) =>
          m.id === old.id ? item : m,
        );
      if (!returnView || returnView === "memory") {
        state.memoryScope = scope;
        state.memoryAgent =
          scope === "personal"
            ? state.user
            : actor.id
              ? key
              : state.memoryAgent;
      }
      state.view = returnView || "memory";
      recallResult = null;
      closeModal();
      render();
      persist();
      toast(
        old
          ? `v${item.version}로 바로잡았어요. 이전 기록도 남아 있어요.`
          : "기억을 저장했어요",
      );
    } else if (kind === "create-skill" && modal) {
      if (
        !canEditBinding(state, modal.agent || state.user) ||
        (values.scope === "팀 공용 스킬" && !canEditTeamSkills(state))
      )
        return;
      if (!values.name || !values.desc || !values.done || !values.input) {
        modalLayer.querySelector("#g-form-error").textContent =
          "스킬 이름, 설명, 입력 항목과 완료 기준을 채워주세요.";
        return;
      }
      const id = `custom-${Date.now()}`,
        target = state.agents.find((a) => a.id === modal.agent) || profile(),
        memory = state.memories.find((m) => m.id === modal.memoryId);
      state.customSkills.push({
        id,
        name: values.name,
        desc: values.desc,
        icon: "workflow",
        version: "1.0",
        role: "personal",
        input: values.input,
        example: "이번에 처리할 업무 대상을 입력하세요",
        tools: "장착한 비서의 허용 도구",
        done: values.done,
        stages: [
          "요청 정리",
          "맥락 확인",
          "업무 수행",
          "결과 검토",
          "결과 정리",
        ],
        ask: false,
        scope:
          target.id || values.scope === "팀 공용 스킬" ? "team" : "personal",
        owner: state.user,
      });
      target.skills.push(id);
      target.skillPins[id] = "1.0";
      target.configVersion += 1;
      if (memory) memory.skillId = id;
      closeModal();
      if (target.id) {
        state.agent = target.id;
        state.agentTab = "skills";
        state.view = "agent";
      } else state.view = "skills";
      state.search = "";
      render();
      persist();
      toast(`스킬을 만들고 ${target.name}에게 장착했어요`);
    }
  });
  initializeModel();
  initializeWorkflows(state);
  ensureOfficeJobs();
  state.tasks.forEach((t) => ensureRun(t));
  syncOfficeJobs(true);
  const entry = new URLSearchParams(location.search);
  if (state.members[entry.get("persona")])
    switchMember(state, entry.get("persona"));
  if (["signup", "home", "admin"].includes(entry.get("screen")))
    state.view = entry.get("screen");
  if (entry.has("persona") || entry.has("screen"))
    history.replaceState(null, "", location.pathname);
  function restoreRoute() {
    const match = location.hash.match(/^#\/tasks\/([^/]+)$/);
    if (match) {
      let id;
      try {
        id = decodeURIComponent(match[1]);
      } catch {
        id = "";
      }
      if (taskBy(id)) {
        state.view = "work";
        state.filter = "all";
        state.task = id;
        state.taskTab = "progress";
      } else {
        state.view = "office";
        toast(
          "이 업무를 찾거나 열람할 수 없어요. 목업 기록은 브라우저별로 보관됩니다.",
        );
      }
    } else if (location.hash === "#/intake") {
      state.view = "intake";
      state.intakeStep = "input";
    } else if (!location.hash)
      state.view = state.view === "work" ? "office" : state.view;
  }
  window.addEventListener("popstate", () => {
    restoreRoute();
    render();
    persist();
  });
  restoreRoute();
  render();
  persist();
  scheduleOffice();
})();
