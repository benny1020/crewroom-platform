import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, newTask, command, values } from "./helpers.js";
import { claimRun, processRun } from "../../server/worker.js";
import { modelProfile } from "../../server/config.js";
import { runSkillDesigner } from "../../server/skill-designer.js";
import { saveSkillStudio } from "../../server/skill-studio.js";
import { createTask } from "../../server/tasks.js";

const draft = {
  name: "주간 업무 정리",
  instructions: "성과, 장애, 다음 계획을 정리하고 부족한 입력은 질문한다.",
  doneCriteria: "세 항목을 빠짐없이 작성하고 추정하지 않는다.",
};
async function create(client, body = {}, key = randomUUID()) {
  return client.request(
    "POST",
    "/api/skill-studio",
    { message: "매주 업무를 세 항목으로 정리하는 스킬을 만들고 싶어", ...body },
    { "idempotency-key": key },
  );
}
async function finish(h, owner = "studio-test") {
  const r = await claimRun(h.pool, owner, h.config);
  assert.ok(r);
  await processRun(h.pool, r, owner, h.config);
  return r;
}
async function detail(client, id) {
  return (await client.request("GET", "/api/tasks/" + id)).json().task;
}
test("AI skill drafting is durable and private, refinement pins edited input, and save/bind is atomic and idempotent", async (t) => {
  const h = await harness(t),
    member = await h.client("member@example.com", true),
    lead = await h.client("lead@example.com"),
    key = randomUUID();
  const response = await create(member, {}, key);
  assert.equal(response.statusCode, 201, response.body);
  const id = response.json().task.id;
  assert.equal((await create(member, {}, key)).json().task.id, id);
  assert.equal(
    (await create(member, { message: "different" }, key)).statusCode,
    409,
  );
  assert.equal((await lead.request("GET", "/api/tasks/" + id)).statusCode, 404);
  assert.equal(
    (await lead.request("GET", "/api/workspace")).json().skillStudios.length,
    0,
  );
  assert.equal(
    (await member.request("GET", "/api/workspace")).json().skillStudios[0].id,
    id,
  );
  const initialSkills = (
    await h.pool.query("SELECT count(*)::int n FROM cr_skills")
  ).rows[0].n;
  await finish(h);
  let task = await detail(member, id);
  assert.equal(task.status, "result_ready");
  assert.ok(task.artifacts.at(-1).result.skillDraft);
  assert.equal(
    (await h.pool.query("SELECT count(*)::int n FROM cr_skills")).rows[0].n,
    initialSkills,
  );
  const turn = await member.request("POST", `/api/skill-studio/${id}/turns`, {
    revision: task.revision,
    message: "이 초안을 세 줄 이내로 다듬어줘",
    draft,
  });
  assert.equal(turn.statusCode, 200, turn.body);
  const run = await finish(h);
  assert.deepEqual(run.snapshot.skillDesign.draft, draft);
  assert.equal(
    run.snapshot.messages.at(-1).body,
    "이 초안을 세 줄 이내로 다듬어줘",
  );
  task = await detail(member, id);
  assert.equal(task.artifacts.length, 2);
  assert.deepEqual(task.artifacts.at(-1).result.skillDraft, draft);
  const body = {
    revision: task.revision,
    draft,
    scope: "private",
    agentId: `personal-${member.user.id}`,
  };
  const saved = await member.request(
    "POST",
    `/api/skill-studio/${id}/save`,
    body,
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const again = await member.request(
    "POST",
    `/api/skill-studio/${id}/save`,
    body,
  );
  assert.deepEqual(again.json(), saved.json());
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*)::int n FROM cr_skill_versions WHERE skill_id=$1",
        [saved.json().skill.id],
      )
    ).rows[0].n,
    1,
  );
  const bound = (await member.request("GET", "/api/workspace"))
    .json()
    .agents.find((a) => a.owner_id === member.user.id).skills;
  assert.ok(
    bound.some((s) => s.skillId === saved.json().skill.id && s.version === 1),
  );
  assert.equal(
    (await lead.request("POST", `/api/skill-studio/${id}/save`, body))
      .statusCode,
    404,
  );
});
test("shared publication and binding keep their roles, invalid binding rolls back publication, and editing detects new versions", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const mr = await create(member);
  await finish(h);
  let mt = await detail(member, mr.json().task.id);
  const skillCount = (
    await h.pool.query("SELECT count(*)::int n FROM cr_skills")
  ).rows[0].n;
  assert.equal(
    (
      await member.request("POST", `/api/skill-studio/${mt.id}/save`, {
        revision: mt.revision,
        draft,
        scope: "team",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await member.request("POST", `/api/skill-studio/${mt.id}/save`, {
        revision: mt.revision,
        draft,
        scope: "private",
        agentId: "dev",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await h.pool.query("SELECT count(*)::int n FROM cr_skills")).rows[0].n,
    skillCount,
  );
  const lr = await create(lead);
  await finish(h);
  const lt = await detail(lead, lr.json().task.id);
  const saved = await lead.request("POST", `/api/skill-studio/${lt.id}/save`, {
    revision: lt.revision,
    draft,
    scope: "team",
    agentId: "dev",
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const skill = saved.json().skill;
  assert.equal(
    (await create(member, { baseSkillId: skill.id })).statusCode,
    403,
  );
  await lead.request("PATCH", `/api/skills/${skill.id}/steward`, {
    stewardId: member.user.id,
  });
  const editing = await create(member, { baseSkillId: skill.id });
  assert.equal(editing.statusCode, 201, editing.body);
  await finish(h);
  const et = await detail(member, editing.json().task.id);
  assert.equal(
    (
      await lead.request("POST", `/api/skills/${skill.id}/versions`, {
        revision: 1,
        instructions: "다른 최신 지침",
        doneCriteria: "현재 최신 기준",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await member.request("POST", `/api/skill-studio/${et.id}/save`, {
        revision: et.revision,
        draft,
        scope: "team",
      })
    ).statusCode,
    409,
  );
});
test("sample runs preserve the exact draft and do not publish, while stale turns and uncertain dispatch cannot be retried", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const r = await create(lead);
  await finish(h);
  let task = await detail(lead, r.json().task.id);
  const body = {
    revision: task.revision,
    message: "이 입력으로 예시를 보여줘",
    mode: "try",
    sample: "로그인 수정 완료",
    draft,
  };
  assert.equal(
    (await lead.request("POST", `/api/skill-studio/${task.id}/turns`, body))
      .statusCode,
    200,
  );
  assert.equal(
    (await lead.request("POST", `/api/skill-studio/${task.id}/turns`, body))
      .statusCode,
    409,
  );
  await finish(h);
  task = await detail(lead, task.id);
  const value = task.artifacts.at(-1).result;
  assert.deepEqual(value.skillDraft, draft);
  assert.ok(value.sampleOutput);
  assert.equal(value.sampleInput, "로그인 수정 완료");
  assert.equal(value.receipt.toolCalls, 0);
  const n = (await h.pool.query("SELECT count(*)::int n FROM cr_skills"))
    .rows[0].n;
  const continued = await lead.request(
    "POST",
    `/api/skill-studio/${task.id}/turns`,
    { revision: task.revision, message: "다시 고쳐줘", draft },
  );
  assert.equal(continued.statusCode, 200);
  const unknown = await claimRun(h.pool, "uncertain", h.config);
  await h.pool.query(
    "UPDATE cr_runs SET status='failed',error_code='DISPATCH_UNKNOWN',lease_owner='uncertain' WHERE id=$1",
    [unknown.id],
  );
  await h.pool.query("UPDATE cr_tasks SET status='failed' WHERE id=$1", [
    task.id,
  ]);
  task = await detail(lead, task.id);
  assert.equal(
    (
      await lead.request("POST", `/api/skill-studio/${task.id}/turns`, {
        revision: task.revision,
        message: "다시",
        draft,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await h.pool.query("SELECT count(*)::int n FROM cr_skills")).rows[0].n,
    n,
  );
});
for (const provider of ["openai-compatible", "anthropic"])
  test(`${provider} skill design and sample use the configured HTTP adapter, strict schema and durable dispatch`, async (t) => {
    const h = await harness(t, {
        provider,
        model: "local-protocol",
        modelEndpoint: "http://model.invalid/v1/messages",
        allowFixture: false,
      }),
      lead = await h.client("lead@example.com");
    const created = await create(lead);
    assert.equal(created.statusCode, 201, created.body);
    const run = await claimRun(h.pool, "http-studio", h.config);
    let requests = 0;
    await processRun(h.pool, run, "http-studio", h.config, {
      fetchImpl: async (url, options) => {
        requests++;
        assert.equal(String(url), h.config.modelEndpoint);
        const body = JSON.parse(options.body);
        const system =
          provider === "anthropic" ? body.system : body.messages[0].content;
        assert.match(system, /스킬/);
        assert.match(system, /게시·동료 적용 권한은 없습니다/);
        const result = {
          summary: "초안을 만들었어요",
          evidence: [],
          unknowns: [],
          nextActions: [],
          skillDraft: draft,
          changeSummary: ["완료 기준을 정리"],
          clarifyingQuestions: ["공유할 대상은 누구인가요?"],
          suggestedTrigger: "업무 정리해줘",
          sampleRequest: "이번 주 변경 내역",
          sampleOutput: null,
        };
        return new Response(
          JSON.stringify(
            provider === "anthropic"
              ? {
                  content: [{ type: "text", text: JSON.stringify(result) }],
                  stop_reason: "end_turn",
                }
              : { choices: [{ message: { content: JSON.stringify(result) } }] },
          ),
          { status: 200 },
        );
      },
    });
    const task = await detail(lead, created.json().task.id);
    assert.equal(task.status, "result_ready");
    assert.equal(requests, 1);
    assert.deepEqual(task.artifacts[0].result.skillDraft, draft);
    assert.equal(
      (
        await h.pool.query(
          "SELECT state FROM cr_model_dispatches WHERE run_id=$1",
          [run.id],
        )
      ).rows[0].state,
      "completed",
    );
  });
test("invalid AI drafts and changed sample drafts are rejected; an absent model cannot masquerade as AI", async (t) => {
  const h = await harness(t, {
      provider: "anthropic",
      model: "protocol",
      modelEndpoint: "http://model.invalid/messages",
      allowFixture: false,
    }),
    lead = await h.client("lead@example.com");
  const created = await create(lead);
  const r = await claimRun(h.pool, "invalid-studio", h.config);
  await processRun(h.pool, r, "invalid-studio", h.config, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"summary":"not a draft"}' }],
        }),
        { status: 200 },
      ),
  });
  const task = await detail(lead, created.json().task.id);
  assert.equal(task.status, "failed");
  assert.equal(task.artifacts.length, 0);
  const config = { ...h.config, modelEndpoint: "", modelBase: "" };
  h.config.modelEndpoint = "";
  assert.equal((await create(lead)).statusCode, 503);
  // A pinned provider profile still applies to the dedicated authoring adapter.
  const snap = {
    ...r.snapshot,
    providerProfile: modelProfile(config),
    skillDesign: { draft, mode: "try", sample: "예시 입력" },
  };
  await assert.rejects(
    runSkillDesigner(snap, { ...config, modelEndpoint: "http://else.invalid" }),
    /변경/,
  );
});
test("manually saved drafts remain authoritative after reload and omitted-draft continuation", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const cr = await create(lead);
  await finish(h);
  let task = await detail(lead, cr.json().task.id);
  const manual = {
    ...draft,
    instructions: "수동 수정본 B. 이 내용을 유지하고 필요한 자료를 질문한다.",
  };
  assert.equal(
    (
      await lead.request("POST", `/api/skill-studio/${task.id}/save`, {
        revision: task.revision,
        draft: manual,
        scope: "private",
      })
    ).statusCode,
    200,
  );
  task = await detail(lead, task.id);
  assert.deepEqual(task.skill_design.draft, manual);
  assert.notDeepEqual(task.artifacts.at(-1).result.skillDraft, manual);
  assert.equal(
    (
      await lead.request("POST", `/api/skill-studio/${task.id}/turns`, {
        revision: task.revision,
        message: "현재 초안을 계속 다듬어줘",
      })
    ).statusCode,
    200,
  );
  const next = await finish(h);
  assert.deepEqual(next.snapshot.skillDesign.draft, manual);
});
test("manual publication after a failed first AI edit can continue without an artifact and preserves ordinary chat guards", async (t) => {
  const h = await harness(t, {
      provider: "anthropic",
      model: "protocol",
      modelEndpoint: "http://model.invalid/messages",
      allowFixture: false,
    }),
    lead = await h.client("lead@example.com");
  const cr = await create(lead, { baseSkillId: "review" });
  const run = await claimRun(h.pool, "first-failed-design", h.config);
  await processRun(h.pool, run, "first-failed-design", h.config, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "{}" }] }),
        { status: 200 },
      ),
  });
  let task = await detail(lead, cr.json().task.id);
  assert.equal(task.status, "failed");
  assert.equal(task.artifacts.length, 0);
  const body = { revision: task.revision, draft, scope: "team" };
  assert.equal(
    (await lead.request("POST", `/api/skill-studio/${task.id}/save`, body))
      .statusCode,
    200,
  );
  task = await detail(lead, task.id);
  const turn = await lead.request(
    "POST",
    `/api/skill-studio/${task.id}/turns`,
    { revision: task.revision, message: "저장한 초안으로 다시 다듬어줘" },
  );
  assert.equal(turn.statusCode, 200, turn.body);
  const next = await claimRun(h.pool, "continued-manual-design", h.config);
  assert.deepEqual(next.snapshot.skillDesign.draft, task.skill_design.draft);
  assert.equal(next.snapshot.inputArtifact, null);
  const ordinary = await newTask(
    lead,
    values({ workType: "chat", agentId: "review" }),
  );
  await h.pool.query("UPDATE cr_tasks SET status='done' WHERE id=$1", [
    ordinary.id,
  ]);
  assert.equal((await command(lead, ordinary, "continue")).statusCode, 409);
});
test("accepted work supplies its pinned result and provenance; a changed source cannot be published", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  let source = await newTask(
    lead,
    values({
      workType: "chat",
      agentId: "review",
      goal: "고객 응대 요약의 좋은 예시",
      visibility: "team",
    }),
  );
  await command(lead, source, "start");
  await finish(h);
  source = await detail(lead, source.id);
  await command(lead, source, "accept");
  const cr = await create(lead, { sourceTaskId: source.id });
  assert.equal(cr.statusCode, 201, cr.body);
  const run = await finish(h);
  const input = run.snapshot.skillDesign;
  assert.equal(input.sourceExample.artifactId, source.artifacts[0].id);
  assert.equal(input.sourceExample.goal, source.goal);
  assert.equal(input.sourceExample.summary, source.artifacts[0].result.summary);
  assert.ok(input.sourceRefs.length);
  let task = await detail(lead, cr.json().task.id);
  // Correcting the cited source removes its old recall fingerprint.
  await h.pool.query(
    "UPDATE cr_artifacts SET result=jsonb_set(result,'{summary}','\"changed source\"') WHERE id=$1",
    [source.artifacts[0].id],
  );
  const saved = await lead.request(
    "POST",
    `/api/skill-studio/${task.id}/save`,
    {
      revision: task.revision,
      draft: task.skill_design.draft,
      scope: "private",
    },
  );
  assert.equal(saved.statusCode, 409, saved.body);
  assert.equal(saved.json().code, "SOURCE_CHANGED");
});
test("a sample response that silently edits the tested draft cannot become a result", async (t) => {
  const h = await harness(t, {
    provider: "anthropic",
    model: "protocol",
    modelEndpoint: "http://model.invalid/messages",
    allowFixture: false,
  });
  const snapshot = {
    agent: { runtime: "readonly" },
    model: h.config.model,
    providerProfile: modelProfile(h.config),
    messages: [],
    memories: [],
    skillDesign: { draft, mode: "try", sample: "입력" },
  };
  const value = {
    summary: "예시",
    evidence: [],
    unknowns: [],
    nextActions: [],
    skillDraft: { ...draft, instructions: "모르게 바뀜" },
    changeSummary: [],
    clarifyingQuestions: [],
    suggestedTrigger: "",
    sampleRequest: "",
    sampleOutput: "예시 결과",
  };
  await assert.rejects(
    runSkillDesigner(snapshot, h.config, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify(value) }],
          }),
          { status: 200 },
        ),
    }),
    (e) => e.code === "SAMPLE_CHANGED_DRAFT",
  );
});
test("question answers, corrected brief and rework instructions reach the actual designer HTTP request", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const cr = await create(lead);
  await finish(h);
  let task = await detail(lead, cr.json().task.id);
  const q = (
    await lead.request("POST", `/api/tasks/${task.id}/questions`, {
      taskRevision: task.revision,
      assigneeId: lead.user.id,
      prompt: "어떤 결과 형식이 필요한가요?",
    })
  ).json().question;
  assert.equal(
    (
      await lead.request("PATCH", `/api/tasks/${task.id}/questions/${q.id}`, {
        action: "answer",
        revision: q.revision,
        answer: "DESIGN_ANSWER_MARKER 담당자별 표",
      })
    ).statusCode,
    200,
  );
  task = await detail(lead, task.id);
  assert.equal(
    (
      await command(lead, task, "rework", {
        reason: "DESIGN_REWORK_MARKER 빠진 근거를 추가",
        targetVersion: task.target_version,
      })
    ).statusCode,
    200,
  );
  task = await detail(lead, task.id);
  assert.equal(
    (
      await command(lead, task, "brief", {
        text: "DESIGN_BRIEF_MARKER 결정 내용",
        reason: "수정",
        source: "request",
      })
    ).statusCode,
    200,
  );
  task = await detail(lead, task.id);
  Object.assign(h.config, {
    provider: "anthropic",
    model: "design-http",
    modelEndpoint: "http://model.invalid/messages",
    allowFixture: false,
  });
  task = await detail(lead, task.id);
  assert.equal((await command(lead, task, "start")).statusCode, 200);
  const r = await claimRun(h.pool, "design-http-rework", h.config);
  let sent;
  await processRun(h.pool, r, "design-http-rework", h.config, {
    fetchImpl: async (url, options) => {
      sent = JSON.parse(JSON.parse(options.body).messages[0].content);
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "수정 초안",
                evidence: [],
                unknowns: [],
                nextActions: [],
                skillDraft: draft,
                changeSummary: [],
                clarifyingQuestions: [],
                suggestedTrigger: "",
                sampleRequest: "",
                sampleOutput: null,
              }),
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.match(JSON.stringify(sent.questions), /DESIGN_ANSWER_MARKER/);
  assert.match(sent.brief.text, /DESIGN_BRIEF_MARKER/);
  assert.match(sent.rework.reason, /DESIGN_REWORK_MARKER/);
  assert.equal((await detail(lead, task.id)).status, "result_ready");
});
test("saving and binding a new version cannot deadlock ordinary work creation for the same agent and skill", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  let r = await create(lead);
  await finish(h);
  let task = await detail(lead, r.json().task.id);
  const saved = (
    await lead.request("POST", `/api/skill-studio/${task.id}/save`, {
      revision: task.revision,
      draft,
      scope: "team",
      agentId: "dev",
    })
  ).json().skill;
  r = await create(lead, { baseSkillId: saved.id });
  await finish(h);
  task = await detail(lead, r.json().task.id);
  let gotSkill, releaseSave, attemptedContext;
  const hasSkill = new Promise((resolve) => (gotSkill = resolve)),
    release = new Promise((resolve) => (releaseSave = resolve)),
    contextAttempt = new Promise((resolve) => (attemptedContext = resolve));
  const wrap = (hook) => ({
    query: (...args) => h.pool.query(...args),
    connect: async () => {
      const c = await h.pool.connect();
      return {
        release: () => c.release(),
        query: async (...args) => {
          await hook("before", args[0]);
          const value = await c.query(...args);
          await hook("after", args[0]);
          return value;
        },
      };
    },
  });
  const saving = saveSkillStudio(
    wrap(async (when, sql) => {
      if (when === "after" && sql.includes("FOR UPDATE OF s")) {
        gotSkill();
        await release;
      }
    }),
    lead.user,
    task.id,
    {
      revision: task.revision,
      draft: { ...draft, doneCriteria: "동시 저장한 최신 기준" },
      scope: "team",
      agentId: "dev",
    },
  );
  await hasSkill;
  const creating = createTask(
    wrap(async (when, sql) => {
      if (when === "before" && sql.includes("crewroom-context-mutation"))
        attemptedContext();
    }),
    lead.user,
    values({ workType: "chat", agentId: "dev", skillId: saved.id }),
    randomUUID(),
  );
  await contextAttempt;
  releaseSave();
  const [published, created] = await Promise.all([saving, creating]);
  assert.equal(published.version, 2);
  assert.equal(created.done_criteria, "동시 저장한 최신 기준");
});
for (const provider of ["openai-compatible", "anthropic"])
  test(`${provider} sample generation accepts canonical JSONB drafts and truncated replies are blocked`, async (t) => {
    const h = await harness(t, {
      provider,
      model: "sample-protocol",
      modelEndpoint: "http://model.invalid/messages",
      allowFixture: false,
    });
    const dbDraft = (await h.pool.query("SELECT $1::jsonb AS draft", [draft]))
      .rows[0].draft;
    const snapshot = {
      agent: { runtime: "readonly" },
      model: h.config.model,
      providerProfile: modelProfile(h.config),
      messages: [],
      memories: [],
      skillDesign: { draft: dbDraft, mode: "try", sample: "입력" },
    };
    const result = {
      summary: "예시",
      evidence: [],
      unknowns: [],
      nextActions: [],
      skillDraft: draft,
      changeSummary: [],
      clarifyingQuestions: [],
      suggestedTrigger: "",
      sampleRequest: "",
      sampleOutput: "예시 결과",
    };
    const response = (truncated) =>
      new Response(
        JSON.stringify(
          provider === "anthropic"
            ? {
                content: [{ type: "text", text: JSON.stringify(result) }],
                stop_reason: truncated ? "max_tokens" : "end_turn",
              }
            : {
                choices: [
                  {
                    message: { content: JSON.stringify(result) },
                    finish_reason: truncated ? "length" : "stop",
                  },
                ],
              },
        ),
        { status: 200 },
      );
    const value = await runSkillDesigner(snapshot, h.config, {
      fetchImpl: async () => response(false),
    });
    assert.equal(value.result.sampleOutput, "예시 결과");
    await assert.rejects(
      runSkillDesigner(snapshot, h.config, {
        fetchImpl: async () => response(true),
      }),
      (e) => e.code === "MODEL_OUTPUT_TRUNCATED",
    );
  });
