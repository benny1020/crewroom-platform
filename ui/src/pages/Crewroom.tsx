import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  ChevronRight,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { companySkillsApi } from "@/api/companySkills";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useCrewroomCapabilities } from "@/hooks/useCrewroomCapabilities";
import { usePrimaryAgentPresentation } from "@/components/primary-agent/PrimaryAgentPresentation";
import {
  useAgentChatNavigation,
  useOpenAgentChat,
} from "@/hooks/useAgentChatNavigation";
import { MotionPreview } from "@/components/crewroom/MotionPreview";
import { CrewroomCharacter } from "@/components/crewroom/CrewroomCharacter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import {
  crewroomAgentState,
  crewroomSortAgents,
  crewroomCanManage,
  crewroomDepartment,
  crewroomDepartments,
} from "@/lib/crewroom";

import {
  ReadError,
  Empty,
  State,
  SectionTitle,
  RosterSkeleton,
  TaskData,
  RunList,
} from "@/components/crewroom/CrewroomPrimitives";
import { PersonalSpace } from "@/components/crewroom/PersonalSpace";
import { SkillsSection } from "@/components/crewroom/SkillsSection";
export function Crewroom() {
  const { selectedCompanyId: companyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const department = crewroomDepartments.find(
    (item) => item.id === params.get("department"),
  );
  const agentId = params.get("agent");
  const view = params.get("view");
  const personal = view === "personal";
  const skillsView = view === "skills";
  const [search, setSearch] = useState("");
  const [motion, setMotion] = useState(() => {
    try { return localStorage.getItem("crewroom.character-motion") !== "off"; } catch { return true; }
  });
  const scope = useRef({ companyId, userId: null as string | null });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const runs = useQuery({
    queryKey: queryKeys.liveRuns(companyId!),
    queryFn: () =>
      heartbeatsApi.liveRunsForCompany(companyId!, { minCount: 0 }),
    enabled: !!companyId,
  });
  const tasks = useQuery({
    queryKey: [...queryKeys.issues.list(companyId!), "crewroom", agentId],
    queryFn: () =>
      issuesApi.list(companyId!, {
        ...(agentId
          ? { assigneeAgentId: agentId }
          : { status: "todo,in_progress,in_review,blocked" }),
        limit: 50,
      }),
    enabled: !!companyId,
  });
  const skills = useQuery({
    queryKey: [...queryKeys.companySkills.list(companyId!), "crewroom", "company", "recent"],
    queryFn: () =>
      companySkillsApi.list(companyId!, { scope: "company", sort: "recent" }),
    enabled: !!companyId,
  });
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const capabilities = useCrewroomCapabilities(companyId, agentId ?? undefined);
  const [memberView, setMemberView] = useState(false);
  const primary = usePrimaryAgentPresentation(companyId);
  const chat = useAgentChatNavigation();
  const openChat = useOpenAgentChat(companyId, chat.userId);
  const [opening, setOpening] = useState(false);
  const [chatError, setChatError] = useState<{ message: string; agent: Agent } | null>(null);
  useEffect(() => {
    const current = { companyId, userId: chat.userId };
    scope.current = current;
    setOpening(false);
    setChatError(null);
  }, [companyId, chat.userId]);
  const roster = crewroomSortAgents(
    agents.data?.filter((agent) => agent.status !== "terminated") ?? [],
  );
  const selectedAgent = roster.find((agent) => agent.id === agentId);
  const fresh = runs.isSuccess && !runs.isRefetchError;
  const visibleAgents = useMemo(
    () =>
      roster.filter(
        (agent) =>
          (!department || crewroomDepartment(agent) === department.id) &&
          (!search.trim() ||
            `${agent.name} ${agent.title ?? ""} ${agent.capabilities ?? ""}`
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase())),
      ),
    [agents.data, department, search],
  );
  const title = selectedAgent
    ? `${selectedAgent.name}의 워크룸`
    : skillsView
      ? "스킬 실행"
      : personal
        ? "내 기본 비서"
        : department
          ? department.name
          : "팀 공간";
  useEffect(() => {
    setBreadcrumbs([
      { label: "Crewroom", href: "/crewroom" },
      { label: title },
    ]);
  }, [setBreadcrumbs, title]);
  useEffect(() => {
    setSearch("");
  }, [department?.id, view, agentId]);
  const startChat = async (agent: Agent) => {
    const current = scope.current;
    setOpening(true);
    setChatError(null);
    try {
      await openChat(agent);
    } catch {
      if (scope.current !== current) return;
      setChatError({
        agent,
        message: "개인 대화를 열지 못했어요. 접근 권한과 기존 대화의 비공개 설정을 확인한 뒤 다시 시도해 주세요.",
      });
    } finally {
      if (scope.current === current) setOpening(false);
    }
  };
  if (!companyId)
    return (
      <div className="crewroom-page">
        <Empty>
          연결된 팀이 없어요. 팀을 선택하거나 먼저 팀을 만들어 주세요.
        </Empty>
      </div>
    );
  const scopedTasks =
    tasks.data?.filter(
      (task) =>
        !department ||
        roster.some(
          (agent) =>
            agent.id === task.assigneeAgentId &&
            crewroomDepartment(agent) === department.id,
        ),
    ) ?? [];
  const observedRuns =
    runs.data?.filter(
      (run) => run.status === "running" || run.status === "queued",
    ) ?? [];
  const canManage = crewroomCanManage(access.data, companyId);
  const requestAgent = selectedAgent ?? primary?.primaryAgent;
  return (
    <section className="crewroom-page" aria-labelledby="crewroom-title" data-motion={motion ? "on" : "off"}>
      <header className="crewroom-page-header flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1
            id="crewroom-title"
            className="text-2xl font-semibold tracking-tight"
          >
            {title}
          </h1>
          <p className="text-sm text-muted-foreground">
            {selectedAgent
              ? (selectedAgent.capabilities ??
                selectedAgent.title ??
                "진행 중인 업무와 결과를 한곳에서 이어가세요.")
              : personal
                ? "생각을 정리하고, 필요한 일을 팀에 연결하세요."
                : skillsView
                  ? "팀이 함께 쓰는 방법을 골라 실제 업무로 시작하세요."
                  : (department?.description ??
                    `${selectedCompany?.name ?? "우리 팀"}의 동료와 지금 하는 일을 한눈에.`)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              aria-pressed={memberView}
              onClick={() => setMemberView((value) => !value)}
            >
              {memberView ? "팀장 보기로" : "팀원 보기로"}
            </Button>
          )}
                  <Button variant="ghost" size="sm" aria-pressed={motion}
                    onClick={() => setMotion(value => {
                      try { localStorage.setItem("crewroom.character-motion", value ? "off" : "on"); } catch { /* Optional preference. */ }
                      return !value;
                    })}>
                    {motion ? <Pause className="size-3" /> : <Play className="size-3" />}
                    {motion ? "동작 멈추기" : "동작 켜기"}
                  </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="팀 상태 새로고침"
            onClick={() => {
              void agents.refetch();
              void runs.refetch();
              void tasks.refetch();
            }}
          >
            <RefreshCw className="size-4" />
          </Button>
          <Button
            variant="outline"
            disabled={
              !capabilities.isSuccess ||
              !(agentId
                ? capabilities.data.canAssignTasks
                : capabilities.data.canCreateUnassignedTask)
            }
            onClick={() =>
              openNewIssue({
                ...(selectedAgent ? { assigneeAgentId: selectedAgent.id } : {}),
                navigateOnCreate: true,
              })
            }
          >
            <Plus className="size-4" />새 업무
          </Button>
          {requestAgent ? <Button disabled={!chat.enabled || opening}
            onClick={() => startChat(requestAgent)}>
            <MessageCircle className="size-4" />
            {opening ? "대화 여는 중…" : "대화로 요청하기"}
          </Button> : <Button asChild variant="outline">
            <Link to="/crewroom?view=personal">기본 비서 선택</Link>
          </Button>}
        </div>
      </header>
      {capabilities.error && (
        <ReadError
          message="업무 생성 권한을 확인하지 못했어요. 확인될 때까지 생성 기능을 잠시 멈춰요."
          retry={capabilities.refetch}
        />
      )}
      {canManage && !memberView && (
        <div className="crewroom-manager-tools flex flex-wrap items-center gap-4 rounded-lg bg-muted/40 px-4 py-3 text-xs">
          <span className="font-medium">팀장 보기</span>
          <Link
            className="text-muted-foreground hover:text-foreground"
            to="/approvals"
          >
            승인 검토
          </Link>
          <Link
            className="text-muted-foreground hover:text-foreground"
            to="/company/settings/members"
          >
            팀원과 권한
          </Link>
          <Link
            className="text-muted-foreground hover:text-foreground"
            to="/costs"
          >
            사용량 확인
          </Link>
          <span className="ml-auto text-muted-foreground">
            보기 전환은 권한을 바꾸지 않아요.
          </span>
        </div>
      )}
      {chatError && (
        <ReadError message={chatError.message} retry={() => startChat(chatError.agent)} />
      )}
      {personal ? (
        <PersonalSpace
          key={companyId}
          companyId={companyId}
          agents={roster}
          primary={primary}
          enabled={chat.enabled}
          loaded={chat.loaded}
          opening={opening}
          onChat={startChat}
        />
      ) : skillsView ? (
        <SkillsSection key={companyId} companyId={companyId} agents={roster} query={skills} />
      ) : selectedAgent ? (
        <div className="crewroom-workroom-grid">
          <section className="flex min-w-0 flex-col gap-6">
            <Link
              to={
                crewroomDepartment(selectedAgent)
                  ? `/crewroom?department=${crewroomDepartment(selectedAgent)}`
                  : "/crewroom"
              }
              className="inline-flex items-center gap-2 self-start text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              명부로 돌아가기
            </Link>
            <div className="crewroom-workroom-identity flex flex-wrap items-center gap-5 rounded-xl bg-muted/40 p-6">
              <CrewroomCharacter
                agent={selectedAgent}
                state={crewroomAgentState(selectedAgent, runs.data, fresh)}
                run={observedRuns.find(run => run.agentId === selectedAgent.id && run.status === "running")}
                large
              />
              <div className="flex flex-1 flex-col gap-3">
                <h2 className="text-xl font-semibold">
                  {selectedAgent.name}의 {crewroomDepartment(selectedAgent) === "development" ? "개발" : "업무"} 일지
                </h2>
                <p className="text-sm text-muted-foreground">
                  {selectedAgent.title ?? selectedAgent.role}
                </p>
                <State
                  state={crewroomAgentState(selectedAgent, runs.data, fresh)}
                />
              </div>
              <Button
                variant="outline"
                disabled={!chat.enabled || opening}
                onClick={() => startChat(selectedAgent)}
              >
                <MessageCircle className="size-4" />
                개인 대화
              </Button>
            </div>
            <div>
              <SectionTitle title="워크룸 업무" />
              <p className="mt-2 text-xs text-muted-foreground">업무를 열어 의견을 남기거나 수정 요청을 이어가세요.</p>
              <TaskData query={tasks} tasks={scopedTasks} />
            </div>
          </section>
          <aside className="crewroom-context">
            <h2 className="text-sm font-semibold">현재 실행</h2>
            <RunList
              runs={observedRuns.filter(
                (run) => run.agentId === selectedAgent.id,
              )}
              error={runs.error}
              loading={runs.isPending}
            />
          </aside>
        </div>
      ) : agentId && agents.isPending ? (
        <RosterSkeleton />
      ) : agentId && agents.error ? (
        <ReadError message="워크룸의 동료 정보를 불러오지 못했어요." retry={agents.refetch} />
      ) : agentId ? (
        <Empty>
          해당 에이전트를 찾을 수 없거나 접근할 수 없어요.
          <Link to="/crewroom" className="ml-2 underline">
            팀 공간으로 돌아가기
          </Link>
        </Empty>
      ) : (
        <div className="crewroom-main-grid">
          <section className="flex min-w-0 flex-col gap-8">
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SectionTitle
                  title={
                    department ? `${department.name} 동료` : "함께하는 동료"
                  }
                  aside={
                    agents.isSuccess ? `${visibleAgents.length}명` : undefined
                  }
                />
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="crewroom-search-icon absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    aria-label="동료 검색"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="이름, 역할 검색"
                    className="pl-9"
                  />
                </div>
              </div>
              {agents.error ? (
                <ReadError
                  message="에이전트 명부를 불러오지 못했어요."
                  retry={agents.refetch}
                />
              ) : agents.isPending ? (
                <RosterSkeleton />
              ) : visibleAgents.length ? (
                <div className="crewroom-roster">
                  {visibleAgents.map((agent) => (
                    <Link
                      key={agent.id}
                      to={`/crewroom?agent=${encodeURIComponent(agent.id)}`}
                      className="crewroom-agent group"
                    >
                      <CrewroomCharacter
                        agent={agent}
                        state={crewroomAgentState(agent, runs.data, fresh)}
                        run={observedRuns.find(run => run.agentId === agent.id && run.status === "running")}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate text-sm font-semibold group-hover:text-primary">
                            {agent.name}
                          </h3>
                          {primary?.primaryAgentId === agent.id && (
                            <span className="crewroom-personal-tag text-xs">
                              내 기본 비서
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {crewroomDepartments.find(
                            (item) => item.id === crewroomDepartment(agent),
                          )?.name ?? "미분류"}{" "}
                          · {agent.title ?? agent.capabilities ?? agent.role}
                        </p>
                        <State
                          state={crewroomAgentState(agent, runs.data, fresh)}
                        />
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </Link>
                  ))}
                </div>
              ) : (
                <Empty
                  action={
                    capabilities.data?.canCreateAgents ? (
                      <Button asChild variant="outline">
                        <Link to="/agents/new">에이전트 추가</Link>
                      </Button>
                    ) : undefined
                  }
                >
                  {search
                    ? "검색 결과가 없어요. 다른 이름이나 역할로 찾아보세요."
                    : department
                      ? "이 부서에 등록된 동료가 없어요. 에이전트의 부서가 지정되면 이곳에 나타나요."
                      : "아직 등록된 동료가 없어요. 첫 에이전트를 연결하면 실제 상태와 워크룸이 나타나요."}
                </Empty>
              )}
              {runs.isRefetchError && (
                <ReadError
                  message="실행 상태를 갱신하지 못했어요. 동료의 현재 상태는 확인 중으로 표시해요."
                  retry={runs.refetch}
                />
              )}
            </div>
            <MotionPreview />
            <div>
              <div className="flex items-center justify-between gap-3">
                <SectionTitle title="이어갈 업무" />
                <Link
                  to="/issues"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  전체 업무
                  <ChevronRight className="size-3" />
                </Link>
              </div>
              <TaskData query={tasks} tasks={scopedTasks.slice(0, 8)} />
            </div>
          </section>
          <aside className="crewroom-context flex flex-col gap-8">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">지금 팀에서는</h2>
                {fresh && (
                  <span className="text-xs text-muted-foreground">
                    서버 상태
                  </span>
                )}
              </div>
              <RunList
                runs={observedRuns}
                error={runs.error}
                loading={runs.isPending}
              />
            </div>
            <div className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold">내 기본 비서</h2>
              {primary?.loading ? (
                <Skeleton className="h-16 w-full" />
              ) : primary?.error ? (
                <ReadError
                  message="내 기본 비서를 불러오지 못했어요."
                  retry={() => primary.onRetry?.()}
                />
              ) : primary?.primaryAgent ? (
                <>
                  <div className="flex items-center gap-3">
                    <CrewroomCharacter agent={primary.primaryAgent} />
                    <span className="flex min-w-0 flex-col gap-1">
                      <strong className="truncate text-sm font-medium">
                        {primary.primaryAgent.name}
                      </strong>
                      <span className="text-xs text-muted-foreground">
                        내 대화에서 이어가기
                      </span>
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={opening || !chat.enabled}
                    onClick={() => startChat(primary.primaryAgent!)}
                  >
                    <MessageCircle className="size-4" />
                    {opening ? "대화 여는 중…" : "대화 열기"}
                  </Button>
                  {!chat.enabled && chat.loaded && (
                    <p className="text-xs text-muted-foreground">
                      개인 대화 기능이 꺼져 있어요.
                    </p>
                  )}
                </>
              ) : (
                <Empty
                  action={
                    <Button asChild variant="outline" size="sm">
                      <Link to="/crewroom?view=personal">비서 선택하기</Link>
                    </Button>
                  }
                >
                  함께 생각을 정리할 내 기본 비서를 선택하세요.
                </Empty>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold">팀의 반복 업무</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                공유 스킬로 정해진 방법을 다시 사용할 수 있어요.
              </p>
              <Link
                to="/crewroom?view=skills"
                className="inline-flex items-center gap-2 text-sm font-medium"
              >
                <Blocks className="size-4" />
                스킬 골라 실행하기
                <ArrowRight className="size-4" />
              </Link>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
