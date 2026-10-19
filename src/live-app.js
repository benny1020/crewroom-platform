import { requestContract } from "./request-contract.js";
import { workroomState } from "./workroom-state.js";
import { officeStation, agentTask, stationMode } from "./office-station.js";
import "./styles.css";
import "./refinements.css";
import "./team.css";
import "./workflow.css";
import "./live.css";
import { createIcons } from "lucide";
import { appIcons } from "./icons.js";
import {
  characters,
  departments,
  defaultAgents,
  defaultPersonas,
} from "./data.js";

const root = document.getElementById("gyeot-demo"),
  frame = root.querySelector("#gyeot-frame"),
  notice = root.querySelector("#gyeot-notice"),
  modal = root.querySelector("#gyeot-modal");
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
const button = (text, action, extra = "", primary = false, glyph = "") =>
  `<button type="button" class="g-button ${primary ? "g-primary" : ""}" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ""}${text}</button>`;
const statusName = {
  queued: "실행 대기",
  running: "작업 중",
  paused: "재개 대기",
  result_ready: "결과 확인 대기",
  done: "수용 완료",
  failed: "확인 필요",
  cancelled: "중단됨",
};
const scopeName = { private: "나만", department: "부서 공유", team: "팀 공유" };
const memoryKindName = {
  fact: "사실",
  decision: "결정",
  preference: "선호",
  procedure: "업무 규칙",
};
const stamp = (v) =>
  new Date(v).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const pill = (t) =>
  `<span class="g-pill ${t.status === "running" ? "blue" : ["failed", "paused", "result_ready"].includes(t.status) ? "amber" : t.status === "done" ? "green" : ""}"><span class="g-dot"></span>${statusName[t.status] || esc(t.status)}</span>`;
let archiveResults = [];
let selectedAgent = "dev",
  workFilter = "all",
  motionOff = false;
let workspace = null,
  session = null,
  task = null,
  eventStream = null,
  connection = "연결 중",
  refreshing = false,
  pendingRefresh = false,
  deferred = false,
  dialog = null,
  busy = false;
let sessionGeneration = 0,
  refreshId = 0;
const requests = new Set();
const drafts = new Map();
const stale = () =>
  Object.assign(new Error("Session changed"), { code: "STALE_SESSION" });
const silent = (error) =>
  ["STALE_SESSION", "AbortError"].includes(error.code || error.name);
function clearSession() {
  sessionGeneration++;
  refreshId++;
  for (const controller of requests) controller.abort();
  requests.clear();
  eventStream?.close();
  eventStream = null;
  session = null;
  workspace = null;
  task = null;
  dialog = null;
  refreshing = false;
  pendingRefresh = false;
  deferred = false;
  selectedAgent = "dev";
  workFilter = "all";
  drafts.clear();
  archiveResults = [];
  modal.innerHTML = "";
  frame.removeAttribute("inert");
}

const draftKey = (form) =>
  form.dataset.form +
  (form.dataset.form === "agent-chat"
    ? ":" + form.dataset.agent
    : ["message", "question-create", "question-answer"].includes(
          form.dataset.form,
        )
      ? ":" + task?.id + ":" + (form.dataset.id || "")
      : "");
const person = (id) =>
  workspace?.members.find((m) => m.id === id)?.name || "팀원";
const agent = (id) => workspace?.agents.find((a) => a.id === id);
const route = () => location.hash.slice(2).split("/").filter(Boolean);
const field = (label, name, value = "", type = "text", extra = "") =>
  `<label class="g-field"><span>${label}</span><input class="g-input" type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`;
const area = (label, name, value = "", extra = "") =>
  `<label class="g-field"><span>${label}</span><textarea class="g-input" name="${name}" ${extra}>${esc(value)}</textarea></label>`;
