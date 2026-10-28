import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import type { CurrentBoardAccess } from "@/api/access";
import {
  crewroomAgentMetadata,
  crewroomAgentState,
  crewroomCanManage,
  crewroomDepartment,
  crewroomSortAgents,
} from "./crewroom";

const agent = {
  id: "agent-a",
  status: "idle",
  lifecycleState: "ready",
} as const;
const run = (status: string, agentId = "agent-a") =>
  ({ id: "run-a", agentId, status }) as LiveRunForIssue;

describe("Crewroom presentation boundaries", () => {
  it("does not infer departments from an agent name or an unsupported metadata version", () => {
    expect(
      crewroomDepartment({
        metadata: {
          crewroom: { schemaVersion: 2, departmentId: "development" },
        },
      }),
    ).toBeNull();
    expect(
      crewroomDepartment({
        metadata: { crewroom: { schemaVersion: 1, departmentId: "unknown" } },
      }),
    ).toBeNull();
    expect(crewroomDepartment({ metadata: null })).toBeNull();
    expect(
      crewroomDepartment({
        metadata: { crewroom: { schemaVersion: 1, departmentId: "qa" } },
      }),
    ).toBe("qa");
  });

  it("preserves a bound character across an agent rename", () => {
    const metadata = {
      crewroom: {
        schemaVersion: 1,
        departmentId: "direct",
        characterId: "mimi",
      },
    };
    expect(crewroomAgentMetadata({ metadata }).characterId).toBe("mimi");
    expect(crewroomAgentMetadata({ metadata: { crewroom: [] } })).toEqual({});
  });

  it("requires fresh observed running evidence and never counts historical success as running", () => {
    expect(crewroomAgentState(agent, [run("succeeded")], true)).toBe(
      "available",
    );
    expect(
      crewroomAgentState(agent, [run("running", "another-agent")], true),
    ).toBe("available");
    expect(crewroomAgentState(agent, [run("running")], true)).toBe("running");
    expect(crewroomAgentState(agent, [run("queued")], true)).toBe("queued");
    expect(crewroomAgentState(agent, [run("running")], false)).toBe("unknown");
    expect(crewroomAgentState(agent, undefined, false)).toBe("unknown");
  });

  it("keeps a preparation or paused state distinct from ready", () => {
    expect(
      crewroomAgentState({ ...agent, lifecycleState: "verifying" }, [], true),
    ).toBe("preparing");
    expect(crewroomAgentState({ ...agent, status: "paused" }, [], true)).toBe(
      "paused",
    );
    expect(crewroomAgentState({ ...agent, status: "error" }, [], true)).toBe(
      "error",
    );
  });

  it("offers team lead presentation only for actual active membership in this company", () => {
    const access = {
      source: "session",
      isInstanceAdmin: false,
      memberships: [
        { companyId: "company-a", membershipRole: "owner", status: "active" },
      ],
    } as CurrentBoardAccess;
    expect(crewroomCanManage(access, "company-a")).toBe(true);
    expect(crewroomCanManage(access, "company-b")).toBe(false);
    expect(
      crewroomCanManage(
        {
          ...access,
          memberships: [
            {
              companyId: "company-a",
              membershipRole: "viewer",
              status: "active",
            },
          ],
        },
        "company-a",
      ),
    ).toBe(false);
    expect(crewroomCanManage(undefined, "company-a")).toBe(false);
  });

  it("sorts only the displayed copy, using explicit order before name", () => {
    const entries = [
      { id: "a", name: "나", metadata: null },
      {
        id: "b",
        name: "가",
        metadata: { crewroom: { schemaVersion: 1, displayOrder: 2 } },
      },
    ] as Agent[];
    expect(crewroomSortAgents(entries).map((item) => item.id)).toEqual([
      "b",
      "a",
    ]);
    expect(entries.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
