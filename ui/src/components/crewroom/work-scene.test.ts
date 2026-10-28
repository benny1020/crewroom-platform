import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { crewroomWorkScene } from "./work-scene";
import { crewroomCharacterId, crewroomCharacters, crewroomDiaryRects } from "./character-manifest";

const run = (currentToolName: string, status = "running") => ({ status, currentToolName }) as LiveRunForIssue;
describe("Crewroom observed work scenes", () => {
  it("does not show a work pose from stale, idle or completed evidence", () => {
    expect(crewroomWorkScene("unknown", run("apply_patch"))).toBe("ready");
    expect(crewroomWorkScene("available", run("test"))).toBe("ready");
    expect(crewroomWorkScene("running", run("test", "succeeded"))).toBe("ready");
    expect(crewroomWorkScene("running")).toBe("ready");
  });
  it("distinguishes observed activity without claiming a successful result", () => {
    expect(crewroomWorkScene("running", run("apply_patch"))).toBe("coding");
    expect(crewroomWorkScene("running", run("run_check"))).toBe("testing");
    expect(crewroomWorkScene("running", run("read_file"))).toBe("investigating");
    expect(crewroomWorkScene("running", run("review"))).toBe("review");
    expect(crewroomWorkScene("running", run("unknown"))).toBe("planning");
    expect(crewroomWorkScene("queued", run("test"))).toBe("queued");
    expect(crewroomWorkScene("paused", run("test"))).toBe("paused");
  });
  it("recognizes stable identities and rejects inherited object names", () => {
    for (const id of Object.keys(crewroomCharacters)) expect(crewroomCharacterId(id)).toBe(id);
    expect(crewroomCharacterId("pom")).toBe("mimi");
    expect(crewroomCharacterId("toString")).toBeNull();
    expect(crewroomCharacterId("__proto__")).toBeNull();
    expect(crewroomCharacterId(null)).toBeNull();
  });
  it("keeps every atlas crop inside its original bitmap", () => {
    for (const scenes of Object.values(crewroomDiaryRects)) for (const [x,y,w,h] of Object.values(scenes)) {
      expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
      expect(w).toBeGreaterThan(0); expect(h).toBeGreaterThan(0);
      expect(x+w).toBeLessThanOrEqual(1086); expect(y+h).toBeLessThanOrEqual(1448);
    }
  });
});
