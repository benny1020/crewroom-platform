import { atlasViewport } from "./plush-sprites.js";
import { characterById, defaultPersonas } from "./data.js";
import { motionAttributes, plushEffects } from "./plush-motion.js";

const esc = (v) =>
  String(v ?? "").replace(
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

export const diaryScenes = {
  ready: [8, 45, 357, 330],
  coding: [374, 55, 346, 317],
  investigating: [730, 60, 350, 320],
  testing: [35, 396, 330, 333],
  review: [397, 405, 310, 324],
  celebrating: [732, 395, 347, 334],
  question: [20, 742, 335, 317],
  writing: [391, 747, 317, 310],
  queued: [735, 770, 345, 290],
  planning: [26, 1071, 344, 330],
  paused: [415, 1090, 288, 310],
  blocked: [707, 1080, 373, 321],
};

export function developerDiaryEnabled(agent) {
  return (
    agent?.id === "dev" &&
    characterById(agent.character, "otter").id === "otter"
  );
}

// Task/Run records choose the scene. A model's summary is never a success signal.
export function diaryState({ task, run, artifact, sample = false } = {}) {
  if (!task)
    return {
      phase: "ready",
      label: "어떤 일을 함께 해볼까요?",
      detail: "새 업무를 맡기면 이곳에서 진행 상황을 볼 수 있어요.",
    };
  if (task.status === "done")
    return {
      phase: "celebrating",
      label: "함께 마무리했어요",
      detail: sample
        ? "샘플 업무의 완료 상태입니다."
        : "책임자가 결과를 수용했어요. 기록은 업무방에 남아 있어요.",
    };
  if (["failed", "cancelled"].includes(task.status))
    return {
      phase: "blocked",
      label:
        task.status === "failed" ? "멈춘 지점을 확인해요" : "업무를 중단했어요",
      detail: "실행 기록을 확인하고 다음 작업을 결정해주세요.",
    };
  if (task.status === "paused")
    return {
      phase: "paused",
      label: "잠깐 멈춰 있어요",
      detail: "저장된 진행 상황에서 다시 이어갈 수 있어요.",
    };
  if (task.status === "queued")
    return {
      phase: "queued",
      label: "차례를 기다리고 있어요",
      detail: "아직 실행 전이에요. 시작되면 작업 상태가 바뀝니다.",
    };
  if (task.status === "needs_input")
    return {
      phase: "question",
      label: "함께 확인할 게 있어요",
      detail: "요청한 내용을 확인하고 답변해주세요.",
    };
  if (task.status === "result_ready") {
    const execution = artifact?.result?.execution,
      current =
        artifact?.id &&
        task.steps?.[task.step_index]?.current_artifact_id === artifact.id &&
        artifact.target_version === task.target_version,
      checked =
        current &&
        artifact.origin === "model" &&
        execution?.passed === true &&
        execution.stopped === true &&
        Array.isArray(execution.checks) &&
        execution.checks.length > 0 &&
        execution.checks.every((c) => c.passed === true && c.exitCode === 0);
    return checked
      ? {
          phase: "celebrating",
          label: "등록한 검사를 통과했어요",
          detail:
            "검사 결과가 준비됐어요. 사람의 결과 확인과 수용은 아직 남아 있어요.",
        }
      : {
          phase: "review",
          label: "결과를 확인해주세요",
          detail: "결과가 준비됐어요. 근거와 미확인 사항을 함께 살펴봐주세요.",
        };
  }
  if (task.status !== "running")
    return {
      phase: "ready",
      label: "업무 기록을 확인해주세요",
      detail: "현재 상태는 업무방에서 확인할 수 있어요.",
    };
  const active =
      task.status === "running" &&
      Boolean(run?.id) &&
      run.id === task.current_run_id &&
      run.status === "running",
    action = active ? run.progress?.action : null;
  if (action === "run_check")
    return {
      phase: "testing",
      label: "등록한 검사를 실행하고 있어요",
      detail: "아직 검사 결과가 확정되지 않았어요.",
    };
  if (["write_file", "apply_patch"].includes(action))
    return {
      phase: "coding",
      label: "코드를 고치고 있어요",
      detail: "수정한 뒤 등록된 검사로 확인해요.",
    };
  if (
    [
      "read_file",
      "list_files",
      "search_memory",
      "read_memory",
      "list_workspace",
      "read_workspace",
    ].includes(action)
  )
    return {
      phase: "investigating",
      label: "필요한 자료를 살펴보고 있어요",
      detail: "현재 업무에 필요한 코드와 근거를 확인해요.",
    };
  if (["write_workspace", "move_workspace"].includes(action))
    return {
      phase: "writing",
      label: "작업 내용을 문서로 남겨요",
      detail: "초안과 진행 기록을 정리하고 있어요. 업무 완료와는 구분해요.",
    };
  return {
    phase: task.work_type === "code-qa" ? "coding" : "planning",
    label: "요청한 일을 진행하고 있어요",
    detail:
      "현재 기록에 맞춰 장면이 바뀝니다. 상세 내용은 업무방에서 확인하세요.",
  };
}

export function diaryIllustration(phase = "ready", className = "") {
  const key = Object.hasOwn(diaryScenes, phase) ? phase : "ready";
  return `<span class="g-diary-illustration ${esc(className)}" data-diary-scene="${key}" aria-hidden="true">${atlasViewport(diaryScenes[key], [1086, 1448])}</span>`;
}

export function workDiary({
  agent,
  task,
  run,
  artifact,
  portrait = "",
  compact = false,
  showTask = true,
  sample = false,
}) {
  if (!agent) return "";
  const state = diaryState({ task, run, artifact, sample }),
    developer = agent.id === "dev",
    title = `${agent.name}의 ${developer ? "개발" : "업무"} 일지`,
    motion = motionAttributes({
      surface: "diary",
      agentId: agent.id,
      character: characterById(
        agent.character,
        defaultPersonas[agent.id]?.character,
      ).id,
      task,
      phase: state.phase,
      artifactId: artifact?.id,
    });
  return `<section class="g-work-diary ${compact ? "is-compact" : ""}" data-phase="${state.phase}" aria-label="${esc(title)}"><div class="g-diary-heading"><h2>${esc(title)}</h2><span>${sample ? "샘플 상태" : "기록 기준"}</span></div><div class="g-diary-body"><div class="g-diary-art" ${motion}>${developerDiaryEnabled(agent) ? diaryIllustration(state.phase) : portrait}${plushEffects()}</div><div class="g-diary-copy"><strong>${esc(state.label)}</strong><p>${esc(state.detail)}</p>${task && showTask ? `<div class="g-diary-task">${esc(task.title)}</div>` : ""}</div></div></section>`;
}
