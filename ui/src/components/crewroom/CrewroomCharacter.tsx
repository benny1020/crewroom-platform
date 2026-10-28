import { useEffect, useRef, useState } from "react";
import { Code2, FileCheck2, Hourglass, Search, Moon } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { AgentAvatar } from "@/components/AgentAvatar";
import { crewroomAgentMetadata, type CrewroomAgentState } from "@/lib/crewroom";
import {
  crewroomCharacterId, crewroomCharacters, crewroomDiaryRects,
  type CrewroomScene, type CrewroomCharacterId,
} from "./character-manifest";
import { CrewroomAtlas, CrewroomPortrait } from "./CrewroomPortrait";
import { crewroomWorkScene } from "./work-scene";

export function CrewroomCharacter({ agent, state = "unknown", run, large = false,
  mascot = false, previewScene, characterId, motion = true,
}: {
  agent?: Agent; state?: CrewroomAgentState; run?: LiveRunForIssue; large?: boolean;
  mascot?: boolean; previewScene?: CrewroomScene; characterId?: CrewroomCharacterId; motion?: boolean;
}) {
  const key = characterId ?? (mascot ? "mimi" : crewroomCharacterId(agent && crewroomAgentMetadata(agent).characterId));
  const character = key ? crewroomCharacters[key] : null;
  const scene = previewScene ?? crewroomWorkScene(state, run);
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(true);
  const [foreground, setForeground] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const sync = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    if (typeof IntersectionObserver === "undefined") return () => document.removeEventListener("visibilitychange", sync);
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (root.current) observer.observe(root.current);
    return () => { document.removeEventListener("visibilitychange", sync); observer.disconnect(); };
  }, []);
  if (!character || !key) return <AgentAvatar agent={agent} size={large ? 96 : 64} />;
  const diaryKey = key === "mimi" || key === "rururu" || key === "otter" ? key : null;
  // Available colleagues keep their own portrait; a work pose needs an observed state.
  const diary = diaryKey && (previewScene || ["running", "queued", "paused", "error"].includes(state));
  const actionScene = ["coding", "testing", "investigating", "review", "writing", "planning"].includes(scene);
  const PropIcon = scene === "testing" || scene === "review" ? FileCheck2
    : scene === "investigating" ? Search : scene === "queued" ? Hourglass
      : scene === "paused" ? Moon : Code2;
  return <span ref={root} className={`crewroom-character${large ? " crewroom-character-large" : ""}`}
    data-character={key} data-state={state} data-scene={scene}
    data-animate={motion && visible && foreground && !mascot ? "on" : "off"}
    data-preview={previewScene ? "true" : undefined} role={mascot ? "img" : undefined} aria-label={mascot ? character.name : undefined} aria-hidden={!mascot}>
    <span className="crewroom-character-pose">
      {diary && diaryKey ? <CrewroomAtlas file={`${diaryKey === "mimi" ? "pom" : diaryKey === "otter" ? "developer" : "rururu"}-diary-v1.webp`}
        rect={crewroomDiaryRects[diaryKey][scene]} width={1086} height={1448} />
        : <CrewroomPortrait characterId={key} />}
    </span>
    {!diary && (actionScene || scene === "queued" || scene === "paused") && <span className="crewroom-work-prop" data-work={actionScene}>
      <PropIcon aria-hidden="true" />
      {actionScene && <span className="crewroom-work-lines"><i /><i /><i /></span>}
    </span>}
    {(diary || actionScene) && <span className="crewroom-work-effects"><i /><i /><i /></span>}
  </span>;
}
