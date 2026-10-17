// Product contracts for the local prototype. Server authorization is not implemented.
import {
  canReadConversation,
  createRunSnapshot,
  appendRunEvent,
} from "./domain.js";

export const WORK_TYPES = {
  "pr-qa": {
    name: "PR 검토 · QA 인계",
    icon: "git-pull-request",
    description: "변경 근거에서 검증 계획까지 같은 업무로",
    done: "같은 커밋의 검토 결과와 QA 계획을 확인하고 수용",
    steps: [
      { id: "review", name: "변경 검토", agentId: "review", skill: "review" },
      { id: "qa", name: "QA 계획", agentId: "qa", skill: "regression" },
    ],
  },
  review: {
    name: "PR 검토",
    icon: "code-2",
    description: "변경 범위·발견 사항·미확인 항목 정리",
    done: "대상 커밋의 발견 사항과 근거를 확인하고 수용",
    steps: [
      { id: "review", name: "변경 검토", agentId: "review", skill: "review" },
    ],
  },
  ops: {
    name: "운영 점검",
    icon: "activity",
    description: "관측 범위와 이상 징후를 한곳에",
    done: "대상 환경·관측 시각·근거·후속 행동을 확인",
    steps: [
      { id: "ops", name: "운영 점검", agentId: "ops", skill: "ops-check" },
    ],
  },
};
const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();
export const visibilityOf = (task) =>
  task.visibility || (task.shared ? "team" : "private");
