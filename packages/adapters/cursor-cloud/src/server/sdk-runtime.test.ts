import { describe, expect, it } from "vitest";
import { Agent, Cursor, SdkUserMessageSchema, ShellCommandSchema } from "@cursor/sdk";

// Do not mock the SDK: its Zod 3-compatible entry points must resolve from
// our patched Zod 4 peer installation without starting a provider session.
describe("installed Cursor SDK schema compatibility", () => {
  it("imports the adapter runtime and validates SDK messages", () => {
    expect(typeof Agent.create).toBe("function");
    expect(typeof Cursor).toBe("function");
    expect(SdkUserMessageSchema.parse({ text: "synthetic compatibility check" }))
      .toEqual({ text: "synthetic compatibility check" });
    expect(SdkUserMessageSchema.safeParse({ text: 42 }).success).toBe(false);
  });

  it("validates shell commands through the SDK's Zod-compatible schema", () => {
    expect(ShellCommandSchema.parse({ command: "true", workingDirectory: "/synthetic" }))
      .toEqual({ command: "true", workingDirectory: "/synthetic" });
    expect(ShellCommandSchema.safeParse({ command: null }).success).toBe(false);
  });
});
