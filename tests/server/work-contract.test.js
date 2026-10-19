import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, command, values, waitFor } from "./helpers.js";
import { startWorker } from "../../server/worker.js";
import { modelMessages } from "../../server/provider.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { claimRun, processRun } from "../../server/worker.js";
import { migrate, event } from "../../server/db.js";

async function ready(h, client, input = values({ workType: "review" })) {
  const worker = await startWorker(h.pool, h.config);
  h.cleanup.push(() => worker.stop());
  let task = await newTask(client, input);
  assert.equal((await command(client, task, "start")).statusCode, 200);
  return waitFor(
    async () =>
      (await client.request("GET", `/api/tasks/${task.id}`)).json().task,
    (t) => t.status === "result_ready",
  );
}
test("rework pins reason and previous result independently of message truncation and a brief correction", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  let task = await ready(h, lead);
  const reference = task.artifacts[0];
  task = (
    await command(lead, task, "rework", {
      targetVersion: "next-version",
      reason: "REWORK_PROBE 재시도 예외 근거를 보완해주세요",
    })
  ).json().task;
  task = (
    await command(lead, task, "brief", {
      text: "새 요약",
      reason: "정정",
      source: "request",
    })
  ).json().task;
  for (let i = 0; i < 22; i++)
    await lead.request("POST", `/api/tasks/${task.id}/messages`, {
      body: "별도 추가 조건 " + i,
    });
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal((await command(lead, task, "start")).statusCode, 200);
  const run = (
    await h.pool.query(
      "SELECT snapshot FROM cr_runs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1",
      [task.id],
    )
  ).rows[0];
  assert.match(JSON.stringify(modelMessages(run.snapshot)), /REWORK_PROBE/);
  assert.equal(run.snapshot.rework.previous.artifactId, reference.id);
  assert.equal(run.snapshot.rework.previous.targetVersion, "abc1234");
  assert.equal(run.snapshot.rework.previous.execution, undefined);
  assert.equal(run.snapshot.targetVersion, "next-version");
  assert.equal(run.snapshot.inputArtifactId, null);
});
test("analysis keeps selected agent, applied skill, target and project; built-in execution skills cannot become chat", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const task = await newTask(
    lead,
    values({
      workType: "analysis",
      agentId: "review",
      skillId: "review",
      target: "provided material",
      targetVersion: "frozen-v2",
      project: "alpha",
    }),
  );
  assert.equal((await command(lead, task, "start")).statusCode, 200);
  const snapshot = (
    await h.pool.query("SELECT snapshot FROM cr_runs WHERE task_id=$1", [
      task.id,
    ])
  ).rows[0].snapshot;
  assert.equal(snapshot.agent.id, "review");
  assert.equal(snapshot.skill.id, "review");
  assert.equal(snapshot.target, "provided material");
  assert.equal(snapshot.targetVersion, "frozen-v2");
  assert.equal(snapshot.project, "alpha");
  for (const skillId of ["review", "code-change", "code-verify"]) {
    const agentId =
      skillId === "code-change"
        ? "dev"
        : skillId === "code-verify"
          ? "qa"
          : "review";
    const r = await lead.request(
      "POST",
      "/api/tasks",
      values({ workType: "chat", agentId, skillId }),
      { "idempotency-key": crypto.randomUUID() },
    );
    assert.equal(r.statusCode, 422);
  }
});
test("question assignment enforces task scopes and answer ownership; old result cannot be accepted after new answer", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  let task = await ready(h, lead);
  const created = await lead.request(
    "POST",
    `/api/tasks/${task.id}/questions`,
    {
      taskRevision: task.revision,
      assigneeId: member.user.id,
      prompt: "어느 테스트 환경을 기준으로 하나요?",
    },
  );
  assert.equal(created.statusCode, 201);
  const q = created.json().question;
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal(
    (await command(lead, task, "accept")).json().code,
    "QUESTIONS_PENDING",
  );
  assert.equal(
    (
      await lead.request("PATCH", `/api/tasks/${task.id}/questions/${q.id}`, {
        action: "answer",
        revision: q.revision,
        answer: "staging",
      })
    ).statusCode,
    403,
  );
  const answers = await Promise.all(
    [1, 2].map(() =>
      member.request("PATCH", `/api/tasks/${task.id}/questions/${q.id}`, {
        action: "answer",
        revision: q.revision,
        answer: "staging의 합성 환경",
      }),
    ),
  );
  assert.deepEqual(answers.map((r) => r.statusCode).sort(), [200, 409]);
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal(
    (await command(lead, task, "accept")).json().code,
    "ANSWERS_NOT_APPLIED",
  );
  task = (
    await command(lead, task, "rework", {
      targetVersion: task.target_version,
      reason: "질문 답변을 반영해주세요",
    })
  ).json().task;
  assert.equal((await command(lead, task, "start")).statusCode, 200);
  task = await waitFor(
    async () =>
      (await lead.request("GET", `/api/tasks/${task.id}`)).json().task,
    (t) => t.status === "result_ready",
  );
  const snap = (
    await h.pool.query("SELECT snapshot FROM cr_runs WHERE id=$1", [
      task.current_run_id,
    ])
  ).rows[0].snapshot;
  assert.match(JSON.stringify(modelMessages(snap)), /staging의 합성 환경/);
  assert.equal((await command(lead, task, "accept")).statusCode, 200);
  const privateTask = await newTask(member, values({ visibility: "private" }));
  assert.equal(
    (
      await member.request("POST", `/api/tasks/${privateTask.id}/questions`, {
        taskRevision: privateTask.revision,
        assigneeId: lead.user.id,
        prompt: "비공개 질문",
      })
    ).statusCode,
    400,
  );
  const own = (
    await member.request("POST", `/api/tasks/${privateTask.id}/questions`, {
      taskRevision: privateTask.revision,
      assigneeId: member.user.id,
      prompt: "숨겨진 질문",
    })
  ).json().question;
  assert.ok(
    !(await lead.request("GET", "/api/workspace")).body.includes(own.id),
  );
  assert.equal(
    (
      await lead.request(
        "PATCH",
        `/api/tasks/${privateTask.id}/questions/${own.id}`,
        { action: "answer", revision: 1, answer: "침범" },
      )
    ).statusCode,
    404,
  );
});
test("questions block start, permit reassignment, close on cancellation and supersede at a changed target", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  let task = await newTask(lead, values({ workType: "review" }));
  let q = (
    await lead.request("POST", `/api/tasks/${task.id}/questions`, {
      taskRevision: task.revision,
      assigneeId: member.user.id,
      prompt: "필수 정보",
    })
  ).json().question;
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal(
    (await command(lead, task, "start")).json().code,
    "QUESTIONS_PENDING",
  );
  q = (
    await lead.request("PATCH", `/api/tasks/${task.id}/questions/${q.id}`, {
      action: "assign",
      revision: q.revision,
      assigneeId: lead.user.id,
    })
  ).json().question;
  assert.equal(
    (
      await member.request("PATCH", `/api/tasks/${task.id}/questions/${q.id}`, {
        action: "answer",
        revision: q.revision,
        answer: "old assignee",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await lead.request("PATCH", `/api/tasks/${task.id}/questions/${q.id}`, {
        action: "close",
        revision: q.revision,
      })
    ).statusCode,
    200,
  );
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal((await command(lead, task, "start")).statusCode, 200);
  const worker = await startWorker(h.pool, h.config);
  h.cleanup.push(() => worker.stop());
  task = await waitFor(
    async () =>
      (await lead.request("GET", `/api/tasks/${task.id}`)).json().task,
    (t) => t.status === "result_ready",
  );
  q = (
    await lead.request("POST", `/api/tasks/${task.id}/questions`, {
      taskRevision: task.revision,
      assigneeId: member.user.id,
      prompt: "옛 대상의 질문",
    })
  ).json().question;
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  task = (
    await command(lead, task, "rework", {
      targetVersion: "changed-sha",
      reason: "대상이 달라졌어요",
    })
  ).json().task;
  const detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal(
    detail.questions.find((x) => x.id === q.id).status,
    "superseded",
  );
  assert.equal(
    (
      await member.request("PATCH", `/api/tasks/${task.id}/questions/${q.id}`, {
        action: "answer",
        revision: q.revision,
        answer: "late",
      })
    ).statusCode,
    409,
  );
  q = (
    await lead.request("POST", `/api/tasks/${task.id}/questions`, {
      taskRevision: task.revision,
      assigneeId: lead.user.id,
      prompt: "닫힐 질문",
    })
  ).json().question;
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.equal((await command(lead, task, "cancel")).statusCode, 200);
  assert.equal(
    (await lead.request("GET", `/api/tasks/${task.id}`))
      .json()
      .task.questions.find((x) => x.id === q.id).status,
    "closed",
  );
});

test("rework instructions cross the real Worker and Claude HTTP adapter exactly in the new request", async (t) => {
  const names = ["MODEL_API_KEY", "MODEL_API_KEY_FILE"],
    old = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  process.env.MODEL_API_KEY = "test-only-rework-key";
  delete process.env.MODEL_API_KEY_FILE;
  t.after(() => {
    for (const k of names) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  });
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: "합성 응답",
              evidence: ["로컬 프로토콜"],
              unknowns: ["실제 추론 아님"],
              nextActions: ["사람 검토"],
            }),
          },
        ],
        stop_reason: "end_turn",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const h = await harness(t, {
    provider: "anthropic",
    model: "local-contract",
    modelEndpoint: `http://127.0.0.1:${server.address().port}/messages`,
    allowFixture: false,
  });
  const lead = await h.client("lead@example.com");
  let task = await newTask(lead, values({ workType: "review" }));
  await command(lead, task, "start");
  let run = await claimRun(h.pool, "rework-http", h.config);
  await processRun(h.pool, run, "rework-http", h.config);
  task = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  task = (
    await command(lead, task, "rework", {
      reason: "HTTP_REWORK_MARKER 이전 누락 근거를 추가",
      targetVersion: task.target_version,
    })
  ).json().task;
  await command(lead, task, "start");
  run = await claimRun(h.pool, "rework-http", h.config);
  await processRun(h.pool, run, "rework-http", h.config);
  assert.equal(bodies.length, 2);
  assert.ok(!JSON.stringify(bodies[0]).includes("HTTP_REWORK_MARKER"));
  assert.match(JSON.stringify(bodies[1]), /HTTP_REWORK_MARKER/);
  assert.match(JSON.stringify(bodies[1]), /이전 검사와 수용/);
});

