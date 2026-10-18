import { z } from "zod";
export const proposalSchema = z
  .object({
    action: z.literal("propose_memory"),
    key: z.string().min(1).max(100),
    quote: z.string().trim().min(8).max(1000),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(2000),
    kind: z.enum(["fact", "decision", "preference", "procedure"]),
    audience: z.enum(["agent", "project"]).default("agent"),
  })
  .strict();
