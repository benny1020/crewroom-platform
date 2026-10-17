import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { harness, newTask, values, command } from "./helpers.js";
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