test("migration 008 upgrades old tasks and recovers explicit legacy rework events without changing old snapshots", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const task = await newTask(lead, values({ workType: "review" }));
  await event(h.pool, task.id, { type: "user", id: lead.user.id }, "rework", {
    reason: "LEGACY_REWORK 기존 요청",
    targetVersion: task.target_version,
  });
  await h.pool.query(
    "DROP TABLE cr_questions; ALTER TABLE cr_tasks DROP COLUMN rework,DROP COLUMN question_revision; ALTER TABLE cr_tasks DROP CONSTRAINT cr_tasks_work_type_check; ALTER TABLE cr_tasks ADD CHECK(work_type IN ('pr-qa','review','ops','chat','code-qa')); DELETE FROM cr_migrations WHERE name='008_work_contract.sql'",
  );
  await migrate(h.pool);
  await migrate(h.pool);
  const restored = (
    await h.pool.query("SELECT * FROM cr_tasks WHERE id=$1", [task.id])
  ).rows[0];
  assert.equal(restored.goal, task.goal);
  assert.equal(restored.question_revision, 0);
  assert.equal(restored.rework.reason, "LEGACY_REWORK 기존 요청");
  assert.equal(
    Number(
      (await h.pool.query("SELECT count(*) FROM cr_questions")).rows[0].count,
    ),
    0,
  );
  assert.equal(
    Number(
      (await h.pool.query("SELECT count(*) FROM cr_migrations")).rows[0].count,
    ),
    8,
  );
});
