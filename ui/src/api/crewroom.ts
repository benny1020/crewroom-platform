import { api } from "./client";

export interface CrewroomCapabilities {
  companyId: string;
  canAssignTasks: boolean;
  canCreateUnassignedTask: boolean;
  canConfigureAgents: boolean;
  canCreateAgents: boolean;
}

export const crewroomApi = {
  capabilities: (companyId: string, assigneeAgentId?: string) => {
    const query = assigneeAgentId
      ? `?assigneeAgentId=${encodeURIComponent(assigneeAgentId)}`
      : "";
    return api.get<CrewroomCapabilities>(
      `/companies/${encodeURIComponent(companyId)}/crewroom/capabilities${query}`,
    );
  },
};
