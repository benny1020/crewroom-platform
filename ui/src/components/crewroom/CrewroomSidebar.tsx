import {
  Blocks,
  Building2,
  ChevronRight,
  CircleUserRound,
  House,
  ListChecks,
  Plus,
  Settings2,
  Users,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useDialogActions } from "@/context/DialogContext";
import { useCrewroomCapabilities } from "@/hooks/useCrewroomCapabilities";
import { useLocation, Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import {
  crewroomCanManage,
  crewroomDepartment,
  crewroomDepartments,
} from "@/lib/crewroom";
import { SidebarNavItem } from "@/components/SidebarNavItem";
import { Button } from "@/components/ui/button";
import { CrewroomCharacter } from "./CrewroomCharacter";

export function CrewroomSidebar() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { collapsed, peeking } = useSidebar();
  const { openNewIssue } = useDialogActions();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const isHome = location.pathname.endsWith("/crewroom");
  const rail = collapsed && !peeking;
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const capabilities = useCrewroomCapabilities(selectedCompanyId);
  return (
    <aside className="crewroom-sidebar flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground">
      <Link
        to="/crewroom"
        className="crewroom-brand flex items-center gap-3 px-5 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Crewroom 홈"
      >
        <span className="crewroom-brand-mark">
          <Users className="size-5" />
        </span>
        {!rail && (
          <span className="flex min-w-0 flex-col gap-1">
            <strong className="text-lg font-semibold">Crewroom</strong>
            <span className="truncate text-xs text-muted-foreground">
              {selectedCompany?.name ?? "우리 팀의 작업 공간"}
            </span>
          </span>
        )}
      </Link>
      <nav
        aria-label="팀 탐색"
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto py-2"
      >
        <div className="flex flex-col gap-1">
          <SidebarNavItem
            to="/crewroom"
            label="팀 공간"
            icon={House}
            active={
              isHome &&
              !params.has("department") &&
              !params.has("view") &&
              !params.has("agent")
            }
          />
          <SidebarNavItem
            to="/crewroom?view=personal"
            label="내 기본 비서"
            icon={CircleUserRound}
            active={isHome && params.get("view") === "personal"}
          />
          <SidebarNavItem to="/issues" label="업무" icon={ListChecks} />
          <SidebarNavItem
            to="/crewroom?view=skills"
            label="스킬 실행"
            icon={Blocks}
            active={isHome && params.get("view") === "skills"}
          />
        </div>
        <div className="flex flex-col gap-1">
          {!rail && (
            <p className="px-4 pb-2 text-xs font-medium text-muted-foreground">
              부서 워크룸
            </p>
          )}
          {crewroomDepartments.map((department) => (
            <SidebarNavItem
              key={department.id}
              to={`/crewroom?department=${department.id}`}
              label={department.name}
              icon={Building2}
              active={isHome && params.get("department") === department.id}
              trailing={
                !rail && agents.data ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {
                      agents.data.filter(
                        (agent) =>
                          agent.status !== "terminated" &&
                          crewroomDepartment(agent) === department.id,
                      ).length
                    }
                  </span>
                ) : undefined
              }
            />
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <SidebarNavItem to="/agents/all" label="에이전트 명부" icon={Users} />
          <SidebarNavItem to="/skills" label="스킬 라이브러리" icon={Blocks} />
          {crewroomCanManage(access.data, selectedCompanyId) && (
            <SidebarNavItem
              to="/company/settings/members"
              label="팀 설정"
              icon={Settings2}
            />
          )}
        </div>
      </nav>
      <div className="flex flex-col gap-4 p-3">
        <Button
          disabled={
            !capabilities.isSuccess ||
            !capabilities.data.canCreateUnassignedTask
          }
          onClick={() => openNewIssue({ navigateOnCreate: true })}
          className="w-full"
          aria-label="새 업무 만들기"
        >
          <Plus className="size-4" />
          {!rail && "새 업무 만들기"}
        </Button>
        {!rail && (
          <div className="crewroom-sidebar-note flex items-center gap-3 rounded-xl bg-muted/50 px-3 py-3">
            <CrewroomCharacter mascot />
            <span className="flex flex-col gap-1">
              <span className="text-xs font-medium">함께, 차근차근.</span>
              <Link
                to="/crewroom?view=personal"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                내 기본 비서 만나기
                <ChevronRight className="size-3" />
              </Link>
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
