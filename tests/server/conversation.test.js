import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, processRun } from "../../server/worker.js";
test("conversation continues in the same shared workroom and pins the previous answer plus new message", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  let task = await newTask(
    lead,
    values({ workType: "chat", agentId: "chief" }),
  );
  await command(lead, task, "start");
  let run = await claimRun(h.pool, "chat-worker", h.config);
  await processRun(h.pool, run, "chat-worker", h.config);
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  const first = task.artifacts[0];
  await command(lead, task, "accept");
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal((await command(member, task, "continue")).statusCode, 403);
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "앞서 답변의 두 번째 항목을 더 자세히 알려주세요.",
  });
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal((await command(lead, task, "continue")).statusCode, 200);
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal((await command(lead, task, "start")).statusCode, 200);
  run = await claimRun(h.pool, "chat-worker", h.config);
  assert.equal(run.snapshot.inputArtifactId, first.id);
  assert.equal(run.snapshot.inputArtifact.summary, first.result.summary);
  assert.match(run.snapshot.messages.at(-1).body, /두 번째/);
  await processRun(h.pool, run, "chat-worker", h.config);
  task = (await member.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal(task.artifacts.length, 2);
  assert.equal(task.status, "result_ready");
  assert.ok(task.acceptances[0].revoked_at);
});