const options = (rows, value) =>
  rows
    .map(
      ([id, label]) =>
        `<option value="${esc(id)}" ${String(id) === String(value) ? "selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
const select = (label, name, rows, value) =>
  `<label class="g-field"><span>${label}</span><select class="g-input" name="${name}" aria-label="${esc(label)}">${options(rows, value)}</select></label>`;
const scopes = (value) =>
  select("공개 범위", "visibility", Object.entries(scopeName), value);
function portrait(a, big = false) {
  const fallback = defaultAgents.find((x) => x.id === a?.id),
    personality = defaultPersonas[fallback?.id];
  const index = [
    "chief",
    "research",
    "dev",
    "review",
    "ops",
    "release-ops",
    "qa",
    "test-design",
  ].indexOf(a?.id);
  const character =
    characters.find((c) => c.id === a?.character) ||
    characters[index < 0 ? 8 : index];
  return `<span class="g-avatar g-character ${big ? "g-big" : ""}" aria-hidden="true"><span class="g-character-portrait" style="background-position:${character.x}% ${character.y}%"></span></span>`;
}
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const generation = sessionGeneration,
    controller = new AbortController();
  requests.add(controller);
  try {
    const response = await fetch(`/api${path}`, {
      method,
      signal: controller.signal,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" && session
          ? { "x-csrf-token": session.csrfToken }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (generation !== sessionGeneration) throw stale();
    if (!response.ok) {
      if (response.status === 401 && session) {
        clearSession();
        render();
      }
      throw Object.assign(
        new Error(value.message || "요청을 처리하지 못했어요."),
        { code: value.code, status: response.status },
      );
    }
    return value;
  } finally {
    requests.delete(controller);
  }
}
let toastTimer;
function toast(message) {
  notice.innerHTML = `<div class="g-toast" role="status">${esc(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (notice.innerHTML = ""), 4000);
}
function navigate(path) {
  if (location.hash === `#/${path}`) load(true);
  else location.hash = `#/${path}`;
}
async function load(force = false) {
  if (!session) return;
  if (refreshing) {
    pendingRefresh ||= force;
    return;
  }
  refreshing = true;
  const generation = sessionGeneration,
    id = ++refreshId;
  try {
    const next = await api("/workspace");
    const [page, taskId] = route(),
      nextTask =
        page === "tasks" && taskId
          ? (await api(`/tasks/${encodeURIComponent(taskId)}`)).task
          : null;
    const proposals =
      page === "memory" ? (await api("/memory/proposals")).items : [];
    if (generation !== sessionGeneration || id !== refreshId) throw stale();
    const ops =
      page === "admin" && next.user.role === "lead"
        ? await api("/admin/operations")
        : null;
    if (generation !== sessionGeneration || id !== refreshId) throw stale();
    workspace = next;
    workspace.operations = ops;
    workspace.memoryProposals = proposals;
    session.user = next.user;
    task = nextTask;
    if (force || (!document.activeElement?.closest("form") && !dialog)) {
      deferred = false;
      render();
    } else {
      deferred = true;
      frame.querySelector("[data-live-refresh]")?.removeAttribute("hidden");
    }
  } catch (error) {
    if (silent(error)) return;
    if (error.status !== 401) toast(error.message);
    if (error.status === 404) {
      task = null;
      render();
    }
  } finally {
    if (generation === sessionGeneration && id === refreshId) {
      refreshing = false;
      if (pendingRefresh) {
        pendingRefresh = false;
        queueMicrotask(() => load(true));
      }
    }
  }
}
function connect() {
  eventStream?.close();
  const generation = sessionGeneration;
  eventStream = new EventSource("/api/events");
  eventStream.onopen = () => {
    if (generation !== sessionGeneration) return;
    connection = "실시간 연결";
    frame
      .querySelector("[data-connection]")
      ?.replaceChildren(document.createTextNode(connection));
  };
  eventStream.addEventListener("refresh", () => {
    if (generation === sessionGeneration) load();
  });
  eventStream.onerror = () => {
    if (generation !== sessionGeneration) return;
    connection = "재연결 중";
    frame
      .querySelector("[data-connection]")
      ?.replaceChildren(document.createTextNode(connection));
  };
}
function loginView() {
  return `<section class="cr-login"><div class="cr-login-story"><span class="g-brand-mark">C</span><h1>같은 동료, 같은 맥락.</h1><p>우리 팀이 함께 쓰는 에이전트.<br>업무와 기억, 결과를 한곳에서 이어가세요.</p><div class="cr-login-crew">${[0, 2, 4, 6].map((i) => portrait({ id: defaultAgents[i].id }, true)).join("")}</div><span class="cr-kicker">CREWROOM · TEAM WORKSPACE</span></div><div class="cr-login-form"><h2>우리 팀으로 들어가기</h2><p class="g-muted">운영 담당자가 발급한 팀 계정으로 로그인하세요.</p><form data-form="login">${field("이메일", "email", "", "email", 'required autocomplete="username" maxlength="254"')}${field("비밀번호", "password", "", "password", 'required autocomplete="current-password" maxlength="128"')}<p class="g-error" role="alert" data-error></p><button type="submit" class="g-button g-primary">로그인 ${icon("arrow-right")}</button></form><p class="cr-login-note">같은 팀 안에서 권한에 따라 업무를 공유합니다. 개인 비서의 대화와 기억은 본인만 볼 수 있어요.</p></div></section>`;
}
function layout(content) {
  const [page] = route(),
    u = workspace.user;
  return `<header class="cr-top"><a class="g-brand" href="#/office"><span class="g-brand-mark">C</span><span class="g-brand-name">크루룸</span></a><span class="cr-team-label">우리 팀 <span class="g-pill green">서버 연결됨</span></span><div class="cr-top-actions"><span data-connection>${connection}</span>${button("새 업무", "navigate", 'data-path="intake"', true, "plus")}<span>${esc(u.name)} / ${u.role === "lead" ? "팀장" : "팀원"}</span>${button("비밀번호 변경", "password")}${button("로그아웃", "logout", "", false, "log-out")}</div></header><div class="cr-layout"><aside class="cr-sidebar"><span class="cr-kicker">워크스페이스</span>${[["office", "panels-top-left", "팀 오피스"], ["inbox", "inbox", "내가 할 일"], ["work", "layers", "공유 업무"], ["memory", "bookmark", "기억 보관함"], ["skills", "blocks", "스킬 라이브러리"], ...(u.role === "lead" ? [["admin", "settings-2", "팀 관리"]] : [])].map(([id, glyph, label]) => `<a class="cr-nav ${page === id ? "selected" : ""}" href="#/${id}">${icon(glyph)}${label}</a>`).join("")}<div class="cr-side-roster"><span class="cr-kicker">공용 에이전트</span>${departments
    .map(
      (d) =>
        `<div class="cr-side-dept">${icon(d.icon)}${d.name}</div>${workspace.agents
          .filter((a) => !a.owner_id && a.department === d.id)
          .map(
            (a) =>
              `<a class="cr-side-agent" href="#/agents/${a.id}">${portrait(a)}<span><strong>${esc(a.name)}</strong><small>${esc(a.role)}</small></span></a>`,
          )
          .join("")}`,
    )
    .join(
      "",
    )}</div><a class="cr-side-agent cr-personal" href="#/agents/personal-${u.id}">${portrait({})}<span><strong>나의 비서</strong><small>개인 대화와 기억</small></span>${icon("lock-keyhole")}</a></aside><main class="cr-main"><div class="cr-live-notice"><span>${icon("radio")} ${workspace.runtime.fixture ? "통합 테스트 실행기 · 실제 AI 미연결" : workspace.runtime.codeExecution ? "코드 수정·QA 실행 가능 · 저장소 반영은 사람이 확인" : "분석·협업 모드 · 코드 실행 미연결"}</span><button class="g-text-button" data-action="refresh" data-live-refresh ${deferred ? "" : "hidden"}>새 변경 확인 ${icon("refresh-cw")}</button></div>${content}</main></div>`;
}
function heading(title, sub, actions = "") {
  return `<div class="g-page-head"><div><h1>${title}</h1><p class="g-page-sub">${sub}</p></div>${actions}</div>`;
}
function taskRow(t) {
  return `<a class="cr-work-row" href="#/tasks/${t.id}"><span class="cr-work-number">W-${t.number}</span><div><strong>${esc(t.title)}</strong><small>${esc(t.target_version)} · ${esc(person(t.responsible_id))} 책임 · ${scopeName[t.visibility]}</small></div>${pill(t)}${icon("chevron-right")}</a>`;
}
function officeView() {
  const tasks = workspace.tasks,
    shared = workspace.agents.filter((a) => !a.owner_id),
    mine = tasks.filter(
      (t) =>
        t.responsible_id === workspace.user.id &&
        ["result_ready", "failed", "paused"].includes(t.status),
    ),
    a = shared.find((a) => a.id === selectedAgent) || shared[0],
    selected = a && agentTask(tasks, a.id);
  return (
    heading(
      "함께 일하는 오피스",
      "동료를 고르면 이어갈 업무와 스킬이 함께 열려요.",
      button(
        motionOff ? "모션 꺼짐" : "모션 켜짐",
        "motion",
        `aria-pressed="${!motionOff}"`,
        false,
        "sparkles",
      ),
    ) +
    `<section class="cw-desk"><div class="cw-desk-intro"><span class="cw-desk-symbol">${icon("git-pull-request")}</span><div><h2>어떤 일을 함께 이어갈까요?</h2><p>새 업무를 맡기거나, 동료가 남긴 결과에서 이어가세요.</p></div></div><div class="cw-actions">${button("새 업무 시작", "navigate", 'data-path="intake"', true, "plus")}${button("기존 결과 가져오기", "navigate", 'data-path="intake/import"', false, "file-check-2")}</div></section>
    ${mine.length ? `<section class="cr-attention"><h2>${icon("circle-help")} 내가 이어갈 일 <span>${mine.length}</span></h2>${mine.slice(0, 3).map(taskRow).join("")}</section>` : ""}
    <div class="cr-overview"><button class="g-text-button" data-action="work-filter" data-filter="running">${icon("activity")} 작업 중 <b>${tasks.filter((t) => t.status === "running").length}</b></button><button class="g-text-button" data-action="work-filter" data-filter="queued">${icon("clock")} 실행 대기 <b>${tasks.filter((t) => t.status === "queued").length}</b></button><button class="g-text-button" data-action="work-filter" data-filter="mine">${icon("circle-help")} 내가 확인할 일 <b>${mine.length}</b></button><small class="g-muted">열람 가능한 최근 업무 최대 200건</small></div>
    <div class="cr-office-layout"><div class="cr-rooms">${departments
      .map(
        (d) =>
          `<section class="cr-room"><header><h2>${icon(d.icon)} ${d.name}</h2><span>${d.description}</span></header><div class="cr-stations">${shared
            .filter((a) => a.department === d.id)
            .map((person) => {
              const t = agentTask(tasks, person.id);
              return officeStation({
                id: person.id,
                name: person.name,
                role: person.role,
                portrait: portrait(person, true),
                mode: stationMode(t?.status),
                label: t ? statusName[t.status] : "표시할 업무 없음",
                stage: t?.step_name,
                taskTitle: t?.title || "스킬을 골라 새 업무를 맡겨보세요.",
                selected: person.id === a?.id,
                motion: ["chief", "research", "review"].includes(person.id)
                  ? "read"
                  : "type",
              });
            })
            .join("")}</div></section>`,
      )
      .join("")}</div>
    <aside class="cr-office-side" aria-label="선택한 동료">${a ? `<div class="cr-office-person">${portrait(a, true)}<div><h2>${esc(a.name)}</h2><p>${esc(a.role)}</p></div></div>${selected ? `<div class="cr-selected-work">${pill(selected)}<h3>${esc(selected.title)}</h3><p>${esc(selected.step_name)} · ${esc(person(selected.responsible_id))} 책임</p><a class="g-button g-primary" href="#/tasks/${selected.id}">${["result_ready", "done"].includes(selected.status) ? "결과 확인" : selected.status === "failed" ? "실패 원인 확인" : "업무 이어가기"} ${icon("arrow-up-right")}</a></div>` : '<p class="cr-note">현재 목록에서 이 동료의 업무를 찾지 못했어요. 새 업무를 시작할 수 있습니다.</p>'}<a class="g-button" href="#/agents/${a.id}">${icon("message-circle")} ${esc(a.name)}에게 말 걸기</a><section class="cr-office-skills"><h3>스킬로 바로 요청</h3>${a.skills.map((b) => `<button class="cr-skill-trigger" data-action="use-skill" data-agent="${a.id}" data-skill="${esc(b.skillId)}"><span>${esc(workspace.skills.find((s) => s.id === b.skillId)?.name || b.skillId)}<small>적용 v${b.version}</small></span>${icon("arrow-up-right")}</button>`).join("") || '<p class="g-muted">적용한 스킬이 없습니다.</p>'}</section><p class="cr-note">실제 서버 상태를 표시합니다. 모션을 꺼도 업무 상태와 다음 행동을 확인할 수 있어요.</p>` : ""}</aside></div>`
  );
}
function beginSkillRequest(agentId, skillId, values = {}) {
  const contract = requestContract(skillId);
  if (contract === "chat") {
    drafts.set("agent-chat:" + agentId, {
      skillId,
      goal: values.goal || "",
      visibility: values.visibility || "team",
    });
    navigate("agents/" + agentId);
    return;
  }
  if (contract === "handoff") {
    workFilter = "all";
    toast(
      "독립 QA는 코드 수정 업무에서 같은 수정본을 인계받아 실행해요. 해당 업무를 선택해주세요.",
    );
    navigate("work");
    return;
  } else
    drafts.set("intake", {
      workType: contract,
      agentId,
      skillId,
      goal: values.goal || "",
      visibility: values.visibility || "team",
    });
  navigate("intake");
}
function inboxView() {
  const mine = workspace.questions.filter(
    (q) => q.assignee_id === workspace.user.id,
  );
  const waiting = workspace.questions.filter(
    (q) =>
      q.responsible_id === workspace.user.id &&
      q.assignee_id !== workspace.user.id,
  );
  const results = workspace.tasks.filter(
    (t) =>
      t.responsible_id === workspace.user.id &&
      ["result_ready", "failed", "paused"].includes(t.status),
  );
  const rows = (items) =>
    items
      .map(
        (q) =>
          `<a class="cr-inbox-question" href="#/tasks/${q.task_id}"><span>${icon("circle-help")}<strong>${esc(q.prompt)}</strong><small>W-${q.number} · ${esc(q.title)} · ${esc(person(q.assignee_id))} 답변</small></span>${icon("arrow-up-right")}</a>`,
      )
      .join("") || '<p class="cr-empty-inline">기다리는 질문이 없어요.</p>';
  return (
    heading("내가 할 일", "답할 질문과 확인할 결과에서 바로 이어가세요.") +
    `<div class="cr-inbox-grid"><section class="cw-paper"><h2>내가 답할 질문 ${mine.length}</h2>${rows(mine)}</section><section class="cw-paper"><h2>내 업무의 답변 대기 ${waiting.length}</h2>${rows(waiting)}</section></div><section class="cw-paper cr-inbox-results"><h2>확인하거나 이어갈 결과 ${results.length}</h2>${results.map(taskRow).join("") || '<p class="cr-empty-inline">지금 확인할 결과가 없어요.</p>'}<p class="cr-note">질문은 열람 가능한 최근 100건, 업무는 최근 200건을 표시합니다.</p></section>`
  );
}
function handoffCard(t, state) {
  const current = state.current;
  return `<section class="cr-handoff-card" aria-label="현재 인계 요약"><div class="cw-section-heading"><h2>지금 이어받을 내용</h2>${pill(t)}</div><dl><div><dt>현재 단계</dt><dd>${esc(t.steps[t.step_index].name)}</dd></div><div><dt>사람 책임자</dt><dd>${esc(person(t.responsible_id))}</dd></div><div><dt>유효한 결과</dt><dd>${current ? "결과 v" + current.version : "아직 없음"}</dd></div><div><dt>대상 버전</dt><dd>${esc(t.target_version)}</dd></div></dl>${t.rework ? `<div class="cr-rework-note"><strong>이번 재작업 지시</strong><p>${esc(t.rework.reason)}</p><small>기준 결과 ${t.rework.previous ? "v" + (t.artifacts.find((a) => a.id === t.rework.previous.artifactId)?.version || "이전") + " · " + esc(t.rework.previous.targetVersion) : "없음"} · 이전 검사·승인은 새 결과의 증거가 아닙니다.</small></div>` : ""}${state.pending.length ? `<p class="cr-input-warning">답변 ${state.pending.length}건을 기다립니다. 답변을 받거나 질문을 닫은 뒤 진행하세요.</p>` : ""}${current && !state.answersApplied ? '<p class="cr-input-warning">새 답변이 아직 이 결과에 반영되지 않았어요. 재작업으로 새 실행을 준비해주세요.</p>' : ""}${current ? `<div class="cr-handoff-columns"><div><h3>아직 확인할 것</h3>${shortList(current.result.unknowns)}</div><div><h3>다음 행동</h3>${shortList(current.result.nextActions)}</div></div><small>결과 준비는 업무 완료가 아닙니다. 아래 근거를 확인하고 수용 또는 재작업을 선택하세요.</small>` : "<p>현재 대상과 단계의 결과가 준비되면 미확인 사항과 다음 행동을 함께 보여줘요.</p>"}</section>`;
}
function shortList(rows) {
  return `<ul>${
    (rows || [])
      .slice(0, 3)
      .map((v) => `<li>${esc(v.length > 220 ? v.slice(0, 220) + "…" : v)}</li>`)
      .join("") || "<li>기록 없음 · 확인 범위를 직접 살펴보세요.</li>"
  }</ul>`;
}
function resultComparison(current, previous) {
  if (!previous) return "";
  const changed = ["summary", "evidence", "unknowns", "nextActions"].filter(
    (key) =>
      JSON.stringify(current.result[key]) !==
      JSON.stringify(previous.result[key]),
  );
  return `<details class="cr-result-compare"><summary>이전 결과와 비교 · ${changed.length ? "달라진 항목 " + changed.length + "개" : "공통 보고 항목의 차이 없음"}</summary><p class="cr-note">같은 단계의 결과 v${previous.version} (${esc(previous.target_version)})와 v${current.version} (${esc(current.target_version)})를 비교합니다. 문구 차이는 수정 지시 충족이나 검사 성공의 판정이 아닙니다.</p><div class="cr-compare-columns"><div><h3>이전 요약</h3><p>${esc(previous.result.summary)}</p></div><div><h3>이번 요약</h3><p>${esc(current.result.summary)}</p></div></div><p>변경된 보고 항목: ${changed.map((k) => ({ summary: "요약", evidence: "근거", unknowns: "미확인", nextActions: "다음 행동" })[k]).join(", ") || "없음"}</p></details>`;
}
function questionsView(t, operator, members, run) {
  const editable =
    operator &&
    ["queued", "result_ready", "failed"].includes(t.status) &&
    !run?.lease_owner &&
    !["queued", "running", "paused"].includes(run?.status);
  const rows = (t.questions || [])
    .map(
      (q) =>
        `<article class="cr-question" data-question="${q.id}"><div class="cw-section-heading"><h3>${esc(q.prompt)}</h3><span class="g-pill ${q.status === "pending" ? "amber" : ""}">${{ pending: "답변 대기", answered: "답변 저장", closed: "닫힘", superseded: "대상 변경으로 대체됨" }[q.status]}</span></div><p class="g-small g-muted">${esc(person(q.assignee_id))} 답변 · 대상 ${esc(q.target_version)}</p>${q.answer ? `<blockquote>${esc(q.answer)}</blockquote>` : ""}${q.status === "pending" && q.assignee_id === workspace.user.id ? `<form data-form="question-answer" data-id="${q.id}" data-revision="${q.revision}">${area("답변", "answer", "", 'required maxlength="1000"')}<button class="g-button g-primary" type="submit">답변 저장</button><p data-error class="g-error"></p></form>` : ""}${
          q.status === "pending" && operator
            ? `<details><summary>답변 담당 변경·질문 닫기</summary><form class="cr-inline-form" data-form="question-assign" data-id="${q.id}" data-revision="${q.revision}">${select(
                "답변 담당",
                "assigneeId",
                members.map((m) => [m.id, m.name]),
                q.assignee_id,
              )}<button type="submit" class="g-button">답변 담당 변경</button><p data-error class="g-error"></p></form>${button("질문 닫기", "question-close", `data-id="${q.id}" data-revision="${q.revision}"`)}</details>`
            : ""
        }</article>`,
    )
    .join("");
  return `<section class="cw-paper cr-questions" aria-label="업무 질문"><h2>확인할 질문과 답변</h2><p class="cr-note">업무를 볼 수 있는 구성원에게 질문합니다. 답변은 다음 새 실행에 반영하며, 이미 만든 결과에는 재작업이 필요해요. 대상 버전마다 최대 5개를 기록합니다.</p>${rows || '<p class="cr-empty-inline">남긴 질문이 없습니다.</p>'}${
    editable
      ? `<details><summary>담당자를 지정해 질문하기</summary><form data-form="question-create">${area("확인할 질문", "prompt", "", 'required maxlength="500"')}${select(
          "답할 사람",
          "assigneeId",
          members.map((m) => [m.id, m.name]),
          t.responsible_id,
        )}<button class="g-button" type="submit">질문 보내기</button><p class="g-error" data-error></p></form></details>`
      : ""
  }</section>`;
}
function intakeView(importing = false) {
  const d = drafts.get("intake") || {},
    chosen =
      d.skillId &&
      agent(d.agentId)?.skills.find((b) => b.skillId === d.skillId),
    example = d.exampleId
      ? workspace.tasks.find((t) => t.id === d.exampleTaskId)
      : null;
  return (
    heading(
      importing
        ? "선택한 결과를 함께 이어가요"
        : "대상을 알려주면, 동료가 이어갈게요",
      "업무와 결과는 선택한 공개 범위를 함께 사용합니다.",
    ) +
    `<div class="cw-intake-layout"><section class="cw-paper">${chosen ? `<div class="cr-request-summary"><strong>${esc(agent(d.agentId).name)} · ${esc(workspace.skills.find((s) => s.id === d.skillId)?.name)} v${chosen.version}</strong><p>${esc(chosen.doneCriteria)}</p><small>${d.workType === "code-qa" ? "개발 동료의 실제 수정·검사 후 독립 QA로 인계합니다." : "지정한 대상 자료를 분석합니다. 실제 코드 수정·검사를 실행하지 않습니다."}</small></div>` : ""}<form data-form="intake" data-importing="${importing}">${select(
      "필요한 결과",
      "workType",
      importing
        ? [["pr-qa", "가져온 검토 결과 → QA 계획"]]
        : chosen
          ? [
              [
                d.workType,
                d.workType === "code-qa"
                  ? "코드 수정 → 실제 QA 실행"
                  : "선택한 스킬로 대상 분석",
              ],
            ]
          : [
              ["code-qa", "코드 수정 → 실제 QA 실행"],
              ["pr-qa", "PR 검토 → QA 인계"],
              ["review", "PR 검토"],
              ["ops", "운영 점검"],
            ],
      d.workType || "pr-qa",
    )}${field("업무 대상 링크 또는 이름", "target", d.target || "", "text", 'required maxlength="500" placeholder="GitLab MR · GitHub PR 주소 또는 검토 대상"')}${field("대상 커밋 또는 관측 버전", "targetVersion", d.targetVersion || "", "text", 'required maxlength="80" placeholder="코드 실행: 전체 커밋 SHA (40자 또는 64자)"')}${field("프로젝트", "project", d.project || "우리 프로젝트", "text", 'required maxlength="80"')}${area("요청할 내용", "goal", d.goal || "", 'required maxlength="4000" placeholder="특히 확인할 범위와 원하는 결과를 알려주세요."')}${scopes(d.visibility || "team")}${importing ? area("공유할 결과 내용", "importBody", d.importBody || "", 'required maxlength="30000"') + field("결과 출처", "importSource", d.importSource || "", "text", 'required maxlength="500"') : ""}${example ? `<p class="cr-note">수용한 업무 W-${example.number}의 완료 기준과 형식을 참고합니다. 이전 대상·검사 결과·승인은 복사하지 않습니다.</p>` : ""}<p class="g-error" role="alert" data-error></p><button type="submit" class="g-button g-primary">공개 내용 확인 ${icon("arrow-right")}</button></form></section><aside class="cr-intake-guide"><div class="cr-guide-crew">${portrait(agent("review"), true)}${icon("arrow-right")}${portrait(agent("qa"), true)}</div><h2>같은 업무방에서 검토부터 QA까지</h2><p>입력과 스킬 버전을 고정해 결과를 남깁니다. 사람이 수용하면 업무가 완료됩니다.</p><div class="cr-note">코드 수정은 연결한 GitLab의 고정 커밋에서 시작합니다. 격리된 컨테이너에서 수정·등록 검사 후, 새 QA 컨테이너로 같은 수정본을 넘깁니다. PR 검토 유형은 읽기 전용 분석입니다.</div></aside></div>`
  );
}
function workView() {
  const rows = workspace.tasks.filter(
    (t) =>
      workFilter === "all" ||
      (workFilter === "mine"
        ? t.responsible_id === workspace.user.id &&
          ["failed", "paused", "result_ready"].includes(t.status)
        : t.status === workFilter),
  );
  return (
    heading(
      "함께 이어가는 업무",
      "요청·대화·결과를 하나의 업무방에서 확인하세요.",
      button("새 업무", "navigate", 'data-path="intake"', true, "plus"),
    ) +
    `<div class="cr-work-filters" aria-label="업무 필터">${[
      ["all", "전체"],
      ["mine", "내가 확인할 일"],
      ["running", "작업 중"],
      ["queued", "실행 대기"],
      ["failed", "실패"],
    ]
      .map(([id, label]) =>
        button(
          label,
          "work-filter",
          `data-filter="${id}" aria-pressed="${workFilter === id}"`,
          workFilter === id,
        ),
      )
      .join(
        "",
      )}</div><section class="cr-work-preview">${rows.map(taskRow).join("") || '<div class="g-empty">이 조건에 맞는 업무가 없어요. 전체 업무에서 확인하거나 새 업무를 시작하세요.</div>'}</section>`
  );
}
function resultView(a) {
  const r = a.result;
  return `<article class="cw-artifact"><div class="cw-section-heading"><h3>결과 v${a.version}</h3><span class="g-pill ${a.origin === "model" ? "blue" : "amber"}">${r.execution ? (r.execution.passed ? "실제 검사 통과" : "실제 검사 확인 필요") : a.origin === "model" ? "모델 분석" : a.origin === "external" ? "외부 작성 · 미검증" : "테스트 fixture"}</span></div><p class="cw-provenance">대상 ${esc(a.target_version)} · ${r.execution ? "고정 수정본의 실제 실행 기록" : "사실·실행 검증 미확인"}</p><p class="cw-artifact-body">${esc(r.summary)}</p>${[
    ["근거", r.evidence],
    ["미확인 사항", r.unknowns],
    ["다음 행동", r.nextActions],
  ]
    .map(
      ([title, rows]) =>
        `<div class="cr-result-section"><h3>${title}</h3><ul>${(rows || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>기록 없음</li>"}</ul></div>`,
    )
    .join(
      "",
    )}${executionView(a)}<div class="cw-evidence"><span>${a.run_id ? "실행 기록 연결됨" : "외부에서 가져옴 · 실행 없음"}</span><span>${stamp(a.created_at)}</span><a href="/api/artifacts/${a.id}">Markdown 다운로드 ${icon("download")}</a></div></article>`;
}
function taskView() {
  if (!task)
    return '<div class="g-empty">이 업무를 찾거나 열람할 수 없어요.</div>';
  const t = task,
    u = workspace.user,
    operator = t.responsible_id === u.id,
    manage = operator || (u.role === "lead" && t.visibility !== "private"),
    step = t.steps[t.step_index],
    run = t.runs.find((r) => r.id === t.current_run_id),
    state = workroomState(t),
    current = state.current,
    final = t.step_index === t.steps.length - 1;
  const cmd = (label, action, primary = false) =>
    button(
      label,
      "command",
      `data-command="${action}" data-revision="${t.revision}"`,
      primary,
    );
  let controls = "";
  if (operator && ["queued", "paused", "failed"].includes(t.status))
    controls += cmd(
      t.status === "paused" ? "저장한 입력으로 재개" : "실행 시작",
      "start",
      true,
    );
  if (operator && ["running", "queued"].includes(t.status) && run)
    controls += cmd("일시정지", "pause");
  if (
    operator &&
    current &&
    t.status === "result_ready" &&
    !state.pending.length &&
    state.answersApplied
  )
    controls += cmd(
      final ? "이 결과 수용" : "이 결과로 QA에 넘기기",
      final ? "accept" : "handoff",
      true,
    );
  if (
    operator &&
    ["result_ready", "done", "failed", "cancelled"].includes(t.status)
  )
    controls += button("재작업 요청", "rework", "", false, "rotate-ccw");
  if (!operator)
    controls += button(
      t.claims.some((c) => c.user_id === u.id)
        ? "인수 요청됨"
        : "업무 인수 요청",
      "command",
      `data-command="claim" data-revision="${t.revision}"`,
    );
  const readyMembers = workspace.members.filter(
    (m) =>
      m.active &&
      (t.visibility === "team" ||
        m.id === t.owner_id ||
        (t.visibility === "department" && m.department === t.department)),
  );
  return `<div class="cr-workroom-head"><a href="#/work" class="g-text-button">${icon("arrow-left")} 전체 업무</a><span>W-${t.number} · ${scopeName[t.visibility]}</span>${button("업무 링크 복사", "copy", "", false, "link")}${task.runs.length ? button("참고한 기억", "used-memory", "", false, "bookmark") : ""}</div>${heading(esc(t.title), `${esc(t.project)} · ${esc(person(t.owner_id))} 요청 / ${esc(person(t.responsible_id))} 책임`, pill(t))}<section class="cr-task-target"><span>대상</span><strong>${esc(t.target)}</strong><code>${esc(t.target_version)}</code></section><div class="cw-step-track">${t.steps.map((s, i) => `<div class="cw-step ${i === t.step_index ? "current" : ""}">${portrait(agent(s.agent_id))}<span><strong>${esc(s.agent_name)}</strong><small>${esc(s.name)} · ${i < t.step_index ? "인계됨" : i === t.step_index ? "현재 단계" : "대기"}</small></span>${i < t.steps.length - 1 ? icon("arrow-right") : ""}</div>`).join("")}</div><section class="cw-next"><div><span class="cw-small-label">다음 행동</span><strong>${state.pending.length ? "지정된 구성원의 답변을 확인해주세요" : current && !state.answersApplied ? "새 답변을 반영하도록 재작업해주세요" : t.status === "result_ready" ? (final ? "결과를 확인하고 수용 또는 재작업" : "검토 결과를 확인하고 QA로 인계") : t.status === "done" ? "수용한 결과를 다음 업무의 기준으로" : t.status === "failed" ? "실행 기록의 확인 필요 사항을 해결해주세요" : t.status === "running" ? "동료가 결과를 정리하고 있어요" : "요청한 입력으로 업무를 이어가세요"}</strong><span>${esc(person(t.responsible_id))} 책임 · ${esc(step.agent_name)} 담당</span></div><div class="cw-actions">${t.status === "result_ready" && state.current ? button("결과 살펴보기", "current-result", "", true, "arrow-right") : controls}</div></section>${run?.error_code ? `<div class="cr-run-error" role="status"><strong>${esc(run.error_message)}</strong><small>${esc(run.error_code)}</small>${run.lease_owner ? "<p>운영 담당자가 이전 Worker의 종료를 확인해야 새 실행이 가능합니다. 비공개 업무 본문을 공개할 필요는 없습니다.</p>" : ""}</div>` : ""}${
    manage
      ? `<details class="cw-owner"><summary>책임자 변경 ${t.claims.length ? `· 인수 요청 ${t.claims.length}건` : ""}</summary><form class="cr-inline-form" data-form="assign" data-revision="${t.revision}">${select(
          "현재 책임자",
          "responsibleId",
          readyMembers.map((m) => [
            m.id,
            m.name +
              (t.claims.some((c) => c.user_id === m.id) ? " · 인수 요청" : ""),
          ]),
          t.responsible_id,
        )}<button type="submit" class="g-button">담당 변경 기록</button><p class="g-error" data-error></p></form></details>`
      : ""
  }<div class="cr-workroom-grid"><div>${handoffCard(t, state)}${state.current ? `<section class="cr-current-result" aria-label="현재 결과">${resultView(state.current)}${resultComparison(state.current, state.previous)}<div class="cr-result-actions"><strong>근거와 미확인 사항을 확인한 뒤 결정하세요.</strong><div class="cw-actions">${controls}</div></div></section>` : '<div class="cw-paper cr-empty-inline">현재 단계와 대상에 맞는 결과가 아직 없습니다. 이전 결과는 아래 이력에서 볼 수 있어요.</div>'}${questionsView(t, operator, readyMembers, run)}<section class="cw-paper cr-brief"><div class="cw-section-heading"><h2>요청 요약과 정정 이력</h2>${operator ? button("요약 바로잡기", "brief", "", false, "pencil") : ""}</div><p class="cw-brief-text">${esc(t.brief.text)}</p><div class="cr-brief-meta">요약 v${t.brief.version} · 대상 ${esc(t.brief.targetVersion)} · 근거 ${t.brief.source === "request" ? "원래 요청" : "저장한 결과"}</div><details class="cr-history"><summary>완료 기준과 요약 이력</summary><p>${esc(t.done_criteria)}</p>${t.brief_history.map((h) => `<div><strong>v${h.version} · ${esc(h.reason)}</strong><p>${esc(h.text)}</p></div>`).join("")}</details></section><section class="cw-paper cr-discussion"><h2>함께 남긴 맥락</h2><p class="g-small g-muted">${t.work_type === "chat" ? "책임자가 메시지를 보내면 이전 답변을 이어서 답합니다. 팀원은 같은 대화를 함께 볼 수 있어요." : "실행 시작 시 이 대화를 고정합니다. 이후 추가 내용은 다음 실행에 반영됩니다."}</p>${t.messages.map((m) => `<article class="cr-message"><strong>${esc(m.author)} <small>${stamp(m.created_at)}</small></strong><p>${esc(m.body)}</p></article>`).join("") || '<p class="cr-empty-inline">조건이나 후속 요청을 남겨보세요.</p>'}<form data-form="message">${area("추가 조건 또는 업무 대화", "body", "", 'required maxlength="6000"')}<button class="g-button g-primary" type="submit">${t.work_type === "chat" && operator && ["result_ready", "done"].includes(t.status) ? "보내고 답변받기" : "맥락 남기기"} ${icon("send")}</button><p class="g-error" data-error></p></form></section><section class="cr-results"><details><summary>이전 결과와 버전 ${t.artifacts.filter((a) => a.id !== state.current?.id).length}</summary>${
    t.artifacts
      .filter((a) => a.id !== state.current?.id)
      .map(resultView)
      .reverse()
      .join("") || '<p class="cr-empty-inline">이전 결과가 없습니다.</p>'
  }</details>${t.status === "done" && current ? `<div class="cw-reuse"><div><strong>좋은 결과를 다음 업무의 기준으로</strong><p>완료 기준과 형식을 참고하고 새 대상에서 시작해요.</p></div>${button("이 기준으로 다음 업무", "reuse", "", false, "plus")}${button("이 결과를 기억으로", "remember", "", false, "bookmark-plus")}${button("반복 업무 스킬 초안", "skill-from-task", "", false, "notebook-pen")}</div>` : ""}</section></div><aside class="cr-execution"><section class="cw-paper"><h2>실행 기록</h2>${t.runs.map((r) => `<details class="cr-run"><summary><strong>${esc(agent(r.agent_id)?.name)}</strong><span class="g-pill">${statusName[r.status] || esc(r.status)}</span></summary><p>${esc(r.snapshot.skill.name)} v${r.snapshot.skill.version} · 설정 v${r.snapshot.agent.configVersion}</p><small>대상 ${esc(r.snapshot.targetVersion)}<br>${esc(r.snapshot.provider)} / ${esc(r.snapshot.model || "모델 설정 필요")}<br>${r.snapshot.execution ? `격리 실행 · ${r.snapshot.execution.mode === "verify" ? "독립 QA" : "코드 수정"} · ${esc(r.progress?.action || "준비 중")}${r.progress?.path ? " · " + esc(r.progress.path) : ""} · ${r.progress?.sequence || 0}/30` : "도구 실행 없음"} · 세대 ${r.generation}</small>${r.snapshot.source?.url ? `<p class="cr-source">고정 저장소 SHA<br>${esc(r.snapshot.source.sha)}</p>` : ""}<code>${esc(r.id)}</code></details>`).join("") || '<p class="cr-empty-inline">아직 시작한 실행이 없어요.</p>'}</section><section class="cw-paper"><h2>결정과 인계</h2>${t.events
    .slice(-12)
    .reverse()
    .map(
      (e) =>
        `<div class="cr-event"><strong>${esc({ task_created: "업무 접수", run_started: "실행 시작", model_dispatched: "모델 호출 발송", result_ready: "결과 준비", assign: "책임자 변경", handoff: "다음 단계 인계", accept: "사람의 결과 수용", rework: "재작업 요청", brief: "요약 정정", message: "맥락 추가", claim: "업무 인수 요청", run_failed: "실행 확인 필요", recovery_required: "복구 확인 필요", context_revoked: "문맥 권한 변경", execution_action: "코드 실행 단계" }[e.type] || e.type)}</strong><small>${e.actor_type === "user" ? esc(person(e.actor_id)) : e.actor_type === "run" ? "에이전트 실행" : "운영 기록"} · ${stamp(e.created_at)}</small></div>`,
    )
    .join(
      "",
    )}</section>${manage && ["queued", "running", "paused"].includes(t.status) ? cmd("업무 중단", "cancel") : ""}</aside></div>`;
}

function agentView(id) {
  const a = agent(id);
  if (!a) return '<div class="g-empty">동료를 찾을 수 없어요.</div>';
  const manage =
    a.owner_id === workspace.user.id ||
    (!a.owner_id && workspace.user.role === "lead");
  return `<div class="cr-agent-head">${portrait(a, true)}<div><h1>${esc(a.name)}</h1><p>${esc(a.role)} · ${a.owner_id ? "나만 보는 개인 비서" : departments.find((d) => d.id === a.department)?.name}</p></div>${a.owner_id && workspace.user.role !== "lead" ? button(workspace.user.leadRequested ? "팀장 권한 요청됨" : "팀장 권한 요청", "lead-request", workspace.user.leadRequested ? "disabled" : "") : ""}</div><div class="cr-agent-layout"><section class="cw-paper"><h2>${esc(a.name)}에게 말 걸기</h2><p class="g-small g-muted">새 업무방에서 시작합니다. 기존 업무는 아래 목록에서 이어가세요.</p><form data-form="agent-chat" data-agent="${a.id}">${select(
    "사용할 스킬",
    "skillId",
    a.skills.map((b) => [
      b.skillId,
      workspace.skills.find((s) => s.id === b.skillId)?.name || b.skillId,
    ]),
    "conversation",
  )}<div class="cr-skill-guide" aria-live="polite"></div>${area("맡길 일 또는 대화", "goal", "", 'required maxlength="4000"')}${a.owner_id ? '<input type="hidden" name="visibility" value="private">' : scopes("team")}<p class="g-error" data-error></p><button type="submit" class="g-button g-primary">업무방 열고 시작 ${icon("arrow-right")}</button></form><div class="cr-agent-work"><h3>연결된 업무</h3>${
    workspace.tasks
      .filter(
        (t) =>
          t.agent_id === a.id ||
          (t.work_type === "pr-qa" && ["review", "qa"].includes(a.id)),
      )
      .map(taskRow)
      .join("") || '<p class="cr-empty-inline">연결된 업무가 없어요.</p>'
  }</div></section><aside><section class="cw-paper"><h2>공통 업무 기준</h2><p class="cr-instructions">${esc(a.instructions)}</p><div class="cr-bound-skills">${a.skills.map((s) => `<span class="g-pill">${esc(workspace.skills.find((x) => x.id === s.skillId)?.name)} v${s.version}</span>`).join("")}</div><a href="#/skills" class="g-text-button">스킬 버전 보기 ${icon("arrow-up-right")}</a></section>${manage ? `<details class="cw-paper cr-agent-config"><summary>비서·동료 설정</summary><form data-form="agent-config" data-id="${a.id}" data-revision="${a.config_version}">${field("이름", "name", a.name, "text", 'required maxlength="40"')}${area("업무 지침", "instructions", a.instructions, 'required maxlength="6000"')}<p class="g-small g-muted">설정 변경은 다음 실행부터 적용합니다.</p><p class="g-error" data-error></p><button class="g-button" type="submit">설정 저장</button></form></details>` : ""}${
    !a.owner_id
      ? `<section class="cw-paper"><h2>이 동료의 기억</h2>${
          workspace.memories
            .filter((m) => m.agent_id === id)
            .slice(0, 5)
            .map(
              (m) =>
                `<article class="cr-memory-snippet"><strong>${esc(m.title)}</strong><p>${esc(m.body)}</p><small>${scopeName[m.visibility]} · ${esc(m.source)}</small></article>`,
            )
            .join("") ||
          '<p class="cr-empty-inline">허용된 기억이 아직 없어요.</p>'
        }</section>`
      : ""
  }</aside></div>`;
}
const memoryValidity = (m) =>
  `${m.valid_from ? new Date(m.valid_from).toLocaleDateString("ko-KR") + "부터" : "시작 제한 없음"} · ${m.valid_to ? new Date(m.valid_to).toLocaleDateString("ko-KR") + " 이전까지" : "종료 제한 없음"}`;
function proposalView() {
  const rows = workspace.memoryProposals || [];
  if (!rows.length) return "";
  return `<section class="cw-paper cr-proposals"><div class="cw-section-heading"><h2>기억 제안 ${rows.length}</h2><span class="g-pill">검토 전</span></div><p class="cr-note">출처에서 정리한 후보입니다. 저장하기 전에는 동료의 기억으로 사용하지 않습니다.</p><div class="cr-memory-grid">${rows.map((c) => `<article class="cr-proposal">${c.unavailable ? `<p>출처가 변경되었거나 적용 기간이 끝나 현재 저장할 수 없는 제안입니다.</p>` : `<h3>${esc(c.title)}</h3><span class="g-pill">${scopeName[c.visibility]} · ${c.audience === "project" ? "프로젝트 공통" : "동료 전용"}</span><p>${esc(c.body)}</p><p class="g-small g-muted">${memoryValidity(c)}</p><blockquote>${esc(c.source_quote)}</blockquote><small>${esc(agent(c.agent_id)?.name)} · ${esc(c.project)}</small>`}<div class="cw-actions">${!c.unavailable ? button("출처 원문", "memory-source", `data-key="${esc(c.source_key)}"`) + button("확인하고 기억에 저장", "resolve-memory", `data-id="${c.id}" data-resolution="accept"`, true, "bookmark-plus") : ""}${button("제안 닫기", "resolve-memory", `data-id="${c.id}" data-resolution="dismiss"`)}</div></article>`).join("")}</div></section>`;
}
function memoryView() {
  const search = drafts.get("memory-search") || {},
    query = search.query || "",
    rows = workspace.memories;
  return (
    heading(
      "팀이 쌓아가는 기억",
      "동료별 핵심 기억과 오래된 대화·업무 요약을 출처와 함께 찾아 이어가세요.",
      button("기억 추가", "new-memory", "", true, "plus"),
    ) +
    proposalView() +
    `<form class="cr-search cr-memory-search" data-form="memory-search">${field("기억 검색", "query", query, "search", 'maxlength="200" placeholder="과거 결정이나 업무 내용을 검색"')}${field("적용 기준일 (비우면 현재)", "asOf", search.asOf || "", "date")}<button class="g-button" type="submit">검색 ${icon("search")}</button></form><div class="cr-memory-grid">${rows.map((m) => `<article class="cw-paper cr-memory"><div class="cw-section-heading"><h2>${esc(m.title)}</h2><span class="g-pill">${scopeName[m.visibility]}</span></div><div class="cr-bound-skills"><span class="g-pill">${memoryKindName[m.kind] || "사실"}</span>${m.pinned ? `<span class="g-pill">${icon("pin")} 핵심 기억</span>` : ""}${m.project ? `<span class="g-pill">${esc(m.project)} · ${m.audience === "project" ? "프로젝트 공통" : "동료 전용"}</span>` : ""}</div><p class="g-small g-muted">${memoryValidity(m)}</p>${m.unavailable ? '<span class="g-pill">자동 사용 중단 · 출처 재검토 필요</span>' : ""}<p class="cr-instructions">${esc(m.body)}</p><div class="cr-memory-meta">${esc(agent(m.agent_id)?.name)} · ${esc(m.source)}<br>v${m.revision} · ${stamp(m.updated_at)}</div><details class="cr-history"><summary>정정 이력 ${m.history.length}</summary>${m.history.map((h) => `<div><strong>v${h.revision} · ${esc(h.reason)}</strong><p>${esc(h.body)}</p></div>`).join("") || "<p>정정 이력이 없어요.</p>"}</details>${m.owner_id === workspace.user.id || (workspace.user.role === "lead" && m.visibility !== "private") ? `<div class="cw-actions">${button("바로잡기", "edit-memory", `data-id="${m.id}"`, false, "pencil")}${button("새 결정으로 대체", "replace-memory", `data-id="${m.id}"`, false, "history")}${button("삭제", "delete-memory", `data-id="${m.id}"`, false, "trash-2")}</div>` : ""}</article>`).join("") || '<div class="cw-paper cr-empty-inline">검색할 수 있는 기억이 없어요.</div>'}</div>` +
    (query || search.asOf
      ? `<section class="cw-paper"><div class="cw-section-heading"><h2>과거 대화·업무에서 찾은 기록</h2><span class="g-pill">관련성 검색</span></div><p class="cr-note">업무 요약은 원문을 발췌한 기록입니다. 현재 검사·승인 상태는 해당 업무에서 확인하세요.</p><div class="cr-memory-grid">${archiveResults.map((m) => `<article class="cw-paper"><h3>${esc(m.title)}</h3><span class="g-pill">${scopeName[m.visibility]}</span><p class="cr-instructions">${esc(m.body)}</p><small>${esc(m.project)} · ${esc(m.source)} · ${stamp(m.createdAt)}</small><div class="cw-actions">${button("출처 원문", "memory-source", `data-key="${esc(m.key)}"`)}${m.taskId ? `<a class="g-button" href="#/tasks/${esc(m.taskId)}">업무방 열기</a>` : ""}</div></article>`).join("") || '<p class="cr-empty-inline">관련된 과거 기록이 없어요.</p>'}</div></section>`
      : "")
  );
}
function skillsView() {
  const user = workspace.user;
  return (
    heading(
      "함께 쓰는 업무 방식",
      "스킬 원본 게시와 동료에 적용하는 버전은 따로 관리합니다.",
      button("새 스킬 만들기", "new-skill", "", true, "plus"),
    ) +
    `<div class="cr-skills-list">${workspace.skills
      .map((s) => {
        const publish =
          user.role === "lead" ||
          s.owner_id === user.id ||
          s.steward_id === user.id;
        return `<article class="cw-paper cr-skill"><div><span class="cr-kicker">COMMON SKILL · v${s.current_version}</span><h2>${esc(s.name)}</h2><p>${esc(s.done_criteria)}</p><small>${s.steward_id ? esc(person(s.steward_id)) + " 관리" : "팀장 관리"}</small><details class="cr-history"><summary>스킬 원문</summary><p class="cr-instructions">${esc(s.instructions)}</p></details></div><div class="cr-skill-apply">${workspace.agents
          .filter((a) => a.skills.some((b) => b.skillId === s.id))
          .map((a) => {
            const binding = a.skills.find((b) => b.skillId === s.id),
              manage =
                a.owner_id === user.id || (user.role === "lead" && !a.owner_id);
            return `<div class="cr-binding">${portrait(a)}<span>${esc(a.name)}<small>적용 v${binding.version}</small></span>${manage && binding.version !== s.current_version ? button(`v${s.current_version} 적용`, "bind-skill", `data-agent="${a.id}" data-skill="${s.id}" data-version="${s.current_version}" data-revision="${a.config_version}"`) : '<span class="g-tiny g-muted">적용됨</span>'}</div>`;
          })
          .join(
            "",
          )}${button("동료에 적용", "apply-skill", `data-id="${s.id}"`, false, "plus")}${publish ? button("다음 버전 게시", "publish-skill", `data-id="${s.id}"`, false, "plus") : ""}</div></article>`;
      })
      .join("")}</div>`
  );
}
function operationsView() {
  const o = workspace.operations;
  if (!o) return "";
  const duration =
    o.mean_duration_ms == null
      ? "기록 없음"
      : `${(o.mean_duration_ms / 1000).toFixed(1)}초`;
  const u = o.usage;
  return `<section class="cw-paper cr-admin-section cr-operations" aria-label="운영 현황"><div class="cw-section-heading"><h2>운영 현황</h2><span class="g-muted">열람 가능한 업무 기준</span></div><div class="cr-op-metrics"><div><span>실행 대기</span><strong>${o.queued}</strong><small>${o.oldest_queued_at ? "가장 오래된 요청 " + stamp(o.oldest_queued_at) : "대기 요청 없음"}</small></div><div><span>실행 중</span><strong>${o.running}</strong><small>전체 동시 실행 한도 ${o.capacity.global} · 동료별 ${o.capacity.perAgent}</small></div><div><span>최근 24시간 실패 / 종료 실행</span><strong>${o.failed} / ${o.finished}</strong><small>평균 처리시간 ${duration}</small></div></div><h3>최근 24시간 저장된 모델 사용 기록</h3><p>성공 결과에 저장된 요청 ${u.recordedCalls}건 · 토큰 사용량 제공 ${u.usageReported}건 · 미제공 ${u.usageMissing}건</p><p class="cr-note">${u.inputTokens == null ? "토큰 사용량 기록이 없습니다." : `입력 ${u.inputTokens.toLocaleString()} · 출력 ${u.outputTokens.toLocaleString()} 토큰`} 비용은 미측정입니다. 실패·취소된 요청의 사용량은 포함하지 않으므로 전체 청구 사용량과 다를 수 있어요.</p><h3>확인이 필요한 업무</h3>${o.attention.map((t) => `<a class="cr-op-alert" href="#/tasks/${t.id}"><span>W-${t.number} ${esc(t.title)}</span><small>${statusName[t.status]}${t.error_code ? " · " + esc(t.error_code) : ""}</small>${icon("arrow-up-right")}</a>`).join("") || '<p class="cr-empty-inline">열람 가능한 업무에 실패·재개 대기 요청이 없습니다.</p>'}</section>`;
}
function adminView() {
  if (workspace.user.role !== "lead")
    return '<div class="g-empty">팀장 권한이 필요해요.</div>';
  const issues = workspace.tasks.filter((t) =>
    ["failed", "paused", "result_ready"].includes(t.status),
  );
  return (
    heading(
      "팀 관리",
      "막힌 업무와 권한 요청을 확인하고 스킬 관리 담당을 정하세요.",
    ) +
    `<section class="cw-paper cr-admin-section"><div class="cw-section-heading"><h2>지금 확인할 공유 업무</h2><span class="g-pill amber">${issues.filter((t) => t.visibility !== "private").length}건</span></div>${
      issues
        .filter((t) => t.visibility !== "private")
        .slice(0, 5)
        .map(taskRow)
        .join("") || '<p class="cr-empty-inline">확인할 공유 업무가 없어요.</p>'
    }</section>${operationsView()}<section class="cw-paper cr-admin-section"><h2>구성원과 역할 요청</h2><p class="g-small g-muted">팀원 계정과 소속 부서는 운영 CLI에서 사전 발급합니다. 팀장 요청은 역할 승인 전까지 권한을 부여하지 않습니다.</p>${workspace.members
      .map(
        (m) =>
          `<form data-form="member" data-id="${m.id}" class="cr-member-row"><div><strong>${esc(m.name)}</strong><small>${esc(m.email)}</small>${m.leadRequested ? '<span class="cw-role-request">팀장 권한 요청</span>' : ""}</div>${select(
            `${m.name}의 역할`,
            "role",
            [
              ["member", "팀원"],
              ["lead", "팀장"],
            ],
            m.role,
          )}${select(
            `${m.name}의 부서`,
            "department",
            departments.map((d) => [d.id, d.name]),
            m.department,
          )}${select(
            `${m.name}의 상태`,
            "active",
            [
              ["true", "활성"],
              ["false", "비활성"],
            ],
            String(m.active),
          )}<button type="submit" class="g-button">저장</button><p class="g-error" data-error></p></form>`,
      )
      .join(
        "",
      )}</section><section class="cw-paper cr-admin-section"><h2>스킬별 관리 담당</h2><p class="g-small g-muted">담당 스킬 게시를 위임합니다. 공용 동료의 설정·적용 권한은 별도입니다.</p>${workspace.skills
      .filter(
        (s) =>
          !s.owner_id &&
          ["review", "regression", "ops-check", "conversation"].includes(s.id),
      )
      .map(
        (s) =>
          `<form class="cr-steward-form" data-form="steward" data-id="${s.id}"><strong>${esc(s.name)}</strong>${select(`${s.name} 관리 담당`, "stewardId", [["", "팀장 관리"], ...workspace.members.filter((m) => m.active).map((m) => [m.id, m.name])], s.steward_id || "")}<button type="submit" class="g-button">담당 저장</button><p class="g-error" data-error></p></form>`,
      )
      .join(
        "",
      )}</section><section class="cw-paper cr-admin-section"><h2>서버와 실행 상태</h2><div class="cr-server-meta"><span>Release ${esc(workspace.release)}</span><span>모델 ${esc(workspace.runtime.model || "설정 필요")}</span><span>동시 실행 2개 · 같은 동료 1개</span></div>${workspace.workers.map((w) => `<div class="cr-worker-row"><span class="g-dot ${w.healthy && w.state === "ready" ? "green" : ""}"></span><code>${esc(w.id)}</code><span>${w.healthy && w.state === "ready" ? "응답 중" : "확인 필요"}</span><small>${stamp(w.heartbeat_at)}</small></div>`).join("") || '<p class="cr-empty-inline">Worker가 연결되지 않았어요.</p>'}<p class="cr-note">비공개 업무의 장애 복구는 운영 CLI에서 불투명한 Run ID로 처리합니다. 팀장의 비공개 본문 접근 권한은 확대하지 않습니다.</p></section>`
  );
}
function render() {
  if (!session || !workspace) {
    frame.innerHTML = loginView();
    modal.innerHTML = "";
    icons();
    return;
  }
  const [page = "office", id] = route();
  const content =
    page === "intake"
      ? intakeView(id === "import")
      : page === "tasks"
        ? taskView()
        : page === "inbox"
          ? inboxView()
          : page === "work"
            ? workView()
            : page === "agents"
              ? agentView(id)
              : page === "memory"
                ? memoryView()
                : page === "skills"
                  ? skillsView()
                  : page === "admin"
                    ? adminView()
                    : officeView();
  frame.innerHTML = layout(content);
  restoreDrafts();
  frame
    .querySelectorAll('form[data-form="agent-chat"]')
    .forEach(updateSkillGuide);
  icons();
}
function icons() {
  createIcons({ icons: appIcons, attrs: { width: 17, height: 17 } });
}
function restoreDrafts() {
  frame.querySelectorAll("form").forEach((form) => {
    const d = drafts.get(draftKey(form));
    if (!d) return;
    for (const [key, value] of Object.entries(d)) {
      const input = form.elements.namedItem(key);
      if (input && input.type !== "password") input.value = value;
    }
  });
}
function updateSkillGuide(form) {
  const a = agent(form.dataset.agent),
    b = a?.skills.find((b) => b.skillId === form.elements.skillId.value);
  const guide = form.querySelector(".cr-skill-guide");
  const contract = requestContract(b?.skillId);
  const submit = form.querySelector('button[type="submit"]');
  if (submit)
    submit.textContent =
      contract === "chat"
        ? "업무방 열고 시작"
        : contract === "handoff"
          ? "인계받을 업무 찾기"
          : "업무 대상 입력하기";
  if (guide)
    guide.innerHTML = b
      ? `<strong>이번 요청에 적용할 스킬 v${b.version}</strong><p>${esc(b.doneCriteria || "완료 기준은 실행을 시작할 때 고정합니다.")}</p><small>${requestContract(b.skillId) === "chat" ? "같은 업무 대화에서 맥락을 이어갑니다." : requestContract(b.skillId) === "handoff" ? "이 스킬은 코드 수정 업무에서 동일 수정본을 인계받아 사용합니다." : "대상·버전·프로젝트를 확인한 뒤 업무로 접수합니다."} 진행 중인 다른 업무의 버전은 바뀌지 않아요.</small>`
      : "";
}
function closeDialog() {
  dialog = null;
  modal.innerHTML = "";
  frame.removeAttribute("inert");
  document.getElementById("cr-modal-trigger")?.focus();
}
function openDialog(type, data = {}) {
  dialog = { type, ...data };
  const focused = document.activeElement;
  if (focused?.tagName === "BUTTON") focused.id = "cr-modal-trigger";
  let title = "",
    body = "",
    form = "",
    submit = "저장";
  if (type === "intake-confirm") {
    title = "이 내용으로 함께 시작해요";
    body = `<dl class="cw-facts"><div><dt>업무 대상</dt><dd>${esc(data.values.target)}</dd></div><div><dt>대상 버전</dt><dd>${esc(data.values.targetVersion)}</dd></div><div><dt>요청할 내용</dt><dd>${esc(data.values.goal)}</dd></div><div><dt>공개 범위</dt><dd>${scopeName[data.values.visibility]}</dd></div></dl>${data.values.imported ? `<div class="cw-import-preview"><strong>공개할 결과</strong><p>${esc(data.values.imported.body)}</p><small>${esc(data.values.imported.source)}</small></div>` : ""}`;
    form = "intake-create";
    submit = "업무 접수하기";
  }
  if (type === "brief") {
    title = "업무 요약 바로잡기";
    form = "brief";
    body =
      area(
        "현재 업무 요약",
        "text",
        task.brief.text,
        'required maxlength="1500"',
      ) +
      field("정정 이유", "reason", "", "text", 'required maxlength="300"') +
      select(
        "요약의 근거",
        "source",
        [
          ["request", "원래 요청"],
          ...task.artifacts.map((a) => [
            a.id,
            `결과 v${a.version} · ${a.target_version}`,
          ]),
        ],
        task.brief.source,
      );
  }
  if (type === "rework") {
    title = "같은 업무에서 재작업";
    form = "rework";
    body =
      area("재작업 이유", "reason", "", 'required maxlength="500"') +
      field(
        "대상 커밋 또는 관측 버전",
        "targetVersion",
        task.target_version,
        "text",
        'required maxlength="80"',
      ) +
      '<p class="cr-note">이전 결과와 승인을 보존하고 첫 단계부터 다시 시작합니다.</p>';
    submit = "새 실행 준비";
  }
  if (type === "new-skill") {
    title = "반복 업무를 스킬로";
    form = "skill-create";
    const base = data.fromTask
      ? workspace.skills.find(
          (s) => s.id === task.runs.at(-1)?.snapshot.skill.id,
        )
      : null;
    body =
      field(
        "스킬 이름",
        "name",
        data.fromTask ? task.title.slice(0, 65) + " · 반복 업무" : "",
        "text",
        'required maxlength="80"',
      ) +
      select(
        "공개 대상",
        "scope",
        [
          ["private", "나의 비서 전용"],
          ...(workspace.user.role === "lead" ? [["team", "팀 공용"]] : []),
        ],
        "private",
      ) +
      area(
        "반복 업무 지침",
        "instructions",
        data.fromTask
          ? `${base?.instructions?.slice(0, 10000) || "업무의 입력과 완료 기준을 확인하고 결과를 정리하세요."}\n\n다음 업무에서는 새 대상과 버전을 입력받고 근거·미확인 사항을 구분하세요. 과거 결과의 검사·수용을 새 업무의 승인으로 사용하지 마세요.\n참고 업무: W-${task.number}`
          : "",
        'required maxlength="12000"',
      ) +
      area(
        "완료 기준",
        "doneCriteria",
        data.fromTask ? task.done_criteria : "",
        'required maxlength="2000"',
      );
  }
  if (type === "apply-skill") {
    const skill = workspace.skills.find((s) => s.id === data.id);
    title = skill.name + " · 동료에 적용";
    form = "skill-apply";
    body =
      select(
        "적용할 동료",
        "agentId",
        workspace.agents
          .filter(
            (a) =>
              (a.owner_id === workspace.user.id ||
                (!a.owner_id && workspace.user.role === "lead")) &&
              (!skill.owner_id || a.owner_id === skill.owner_id),
          )
          .map((a) => [a.id, a.name]),
        "",
      ) +
      '<p class="cr-note">현재 게시 버전을 적용합니다. 에이전트에게 말 걸 때 이 스킬을 선택해 바로 실행할 수 있어요.</p>';
  }
  if (type === "publish-skill") {
    const s = workspace.skills.find((s) => s.id === data.id);
    title = `${s.name} · 다음 버전`;
    form = "skill-publish";
    body =
      area(
        "공용 스킬 원문",
        "instructions",
        s.instructions,
        'required maxlength="12000"',
      ) +
      area(
        "완료 기준",
        "doneCriteria",
        s.done_criteria,
        'required maxlength="2000"',
      ) +
      '<p class="cr-note">게시해도 동료의 적용 버전이나 진행 중 실행을 바꾸지 않습니다.</p>';
    submit = "새 버전 게시";
  }
  if (type === "password") {
    title = "비밀번호 변경";
    form = "password";
    body =
      field(
        "현재 비밀번호",
        "currentPassword",
        "",
        "password",
        'required autocomplete="current-password" maxlength="128"',
      ) +
      field(
        "새 비밀번호 (12자 이상)",
        "nextPassword",
        "",
        "password",
        'required autocomplete="new-password" minlength="12" maxlength="128"',
      ) +
      '<p class="cr-note">변경하면 모든 기기의 세션이 종료됩니다. 새 비밀번호로 다시 로그인하세요.</p>';
  }
  if (
    ["new-memory", "edit-memory", "remember", "replace-memory"].includes(type)
  ) {
    const m = workspace.memories.find((m) => m.id === data.id),
      a =
        type === "remember"
          ? task.steps[task.step_index].agent_id
          : m?.agent_id;
    const replacing = type === "replace-memory";
    title = replacing
      ? "새 결정의 적용 기간 정하기"
      : m
        ? "기억 바로잡기"
        : "출처와 함께 기억하기";
    form = m && !replacing ? "memory-edit" : "memory-create";
    body =
      !m || replacing
        ? select(
            "기억할 동료",
            "agentId",
            workspace.agents.map((a) => [a.id, `${a.name} · ${a.role}`]),
            a,
          ) +
          scopes(
            m?.visibility ||
              (type === "remember" ? task.visibility : "private"),
          )
        : "";
    body +=
      select(
        "기억 종류",
        "kind",
        [
          ["fact", "사실"],
          ["decision", "결정"],
          ["preference", "선호"],
          ["procedure", "업무 규칙"],
        ],
        m?.kind || "fact",
      ) +
      select(
        "기본 문맥에 우선 포함",
        "pinned",
        [
          ["false", "관련될 때 검색"],
          ["true", "핵심 기억으로 고정"],
        ],
        String(m?.pinned || false),
      );
    if ((!m || replacing) && type !== "remember")
      body += field(
        "프로젝트 (비우면 공통)",
        "project",
        m?.project || "",
        "text",
        'maxlength="80"',
      );
    if (!m || replacing)
      body +=
        select(
          "기억 적용 대상",
          "audience",
          [
            ["agent", "이 동료 전용"],
            ["project", "같은 프로젝트의 공용 동료"],
          ],
          m?.audience || "agent",
        ) +
        field(
          "적용 시작 (비우면 상시)",
          "validFrom",
          replacing
            ? new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 16)
            : "",
          "datetime-local",
          replacing ? "required" : "",
        ) +
        field("적용 종료 (선택)", "validTo", "", "datetime-local");
    body +=
      field(
        "기억 제목",
        "title",
        m?.title || (type === "remember" ? task.title : ""),
        "text",
        'required maxlength="120"',
      ) +
      area("기억할 내용", "body", m?.body || "", 'required maxlength="10000"') +
      (m && !replacing
        ? field("정정 이유", "reason", "", "text", 'required maxlength="300"')
        : field(
            "출처",
            "source",
            type === "remember" ? `업무 W-${task.number}` : m?.source || "",
            "text",
            'required maxlength="500"',
          ));
    if (replacing)
      body += `<p class="cr-note">기존 결정은 새 적용 시작 전까지 유효합니다. 과거 기록과 정정 이력은 유지합니다.</p>`;
    if (type === "remember")
      body += '<p class="cr-note">원본 업무와 같은 공개 범위로 저장합니다.</p>';
  }
  if (type === "used-memory") {
    title = "이번 실행이 참고한 기억";
    form = "memory-source";
    submit = "닫기";
    body = `<p class="cr-note">원본의 현재 버전과 접근 범위가 유효한 기록입니다. 변경·삭제된 출처 ${data.unavailable}개.</p>${data.items.map((m) => `<article class="cw-paper"><h3>${esc(m.title)}</h3><p class="cr-instructions">${esc(m.body)}</p><small>${esc(m.source)}</small></article>`).join("") || "<p>참고한 장기 기억이 없습니다.</p>"}`;
  }
  if (type === "memory-source") {
    title = data.item.title;
    form = "memory-source";
    submit = "닫기";
    body = `<p class="cr-note">${esc(data.item.source)} · ${esc(data.item.targetVersion || "버전 미기록")} · ${data.item.audience === "project" ? "프로젝트 공통" : "동료 전용"}</p><p class="cr-instructions">${esc(data.item.body)}</p>`;
  }
  if (type === "delete-memory") {
    title = "기억을 검색에서 제외할까요?";
    form = "memory-delete";
    body =
      "<p>이 기억은 새 업무 검색과 실행 문맥에서 제외됩니다. 이미 저장한 업무 이력과 백업의 보존 정책은 별도로 적용됩니다.</p>";
    submit = "기억 삭제";
  }
  modal.innerHTML = `<div class="cr-modal-overlay"><section class="cr-modal" role="dialog" aria-modal="true" aria-labelledby="cr-dialog-title"><header><h2 id="cr-dialog-title">${esc(title)}</h2>${button("닫기", "close", "", false, "x")}</header><form data-form="${form}">${body}<p class="g-error" role="alert" data-error></p><footer>${button("취소", "close")}<button type="submit" class="g-button g-primary">${submit}</button></footer></form></section></div>`;
  frame.setAttribute("inert", "");
  modal.querySelector("input,textarea,select,button")?.focus();
  icons();
}
async function sendCommand(action, extra = {}, rev = task.revision) {
  await api(`/tasks/${task.id}/commands`, {
    method: "POST",
    body: { action, revision: rev, ...extra },
  });
  await load(true);
}
root.addEventListener("input", (e) => {
  const form = e.target.closest("form");
  if (
    form &&
    [
      "intake",
      "agent-chat",
      "message",
      "memory-search",
      "question-create",
      "question-answer",
    ].includes(form.dataset.form)
  )
    drafts.set(draftKey(form), {
      ...drafts.get(draftKey(form)),
      ...Object.fromEntries(new FormData(form)),
    });
});
root.addEventListener("change", (e) => {
  if (
    e.target.name === "skillId" &&
    e.target.form?.dataset.form === "agent-chat"
  )
    updateSkillGuide(e.target.form);
});
root.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || busy) return;
  const { action } = el.dataset;
  try {
    if (action === "resolve-memory") {
      await api(`/memory/proposals/${el.dataset.id}`, {
        method: "POST",
        body: { action: el.dataset.resolution },
      });
      await load(true);
      toast(
        el.dataset.resolution === "accept"
          ? "원문을 확인한 기억으로 저장했어요."
          : "기억 제안을 닫았어요.",
      );
      return;
    }
    if (action === "skill-from-task") {
      openDialog("new-skill", { fromTask: true });
      return;
    }
    if (action === "navigate") navigate(el.dataset.path);
    if (action === "close") {
      closeDialog();
      return;
    }
    if (action === "current-result") {
      frame
        .querySelector(".cr-current-result")
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    if (action === "question-close") {
      await api(`/tasks/${task.id}/questions/${el.dataset.id}`, {
        method: "PATCH",
        body: { action: "close", revision: Number(el.dataset.revision) },
      });
      await load(true);
      return;
    }
    if (action === "used-memory") {
      const response = await api(`/tasks/${task.id}/memory`);
      openDialog("used-memory", response);
      return;
    }
    if (action === "memory-source") {
      const response = await api(
        "/memory/sources/" + encodeURIComponent(el.dataset.key),
      );
      openDialog("memory-source", { item: response.item });
      return;
    }
    if (action === "password") openDialog("password");
    if (["new-skill", "apply-skill"].includes(action))
      openDialog(action, el.dataset);
    if (action === "refresh") await load(true);
    if (action === "lead-request") {
      await api("/auth/lead-request", { method: "POST", body: {} });
      await load(true);
      toast("기존 팀장이 요청을 확인하면 역할을 부여합니다.");
    }
    if (action === "office-select") {
      selectedAgent = el.dataset.id;
      render();
      frame
        .querySelector(
          `.g-office-station[data-id="${CSS.escape(selectedAgent)}"]`,
        )
        ?.focus();
      return;
    }
    if (action === "use-skill") {
      beginSkillRequest(el.dataset.agent, el.dataset.skill);

      return;
    }
    if (action === "work-filter") {
      workFilter = ["all", "mine", "running", "queued", "failed"].includes(
        el.dataset.filter,
      )
        ? el.dataset.filter
        : "all";
      navigate("work");
      return;
    }
    if (action === "motion") {
      motionOff = !motionOff;
      root.classList.toggle("cr-no-motion", motionOff);
      render();
      return;
    }
    if (action === "logout") {
      await api("/auth/logout", { method: "POST", body: {} });
      clearSession();
      location.hash = "";
      render();
    }
    if (action === "command")
      await sendCommand(el.dataset.command, {}, Number(el.dataset.revision));
    if (
      [
        "brief",
        "rework",
        "new-memory",
        "edit-memory",
        "replace-memory",
        "delete-memory",
        "publish-skill",
        "remember",
      ].includes(action)
    )
      openDialog(action, el.dataset);
    if (action === "copy") {
      await navigator.clipboard.writeText(location.href);
      toast("업무 링크를 복사했어요.");
    }
    if (action === "reuse") {
      drafts.set("intake", {
        workType: task.work_type,
        ...(task.work_type === "analysis"
          ? { agentId: task.steps[0].agent_id, skillId: task.steps[0].skill_id }
          : {}),
        project: task.project,
        goal: task.done_criteria,
        visibility: task.visibility,
        target: "",
        targetVersion: "",
        exampleId: task.acceptances.find((a) => !a.revoked_at)?.artifact_id,
        exampleTaskId: task.id,
      });
      navigate("intake");
    }
    if (action === "bind-skill") {
      await api(`/agents/${el.dataset.agent}/bindings`, {
        method: "POST",
        body: {
          skillId: el.dataset.skill,
          version: Number(el.dataset.version),
          agentRevision: Number(el.dataset.revision),
        },
      });
      await load(true);
      toast("다음 실행부터 새 스킬을 적용해요.");
    }
  } catch (error) {
    if (silent(error)) return;
    toast(error.message);
    if (error.status === 409) await load(true);
  }
});
root.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  if (busy) return;
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form)),
    kind = form.dataset.form;
  busy = true;
  form.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    if (kind === "login") {
      clearSession();
      session = await api("/auth/login", { method: "POST", body: values });
      await load(true);
      connect();
    }
    if (kind === "password") {
      await api("/auth/password", { method: "POST", body: values });
      clearSession();
      render();
      toast("비밀번호가 변경됐어요. 다시 로그인해주세요.");
    }
    if (kind === "intake") {
      const d = drafts.get("intake") || {};
      const payload = {
        workType: values.workType,
        target: values.target,
        targetVersion: values.targetVersion,
        project: values.project,
        goal: values.goal,
        visibility: values.visibility,
        ...(d.exampleId ? { exampleId: d.exampleId } : {}),
        ...(d.skillId ? { agentId: d.agentId, skillId: d.skillId } : {}),
        ...(form.dataset.importing === "true"
          ? {
              imported: {
                body: values.importBody,
                source: values.importSource,
              },
            }
          : {}),
      };
      openDialog("intake-confirm", {
        values: payload,
        idempotencyKey: crypto.randomUUID(),
      });
    }
    if (kind === "intake-create") {
      const response = await api("/tasks", {
        method: "POST",
        body: dialog.values,
        headers: { "idempotency-key": dialog.idempotencyKey },
      });
      drafts.delete("intake");
      closeDialog();
      navigate(`tasks/${response.task.id}`);
    }
    if (kind === "message") {
      const submittedTaskId = task.id,
        submittedDraftKey = draftKey(form);
      await api(`/tasks/${submittedTaskId}/messages`, {
        method: "POST",
        body: values,
      });
      drafts.delete(submittedDraftKey);
      await load(true);
      if (
        task?.id === submittedTaskId &&
        task.work_type === "chat" &&
        task.responsible_id === workspace.user.id &&
        ["result_ready", "done"].includes(task.status)
      ) {
        const next = await api(`/tasks/${submittedTaskId}/commands`, {
          method: "POST",
          body: { action: "continue", revision: task.revision },
        });
        await api(`/tasks/${submittedTaskId}/commands`, {
          method: "POST",
          body: { action: "start", revision: next.task.revision },
        });
        await load(true);
      }
    }
    if (kind === "question-create") {
      await api(`/tasks/${task.id}/questions`, {
        method: "POST",
        body: {
          taskRevision: task.revision,
          assigneeId: values.assigneeId,
          prompt: values.prompt,
        },
      });
      drafts.delete(draftKey(form));
      await load(true);
    }
    if (kind === "question-answer") {
      await api(`/tasks/${task.id}/questions/${form.dataset.id}`, {
        method: "PATCH",
        body: {
          action: "answer",
          revision: Number(form.dataset.revision),
          answer: values.answer,
        },
      });
      drafts.delete(draftKey(form));
      await load(true);
      toast("답변을 저장했어요. 이미 만든 결과에는 재작업 후 반영됩니다.");
    }
    if (kind === "question-assign") {
      await api(`/tasks/${task.id}/questions/${form.dataset.id}`, {
        method: "PATCH",
        body: {
          action: "assign",
          revision: Number(form.dataset.revision),
          assigneeId: values.assigneeId,
        },
      });
      await load(true);
    }
    if (kind === "assign")
      await sendCommand("assign", values, Number(form.dataset.revision));
    if (["brief", "rework"].includes(kind)) {
      await sendCommand(kind, values);
      closeDialog();
    }
    if (kind === "agent-chat") {
      if (requestContract(values.skillId) !== "chat") {
        beginSkillRequest(form.dataset.agent, values.skillId, values);
        return;
      }
      const response = await api("/tasks", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: {
          workType: "chat",
          agentId: form.dataset.agent,
          skillId: values.skillId,
          target: "업무 대화",
          targetVersion: new Date().toISOString(),
          project: "팀 업무",
          goal: values.goal,
          visibility: values.visibility,
        },
      });
      drafts.delete(draftKey(form));
      await api(`/tasks/${response.task.id}/commands`, {
        method: "POST",
        body: { action: "start", revision: response.task.revision },
      });
      navigate(`tasks/${response.task.id}`);
    }
    if (kind === "agent-config") {
      await api(`/agents/${form.dataset.id}`, {
        method: "PATCH",
        body: {
          ...values,
          revision: Number(form.dataset.revision),
          runtime: agent(form.dataset.id).runtime,
        },
      });
      drafts.delete(draftKey(form));
      await load(true);
      toast("다음 실행부터 새 설정을 적용해요.");
    }
    if (kind === "memory-source") {
      closeDialog();
      return;
    }
    if (kind === "memory-search") {
      drafts.set(kind, values);
      const response = await api(
        `/memories?q=${encodeURIComponent(values.query)}`,
      );
      workspace.memories = response.memories;
      const recalled = await api(
        `/memory/search?q=${encodeURIComponent(values.query)}${values.asOf ? "&asOf=" + encodeURIComponent(new Date(values.asOf + "T00:00:00").toISOString()) : ""}`,
      );
      if (values.query || values.asOf)
        workspace.memories = response.memories.filter((m) =>
          recalled.items.some((d) => d.key === "memory:" + m.id),
        );
      archiveResults = recalled.items.filter(
        (m) => !m.key.startsWith("memory:"),
      );
      render();
    }
    if (kind === "memory-create" || kind === "memory-edit")
      values.pinned = values.pinned === "true";
    if (kind === "memory-create") {
      values.validFrom = values.validFrom
        ? new Date(values.validFrom).toISOString()
        : null;
      values.validTo = values.validTo
        ? new Date(values.validTo).toISOString()
        : null;
      if (dialog.type === "replace-memory") values.supersedesId = dialog.id;
      await api("/memories", {
        method: "POST",
        body: {
          ...values,
          ...(dialog.type === "remember" ? { sourceTaskId: task.id } : {}),
        },
      });
      closeDialog();
      await load(true);
      toast("출처와 함께 기억했어요.");
    }
    if (kind === "memory-edit" || kind === "memory-delete") {
      const m = workspace.memories.find((m) => m.id === dialog.id);
      await api(`/memories/${m.id}`, {
        method: kind === "memory-delete" ? "DELETE" : "PATCH",
        body:
          kind === "memory-delete"
            ? { revision: m.revision }
            : { ...values, revision: m.revision },
      });
      closeDialog();
      await load(true);
    }
    if (kind === "skill-create") {
      await api("/skills", { method: "POST", body: values });
      closeDialog();
      await load(true);
      toast("스킬을 만들었어요. 동료에 적용해 사용하세요.");
    }
    if (kind === "skill-apply") {
      const skill = workspace.skills.find((s) => s.id === dialog.id),
        a = agent(values.agentId);
      if (!a) throw new Error("적용할 동료를 선택해주세요.");
      await api("/agents/" + a.id + "/bindings", {
        method: "POST",
        body: {
          skillId: skill.id,
          version: skill.current_version,
          agentRevision: a.config_version,
        },
      });
      closeDialog();
      await load(true);
      toast("동료에 스킬을 적용했어요.");
    }
    if (kind === "skill-publish") {
      const s = workspace.skills.find((s) => s.id === dialog.id);
      await api(`/skills/${s.id}/versions`, {
        method: "POST",
        body: { ...values, revision: s.current_version },
      });
      closeDialog();
      await load(true);
      toast("새 버전을 게시했어요. 동료 적용은 따로 결정합니다.");
    }
    if (kind === "member") {
      await api(`/members/${form.dataset.id}`, {
        method: "PATCH",
        body: { ...values, active: values.active === "true" },
      });
      drafts.delete(draftKey(form));
      await load(true);
    }
    if (kind === "steward") {
      await api(`/skills/${form.dataset.id}/steward`, {
        method: "PATCH",
        body: { stewardId: values.stewardId || null },
      });
      drafts.delete(draftKey(form));
      await load(true);
      toast("스킬 관리 담당을 저장했어요.");
    }
  } catch (error) {
    if (silent(error)) return;
    const output = form.querySelector("[data-error]");
    if (output) output.textContent = error.message;
    else toast(error.message);
  } finally {
    busy = false;
    form.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dialog) closeDialog();
  if (e.key === "Tab" && dialog) {
    const nodes = [
        ...modal.querySelectorAll("button,input,textarea,select,a[href]"),
      ].filter((n) => !n.disabled),
      first = nodes[0],
      last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
});
window.addEventListener("hashchange", () => {
  dialog = null;
  modal.innerHTML = "";
  frame.removeAttribute("inert");
  load(true);
});
try {
  session = await api("/auth/session");
  await load(true);
  connect();
} catch {
  render();
}

function executionView(artifact) {
  const execution = artifact.result.execution;
  if (!execution) return "";
  return `<section class="cr-code-result"><div class="cr-code-receipt"><span class="g-pill ${execution.passed ? "green" : "amber"}">${execution.passed ? "등록 검사 모두 통과" : "검사 실패 또는 재검사 필요"}</span><span>${execution.mode === "verify" ? "새 컨테이너에서 독립 QA" : "개발 실행"} · ${execution.stopped ? "컨테이너 종료 확인" : "종료 확인 필요"}</span></div><p class="g-small g-muted">기준 SHA ${esc(execution.baselineSha)}<br>수정본 ${esc(execution.patchHash.slice(0, 16))} · 실행 설정 ${esc(execution.profileId.slice(0, 16))}</p>${execution.checks.map((check) => `<details class="cr-check"><summary><span class="g-pill ${check.passed ? "green" : "amber"}">${check.passed ? "통과" : "실패"}</span> ${esc(check.label || check.checkId)} · exit ${esc(check.exitCode)} · ${(check.durationMs / 1000).toFixed(1)}초</summary><pre>${esc(check.stdout)}${esc(check.stderr)}${check.timedOut ? "\n시간 제한 초과" : ""}${check.sourceUnchanged ? "" : "\n검사 중 소스가 변경됨"}</pre></details>`).join("") || '<p class="cr-note">현재 수정본과 일치하는 검사 결과가 없습니다.</p>'}<details class="cr-diff" open><summary>수정 diff <a href="/api/artifacts/${artifact.id}?format=patch">Patch 다운로드</a></summary><pre>${
    execution.patch
      .split("\n")
      .map(
        (line) =>
          `<span class="${line.startsWith("+") ? "cr-line-add" : line.startsWith("-") ? "cr-line-remove" : ""}">${esc(line)}</span>`,
      )
      .join("\n") || "수정 없음"
  }</pre></details></section>`;
}
