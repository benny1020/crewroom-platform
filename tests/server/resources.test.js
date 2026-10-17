import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, command, values } from "./helpers.js";
import { claimRun, processRun } from "../../server/worker.js";

test("skill publishing and agent binding are separate permissions, and queued runs keep immutable bodies", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  assert.equal(
    (
      await lead.request("PATCH", "/api/skills/review/steward", {
        stewardId: member.user.id,
      })
    ).statusCode,
    200,
  );
  let task = await newTask(lead);
  task = (await command(lead, task, "start")).json().task;
  assert.equal(
    (
      await member.request("POST", "/api/skills/review/versions", {
        revision: 1,
        instructions: "새 공용 검토 기준",
        doneCriteria: "근거를 확인",
      })
    ).statusCode,
    200,
  );
  let data = (await lead.request("GET", "/api/workspace")).json(),
    agent = data.agents.find((a) => a.id === "review");
  assert.equal(agent.skills.find((s) => s.skillId === "review").version, 1);
  assert.equal(
    (
      await member.request("POST", "/api/agents/review/bindings", {
        skillId: "review",
        version: 2,
        agentRevision: agent.config_version,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await lead.request("POST", "/api/agents/review/bindings", {
        skillId: "review",
        version: 2,
        agentRevision: agent.config_version,
      })
    ).statusCode,
    200,
  );
  const run = await claimRun(h.pool, "fixture-worker", h.config);
  assert.equal(run.snapshot.skill.version, 1);
  assert.ok(!run.snapshot.skill.instructions.includes("새 공용 검토 기준"));
});
test("private memories never enter team runs, and source task scopes cannot be widened", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  assert.equal(
    (
      await lead.request("POST", "/api/memories", {
        agentId: "review",
        visibility: "private",
        title: "비공개",
        body: "개인 전용 고유문장",
        source: "개인 대화",
      })
    ).statusCode,
    201,
  );
  const own = await newTask(lead, values({ visibility: "private" }));
  assert.equal(
    (
      await lead.request("POST", "/api/memories", {
        agentId: "review",
        visibility: "team",
        sourceTaskId: own.id,
        title: "유출 시도",
        body: "고유문장",
        source: "비공개 업무",
      })
    ).statusCode,
    400,
  );
  const task = await newTask(lead);
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "fixture-worker", h.config);
  assert.ok(!JSON.stringify(run.snapshot).includes("개인 전용 고유문장"));
  assert.ok(
    !(await member.request("GET", "/api/memories")).body.includes(
      "개인 전용 고유문장",
    ),
  );
});
test("deleting a pinned memory invalidates queued context rather than silently reusing it", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const response = await lead.request("POST", "/api/memories", {
      agentId: "review",
      visibility: "team",
      title: "공용 규칙",
      body: "출처 기록",
      source: "팀 합의",
    }),
    memory = response.json();
  const task = await newTask(lead);
  await command(lead, task, "start");
  assert.equal(
    (
      await lead.request("DELETE", `/api/memories/${memory.id}`, {
        revision: 1,
      })
    ).statusCode,
    200,
  );
  assert.equal(await claimRun(h.pool, "fixture-worker", h.config), null);
  const result = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal(result.status, "failed");
  assert.equal(result.runs[0].error_code, "CONTEXT_REVOKED");
});
