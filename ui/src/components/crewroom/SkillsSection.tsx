import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Blocks, ChevronRight } from "lucide-react";
import type { Agent, CompanySkillListItem } from "@paperclipai/shared";
import { companySkillsApi } from "@/api/companySkills";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Link, useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { useCrewroomCapabilities } from "@/hooks/useCrewroomCapabilities";
import { ReadError, Empty, RosterSkeleton } from "./CrewroomPrimitives";
export function SkillsSection({
  companyId,
  agents,
  query,
}: {
  companyId: string;
  agents: Agent[];
  query: {
    data?: CompanySkillListItem[];
    error: unknown;
    isPending: boolean;
    refetch: () => unknown;
  };
}) {
  const [skill, setSkill] = useState<CompanySkillListItem | null>(null);
  const [agentId, setAgentId] = useState("");
  const [input, setInput] = useState("");
  const navigate = useNavigate();
  const client = useQueryClient();
  const mounted = useRef(true);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const detail = useQuery({
    queryKey: queryKeys.companySkills.detail(companyId, skill?.id ?? "__none__"),
    queryFn: () => companySkillsApi.detail(companyId, skill!.id),
    enabled: !!skill,
  });
  const assignment = useQuery({
    queryKey: [...queryKeys.agents.skills(agentId), companyId],
    queryFn: () => agentsApi.skills(agentId, companyId),
    enabled: Boolean(agentId),
  });
  const capabilities = useCrewroomCapabilities(companyId, agentId || undefined);
  const assignedVersion = assignment.data?.entries.find(
    (entry) =>
      entry.key === skill?.key &&
      entry.desired &&
      entry.versionId === detail.data?.currentVersionId &&
      entry.managed &&
      entry.state === "installed",
  );
  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const mutation = useMutation({
    mutationFn: async () => {
      if (
        !capabilities.data?.canAssignTasks ||
        !skill ||
        !detail.data?.currentVersionId ||
        !assignedVersion ||
        !agentId ||
        !input.trim()
      )
        throw new Error("스킬과 담당자, 요청 내용을 확인해 주세요.");
      const fingerprint = JSON.stringify([
        skill.id,
        detail.data.currentVersionId,
        agentId,
        input.trim(),
      ]);
      if (intent.current?.fingerprint !== fingerprint)
        intent.current = { fingerprint, key: crypto.randomUUID() };
      return issuesApi.create(companyId, {
        idempotencyKey: intent.current.key,
        title: `${skill.name} · ${input.trim().split("\n")[0].slice(0, 80)}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        description: `## 요청\n${input.trim()}\n\n## 스킬 사용 요청\n- 이름: ${skill.name}\n- key: ${skill.key}\n- skill ID: ${skill.id}\n- 선택한 버전: ${detail.data.currentVersionId}\n- source hash: ${skill.originHash ?? "제공되지 않음"}\n\n선택한 버전의 스킬을 읽고 적용하세요. 스킬 또는 필요한 파일에 접근할 수 없으면 다른 방법으로 대체하지 말고 업무에 차단 사유를 남기세요. 이 기록은 스킬 사용 요청이며 실행 시점의 immutable snapshot 적용을 보장하지 않습니다.`,
      });
    },
    onSuccess: (task) => {
      void client.invalidateQueries({
        queryKey: queryKeys.issues.list(companyId),
      });
      if (mounted.current) navigate(`/issues/${task.identifier ?? task.id}`);
    },
  });
  if (query.error)
    return (
      <ReadError
        message="공유 스킬을 불러오지 못했어요."
        retry={query.refetch}
      />
    );
  if (query.isPending) return <RosterSkeleton />;
  if (!query.data?.length)
    return (
      <Empty
        action={
          <Button asChild variant="outline">
            <Link to="/skills">스킬 라이브러리 열기</Link>
          </Button>
        }
      >
        아직 팀에 공유된 스킬이 없어요. 라이브러리에서 스킬을 추가하거나
        공유하면 여기서 업무로 시작할 수 있어요.
      </Empty>
    );
  return (
    <section className="crewroom-skills-grid">
      <div className="flex min-w-0 flex-col gap-2">
        {query.data.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={item.id === skill?.id}
            className="crewroom-skill-row flex items-center gap-4 rounded-xl px-4 py-5 text-left"
            onClick={() => {
              setSkill(item);
              mutation.reset();
            }}
          >
            <Blocks className="size-5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <strong className="text-sm font-medium">{item.name}</strong>
              <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {item.description ?? item.tagline ?? "팀이 함께 사용하는 스킬"}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
      <div className="crewroom-skill-form flex flex-col gap-5">
        {!skill ? (
          <Empty>
            왼쪽에서 스킬을 선택하면 필요한 내용을 입력하고 담당자에게 업무를
            맡길 수 있어요.
          </Empty>
        ) : (
          <>
            <h2 className="text-lg font-semibold">
              {skill.name}로 업무 만들기
            </h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              스킬의 버전과 사용 요청을 업무에 저장해 담당자에게 전달해요. 실행
              시점에 같은 버전이 적용되는지는 업무 결과에서 확인하세요.
            </p>
            {detail.error ? (
              <ReadError
                message="스킬 지침을 불러오지 못했어요."
                retry={detail.refetch}
              />
            ) : detail.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  담당자
                  <select
                    className="crewroom-select"
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                  >
                    <option value="">담당 에이전트를 선택하세요</option>
                    {agents
                      .filter(
                        (agent) =>
                          !["pending_approval", "terminated"].includes(
                            agent.status,
                          ),
                      )
                      .map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                          {detail.data?.usedByAgents.some(
                            (used) => used.id === agent.id,
                          )
                            ? " · 이 스킬 사용 중"
                            : ""}
                        </option>
                      ))}
                  </select>
                </label>
                {agentId &&
                  (assignment.isPending ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      담당자의 스킬 할당을 확인하고 있어요…
                    </p>
                  ) : assignment.error ? (
                    <ReadError
                      message="담당자의 스킬 할당을 확인하지 못했어요."
                      retry={assignment.refetch}
                    />
                  ) : !assignedVersion ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      선택한 버전이 담당자에게 설치되어 있지 않아요.{" "}
                      {selectedAgent && (
                        <Link
                          className="underline underline-offset-4"
                          to={`/agents/${agentRouteRef(selectedAgent)}/skills`}
                        >
                          담당자의 스킬 설정 열기
                        </Link>
                      )}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      선택한 버전의 스킬 할당을 확인했어요.
                    </p>
                  ))}
                <label className="flex flex-col gap-2 text-sm font-medium">
                  어떤 일을 할까요?
                  <Textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="대상, 원하는 결과, 주의할 점을 적어 주세요."
                    rows={5}
                  />
                </label>
                {capabilities.error ? (
                  <ReadError
                    message="업무 생성 권한을 확인하지 못했어요. 다시 확인한 뒤 진행해 주세요."
                    retry={capabilities.refetch}
                  />
                ) : capabilities.isPending ? (
                  <p role="status" className="text-xs text-muted-foreground">업무 생성 권한을 확인하고 있어요…</p>
                ) : !capabilities.data.canAssignTasks ? (
                  <p className="text-xs text-muted-foreground">선택한 담당자에게 업무를 맡길 권한이 없어요.</p>
                ) : null}
                {mutation.error && (
                  <p role="alert" className="text-sm text-destructive">
                    업무를 만들지 못했어요. 입력 내용과 권한을 확인한 뒤 다시
                    시도해 주세요.
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <Button
                    variant="ghost"
                    disabled={mutation.isPending}
                    onClick={() => setSkill(null)}
                  >
                    취소
                  </Button>
                  <Button
                    disabled={
                      !capabilities.isSuccess ||
                      !capabilities.data.canAssignTasks ||
                      !assignedVersion ||
                      !input.trim() ||
                      mutation.isPending
                    }
                    onClick={() => mutation.mutate()}
                  >
                    {mutation.isPending ? "업무 만드는 중…" : "업무 만들기"}
                    <ArrowRight className="size-4" />
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
