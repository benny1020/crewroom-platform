import test from "node:test";
import assert from "node:assert/strict";
import { motionAttributes, plushEffects } from "../src/plush-motion.js";

test("animation identity survives progress updates but changes for another task, run, result, state or avatar", () => {
  const input = {
    surface: "diary",
    agentId: "dev",
    character: "otter",
    phase: "celebrating",
    task: { id: "T1", status: "result_ready", current_run_id: "R1" },
    artifactId: "A1",
  };
  assert.equal(
    motionAttributes(input),
    motionAttributes({
      ...input,
      task: { ...input.task, revision: 15, updated_at: "later", progress: 98 },
    }),
  );
  for (const changed of [
    { ...input, surface: "station" },
    { ...input, character: "rabbit" },
    { ...input, phase: "review" },
    { ...input, artifactId: "A2" },
    { ...input, task: { ...input.task, id: "T2" } },
    { ...input, task: { ...input.task, current_run_id: "R2" } },
    { ...input, task: { ...input.task, status: "done" } },
  ])
    assert.notEqual(motionAttributes(input), motionAttributes(changed));
});

test("motion markup contains no task text, escapes identity and fails closed for unknown phases", () => {
  const html = motionAttributes({
    surface: 'x" onclick="bad',
    agentId: "<script>",
    character: "rabbit",
    task: { id: "safe", title: "PRIVATE_TASK_TITLE", goal: "PRIVATE_GOAL" },
    phase: "__proto__",
  });
  assert.ok(!html.includes('onclick="bad'));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("PRIVATE_"));
  assert.ok(html.includes('data-plush-phase="ready"'));
  assert.ok(plushEffects().includes('aria-hidden="true"'));
});
