import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values, command } from "./helpers.js";
test("team skill creation is lead-controlled; personal skill stays private and selected binding is pinned", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true),
    input = {
      name: "주간 업무 정리",
      scope: "private",
      instructions: "업무를 성과, 장애, 다음 계획 순으로 정리한다.",
      doneCriteria: "세 구분을 빠짐없이 작성한다.",
    };
  assert.equal(
    (await member.request("POST", "/api/skills", { ...input, scope: "team" }))
      .statusCode,
    403,
  );
  const created = await member.request("POST", "/api/skills", input);
  assert.equal(created.statusCode, 201);
  const skill = created.json().skill;
  let workspace = (await member.request("GET", "/api/workspace")).json();
  const assistant = workspace.agents.find((a) => a.owner_id === member.user.id);
  assert.equal(
    (
      await lead.request("POST", `/api/skills/${skill.id}/versions`, {
        revision: 1,
        instructions: "stolen",
        doneCriteria: "stolen",
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await member.request("POST", `/api/agents/${assistant.id}/bindings`, {
        skillId: skill.id,
        version: 1,
        agentRevision: assistant.config_version,
      })
    ).statusCode,
    200,
  );
  const task = await newTask(
    member,
    values({
      workType: "chat",
      agentId: assistant.id,
      skillId: skill.id,
      visibility: "private",
    }),
  );
  assert.equal((await command(member, task, "start")).statusCode, 200);
  const run = (
    await h.pool.query("SELECT snapshot FROM cr_runs WHERE task_id=$1", [
      task.id,
    ])
  ).rows[0];
  assert.equal(run.snapshot.skill.id, skill.id);
  assert.equal(run.snapshot.skill.instructions, input.instructions);
  assert.equal(
    (await lead.request("GET", "/api/workspace"))
      .json()
      .skills.some((s) => s.id === skill.id),
    false,
  );
  const publicSkill = (
    await lead.request("POST", "/api/skills", { ...input, scope: "team" })
  ).json().skill;
  const shared = (await lead.request("GET", "/api/workspace"))
    .json()
    .agents.find((a) => a.id === "dev");
  assert.equal(
    (
      await lead.request("POST", "/api/agents/dev/bindings", {
        skillId: publicSkill.id,
        version: 1,
        agentRevision: shared.config_version,
      })
    ).statusCode,
    200,
  );
});
