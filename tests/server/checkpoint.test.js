import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, actInWorkspace } from "../../server/worker.js";
import { confirmStopped } from "../../server/recovery.js";

async function pausedCheckpoint(t) {
  const profile = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "checkpoint-sources",
        imageId: "sha256:" + "a".repeat(64),
        checks: [{ id: "test" }],
      }),
    );
  });
  await new Promise((r) => profile.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => profile.close(r)));
  const runnerUrl = `http://127.0.0.1:${profile.address().port}`,
    h = await harness(t, { runnerUrl }),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const source = await lead.request("POST", "/api/memories", {
    agentId: "dev",
    visibility: "team",
    project: "checkpoint-source-quality",
    title: "Implementation requirement",
    body: "Use the original accepted requirement",
    source: "explicit synthetic input",
  });
  assert.equal(source.statusCode, 201, source.body);
  let task = await newTask(
    lead,
    values({
      workType: "code-qa",
      project: "checkpoint-source-quality",
      target: "https://gitlab.test/team/project",
      targetVersion: "a".repeat(40),
    }),
  );
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "checkpoint-source", h.config),
    draft = await actInWorkspace(h.pool, run, "checkpoint-source", {
      action: "write_workspace",
      path: "progress.md",
      content: "Implementation plan based on the original source",
      expectedRevision: 0,
    }),
    checkpoint = {
      patch: "synthetic checkpoint for source propagation",
      patchHash: "b".repeat(64),
      baselineSha: "a".repeat(40),
      profileId: "checkpoint-sources",
    };
  await h.pool.query(
    "INSERT INTO cr_execution_jobs(run_id,generation,job_id,endpoint,profile_id,status,checkpoint) VALUES($1,$2,$3,$4,$5,'stopped',$6)",
    [
      run.id,
      run.generation,
      run.id + "-1",
      runnerUrl,
      checkpoint.profileId,
      checkpoint,
    ],
  );
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  await command(lead, task, "pause");
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  await confirmStopped(
    h.pool,
    run.id,
    "Synthetic operator confirmed the code Job is stopped",
  );
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  return {
    ...h,
    lead,
    member,
    task,
    run,
    draft,
    checkpoint,
    memory: source.json(),
  };
}

test("code handoff inherits current checkpoint memory and workspace sources under the new requester", async (t) => {
  const h = await pausedCheckpoint(t);
  let task = (
    await command(h.lead, h.task, "assign", { responsibleId: h.member.user.id })
  ).json().task;
  await h.pool.query("UPDATE cr_members SET active=false WHERE id=$1", [
    h.lead.user.id,
  ]);
  const response = await command(h.member, task, "start");
  assert.equal(response.statusCode, 200, response.body);
  const next = (
    await h.pool.query("SELECT * FROM cr_runs WHERE id=$1", [
      response.json().task.current_run_id,
    ])
  ).rows[0];
  assert.equal(next.requested_by, h.member.user.id);
  assert.equal(next.snapshot.execution.checkpoint.patch, h.checkpoint.patch);
  assert.ok(
    next.snapshot.inheritedRefs.some((r) => r.key === "memory:" + h.memory.id),
  );
  assert.ok(
    next.snapshot.inheritedRefs.some(
      (r) => r.key === "workspace:" + h.draft.id,
    ),
  );
  assert.equal(next.snapshot.execution.checkpoint.contextVersion, 1);
});

test("a corrected checkpoint source blocks handoff reuse while preserving the old patch", async (t) => {
  const h = await pausedCheckpoint(t);
  const corrected = await h.lead.request(
    "PATCH",
    `/api/memories/${h.memory.id}`,
    {
      revision: 1,
      title: "Corrected requirement",
      body: "The old requirement is revoked",
      reason: "Corrected before responsibility transfer",
    },
  );
  assert.equal(corrected.statusCode, 200, corrected.body);
  const task = (
    await command(h.lead, h.task, "assign", { responsibleId: h.member.user.id })
  ).json().task;
  const response = await command(h.member, task, "start");
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "CHECKPOINT_CONTEXT_REVOKED");
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*)::int AS n FROM cr_runs WHERE task_id=$1",
        [task.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await h.pool.query(
        "SELECT checkpoint->>'patch' AS patch FROM cr_execution_jobs WHERE run_id=$1",
        [h.run.id],
      )
    ).rows[0].patch,
    h.checkpoint.patch,
  );
});

