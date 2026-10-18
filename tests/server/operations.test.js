import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, command, values } from "./helpers.js";
import { insertArtifact } from "../../server/tasks.js";

test("operator metrics enforce role and task ACL, include old visible tasks and count each receipt once", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  assert.equal(
    (await member.request("GET", "/api/admin/operations")).statusCode,
    403,
  );
  assert.equal(
    (await h.app.inject({ method: "GET", url: "/api/admin/operations" }))
      .statusCode,
    401,
  );
  const shared = await newTask(lead, values({ workType: "review" }));
  const hidden = await newTask(
    member,
    values({
      workType: "chat",
      agentId: "personal-" + member.user.id,
      visibility: "private",
      goal: "hidden-marker",
    }),
  );
  const department = await newTask(
    member,
    values({ visibility: "department", goal: "qa-hidden-marker" }),
  );
  await command(lead, shared, "start");
  await insertArtifact(h.pool, shared, 0, {
    origin: "model",
    result: {
      summary: "recorded",
      evidence: [],
      unknowns: [],
      nextActions: [],
      receipt: {
        usage: { promptTokens: 99, completionTokens: 99 },
        requests: [
          { usage: { promptTokens: 10, completionTokens: 4 } },
          { usage: null },
        ],
      },
    },
  });
  for (const task of [hidden, department]) {
    await h.pool.query("UPDATE cr_tasks SET status='failed' WHERE id=$1", [
      task.id,
    ]);
    await insertArtifact(h.pool, task, 0, {
      origin: "model",
      result: {
        summary: "hidden",
        receipt: { usage: { promptTokens: 90000, completionTokens: 90000 } },
      },
    });
  }
  await insertArtifact(h.pool, shared, 0, {
    origin: "fixture",
    result: {
      summary: "fixture",
      receipt: { usage: { promptTokens: 80000, completionTokens: 80000 } },
    },
  });
  const r = (await lead.request("GET", "/api/admin/operations")).json();
  assert.equal(r.queued, 1);
  assert.equal(r.tasks.queued, 1);
  assert.equal(r.tasks.failed, undefined);
  assert.equal(r.usage.recordedCalls, 2);
  assert.equal(r.usage.inputTokens, 10);
  assert.equal(r.usage.outputTokens, 4);
  assert.equal(r.usage.usageMissing, 1);
  assert.equal(r.usage.cost, null);
  assert.ok(!JSON.stringify(r).includes("hidden-marker"));
  assert.equal(r.attention.length, 0);
  await h.pool.query(
    "UPDATE cr_runs SET status='failed',error_code='MODEL_TIMEOUT',started_at=now()-interval '12 seconds',finished_at=now() WHERE task_id=$1",
    [shared.id],
  );
  await h.pool.query(
    "UPDATE cr_tasks SET status='failed',updated_at=now()-interval '3 days' WHERE id=$1",
    [shared.id],
  );
  const failed = (await lead.request("GET", "/api/admin/operations")).json();
  assert.equal(failed.failed, 1);
  assert.equal(failed.finished, 1);
  assert.ok(failed.mean_duration_ms >= 12000);
  assert.equal(failed.attention[0].id, shared.id);
  assert.equal(failed.attention[0].error_code, "MODEL_TIMEOUT");
});
test("task list retains agent ID through renaming and exposes the applied skill criterion rather than latest publication", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  await newTask(lead, values({ workType: "review" }));
  await h.pool.query(
    "UPDATE cr_agents SET name='같은 이름' WHERE id IN ('review','qa')",
  );
  const w = (await lead.request("GET", "/api/workspace")).json();
  assert.equal(w.tasks[0].agent_id, "review");
  const a = w.agents.find((a) => a.id === "review");
  assert.ok(
    a.skills.every(
      (b) => typeof b.doneCriteria === "string" && b.doneCriteria.length,
    ),
  );
  const empty = (await lead.request("GET", "/api/admin/operations")).json();
  assert.equal(empty.usage.inputTokens, null);
  assert.equal(empty.mean_duration_ms, null);
});

test("ten queued requests drain through two slots without duplicate results and the operator view follows the queue", async (t) => {
  const { claimRun, processRun } = await import("../../server/worker.js");
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    ids = [];
  for (let i = 0; i < 10; i++) {
    const task = await newTask(
      lead,
      values({
        workType: "chat",
        agentId: i % 2 ? "review" : "ops",
        goal: "합성 대기열 검사 " + i,
      }),
    );
    await command(lead, task, "start");
    ids.push(task.id);
  }
  const metrics = async () =>
    (await lead.request("GET", "/api/admin/operations")).json();
  assert.equal((await metrics()).queued, 10);
  const claimed = new Set();
  for (let batch = 0; batch < 5; batch++) {
    const first = await claimRun(h.pool, "queue-check", h.config),
      second = await claimRun(h.pool, "queue-check", h.config);
    assert.ok(first && second);
    assert.notEqual(first.agent_id, second.agent_id);
    assert.equal(await claimRun(h.pool, "queue-check", h.config), null);
    assert.equal((await metrics()).running, 2);
    for (const r of [first, second]) {
      assert.ok(!claimed.has(r.id));
      claimed.add(r.id);
    }
    await Promise.all(
      [first, second].map((r) =>
        processRun(h.pool, r, "queue-check", h.config),
      ),
    );
  }
  const final = await metrics();
  assert.equal(claimed.size, 10);
  assert.equal(final.running, 0);
  assert.equal(final.queued, 0);
  assert.equal(final.finished, 10);
  assert.equal(final.failed, 0);
  const count = await h.pool.query(
    "SELECT count(*)::int n FROM cr_artifacts WHERE task_id=ANY($1::uuid[])",
    [ids],
  );
  assert.equal(count.rows[0].n, 10);
});
