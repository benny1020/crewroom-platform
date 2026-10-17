import test from "node:test";
import assert from "node:assert/strict";
import {
  canReadConversation,
  memoryScopeForConversation,
  createRunSnapshot,
  appendRunEvent,
  recoverInterruptedRuns,
  skillBindingStatus,
  nextVersion,
} from "../src/domain.js";

const task = {
  id: "T-201",
  owner: "roopre",
  requesterAgent: "dev",
  conversationId: "c-201",
  status: "running",
};
const actor = {
  runtime: "hermes",
  configVersion: 3,
  harness: "균형",
  skillPins: { review: "1.4" },
};
const skill = {
  id: "review",
  name: "코드 리뷰",
  version: "1.5",
  done: "근거를 제출한다",
  stages: ["읽기", "검토", "결과"],
};

test("private and department conversations reject other users and unknown identities", () => {
  const c = {
    id: "c",
    actorId: "dev",
    owner: "roopre",
    visibility: "private",
    department: "development",
  };
  assert.equal(canReadConversation(c, "roopre"), true);
  assert.equal(canReadConversation(c, "minji"), false);
  assert.equal(
    canReadConversation({ ...c, visibility: "department" }, "minji"),
    false,
  );
  assert.equal(
    canReadConversation({ ...c, visibility: "team" }, "minji"),
    true,
  );
  assert.equal(
    canReadConversation({ ...c, visibility: "team" }, "anonymous"),
    false,
  );
});

test("remembering a private conversation with a shared agent creates personal memory", () => {
  const c = {
    id: "private-thread",
    actorId: "dev",
    owner: "roopre",
    visibility: "private",
  };
  assert.deepEqual(memoryScopeForConversation(c, "roopre", true), {
    scope: "personal",
    owner: "roopre",
    agentId: "dev",
    conversationId: "private-thread",
  });
  assert.throws(
    () => memoryScopeForConversation(c, "minji", true),
    /FORBIDDEN/,
  );
  assert.deepEqual(
    memoryScopeForConversation({ ...c, visibility: "team" }, "minji", true),
    { scope: "agent", owner: "dev" },
  );
});

test("a started run retains its chosen skill and config when the actor is updated", () => {
  const localActor = structuredClone(actor),
    localSkill = structuredClone(skill);
  const run = createRunSnapshot(
    task,
    localActor,
    localSkill,
    [],
    "2026-10-16T00:00:00Z",
  );
  localActor.skillPins.review = "1.6";
  localActor.configVersion = 9;
  localSkill.stages.push("후속 확인");
  assert.equal(run.skillVersion, "1.4");
  assert.equal(run.configVersion, 3);
  assert.equal(run.snapshot.stages.length, 3);
  assert.equal(run.conversationId, "c-201");
});

test("another attempt gets a separate run identity and monotonically ordered events", () => {
  const first = createRunSnapshot(task, actor, skill);
  const second = createRunSnapshot(task, actor, skill, [first]);
  assert.notEqual(first.id, second.id);
  assert.equal(second.attempt, 2);
  appendRunEvent(second, { type: "started", text: "start" });
  appendRunEvent(second, { type: "waiting", text: "approval" });
  assert.deepEqual(
    second.events.map((e) => e.sequence),
    [1, 2],
  );
  second.generation = 2;
  assert.throws(
    () =>
      appendRunEvent(second, { generation: 1, type: "late", text: "stale" }),
    /STALE_GENERATION/,
  );
  assert.equal(second.events.length, 2);
});

test("reload pauses an interrupted run while preserving its pin and waiting runs", () => {
  const run = createRunSnapshot(task, actor, skill);
  const recovered = recoverInterruptedRuns([
    run,
    { ...run, id: "waiting", status: "needs_input" },
  ]);
  assert.equal(recovered[0].status, "paused");
  assert.equal(recovered[0].skillVersion, "1.4");
  assert.equal(recovered[1].status, "needs_input");
  assert.equal(run.status, "running");
});

test("binding distinguishes desired/effective versions and unsupported profiles", () => {
  assert.equal(
    skillBindingStatus({
      attached: true,
      desired: "1.5",
      effective: "1.4",
      running: "1.4",
      supported: true,
    }).id,
    "pending",
  );
  assert.equal(
    skillBindingStatus({
      attached: true,
      desired: "1.5",
      effective: "1.5",
      running: "1.4",
      supported: true,
    }).id,
    "pinned",
  );
  assert.equal(
    skillBindingStatus({ attached: true, supported: false }).id,
    "unsupported",
  );
  assert.equal(nextVersion("1.9"), "1.10");
  assert.throws(() => nextVersion("bad"), /INVALID_VERSION/);
});