test("legacy repeated checkpoint retries validate ancestor sources instead of laundering an old patch", async (t) => {
  const h = await pausedCheckpoint(t);
  await h.pool.query("UPDATE cr_runs SET status='failed' WHERE id=$1", [
    h.run.id,
  ]);
  await h.pool.query(
    "UPDATE cr_tasks SET status='failed',revision=revision+1 WHERE id=$1",
    [h.task.id],
  );
  let task = (await h.lead.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  const first = await command(h.lead, task, "start");
  assert.equal(first.statusCode, 200, first.body);
  const secondId = first.json().task.current_run_id;
  // Reproduce a pre-provenance snapshot: patch/sourceRunId survived, refs did not.
  await h.pool.query(
    "UPDATE cr_runs SET status='failed',snapshot=(snapshot||'{\"inheritedRefs\":[]}'::jsonb)#-'{execution,checkpoint,sourceRefs}' #-'{execution,checkpoint,contextVersion}' WHERE id=$1",
    [secondId],
  );
  await h.pool.query(
    "UPDATE cr_tasks SET status='failed',revision=revision+1 WHERE id=$1",
    [task.id],
  );
  const corrected = await h.lead.request(
    "PATCH",
    `/api/memories/${h.memory.id}`,
    {
      revision: 1,
      title: "Corrected ancestor",
      body: "The ancestor requirement no longer applies",
      reason: "Corrected between legacy retries",
    },
  );
  assert.equal(corrected.statusCode, 200);
  task = (await h.lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  const response = await command(h.lead, task, "start");
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "CHECKPOINT_CONTEXT_REVOKED");
});
test("inherited checkpoint survives repeated failures before a new job exists and still rejects profile changes", async (t) => {
  let profileId = "stable-profile";
  const profile = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: profileId,
        imageId: "sha256:" + "a".repeat(64),
        checks: [{ id: "test" }],
      }),
    );
  });
  await new Promise((r) => profile.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => profile.close(r)));
  const runnerUrl = "http://127.0.0.1:" + profile.address().port,
    h = await harness(t, { runnerUrl }),
    user = await h.client("lead@example.com");
  let task = await newTask(
    user,
    values({
      workType: "code-qa",
      target: "https://gitlab.test/team/project",
      targetVersion: "a".repeat(40),
    }),
  );
  await command(user, task, "start");
  const first = (
      await h.pool.query("SELECT * FROM cr_runs WHERE task_id=$1", [task.id])
    ).rows[0],
    checkpoint = {
      patch: "preserved synthetic patch",
      patchHash: "b".repeat(64),
      baselineSha: "a".repeat(40),
      profileId,
    };
  await h.pool.query(
    "INSERT INTO cr_execution_jobs(run_id,generation,job_id,endpoint,profile_id,status,checkpoint) VALUES($1,1,$2,$3,$4,'stopped',$5)",
    [first.id, first.id + "-1", runnerUrl, profileId, checkpoint],
  );
  async function fail(id) {
    await h.pool.query(
      "UPDATE cr_runs SET status='failed',error_code='ARCHIVE_UNAVAILABLE' WHERE id=$1",
      [id],
    );
    await h.pool.query(
      "UPDATE cr_tasks SET status='failed',revision=revision+1 WHERE id=$1",
      [task.id],
    );
    task = (await user.request("GET", `/api/tasks/${task.id}`)).json().task;
  }
  await fail(first.id);
  assert.equal((await command(user, task, "start")).statusCode, 200);
  let second = (
    await h.pool.query(
      "SELECT * FROM cr_runs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1",
      [task.id],
    )
  ).rows[0];
  assert.equal(second.snapshot.execution.checkpoint.patch, checkpoint.patch);
  assert.equal(
    (
      await h.pool.query("SELECT * FROM cr_execution_jobs WHERE run_id=$1", [
        second.id,
      ])
    ).rowCount,
    0,
  );
  await fail(second.id);
  assert.equal((await command(user, task, "start")).statusCode, 200);
  const third = (
    await h.pool.query(
      "SELECT * FROM cr_runs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1",
      [task.id],
    )
  ).rows[0];
  assert.equal(third.snapshot.execution.checkpoint.patch, checkpoint.patch);
  assert.equal(third.snapshot.execution.checkpoint.sourceRunId, second.id);
  await fail(third.id);
  profileId = "changed-profile";
  const rejected = await command(user, task, "start");
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, "CHECKPOINT_PROFILE_CHANGED");
});
