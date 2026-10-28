import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import type { CurrentBoardAccess } from "@/api/access";

/** Departments organize the shared roster; they do not grant resource access. */
export const crewroomDepartments = [
  {
    id: "direct",
    name: "팀장 직속",
    description: "방향을 정하고, 팀의 다음 일을 연결해요.",
  },
  {
    id: "development",
    name: "개발",
    description: "아이디어를 작동하는 제품으로 만들어요.",
  },
  {
    id: "operations",
    name: "운영",
    description: "반복되는 일을 정리하고 흐름을 지켜요.",
  },
  { id: "qa", name: "QA", description: "결과를 확인하고 놓친 부분을 찾아요." },
] as const;
export type CrewroomDepartment = (typeof crewroomDepartments)[number]["id"];
export function crewroomAgentMetadata(agent: Pick<Agent, "metadata">) {
  const value = agent.metadata?.crewroom;
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === 1
    ? (value as Record<string, unknown>)
    : {};
}
export function crewroomDepartment(
  agent: Pick<Agent, "metadata">,
): CrewroomDepartment | null {
  const value = crewroomAgentMetadata(agent).departmentId;
  return (
    crewroomDepartments.find((department) => department.id === value)?.id ??
    null
  );
}
export type CrewroomAgentState =
  | "running"
  | "queued"
  | "paused"
  | "error"
  | "available"
  | "unavailable"
  | "preparing"
  | "unknown";
export function crewroomAgentState(
  agent: Pick<Agent, "id" | "status" | "lifecycleState">,
  runs: LiveRunForIssue[] | undefined,
  fresh: boolean,
): CrewroomAgentState {
  if (!fresh || !runs) return "unknown";
  if (runs.some((run) => run.agentId === agent.id && run.status === "running"))
    return "running";
  if (runs.some((run) => run.agentId === agent.id && run.status === "queued"))
    return "queued";
  if (agent.status === "error") return "error";
  if (agent.status === "paused") return "paused";
  if (
    agent.lifecycleState &&
    ["preparing", "verifying", "resuming"].includes(agent.lifecycleState)
  )
    return "preparing";
  if (["terminated", "pending_approval"].includes(agent.status))
    return "unavailable";
  return "available";
}
export const crewroomStateLabels: Record<CrewroomAgentState, string> = {
  running: "작업 중",
  queued: "실행 대기",
  paused: "일시 정지",
  error: "확인 필요",
  available: "대기 중",
  unavailable: "사용 불가",
  preparing: "실행 준비 중",
  unknown: "상태 확인 중",
};
export const crewroomTaskLabels: Record<string, string> = {
  backlog: "예정",
  todo: "할 일",
  in_progress: "진행 중",
  in_review: "검토 중",
  blocked: "막힘",
  done: "완료",
  cancelled: "취소",
};
export function crewroomCanManage(
  access: CurrentBoardAccess | undefined,
  companyId: string | null,
) {
  return Boolean(
    access &&
    (access.source === "local_implicit" ||
      access.isInstanceAdmin ||
      access.memberships?.some(
        (member) =>
          member.companyId === companyId &&
          member.status === "active" &&
          (member.membershipRole === "owner" ||
            member.membershipRole === "admin"),
      )),
  );
}
export function crewroomSortAgents(agents: Agent[]) {
  return [...agents].sort((a, b) => {
    const order = (agent: Agent) => {
      const value = crewroomAgentMetadata(agent).displayOrder;
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : Number.MAX_SAFE_INTEGER;
    };
    return (
      order(a) - order(b) ||
      a.name.localeCompare(b.name, "ko") ||
      a.id.localeCompare(b.id)
    );
  });
}
