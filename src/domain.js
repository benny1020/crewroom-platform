// Browser prototype contracts. These checks model product behavior; a real
// service must enforce the same rules on an authenticated server.
export const RUNTIMES = {
  hermes: {
    name: "Hermes",
    description: "일반 업무 비서 프로필",
    skills: null,
  },
  letta: {
    name: "Letta Code",
    description: "기억 중심 비서 프로필",
    skills: null,
  },
  openhands: {
    name: "OpenHands",
    description: "저장소 업무 전용 예시 프로필",
    skills: ["bug", "review", "release", "regression"],
  },
};

export const DEMO_USERS = {
  roopre: { department: "development", name: "로프레" },
  minji: { department: "qa", name: "민지" },
};

export function canReadConversation(conversation, userId, users = DEMO_USERS) {
  if (!conversation || !users[userId]) return false;
  if (conversation.owner === userId) return true;
  if (conversation.visibility === "team") return true;
  return (
    conversation.visibility === "department" &&
    users[userId]?.department === conversation.department
  );
}

export function memoryScopeForConversation(
  conversation,
  userId,
  sharedAgent,
  users = DEMO_USERS,
) {
  if (!canReadConversation(conversation, userId, users))
    throw new Error("CONVERSATION_FORBIDDEN");
  if (!sharedAgent || conversation.visibility === "private") {
    return {
      scope: "personal",
      owner: userId,
      agentId: conversation.actorId,
      conversationId: conversation.id,
    };
  }
  if (conversation.visibility === "department") {
    return { scope: "department", owner: conversation.department };
  }
  return { scope: "agent", owner: conversation.actorId };
}

export function runtimeSupportsSkill(runtime, skillId) {
  const profile = RUNTIMES[runtime];
  return Boolean(
    profile && (!profile.skills || profile.skills.includes(skillId)),
  );
}

export function skillBindingStatus({
  attached,
  desired,
  effective,
  running,
  supported,
}) {
  if (!supported) return { id: "unsupported", label: "이 프로필에서 미지원" };
  if (!attached) return { id: "available", label: "장착 가능" };
  if (desired !== effective)
    return { id: "pending", label: "다음 실행부터 적용" };
  if (running && running !== desired)
    return { id: "pinned", label: "진행 실행은 이전 버전" };
  return { id: "applied", label: "적용됨" };
}

export function createRunSnapshot(
  task,
  actor,
  skill,
  previousRuns = [],
  now = new Date().toISOString(),
) {
  const attempt =
    previousRuns.filter((run) => run.taskId === task.id).length + 1;
  const runtime = actor.runtime || "hermes";
  if (!runtimeSupportsSkill(runtime, skill.id))
    throw new Error("UNSUPPORTED_SKILL");
  return {
    id: `${task.id}-R${attempt}`,
    taskId: task.id,
    agentId: task.requesterAgent,
    conversationId: task.conversationId || null,
    attempt,
    generation: 1,
    status: task.status,
    runtime,
    environment: `demo/${task.owner}/${task.requesterAgent}/${task.id}`,
    configVersion: actor.configVersion || 1,
    skillId: skill.id,
    skillVersion: actor.skillPins?.[skill.id] || skill.version,
    snapshot: {
      name: skill.name,
      done: skill.done,
      stages: [...skill.stages],
      harness: actor.harness,
    },
    createdAt: now,
    updatedAt: now,
    events: [],
    simulated: true,
  };
}

export function appendRunEvent(
  run,
  { type, text, generation = run.generation, at = new Date().toISOString() },
) {
  if (generation !== run.generation) throw new Error("STALE_GENERATION");
  const sequence = (run.events.at(-1)?.sequence || 0) + 1;
  const event = {
    id: `${run.id}:${sequence}`,
    sequence,
    generation,
    type,
    text,
    at,
  };
  run.events.push(event);
  run.updatedAt = at;
  return event;
}

export function recoverInterruptedRuns(runs) {
  return runs.map((run) =>
    run.status === "running"
      ? { ...run, status: "paused", recoveryReason: "browser_reload" }
      : run,
  );
}

export function nextVersion(version) {
  const parts = String(version).split(".").map(Number);
  if (
    parts.length < 2 ||
    parts.some((part) => !Number.isInteger(part) || part < 0)
  )
    throw new Error("INVALID_VERSION");
  parts[parts.length - 1] += 1;
  return parts.join(".");
}
