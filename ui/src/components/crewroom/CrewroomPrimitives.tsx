import type { ReactNode } from "react";
import { CircleAlert, ChevronRight, Clock3 } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/lib/router";
import {
  crewroomStateLabels,
  crewroomTaskLabels,
  type CrewroomAgentState,
} from "@/lib/crewroom";
export function ReadError({
  message,
  retry,
}: {
  message: string;
  retry: () => unknown;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/5 px-4 py-3 text-sm"
    >
      <CircleAlert className="size-4 shrink-0 text-destructive" />
      <span className="flex-1">{message}</span>
      <Button size="sm" variant="outline" onClick={() => retry()}>
        다시 불러오기
      </Button>
    </div>
  );
}
export function Empty({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="crewroom-empty flex flex-col items-start gap-4 py-8">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {children}
      </p>
      {action}
    </div>
  );
}
export function State({ state }: { state: CrewroomAgentState }) {
  return (
    <span
      className="crewroom-agent-state inline-flex items-center gap-1.5 whitespace-nowrap text-xs"
      data-state={state}
    >
      <span className="crewroom-state-dot" aria-hidden="true" />
      {crewroomStateLabels[state]}
    </span>
  );
}
export function TaskRows({
  tasks,
  empty = "아직 연결된 업무가 없어요. 새 업무를 만들면 이곳에서 이어갈 수 있어요.",
}: {
  tasks: Issue[];
  empty?: string;
}) {
  if (!tasks.length) return <Empty>{empty}</Empty>;
  return (
    <div className="flex flex-col divide-y divide-border/60">
      {tasks.map((task) => (
        <Link
          key={task.id}
          to={`/issues/${task.identifier ?? task.id}`}
          className="crewroom-task-row group flex items-center gap-3 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className="crewroom-task-marker"
            data-state={task.status}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-medium group-hover:text-primary">
              {task.title}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {task.identifier}
            </span>
            <span className="text-xs text-muted-foreground">의견 · 수정 요청</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {crewroomTaskLabels[task.status] ?? task.status}
          </span>
          <ChevronRight className="size-4 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}

export function SectionTitle({
  title,
  aside,
}: {
  title: string;
  aside?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
    </div>
  );
}
export function RosterSkeleton() {
  return (
    <div
      aria-label="동료를 불러오는 중"
      role="status"
      className="crewroom-roster"
    >
      {[0, 1, 2, 3].map((item) => (
        <Skeleton key={item} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  );
}
export function TaskData({
  query,
  tasks,
}: {
  query: { isPending: boolean; error: unknown; refetch: () => unknown };
  tasks: Issue[];
}) {
  return query.error ? (
    <ReadError message="업무를 불러오지 못했어요." retry={query.refetch} />
  ) : query.isPending ? (
    <div className="flex flex-col gap-3 py-4">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  ) : (
    <TaskRows tasks={tasks} />
  );
}
export function RunList({
  runs,
  error,
  loading,
}: {
  runs: Array<{
    id: string;
    status: string;
    agentName: string;
    issueId?: string | null;
    currentStatusMessage?: string | null;
  }>;
  error: unknown;
  loading: boolean;
}) {
  if (error)
    return (
      <p
        role="status"
        className="text-xs leading-relaxed text-muted-foreground"
      >
        현재 실행 상태를 확인할 수 없어요. 잠시 후 새로고침해 주세요.
      </p>
    );
  if (loading) return <Skeleton className="h-20 w-full" />;
  if (!runs.length)
    return (
      <div className="flex items-start gap-3">
        <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          현재 실행 중이거나 대기열에 있는 업무가 없어요.
        </p>
      </div>
    );
  return (
    <div className="flex flex-col gap-5">
      {runs.slice(0, 6).map((run) => (
        <div key={run.id} className="flex items-start gap-3">
          <span className="crewroom-state-dot mt-1.5" data-state={run.status} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-sm font-medium">
              {run.agentName}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {run.status === "running" ? "작업 중" : "실행 대기"}
              </span>
            </span>
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              연결된 실행 기록을 확인할 수 있어요.
            </p>
            {run.issueId && (
              <Link
                to={`/issues/${run.issueId}`}
                className="self-start text-xs underline underline-offset-4"
              >
                업무 열기
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
