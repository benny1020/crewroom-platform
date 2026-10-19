import test from "node:test";
import assert from "node:assert/strict";
import { workroomState } from "../src/workroom-state.js";
import { requestContract } from "../src/request-contract.js";
test("handoff never promotes an old target or another step to current result and detects answers not applied", () => {
  const task = {
    step_index: 1,
    target_version: "new",
    question_revision: 2,
    steps: [{}, { current_artifact_id: "qa" }],
    runs: [{ id: "run", snapshot: { questionRevision: 1 } }],
    questions: [
      { status: "pending", target_version: "old" },
      { status: "answered", target_version: "new" },
    ],
    artifacts: [
      {
        id: "qa",
        step_index: 1,
        target_version: "new",
        run_id: "run",
        version: 2,
      },
      { id: "dev", step_index: 0, target_version: "new", version: 3 },
      { id: "old", step_index: 1, target_version: "old", version: 1 },
    ],
  };
  assert.equal(workroomState(task).current.id, "qa");
  assert.equal(workroomState(task).answersApplied, false);
  assert.equal(workroomState(task).previous.id, "old");
  assert.equal(workroomState(task).pending.length, 0);
  task.target_version = "next";
  assert.equal(workroomState(task).current, undefined);
  task.steps[1].current_artifact_id = "dev";
  assert.equal(workroomState(task).current, undefined);
});
test("conversation, target analysis, code edit and verification handoff have explicit distinct request contracts", () => {
  assert.equal(requestContract("conversation"), "chat");
  assert.equal(requestContract("review"), "analysis");
  assert.equal(requestContract("custom-example"), "chat");
  assert.equal(requestContract("code-change"), "code-qa");
  assert.equal(requestContract("code-verify"), "handoff");
});
