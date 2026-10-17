import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, newTask, command, values, waitFor } from "./helpers.js";
import {
  startWorker,
  claimRun,
  processRun,
  completeRun,
  expireRuns,
} from "../../server/worker.js";

test("two users share one persisted workflow with pinned review→QA artifacts and human acceptance", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const worker = await startWorker(h.pool, h.config);
  h.cleanup.push(() => worker.stop());
  let task = await newTask(lead),
    r = await command(lead, task, "start");
  assert.equal(r.statusCode, 200);
  task = await waitFor(
    async () =>
      (await lead.request("GET", `/api/tasks/${task.id}`)).json().task,
    (t) => t.status === "result_ready",
  );
  assert.equal(task.runs.length, 1);
  assert.equal(task.artifacts[0].origin, "fixture");
  assert.equal(task.acceptances.length, 0);
  assert.equal((await command(member, task, "handoff")).statusCode, 403);
  assert.equal(
    (
      await member.request("POST", `/api/tasks/${task.id}/messages`, {
        body: "다중 탭도 확인해주세요",
      })
    ).statusCode,
    200,
  );
  let response = await command(lead, task, "assign", {
    responsibleId: member.user.id,
  });
  task = response.json().task;
  response = await command(member, task, "handoff");
  task = response.json().task;
  assert.equal(task.step_index, 1);
  assert.equal((await command(member, task, "start")).statusCode, 200);
  task = await waitFor(
    async () =>
      (await member.request("GET", `/api/tasks/${task.id}`)).json().task,
    (t) => t.status === "result_ready",
  );
  assert.equal(task.runs.length, 2);
  assert.equal(task.runs[1].snapshot.inputArtifactId, task.artifacts[0].id);
  assert.equal(task.runs[1].snapshot.targetVersion, "abc1234");
  assert.equal((await command(member, task, "accept")).statusCode, 200);
  const read = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal(read.status, "done");
  assert.equal(read.acceptances.length, 1);
  assert.equal(read.messages[0].body, "다중 탭도 확인해주세요");
  assert.equal(read.artifacts[1].result.verification, "unverified");
  assert.equal(
    (await lead.request("GET", `/api/artifacts/${read.artifacts[1].id}`))
      .statusCode,
    200,
  );
});
test("creation is idempotent, conflicting contents and stale task revisions cannot overwrite work", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    key = randomUUID();
  const requests = await Promise.all(
    [1, 2].map(() =>
      lead.request("POST", "/api/tasks", values(), { "idempotency-key": key }),
    ),
  );
  assert.equal(requests[0].json().task.id, requests[1].json().task.id);
  assert.equal(
    (
      await lead.request("POST", "/api/tasks", values({ goal: "different" }), {
        "idempotency-key": key,
      })
    ).statusCode,
    409,
  );
  const task = requests[0].json().task;
  const starts = await Promise.all([
    command(lead, task, "start"),
    command(lead, task, "start"),
  ]);
  assert.deepEqual(starts.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    Number((await h.pool.query("SELECT count(*) FROM cr_runs")).rows[0].count),
    1,
  );
});
test("private and department tasks/artifacts stay inaccessible even to a team lead outside scope", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const task = await newTask(
    member,
    values({
      visibility: "private",
      imported: { body: "개인 결과 문장", source: "원문" },
    }),
  );
  assert.equal(
    (await lead.request("GET", `/api/tasks/${task.id}`)).statusCode,
    404,
  );
  assert.ok(
    !(await lead.request("GET", "/api/workspace")).body.includes(
      "개인 결과 문장",
    ),
  );
  const artifact = (await member.request("GET", `/api/tasks/${task.id}`)).json()
    .task.artifacts[0];
  assert.equal(
    (await lead.request("GET", `/api/artifacts/${artifact.id}`)).statusCode,
    404,
  );
  const dept = await newTask(member, values({ visibility: "department" }));
  assert.equal(
    (await lead.request("GET", `/api/tasks/${dept.id}`)).statusCode,
    404,
  );
});
test("claim is atomic across workers, paused runs retain versions, late completions are rejected", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  let task = await newTask(lead);
  task = (await command(lead, task, "start")).json().task;
  const [a, b] = await Promise.all([
    claimRun(h.pool, "worker-a", h.config),
    claimRun(h.pool, "worker-b", h.config),
  ]);
  const run = a || b,
    owner = a ? "worker-a" : "worker-b";
  assert.ok(run);
  assert.ok(!a || !b);
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal((await command(lead, task, "pause")).statusCode, 200);
  const result = await completeRun(h.pool, run.id, owner, run.generation, {
    origin: "fixture",
    result: { summary: "late" },
    receipt: {},
  });
  assert.equal(result, false);
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal(
    (await command(lead, task, "start")).json().code,
    "STOP_CONFIRMATION_REQUIRED",
  );
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  assert.equal(
    (
      await lead.request("POST", `/api/runs/${run.id}/confirm-stopped`, {
        confirmedStopped: true,
      })
    ).statusCode,
    200,
  );
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal((await command(lead, task, "start")).statusCode, 200);
  const resumed = await claimRun(h.pool, "worker-c", h.config);
  assert.equal(resumed.id, run.id);
  assert.deepEqual(resumed.snapshot.skill, run.snapshot.skill);
  assert.ok(resumed.generation > run.generation);
});
test("expired execution becomes recovery-required and is never automatically dispatched again", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  let task = await newTask(lead);
  task = (await command(lead, task, "start")).json().task;
  const run = await claimRun(h.pool, "dead-worker", h.config);
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  assert.equal(await expireRuns(h.pool), 1);
  const result = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal(result.status, "failed");
  assert.equal(result.runs[0].error_code, "LEASE_EXPIRED");
  assert.equal(await claimRun(h.pool, "new-worker", h.config), null);
  assert.equal((await command(lead, result, "start")).statusCode, 409);
});
