import { useQuery } from "@tanstack/react-query";
import { crewroomApi } from "@/api/crewroom";

export function useCrewroomCapabilities(
  companyId: string | null,
  assigneeAgentId?: string,
) {
  return useQuery({
    queryKey: ["crewroom", "capabilities", companyId, assigneeAgentId ?? null],
    queryFn: () => crewroomApi.capabilities(companyId!, assigneeAgentId),
    enabled: Boolean(companyId),
    retry: false,
  });
}
