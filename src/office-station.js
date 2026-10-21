import { diaryIllustration } from "./work-diary.js";

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Portrait is trusted application markup; all user-visible labels are escaped here.
export function officeStation({
  id,
  name,
  role,
  portrait,
  mode,
  label,
  stage = "",
  taskTitle = "",
  selected = false,
  motion = "type",
  diaryPhase = "ready",
  diaryEnabled = false,
}) {
  const bubble =
    mode === "waiting"
      ? "!"
      : mode === "done"
        ? "✓"
        : mode === "working"
          ? '<span class="g-dot"></span><span class="g-dot"></span><span class="g-dot"></span>'
          : `<i class="g-icon" data-lucide="${mode === "paused" ? "pause" : "coffee"}" aria-hidden="true"></i>`;
  return `<button type="button" class="g-office-station g-plush-station cursor-interaction is-${esc(mode)}" data-action="office-select" data-id="${esc(id)}" data-motion="${esc(motion)}" aria-pressed="${selected}" aria-label="${esc(name)} · ${esc(role)} · ${esc(label)}"><span class="g-desk-scene ${diaryEnabled ? "has-diary-scene" : ""}" aria-hidden="true"><span class="g-desk-floor"></span>${diaryEnabled ? diaryIllustration(diaryPhase) : portrait}<span class="g-station-bubble">${bubble}</span><span class="g-work-desk"></span><span class="g-office-monitor"><span class="g-code-line"></span><span class="g-code-line"></span><span class="g-code-line"></span></span><span class="g-office-keyboard"></span><span class="g-office-paw"></span><span class="g-office-paw second"></span></span><span class="g-station-name">${esc(name)}<span class="g-station-role">${esc(role)}</span></span><span class="g-station-state"><span class="g-dot"></span>${esc(label)}${mode === "working" && stage ? " · " + esc(stage) : ""}</span><span class="g-station-task" data-tooltip="${esc(taskTitle)}">${esc(taskTitle)}</span></button>`;
}

export function agentTask(tasks, id) {
  const order = {
    running: 0,
    failed: 1,
    result_ready: 2,
    paused: 3,
    queued: 4,
    done: 5,
    cancelled: 6,
  };
  return tasks
    .filter((t) => t.agent_id === id)
    .sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        Date.parse(b.updated_at) - Date.parse(a.updated_at),
    )[0];
}
export function stationMode(status) {
  return status === "running"
    ? "working"
    : ["failed", "result_ready"].includes(status)
      ? "waiting"
      : status === "paused"
        ? "paused"
        : status === "done"
          ? "done"
          : "idle";
}