export function canReadTask(state, task, userId = state.user) {
  return Boolean(
    task &&
    canReadConversation(
      {
        owner: task.owner,
        visibility: visibilityOf(task),
        department: task.department,
      },
      userId,
      state.members,
    ),
  );
}
export function canOperateTask(state, task, userId = state.user) {
  return (
    canReadTask(state, task, userId) &&
    (task.responsible || task.owner) === userId
  );
}
export function canInterveneTask(state, task) {
  return (
    canReadTask(state, task) &&
    visibilityOf(task) !== "private" &&
    state.members[state.user]?.role === "lead"
  );
}
export function requireOperator(state, task) {
  if (!canOperateTask(state, task))
    throw new Error(
      "현재 업무 책임자만 이 동작을 할 수 있어요. 인수를 요청해주세요.",
    );
}
export function targetKey(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(value || "")
      .trim()
      .toLowerCase();
  }
}
export function relatedWork(state, values) {
  const key = targetKey(values.target);
  if (!key) return [];
  return state.tasks
    .filter(
      (task) =>
        task.workflow &&
        canReadTask(state, task) &&
        targetKey(task.target) === key,
    )
    .map((task) => ({
      task,
      same:
        task.workType === values.workType &&
        task.targetVersion === values.targetVersion &&
        visibilityOf(task) === values.visibility,
    }));
}
export function workflowEvent(
  state,
  task,
  text,
  type = "decision",
  actor = { actorType: "user", actorId: state.user },
) {
  const event = {
    id: uid("event"),
    actor: actor.actorId,
    ...actor,
    text,
    type,
    at: now(),
    time: new Date().toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
  task.events.push(event);
  task.updatedAt = event.at;
  return event;
}
export function initializeWorkflows(state) {
  state.artifacts ||= [];
  state.intakeDrafts ||= {};
  state.skillStewards ||= { regression: "minji", review: "roopre" };
  state.visits ||= {};
  for (const task of state.tasks) {
    task.visibility ||= task.shared ? "team" : "private";
    task.department ||= state.members[task.owner]?.department || "development";
    task.responsible ||= task.owner;
    task.claims ||= [];
    task.discussion ||= [];
  }
  if (!state.workflowSeeded) {
    state.workflowSeeded = true;
    const task = createWorkflow(state, {
      workType: "pr-qa",
      target: "https://github.com/example/product/pull/124",
      targetVersion: "a81f9c2",
      visibility: "team",
      project: "제품 웹",
      goal: "로그인 세션 변경을 검토하고 QA 계획까지 이어주세요.",
    });
    task.title = "로그인 세션 변경 · PR #124";
    const run = startWorkflowRun(state, task, [
      {
        id: "review",
        name: "코드 리뷰",
        version: "1.2",
        done: WORK_TYPES["pr-qa"].done,
        stages: ["대상 확인", "검토", "결과 정리"],
      },
    ]);
    completeWorkflowRun(state, task, run.id, run.generation);
    task.brief = {
      targetVersion: task.targetVersion,
      version: 1,
      text: "로그인 만료와 동시 요청을 중심으로 QA 범위를 정해주세요. 검토 보고서는 시연 예시이며 실제 저장소 검사는 수행하지 않았습니다.",
      source: task.artifactIds[0],
      history: [],
    };
    workflowEvent(
      state,
      task,
      "검토 결과 준비. 같은 버전의 QA 계획으로 이어갈 수 있어요.",
      "handoff",
    );
  }
  for (const task of state.tasks.filter((t) => t.workflow)) {
    const conversation = state.conversations.find(
      (c) => c.id === task.conversationId,
    );
    if (conversation) {
      conversation.visibility = visibilityOf(task);
      conversation.department = task.department;
    }
    const legacyMessages = state.messages[task.conversationId] || [];
    if (legacyMessages.length) {
      task.discussion.push(
        ...legacyMessages.map((m) => ({
          ...m,
          migratedFromConversation: task.conversationId,
        })),
      );
      state.messages[task.conversationId] = [];
    }
  }
  state.schema = 10;
}
export function createWorkflow(state, values) {
  const type = WORK_TYPES[values.workType];
  if (
    !type ||
    !String(values.target || "").trim() ||
    !String(values.targetVersion || "").trim()
  )
    throw new Error("업무 대상과 대상 버전을 입력해주세요.");
  if (!["private", "department", "team"].includes(values.visibility))
    throw new Error("공개 범위를 확인해주세요.");
  if (values.target.length > 500 || values.targetVersion.length > 80)
    throw new Error("대상은 500자, 버전은 80자 이내로 입력해주세요.");
  const id = `W-${(state.workflowCounter = (state.workflowCounter || 200) + 1)}`;
  const conversationId = uid("c-task");
  const task = {
    id,
    workflow: true,
    workType: values.workType,
    title:
      values.goal?.slice(0, 110) ||
      `${type.name} · ${values.target.split("/").at(-1)}`,
    owner: state.user,
    responsible: state.user,
    visibility: values.visibility,
    shared: values.visibility === "team",
    department: state.members[state.user].department,
    target: values.target.trim(),
    targetVersion: values.targetVersion.trim(),
    project: values.project || "제품 웹",
    env: values.workType === "ops" ? "관측 계획" : "검토 대상",
    goal: values.goal || type.done,
    doneCriteria: type.done,
    status: "queued",
    stage: 0,
    stepIndex: 0,
    skill: type.steps[0].skill,
    requesterAgent: type.steps[0].agentId,
    steps: structuredClone(type.steps),
    conversationId,
    artifactIds: [],
    discussion: [],
    events: [],
    claims: [],
    brief: {
      targetVersion: values.targetVersion.trim(),
      version: 1,
      text: values.goal || "업무 대상과 완료 기준을 확인해 주세요.",
      source: "request",
      history: [],
    },
    createdAt: now(),
    updatedAt: now(),
  };
  if (values.exampleId) {
    const artifact = state.artifacts.find((a) => a.id === values.exampleId);
    const sourceTask = state.tasks.find((t) => t.id === artifact?.taskId);
    if (
      !artifact?.acceptedBy ||
      !canReadTask(state, sourceTask) ||
      sourceTask.project !== task.project ||
      visibilityOf(sourceTask) !== task.visibility ||
      (task.visibility === "department" &&
        sourceTask.department !== task.department) ||
      (task.visibility === "private" && sourceTask.owner !== task.owner)
    )
      throw new Error(
        "같은 프로젝트·공개 범위의 수용한 결과만 예시로 사용할 수 있어요.",
      );
    task.exampleId = artifact.id;
    task.doneCriteria = sourceTask.doneCriteria;
  }
  state.tasks.unshift(task);
  state.conversations.push({
    id: conversationId,
    actorId: task.requesterAgent,
    agentIds: task.steps.map((s) => s.agentId),
    taskId: id,
    owner: task.owner,
    visibility: task.visibility,
    department: task.department,
    title: task.title,
    createdAt: now(),
  });
  state.messages[conversationId] = [];
  workflowEvent(
    state,
    task,
    `${state.members[state.user].name}가 업무를 접수했어요. 대상 ${task.targetVersion}`,
    "request",
  );
  return task;
}
export function startWorkflowRun(state, task, skills) {
  requireOperator(state, task);
  if (!["queued", "paused"].includes(task.status))
    throw new Error("현재 상태에서는 실행할 수 없어요.");
  const step = task.steps[task.stepIndex];
  if (
    state.tasks.some(
      (t) =>
        t.id !== task.id &&
        t.workflow &&
        t.requesterAgent === step.agentId &&
        ["running", "paused"].includes(t.status),
    )
  )
    throw new Error(
      "이 동료의 다른 실행이 진행·재개 대기 중이에요. 해당 업무를 마치거나 중단한 뒤 시작해주세요.",
    );
  let run = state.runs.find((r) => r.id === task.runId);
  if (task.status === "paused" && run?.status === "paused") {
    run.generation += 1;
    delete run.recoveryReason;
  } else {
    const actor = state.agents.find((a) => a.id === step.agentId);
    const skill = skills.find((s) => s.id === step.skill);
    if (!actor || !skill || !skill.version)
      throw new Error("필요한 담당 동료와 스킬 버전을 찾을 수 없어요.");
    task.requesterAgent = step.agentId;
    task.skill = step.skill;
    run = createRunSnapshot(task, actor, skill, state.runs);
    run.stepId = step.id;
    run.targetVersion = task.targetVersion;
    run.inputArtifactId = step.inputArtifactId || null;
    run.environment = `demo/runs/${run.id}`;
    run.snapshot = {
      ...run.snapshot,
      instruction: actor.instruction || actor.note || "",
      doneCriteria: task.doneCriteria,
      outputSchemaVersion: "1",
      templateVersion: "1",
    };
    state.runs.push(run);
    task.runId = run.id;
    step.runIds = [...(step.runIds || []), run.id];
  }
  task.status = run.status = "running";
  task.updatedAt = now();
  appendRunEvent(run, {
    type: "started",
    text: `${step.name} · 대상 ${run.targetVersion} · 로컬 시연 시작`,
  });
  workflowEvent(
    state,
    task,
    `${step.name} 시연 시작. 적용 버전과 입력 결과를 실행에 고정했어요.`,
    "run",
  );
  return run;
}
export function completeWorkflowRun(state, task, runId, generation) {
  const run = state.runs.find((r) => r.id === runId);
  if (
    !run ||
    task.runId !== runId ||
    task.status !== "running" ||
    generation == null ||
    generation !== run.generation
  )
    return false;
  const step = task.steps[task.stepIndex];
  if (
    run.stepId !== step.id ||
    run.targetVersion !== task.targetVersion ||
    run.inputArtifactId !== (step.inputArtifactId || null)
  )
    return false;
  run.status = "succeeded";
  appendRunEvent(run, {
    type: "result_ready",
    text: "샘플 결과 준비. 실제 코드 검사·테스트는 실행하지 않았습니다.",
  });
  const version =
    state.artifacts.filter((a) => a.taskId === task.id && a.stepId === step.id)
      .length + 1;
  const artifact = {
    id: uid("artifact"),
    taskId: task.id,
    stepId: step.id,
    runId: run.id,
    agentId: run.agentId,
    version,
    targetVersion: run.targetVersion,
    origin: "simulation",
    structure: "valid",
    verification: "unverified",
    createdAt: now(),
    title: `${step.name} 보고서`,
    body:
      step.id === "qa"
        ? "검증 계획: 세션 만료 후 갱신, 여러 탭의 동시 요청, 재로그인 흐름을 확인합니다.\n실제 결과: 미실행. 환경과 검사 근거를 연결한 뒤 판단해야 합니다."
        : "검토 범위: 요청한 대상 버전의 변경 사항과 후속 검증 범위를 정리합니다.\n확인 필요: 실제 코드 위치, 실행 로그, 재현 환경.\n이 결과는 업무 흐름을 체험하기 위한 샘플입니다.",
    evidence: [
      { label: "요청과 대상 버전", ref: "request" },
      { label: "시연 실행 기록", ref: run.id },
    ],
    inputArtifactId: step.inputArtifactId || null,
  };
  state.artifacts.push(artifact);
  task.artifactIds.push(artifact.id);
  step.artifactId = artifact.id;
  step.status = "result_ready";
  task.status = "result_ready";
  task.stage = 5;
  workflowEvent(
    state,
    task,
    `${step.name} 결과 v${version} 준비 · 아직 업무 완료가 아니에요.`,
    "result",
    { actorType: "run", actorId: run.id },
  );
  return artifact;
}
export function importResult(state, values) {
  if (!values.body?.trim() || !values.source?.trim())
    throw new Error("공유할 결과와 출처를 입력해주세요.");
  if (values.body.length > 5000 || values.source.length > 500)
    throw new Error("결과는 5,000자, 출처는 500자 이내로 입력해주세요.");
  const task = createWorkflow(state, { ...values, workType: "pr-qa" });
  const artifact = {
    id: uid("artifact"),
    taskId: task.id,
    stepId: "review",
    runId: null,
    agentId: null,
    version: 1,
    targetVersion: task.targetVersion,
    origin: "external",
    structure: "draft",
    verification: "unverified",
    title: "가져온 검토 결과",
    body: values.body.trim(),
    source: values.source.trim(),
    importedByUserId: state.user,
    originalAuthor: null,
    createdAt: now(),
    evidence: [{ label: values.source.trim(), ref: "external" }],
  };
  state.artifacts.push(artifact);
  task.artifactIds.push(artifact.id);
  task.steps[0].artifactId = artifact.id;
  task.steps[0].status = "result_ready";
  task.status = "result_ready";
  task.brief.text =
    "선택한 결과만 가져왔습니다. 출처와 대상 버전을 확인한 뒤 QA에 넘겨주세요.";
  task.brief.source = artifact.id;
  workflowEvent(
    state,
    task,
    "외부 결과 가져오기 · 크루룸에서 내용·검사 근거를 검증하지 않았어요.",
    "import",
  );
  return task;
}
export function handoffWorkflow(state, task) {
  requireOperator(state, task);
  const current = task.steps[task.stepIndex];
  const artifact = state.artifacts.find((a) => a.id === current.artifactId);
  const next = task.steps[task.stepIndex + 1];
  if (
    task.status !== "result_ready" ||
    !next ||
    !artifact ||
    artifact.targetVersion !== task.targetVersion
  )
    throw new Error("현재 대상 버전의 결과를 먼저 준비해주세요.");
  next.inputArtifactId = artifact.id;
  current.status = "handed_off";
  task.stepIndex += 1;
  task.requesterAgent = next.agentId;
  task.skill = next.skill;
  task.runId = null;
  task.stage = 0;
  task.status = "queued";
  workflowEvent(
    state,
    task,
    `${current.name} 결과 v${artifact.version} → ${next.name}. 대상 ${task.targetVersion}를 유지해요.`,
    "handoff",
  );
}
export function acceptWorkflow(state, task) {
  requireOperator(state, task);
  const artifact = state.artifacts.find(
    (a) => a.id === task.steps[task.stepIndex].artifactId,
  );
  if (
    task.status !== "result_ready" ||
    task.stepIndex !== task.steps.length - 1 ||
    !artifact ||
    artifact.targetVersion !== task.targetVersion
  )
    throw new Error("모든 단계의 현재 버전 결과를 확인해주세요.");
  artifact.acceptedBy = state.user;
  artifact.acceptedAt = now();
  task.acceptedArtifactId = artifact.id;
  task.status = "done";
  workflowEvent(
    state,
    task,
    `${state.members[state.user].name}가 결과 v${artifact.version}를 수용했어요. 실제 검증 여부는 결과의 근거를 따릅니다.`,
    "accept",
  );
}
export function reworkWorkflow(
  state,
  task,
  reason,
  targetVersion = task.targetVersion,
) {
  requireOperator(state, task);
  if (
    !["result_ready", "done", "cancelled"].includes(task.status) ||
    !reason?.trim()
  )
    throw new Error("결과를 확인하고 재작업 이유를 남겨주세요.");
  if (!targetVersion.trim() || targetVersion.length > 80)
    throw new Error("대상 버전을 확인해주세요.");
  const previousBrief = {
    ...task.brief,
    history: undefined,
    at: now(),
    actor: state.user,
    reason: reason.trim(),
  };
  task.targetVersion = targetVersion.trim();
  task.stepIndex = 0;
  task.steps = structuredClone(WORK_TYPES[task.workType].steps);
  task.brief = {
    version: task.brief.version + 1,
    targetVersion: task.targetVersion,
    text: task.goal,
    source: "request",
    history: [...task.brief.history, previousBrief],
  };
  delete task.acceptedArtifactId;
  task.status = "queued";
  task.runId = null;
  task.stage = 0;
  task.requesterAgent = task.steps[task.stepIndex].agentId;
  task.skill = task.steps[task.stepIndex].skill;
  delete task.steps[task.stepIndex].artifactId;
  task.steps[task.stepIndex].status = "queued";
  workflowEvent(
    state,
    task,
    `재작업: ${reason.trim()} · 대상 ${task.targetVersion}, 첫 단계부터 다시 시작`,
    "rework",
  );
}
export function reassignWorkflow(state, task, userId) {
  if (!(canOperateTask(state, task) || canInterveneTask(state, task)))
    throw new Error("책임자 또는 팀장만 담당을 바꿀 수 있어요.");
  if (!canReadTask(state, task, userId))
    throw new Error("이 업무를 볼 수 있는 구성원을 선택해주세요.");
  task.responsible = userId;
  task.claims = task.claims.filter((id) => id !== userId);
  workflowEvent(
    state,
    task,
    `${state.members[state.user].name}가 책임자를 ${state.members[userId].name}(으)로 변경했어요.`,
    "assignment",
  );
}
export function correctBrief(state, task, values) {
  requireOperator(state, task);
  if (!values.text?.trim() || !values.reason?.trim() || !values.source)
    throw new Error("내용·정정 이유·근거를 모두 남겨주세요.");
  const allowed = [
    "request",
    ...task.artifactIds,
    ...task.events.map((e) => e.id).filter(Boolean),
  ];
  if (!allowed.includes(values.source))
    throw new Error("이 업무의 근거를 선택해주세요.");
  task.brief.history.push({
    version: task.brief.version,
    targetVersion: task.brief.targetVersion,
    text: task.brief.text,
    source: task.brief.source,
    at: now(),
    actor: state.user,
    reason: values.reason,
  });
  Object.assign(task.brief, {
    version: task.brief.version + 1,
    text: values.text,
    source: values.source,
  });
  workflowEvent(state, task, `업무 요약 정정: ${values.reason}`, "correction");
}
