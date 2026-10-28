import type { LiveRunForIssue } from "@/api/heartbeats";
import type { CrewroomAgentState } from "@/lib/crewroom";
import type { CrewroomScene } from "./character-manifest";

/** Tool names are evidence of an action, never evidence of successful completion. */
export function crewroomWorkScene(state: CrewroomAgentState, run?: LiveRunForIssue): CrewroomScene {
  if (state === "queued") return "queued";
  if (state === "paused") return "paused";
  if (state === "error") return "blocked";
  if (state !== "running" || run?.status !== "running") return "ready";
  const tool = run.currentToolName?.toLowerCase() ?? "";
  if (/test|check|lint|verify/.test(tool)) return "testing";
  if (/patch|write_file|edit_file|notebookedit/.test(tool)) return "coding";
  if (/read|search|grep|glob|browse|fetch/.test(tool)) return "investigating";
  if (/review/.test(tool)) return "review";
  if (/document|write_workspace/.test(tool)) return "writing";
  return "planning";
}
