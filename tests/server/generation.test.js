import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, command } from "./helpers.js";
import { claimRun, failRun } from "../../server/worker.js";
import { confirmStopped } from "../../server/recovery.js";
import { HttpError } from "../../server/errors.js";
test("late unknown error cannot fail a resumed generation owned by the same worker", async (t) => {
  const h = await harness(t),
    user = await h.client("lead@example.com");
  let task = await newTask(user);
  await command(user, task, "start");
  const old = await claimRun(h.pool, "same-worker", h.config);
  task = (await user.request("GET", `/api/tasks/${task.id}`)).json().task;
  await command(user, task, "pause");
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [old.id],
  );
  await confirmStopped(
    h.pool,
    old.id,
    "operator test confirms old execution ended",
  );
  task = (await user.request("GET", `/api/tasks/${task.id}`)).json().task;
  await command(user, task, "start");
  const resumed = await claimRun(h.pool, "same-worker", h.config);
  assert.ok(resumed.generation > old.generation + 1);
  assert.equal(
    await failRun(
      h.pool,
      old.id,
      "same-worker",
      old.generation,
      new HttpError(503, "DISPATCH_UNKNOWN", "old response unknown"),
    ),
    false,
  );
  const current = (
    await h.pool.query("SELECT * FROM cr_runs WHERE id=$1", [old.id])
  ).rows[0];
  assert.equal(current.status, "running");
  assert.equal(current.generation, resumed.generation);
});
