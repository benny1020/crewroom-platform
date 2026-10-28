import type { CSSProperties } from "react";
import { crewroomCharacters, type AtlasRect, type CrewroomCharacterId } from "./character-manifest";

/** Intrinsic crop coordinates; displayed dimensions always come from the parent. */
export function CrewroomAtlas({ file, rect, width, height }: {
  file: string; rect: AtlasRect; width: number; height: number;
}) {
  const [x, y, w, h] = rect;
  return <span className="crewroom-atlas" style={{
    "--atlas-x": x, "--atlas-y": y, "--atlas-w": w, "--atlas-h": h,
    "--atlas-width": width, "--atlas-height": height,
    backgroundImage: `url(/crewroom/${file})`,
  } as CSSProperties} />;
}

/** Shared static identity for chat, task and roster contexts. Never implies work. */
export function CrewroomPortrait({ characterId }: { characterId: CrewroomCharacterId }) {
  const character = crewroomCharacters[characterId];
  return <span className="inline-flex size-full items-center justify-center" data-crewroom-portrait={characterId}>
    {"portrait" in character
      ? <img src={`/crewroom/${character.portrait}`} alt="" loading="lazy" decoding="async" className="size-full object-contain" />
      : <CrewroomAtlas file="plush-crew-v2.webp" rect={character.rect} width={1983} height={793} />}
  </span>;
}
