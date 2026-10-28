import { CrewroomCharacter } from "./CrewroomCharacter";
import { crewroomSceneLabels, type CrewroomScene } from "./character-manifest";

/** Deliberate sample gallery. Never feeds agent presence or live task state. */
export function MotionPreview() {
  return <details className="crewroom-motion-preview">
    <summary className="cursor-pointer text-xs text-muted-foreground">미미의 동작 미리보기</summary>
    <p className="mt-3 text-xs text-muted-foreground">12가지 장면을 보여주는 미리보기예요. 실제 동료의 실행 상태와는 별개예요.</p>
    <div className="crewroom-scene-gallery">
      {(Object.entries(crewroomSceneLabels) as [CrewroomScene, string][]).map(([scene, label]) =>
        <figure key={scene} className="flex flex-col items-center gap-2">
          <CrewroomCharacter previewScene={scene} characterId="mimi" />
          <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
        </figure>)}
    </div>
  </details>;
}
