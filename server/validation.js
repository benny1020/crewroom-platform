import { z } from "zod";
export const id = z.uuid();
export const revision = z.number().int().positive();
export const visibility = z.enum(["private", "department", "team"]);
export const department = z.enum(["direct", "development", "operations", "qa"]);
export const register = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase().trim()),
    name: z.string().trim().min(1).max(40),
    password: z.string().min(12).max(128),
    department,
    assistantName: z.string().trim().min(1).max(30).optional(),
    leadRequested: z.boolean().default(false),
  })
  .strict();
export const login = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(128) })
  .strict();
export const taskInput = z
  .object({
    workType: z.enum(["pr-qa", "review", "ops", "chat", "code-qa", "analysis"]),
    title: z.string().trim().max(110).optional(),
    target: z.string().trim().min(1).max(500),
    targetVersion: z.string().trim().min(1).max(80),
    project: z.string().trim().min(1).max(80),
    goal: z.string().trim().min(1).max(4000),
    visibility,
    agentId: z.string().max(80).optional(),
    skillId: z.string().max(80).optional(),
    exampleId: id.optional(),
    imported: z
      .object({
        body: z.string().trim().min(1).max(30000),
        source: z.string().trim().min(1).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();
export const command = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("start"), revision }),
    z.object({ action: z.literal("continue"), revision }),
    z.object({ action: z.literal("pause"), revision }),
    z.object({ action: z.literal("cancel"), revision }),
    z.object({ action: z.literal("handoff"), revision }),
    z.object({ action: z.literal("accept"), revision }),
    z.object({
      action: z.literal("rework"),
      revision,
      reason: z.string().trim().min(1).max(500),
      targetVersion: z.string().trim().min(1).max(80),
    }),
    z.object({ action: z.literal("assign"), revision, responsibleId: id }),
    z.object({
      action: z.literal("brief"),
      revision,
      text: z.string().trim().min(1).max(1500),
      reason: z.string().trim().min(1).max(300),
      source: z.string().max(80),
    }),
    z.object({ action: z.literal("claim"), revision }),
  ].map((s) => s.strict()),
);
export const memoryInput = z
  .object({
    agentId: z.string().min(1).max(80),
    visibility,
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(10000),
    source: z.string().trim().min(1).max(500),
    sourceTaskId: id.optional(),
    kind: z
      .enum(["fact", "decision", "preference", "procedure"])
      .default("fact"),
    pinned: z.boolean().default(false),
    project: z.string().trim().max(80).default(""),
    audience: z.enum(["agent", "project"]).default("agent"),
    validFrom: z.iso.datetime({ offset: true }).nullable().default(null),
    validTo: z.iso.datetime({ offset: true }).nullable().default(null),
    supersedesId: id.nullable().default(null),
    sourceKey: z.string().max(120).nullable().default(null),
  })
  .strict();
