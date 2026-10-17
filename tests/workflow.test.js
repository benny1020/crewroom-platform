import test from "node:test";
import assert from "node:assert/strict";
import { initial, baseSkills } from "../src/data.js";
import {
  initializeTeam,
  canPublishSkill,
  canEditBinding,
} from "../src/team-domain.js";
import {
  initializeWorkflows,
  createWorkflow,
  startWorkflowRun,
  completeWorkflowRun,
  handoffWorkflow,
  acceptWorkflow,
  reworkWorkflow,
  reassignWorkflow,
  canReadTask,
  canOperateTask,
  correctBrief,
  importResult,
  relatedWork,
} from "../src/workflow-domain.js";
const seed = () => {
  const state = initializeTeam({
    ...initial(),
    conversations: [],
    messages: {},
    runs: [],
  });
  initializeWorkflows(state);
  return state;
};
const values = (overrides = {}) => ({
  workType: "pr-qa",
  target: "https://github.com/example/product/pull/42",
  targetVersion: "abc123",
  project: "제품 웹",
  visibility: "team",
  goal: "변경 검토",
  ...overrides,
});
const complete = (s, t) => {
  const r = startWorkflowRun(s, t, baseSkills);
  return completeWorkflowRun(s, t, r.id, r.generation);
};

test("one task hands a pinned artifact to another agent and completes only on acceptance", () => {
  const s = seed(),
    t = createWorkflow(s, values()),
    a = complete(s, t),
    first = t.runId;
  assert.equal(t.status, "result_ready");
  assert.equal(s.runs.find((r) => r.id === first).status, "succeeded");
  handoffWorkflow(s, t);
  assert.equal(t.steps[1].inputArtifactId, a.id);
  assert.equal(t.runId, null);
  const b = complete(s, t),
    r = s.runs.find((r) => r.id === b.runId);
  assert.notEqual(r.id, first);
  assert.equal(r.agentId, "qa");
  assert.equal(r.targetVersion, "abc123");
  assert.equal(r.inputArtifactId, a.id);
  assert.equal(
    t.conversationId,
    s.runs.find((r) => r.id === first).conversationId,
  );
  acceptWorkflow(s, t);
  assert.equal(t.status, "done");
  assert.equal(b.verification, "unverified");
  assert.equal(t.acceptedArtifactId, b.id);
});
test("viewer cannot run, accept or edit a brief, but a lead can reassign a shared task", () => {
  const s = seed(),
    t = createWorkflow(s, values());
  s.user = "minji";
  assert.equal(canReadTask(s, t), true);
  assert.equal(canOperateTask(s, t), false);
  assert.throws(() => startWorkflowRun(s, t, baseSkills));
  assert.throws(() => acceptWorkflow(s, t));
  assert.throws(() =>
    correctBrief(s, t, { text: "x", source: "request", reason: "x" }),
  );
  s.user = "roopre";
  reassignWorkflow(s, t, "minji");
  assert.equal(t.owner, "roopre");
  assert.equal(t.responsible, "minji");
  assert.throws(() => startWorkflowRun(s, t, baseSkills));
});
test("missing skills, stale generations and mismatched targets cannot complete a run", () => {
  const s = seed(),
    t = createWorkflow(s, values());
  assert.throws(() =>
    startWorkflowRun(
      s,
      t,
      baseSkills.filter((x) => x.id !== "review"),
    ),
  );
  const r = startWorkflowRun(s, t, baseSkills);
  assert.equal(completeWorkflowRun(s, t, r.id), false);
  assert.equal(completeWorkflowRun(s, t, r.id, 99), false);
  t.targetVersion = "changed";
  assert.equal(completeWorkflowRun(s, t, r.id, r.generation), false);
  assert.equal(t.artifactIds.length, 0);
});
test("paused runs retain pins and block same-agent work until released", () => {
  const s = seed(),
    t = createWorkflow(s, values()),
    r = startWorkflowRun(s, t, baseSkills),
    pinned = r.skillVersion;
  t.status = r.status = "paused";
  s.agents.find((a) => a.id === "review").skillPins = { review: "99.0" };
  const second = createWorkflow(s, values({ targetVersion: "other" }));
  assert.throws(() => startWorkflowRun(s, second, baseSkills));
  startWorkflowRun(s, t, baseSkills);
  assert.equal(t.runId, r.id);
  assert.equal(r.generation, 2);
  assert.equal(r.skillVersion, pinned);
  assert.equal(completeWorkflowRun(s, t, r.id, 1), false);
  assert.ok(completeWorkflowRun(s, t, r.id, 2));
});
test("rework resets all active handoffs and brief while retaining evidence at its old SHA", () => {
  const s = seed(),
    t = createWorkflow(s, values()),
    a = complete(s, t);
  handoffWorkflow(s, t);
  complete(s, t);
  acceptWorkflow(s, t);
  correctBrief(s, t, { text: "old result", source: a.id, reason: "근거 반영" });
  reworkWorkflow(s, t, "새 변경", "def456");
  assert.equal(t.stepIndex, 0);
  assert.equal(t.acceptedArtifactId, undefined);
  assert.equal(t.steps[1].inputArtifactId, undefined);
  assert.equal(t.brief.source, "request");
  assert.equal(t.brief.targetVersion, "def456");
  assert.ok(
    t.brief.history.some(
      (v) => v.text === "old result" && v.targetVersion === "abc123",
    ),
  );
  assert.equal(s.artifacts.find((x) => x.id === a.id).targetVersion, "abc123");
  assert.equal(t.artifactIds.length, 2);
});
test("example reuse enforces department identity and never copies target or approval", () => {
  const s = seed(),
    t = createWorkflow(
      s,
      values({ workType: "review", visibility: "department" }),
    );
  const a = complete(s, t);
  acceptWorkflow(s, t);
  const fresh = createWorkflow(
    s,
    values({
      workType: "review",
      visibility: "department",
      targetVersion: "new",
      exampleId: a.id,
    }),
  );
  assert.equal(fresh.targetVersion, "new");
  assert.equal(fresh.acceptedArtifactId, undefined);
  assert.deepEqual(fresh.artifactIds, []);
  s.members.roopre.department = "qa";
  assert.throws(() =>
    createWorkflow(s, values({ visibility: "department", exampleId: a.id })),
  );
});
test("related work filters private tasks before suggesting matches", () => {
  const s = seed();
  createWorkflow(s, values({ visibility: "private" }));
  const shared = createWorkflow(s, values());
  s.user = "minji";
  assert.deepEqual(
    relatedWork(s, values()).map((x) => x.task.id),
    [shared.id],
  );
});
test("import remains external with no run and automatic completion records the run actor", () => {
  const s = seed(),
    t = importResult(
      s,
      values({ source: "個人 review.md", body: "<script>unsafe()</script>" }),
    ),
    a = s.artifacts.at(-1);
  assert.equal(a.runId, null);
  assert.equal(a.importedByUserId, "roopre");
  assert.equal(a.originalAuthor, null);
  assert.equal(a.verification, "unverified");
  handoffWorkflow(s, t);
  const r = startWorkflowRun(s, t, baseSkills);
  s.user = "minji";
  completeWorkflowRun(s, t, r.id, r.generation);
  assert.equal(t.events.at(-1).actorType, "run");
  assert.equal(t.events.at(-1).actorId, r.id);
});
test("brief corrections require task-local evidence and delegated publishing grants no agent settings", () => {
  const s = seed(),
    t = createWorkflow(s, values());
  assert.throws(() =>
    correctBrief(s, t, { text: "x", reason: "x", source: "other-task" }),
  );
  correctBrief(s, t, { text: "수정", reason: "근거 보완", source: "request" });
  assert.equal(t.brief.history.length, 1);
  s.user = "minji";
  assert.equal(canPublishSkill(s, { id: "regression", scope: "team" }), true);
  assert.equal(canPublishSkill(s, { id: "ops-check", scope: "team" }), false);
  assert.equal(canEditBinding(s, "qa"), false);
});

test("legacy workflow messages migrate once and conversation access follows the task", () => {
  const s = seed(),
    t = s.tasks.find((t) => t.workflow),
    c = s.conversations.find((c) => c.id === t.conversationId);
  s.messages[c.id] = [{ author: "로프레", text: "기존 업무 조건" }];
  t.visibility = "department";
  c.visibility = "team";
  initializeWorkflows(s);
  initializeWorkflows(s);
  assert.equal(
    t.discussion.filter((m) => m.text === "기존 업무 조건").length,
    1,
  );
  assert.equal(c.visibility, "department");
  assert.deepEqual(s.messages[c.id], []);
});
