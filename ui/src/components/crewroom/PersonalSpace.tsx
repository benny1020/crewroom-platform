import { useState, useEffect } from "react";
import { ArrowRight, Check, MessageCircle } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { usePrimaryAgentPresentation } from "@/components/primary-agent/PrimaryAgentPresentation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CrewroomCharacter } from "./CrewroomCharacter";
import { ReadError } from "./CrewroomPrimitives";
export function PersonalSpace({
  companyId,
  agents,
  primary,
  enabled,
  loaded,
  opening,
  onChat,
}: {
  companyId: string;
  agents: Agent[];
  primary: ReturnType<typeof usePrimaryAgentPresentation>;
  enabled: boolean;
  loaded: boolean;
  opening: boolean;
  onChat: (agent: Agent) => void;
}) {
  const [choice, setChoice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const selected = agents.find((agent) => agent.id === choice);
  useEffect(() => {
    setChoice(primary?.primaryAgentId ?? "");
    setConfirming(false);
  }, [companyId, primary?.primaryAgentId]);
  return (
    <section className="crewroom-personal">
      <div className="crewroom-personal-intro flex flex-col items-start gap-6">
        <CrewroomCharacter
          agent={primary?.primaryAgent ?? undefined}
          mascot={!primary?.primaryAgent}
          large
        />
        <div className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">
            {primary?.primaryAgent
              ? `${primary.primaryAgent.name}와 함께 다음 한 걸음.`
              : "내 일을 함께 정리할 동료."}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            개인 대화에서 생각을 정리하고 필요한 업무를 시작하세요. 비서를
            바꿔도 이전 대화는 그대로 남아요.
          </p>
        </div>
        {primary?.loading ? (
          <Skeleton className="h-10 w-48" />
        ) : primary?.error ? (
          <ReadError
            message="비서 설정을 불러오지 못했어요."
            retry={() => primary.onRetry?.()}
          />
        ) : (
          primary?.primaryAgent && (
            <Button
              disabled={!enabled || opening}
              onClick={() => onChat(primary.primaryAgent!)}
            >
              <MessageCircle className="size-4" />
              {opening ? "대화 여는 중…" : "대화로 요청하기"}
              <ArrowRight className="size-4" />
            </Button>
          )
        )}
        {loaded && !enabled && (
          <p className="text-sm text-muted-foreground">
            개인 대화 기능이 꺼져 있어요. 팀 관리자에게 활성화를 요청해 주세요.
          </p>
        )}
      </div>
      <div className="crewroom-personal-settings flex flex-col gap-5">
        <h2 className="text-base font-semibold">내 기본 비서 선택</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          팀의 에이전트 중 한 명을 내 기본 비서로 지정해요. 조직 역할과 접근
          권한은 바뀌지 않아요.
        </p>
        <label className="flex flex-col gap-2 text-sm font-medium">
          비서
          <select
            className="crewroom-select"
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value);
              setConfirming(false);
            }}
            disabled={primary?.loading || Boolean(primary?.pendingAgentId)}
          >
            <option value="">에이전트를 선택하세요</option>
            {agents
              .filter((agent) => agent.status !== "pending_approval")
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.title ?? agent.role}
                </option>
              ))}
          </select>
        </label>
        {primary?.primaryAgentId === choice && choice ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Check className="size-4" />
            현재 내 기본 비서예요.
          </p>
        ) : confirming && selected ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              {selected.name}를 내 기본 비서로 지정할까요?
            </p>
            <div className="flex justify-between gap-3">
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                돌아가기
              </Button>
              <Button
                disabled={Boolean(primary?.pendingAgentId)}
                onClick={() => primary?.onChange(selected.id)}
              >
                비서로 지정
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="self-start"
            disabled={
              !selected || !primary || Boolean(primary.error) || primary.loading
            }
            onClick={() => setConfirming(true)}
          >
            비서 선택하기
          </Button>
        )}
      </div>
    </section>
  );
}
