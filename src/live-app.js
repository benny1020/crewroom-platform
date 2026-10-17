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
  drafts.clear();
  archiveResults = [];
  modal.innerHTML = "";
  frame.removeAttribute("inert");
}

const draftKey = (form) =>
  form.dataset.form +
  (form.dataset.form === "agent-chat"
    ? ":" + form.dataset.agent
    : form.dataset.form === "message"
      ? ":" + task?.id
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
    if (generation !== sessionGeneration || id !== refreshId) throw stale();
    workspace = next;
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
  return `<header class="cr-top"><a class="g-brand" href="#/office"><span class="g-brand-mark">C</span><span class="g-brand-name">크루룸</span></a><span class="cr-team-label">우리 팀 <span class="g-pill green">서버 연결됨</span></span><div class="cr-top-actions"><span data-connection>${connection}</span>${button("새 업무", "navigate", 'data-path="intake"', true, "plus")}<span>${esc(u.name)} / ${u.role === "lead" ? "팀장" : "팀원"}</span>${button("비밀번호 변경", "password")}${button("로그아웃", "logout", "", false, "log-out")}</div></header><div class="cr-layout"><aside class="cr-sidebar"><span class="cr-kicker">워크스페이스</span>${[["office", "panels-top-left", "팀 오피스"], ["work", "layers", "공유 업무"], ["memory", "bookmark", "기억 보관함"], ["skills", "blocks", "스킬 라이브러리"], ...(u.role === "lead" ? [["admin", "settings-2", "팀 관리"]] : [])].map(([id, glyph, label]) => `<a class="cr-nav ${page === id ? "selected" : ""}" href="#/${id}">${icon(glyph)}${label}</a>`).join("")}<div class="cr-side-roster"><span class="cr-kicker">공용 에이전트</span>${departments
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
    )}</div><a class="cr-side-agent cr-personal" href="#/agents/personal-${u.id}">${portrait({})}<span><strong>나의 비서</strong><small>개인 대화와 기억</small></span>${icon("lock-keyhole")}</a></aside><main class="cr-main"><div class="cr-live-notice"><span>${icon("radio")} ${workspace.runtime.fixture ? "통합 테스트 실행기 · 실제 AI 미연결" : "읽기 전용 AI 업무 · 외부 변경 미허용"}</span><button class="g-text-button" data-action="refresh" data-live-refresh ${deferred ? "" : "hidden"}>새 변경 확인 ${icon("refresh-cw")}</button></div>${content}</main></div>`;
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
    );
  return (
    heading(
      "함께 일하는 오피스",
      "네 부서의 동료와 같은 업무를 이어가세요.",
      button("모션 전환", "motion", "", false, "sparkles"),
    ) +
    `<section class="cw-desk"><div class="cw-desk-intro"><span class="cw-desk-symbol">${icon("git-pull-request")}</span><div><h2>어떤 일을 함께 이어갈까요?</h2><p>대상과 원하는 결과를 입력하면 담당 동료를 준비해요.</p></div></div><div class="cw-actions">${button("새 업무 시작", "navigate", 'data-path="intake"', true, "plus")}${button("기존 결과 가져오기", "navigate", 'data-path="intake/import"', false, "file-check-2")}</div></section><section class="cr-work-preview">${tasks.slice(0, 2).map(taskRow).join("") || '<div class="cr-empty-inline">첫 업무를 맡겨보세요. 팀원이 같은 업무방에서 이어받을 수 있어요.</div>'}</section><div class="cr-overview"><span>${icon("activity")} 진행 중 <b>${tasks.filter((t) => t.status === "running").length}</b></span><span>${icon("circle-help")} 내가 확인할 일 <b>${mine.length}</b></span><span>${icon("file-check-2")} 수용한 결과 <b>${tasks.filter((t) => t.status === "done").length}</b></span><span class="g-muted">Worker ${workspace.workers.some((w) => w.healthy && w.state === "ready") ? "연결됨" : "연결 확인 필요"}</span></div><div class="cr-rooms">${departments
      .map(
        (d) =>
          `<section class="cr-room"><header><h2>${icon(d.icon)} ${d.name}</h2><span>${d.description}</span></header><div class="cr-stations">${shared
            .filter((a) => a.department === d.id)
            .map((a) => {
              const work = tasks.find(
                  (t) =>
                    t.agent_name === a.name &&
                    [
                      "running",
                      "queued",
                      "result_ready",
                      "paused",
                      "failed",
                    ].includes(t.status),
                ),
                working = work?.status === "running";
              return `<a href="#/agents/${a.id}" class="cr-station ${working ? "working" : ""}"><div class="cr-desk-scene">${portrait(a, true)}<div class="cr-laptop">${working ? "<span></span><span></span><span></span>" : icon("minus")}</div><div class="cr-table"></div></div><strong>${esc(a.name)} <small>${esc(a.role)}</small></strong><span class="cr-station-status ${working ? "active" : ""}">${work ? statusName[work.status] : "새 업무를 맡길 수 있어요"}</span><p>${esc(work?.title || "업무 대기 중")}</p></a>`;
            })
            .join("")}</div></section>`,
      )
      .join("")}</div>`
  );
}
function intakeView(importing = false) {
  const d = drafts.get("intake") || {},
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
    `<div class="cw-intake-layout"><section class="cw-paper"><form data-form="intake" data-importing="${importing}">${select(
      "필요한 결과",
      "workType",
      importing
        ? [["pr-qa", "가져온 검토 결과 → QA 계획"]]
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
  return (
    heading(
      "함께 이어가는 업무",
      "요청·대화·결과를 하나의 업무방에서 확인하세요.",
      button("새 업무", "navigate", 'data-path="intake"', true, "plus"),
    ) +
    `<section class="cr-work-preview">${workspace.tasks.map(taskRow).join("") || '<div class="g-empty">접수된 업무가 없어요.</div>'}</section>`
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
    current = t.artifacts.find((a) => a.id === step.current_artifact_id),
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
  if (operator && t.status === "result_ready")
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
  return `<div class="cr-workroom-head"><a href="#/work" class="g-text-button">${icon("arrow-left")} 전체 업무</a><span>W-${t.number} · ${scopeName[t.visibility]}</span>${button("업무 링크 복사", "copy", "", false, "link")}${task.runs.length ? button("참고한 기억", "used-memory", "", false, "bookmark") : ""}</div>${heading(esc(t.title), `${esc(t.project)} · ${esc(person(t.owner_id))} 요청 / ${esc(person(t.responsible_id))} 책임`, pill(t))}<section class="cr-task-target"><span>대상</span><strong>${esc(t.target)}</strong><code>${esc(t.target_version)}</code></section><div class="cw-step-track">${t.steps.map((s, i) => `<div class="cw-step ${i === t.step_index ? "current" : ""}">${portrait(agent(s.agent_id))}<span><strong>${esc(s.agent_name)}</strong><small>${esc(s.name)} · ${i < t.step_index ? "인계됨" : i === t.step_index ? "현재 단계" : "대기"}</small></span>${i < t.steps.length - 1 ? icon("arrow-right") : ""}</div>`).join("")}</div><section class="cw-next"><div><span class="cw-small-label">다음 행동</span><strong>${t.status === "result_ready" ? (final ? "결과를 확인하고 수용 또는 재작업" : "검토 결과를 확인하고 QA로 인계") : t.status === "done" ? "수용한 결과를 다음 업무의 기준으로" : t.status === "failed" ? "실행 기록의 확인 필요 사항을 해결해주세요" : t.status === "running" ? "동료가 결과를 정리하고 있어요" : "요청한 입력으로 업무를 이어가세요"}</strong><span>${esc(person(t.responsible_id))} 책임 · ${esc(step.agent_name)} 담당</span></div><div class="cw-actions">${controls}</div></section>${run?.error_code ? `<div class="cr-run-error" role="status"><strong>${esc(run.error_message)}</strong><small>${esc(run.error_code)}</small>${run.lease_owner ? "<p>운영 담당자가 이전 Worker의 종료를 확인해야 새 실행이 가능합니다. 비공개 업무 본문을 공개할 필요는 없습니다.</p>" : ""}</div>` : ""}${
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
  }<div class="cr-workroom-grid"><div><section class="cw-paper cr-brief"><div class="cw-section-heading"><h2>지금 이어받을 내용</h2>${operator ? button("요약 바로잡기", "brief", "", false, "pencil") : ""}</div><p class="cw-brief-text">${esc(t.brief.text)}</p><div class="cr-brief-meta">요약 v${t.brief.version} · 대상 ${esc(t.brief.targetVersion)} · 근거 ${t.brief.source === "request" ? "원래 요청" : "저장한 결과"}</div><details class="cr-history"><summary>완료 기준과 요약 이력</summary><p>${esc(t.done_criteria)}</p>${t.brief_history.map((h) => `<div><strong>v${h.version} · ${esc(h.reason)}</strong><p>${esc(h.text)}</p></div>`).join("")}</details></section><section class="cw-paper cr-discussion"><h2>함께 남긴 맥락</h2><p class="g-small g-muted">${t.work_type === "chat" ? "책임자가 메시지를 보내면 이전 답변을 이어서 답합니다. 팀원은 같은 대화를 함께 볼 수 있어요." : "실행 시작 시 이 대화를 고정합니다. 이후 추가 내용은 다음 실행에 반영됩니다."}</p>${t.messages.map((m) => `<article class="cr-message"><strong>${esc(m.author)} <small>${stamp(m.created_at)}</small></strong><p>${esc(m.body)}</p></article>`).join("") || '<p class="cr-empty-inline">조건이나 후속 요청을 남겨보세요.</p>'}<form data-form="message">${area("추가 조건 또는 업무 대화", "body", "", 'required maxlength="6000"')}<button class="g-button g-primary" type="submit">${t.work_type === "chat" && operator && ["result_ready", "done"].includes(t.status) ? "보내고 답변받기" : "맥락 남기기"} ${icon("send")}</button><p class="g-error" data-error></p></form></section><section class="cr-results"><h2>결과와 버전 ${t.artifacts.length}</h2>${t.artifacts.map(resultView).reverse().join("") || '<div class="cw-paper cr-empty-inline">결과가 준비되면 출처와 근거를 여기에 모아요.</div>'}${t.status === "done" && current ? `<div class="cw-reuse"><div><strong>좋은 결과를 다음 업무의 기준으로</strong><p>완료 기준과 형식을 참고하고 새 대상에서 시작해요.</p></div>${button("이 기준으로 다음 업무", "reuse", "", false, "plus")}${button("이 결과를 기억으로", "remember", "", false, "bookmark-plus")}</div>` : ""}</section></div><aside class="cr-execution"><section class="cw-paper"><h2>실행 기록</h2>${t.runs.map((r) => `<article class="cr-run"><div class="g-row g-between"><strong>${esc(agent(r.agent_id)?.name)}</strong><span class="g-pill">${statusName[r.status] || esc(r.status)}</span></div><p>${esc(r.snapshot.skill.name)} v${r.snapshot.skill.version} · 설정 v${r.snapshot.agent.configVersion}</p><small>대상 ${esc(r.snapshot.targetVersion)}<br>${esc(r.snapshot.provider)} / ${esc(r.snapshot.model || "모델 설정 필요")}<br>${r.snapshot.execution ? `격리 실행 · ${r.snapshot.execution.mode === "verify" ? "독립 QA" : "코드 수정"} · ${esc(r.progress?.action || "준비 중")}${r.progress?.path ? " · " + esc(r.progress.path) : ""} · ${r.progress?.sequence || 0}/30` : "도구 실행 없음"} · 세대 ${r.generation}</small>${r.snapshot.source?.url ? `<p class="cr-source">고정 저장소 SHA<br>${esc(r.snapshot.source.sha)}</p>` : ""}<code>${esc(r.id)}</code></article>`).join("") || '<p class="cr-empty-inline">아직 시작한 실행이 없어요.</p>'}</section><section class="cw-paper"><h2>결정과 인계</h2>${t.events
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
  )}${area("맡길 일 또는 대화", "goal", "", 'required maxlength="4000"')}${a.owner_id ? '<input type="hidden" name="visibility" value="private">' : scopes("team")}<p class="g-error" data-error></p><button type="submit" class="g-button g-primary">업무방 열고 시작 ${icon("arrow-right")}</button></form><div class="cr-agent-work"><h3>연결된 업무</h3>${
    workspace.tasks
      .filter(
        (t) =>
          t.agent_name === a.name ||
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
function memoryView() {
  const query = drafts.get("memory-search")?.query || "",
    rows = workspace.memories;
  return (
    heading(
      "팀이 쌓아가는 기억",
      "동료별 핵심 기억과 오래된 대화·업무 요약을 출처와 함께 찾아 이어가세요.",
      button("기억 추가", "new-memory", "", true, "plus"),
    ) +
    `<form class="cr-search" data-form="memory-search">${field("기억 검색", "query", query, "search", 'maxlength="200" placeholder="과거 결정이나 업무 내용을 검색"')}<button class="g-button" type="submit">검색 ${icon("search")}</button></form><div class="cr-memory-grid">${rows.map((m) => `<article class="cw-paper cr-memory"><div class="cw-section-heading"><h2>${esc(m.title)}</h2><span class="g-pill">${scopeName[m.visibility]}</span></div><div class="cr-bound-skills"><span class="g-pill">${memoryKindName[m.kind] || "사실"}</span>${m.pinned ? `<span class="g-pill">${icon("pin")} 핵심 기억</span>` : ""}${m.project ? `<span class="g-pill">${esc(m.project)}</span>` : ""}</div><p class="cr-instructions">${esc(m.body)}</p><div class="cr-memory-meta">${esc(agent(m.agent_id)?.name)} · ${esc(m.source)}<br>v${m.revision} · ${stamp(m.updated_at)}</div><details class="cr-history"><summary>정정 이력 ${m.history.length}</summary>${m.history.map((h) => `<div><strong>v${h.revision} · ${esc(h.reason)}</strong><p>${esc(h.body)}</p></div>`).join("") || "<p>정정 이력이 없어요.</p>"}</details>${m.owner_id === workspace.user.id || (workspace.user.role === "lead" && m.visibility !== "private") ? `<div class="cw-actions">${button("바로잡기", "edit-memory", `data-id="${m.id}"`, false, "pencil")}${button("삭제", "delete-memory", `data-id="${m.id}"`, false, "trash-2")}</div>` : ""}</article>`).join("") || '<div class="cw-paper cr-empty-inline">검색할 수 있는 기억이 없어요.</div>'}</div>` +
    (query
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
    }</section><section class="cw-paper cr-admin-section"><h2>구성원과 역할 요청</h2><p class="g-small g-muted">팀원 계정과 소속 부서는 운영 CLI에서 사전 발급합니다. 팀장 요청은 역할 승인 전까지 권한을 부여하지 않습니다.</p>${workspace.members
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
    body =
      field("스킬 이름", "name", "", "text", 'required maxlength="80"') +
      select(
        "공개 대상",
        "scope",
        [
          ["private", "나의 비서 전용"],
          ...(workspace.user.role === "lead" ? [["team", "팀 공용"]] : []),
        ],
        "private",
      ) +
      area("반복 업무 지침", "instructions", "", 'required maxlength="12000"') +
      area("완료 기준", "doneCriteria", "", 'required maxlength="2000"');
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
  if (["new-memory", "edit-memory", "remember"].includes(type)) {
    const m = workspace.memories.find((m) => m.id === data.id),
      a =
        type === "remember"
          ? task.steps[task.step_index].agent_id
          : m?.agent_id;
    title = m ? "기억 바로잡기" : "출처와 함께 기억하기";
    form = m ? "memory-edit" : "memory-create";
    body = !m
      ? select(
          "기억할 동료",
          "agentId",
          workspace.agents.map((a) => [a.id, `${a.name} · ${a.role}`]),
          a,
        ) + scopes(type === "remember" ? task.visibility : "private")
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
    if (!m && type !== "remember")
      body += field(
        "프로젝트 (비우면 공통)",
        "project",
        "",
        "text",
        'maxlength="80"',
      );
    body +=
      field(
        "기억 제목",
        "title",
        m?.title || (type === "remember" ? task.title : ""),
        "text",
        'required maxlength="120"',
      ) +
      area("기억할 내용", "body", m?.body || "", 'required maxlength="10000"') +
      (m
        ? field("정정 이유", "reason", "", "text", 'required maxlength="300"')
        : field(
            "출처",
            "source",
            type === "remember" ? `업무 W-${task.number}` : "",
            "text",
            'required maxlength="500"',
          ));
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
    body = `<p class="cr-note">${esc(data.item.source)} · ${esc(data.item.targetVersion || "버전 미기록")}</p><p class="cr-instructions">${esc(data.item.body)}</p>`;
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
    ["intake", "agent-chat", "message", "memory-search"].includes(
      form.dataset.form,
    )
  )
    drafts.set(draftKey(form), Object.fromEntries(new FormData(form)));
});
root.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || busy) return;
  const { action } = el.dataset;
  try {
    if (action === "navigate") navigate(el.dataset.path);
    if (action === "close") {
      closeDialog();
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
    if (action === "motion") {
      root.classList.toggle("cr-no-motion");
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
    if (kind === "assign")
      await sendCommand("assign", values, Number(form.dataset.revision));
    if (["brief", "rework"].includes(kind)) {
      await sendCommand(kind, values);
      closeDialog();
    }
    if (kind === "agent-chat") {
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
        `/memory/search?q=${encodeURIComponent(values.query)}`,
      );
      archiveResults = recalled.items.filter(
        (m) => !m.key.startsWith("memory:"),
      );
      render();
    }
    if (kind === "memory-create" || kind === "memory-edit")
      values.pinned = values.pinned === "true";
    if (kind === "memory-create") {
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
