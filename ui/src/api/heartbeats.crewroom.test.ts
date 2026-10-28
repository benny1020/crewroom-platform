import { beforeEach, describe, expect, it, vi } from "vitest";
const get = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ api: { get } }));
import { heartbeatsApi } from "./heartbeats";

describe("Crewroom live-only run request", () => {
  beforeEach(() => get.mockReset());
  it("serializes an explicit zero padding floor instead of silently loading historical runs", async () => {
    get.mockResolvedValue([]);
    await heartbeatsApi.liveRunsForCompany("team-a", { minCount: 0 });
    expect(get).toHaveBeenCalledWith("/companies/team-a/live-runs?minCount=0");
  });
});
