import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, recallForRun, processRun } from "../../server/worker.js";
import { searchMemory, documentsByKeys } from "../../server/memory.js";
import { insertArtifact } from "../../server/tasks.js";
const remember = async (c, extra = {}) => {
  const r = await c.request("POST", "/api/memories", {
    agentId: "review",
    visibility: "team",
    title: "로그인 정책",
    body: "로그인 세션은 35분입니다.",
    source: "정책 합의",
    project: "인증",
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
};
const result = (summary, evidence = []) => ({
  summary,
  evidence,
  unknowns: [],
  nextActions: [],
});
const query = (h, u, extra = {}) =>
  searchMemory(
    h.pool,
    { ...u, active: true },
    { visibility: "team", department: u.department },
    { query: "로그인", agentId: "qa", project: "인증", ...extra },
  );
async function proposalRun(t, scope = "team") {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const task = await newTask(
    lead,
    values({
      workType: "chat",
      agentId: "review",
      project: "인증",
      visibility: scope,
    }),
  );
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "팀 합의: 로그인 세션은 35분입니다. 원문을 확인하세요.",
  });
  const msg = (
    await h.pool.query("SELECT id FROM cr_messages WHERE task_id=$1", [task.id])
  ).rows[0];
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "proposal-test", h.config);
  const action = {
    action: "propose_memory",
    key: "message:" + msg.id,
    quote: "로그인 세션은 35분입니다.",
    title: "검토할 로그인 결정",
    body: "로그인 세션은 35분입니다.",
    kind: "decision",
    audience: scope === "private" ? "agent" : "project",
  };
  return { h, lead, member, task, run, action };
}
test("all historic assistant answers and evidence remain searchable after a newer answer", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const task = await newTask(
    lead,
    values({ workType: "chat", agentId: "review", project: "인증" }),
  );
  const old = await insertArtifact(h.pool, task, 0, {
    origin: "external",
    result: result("이전 답변입니다.", [
      "옥색배포키는 4827이며 이전 답변의 상세 근거입니다.",
    ]),
  });
  await insertArtifact(h.pool, task, 0, {
    origin: "external",
    result: result("새로운 요약은 다른 주제입니다."),
  });
  const docs = await query(h, lead.user, {
    query: "옥색배포키",
    agentId: "review",
  });
  assert.ok(docs.some((d) => d.key === `artifact:${old.id}:evidence:1`));
  assert.match(docs[0].body, /4827/);
  const raw = await lead.request(
    "GET",
    "/api/memory/sources/" + encodeURIComponent(docs[0].key),
  );
  assert.equal(raw.statusCode, 200);
});
test("project memory crosses roles while agent notes and private chats stay isolated", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const shared = await remember(lead, { audience: "project" });
  await remember(lead, {
    title: "로그인 동료 전용",
    body: "동료 전용 민트값",
    audience: "agent",
  });
  const priv = await newTask(
    lead,
    values({
      workType: "chat",
      agentId: "review",
      project: "인증",
      visibility: "private",
    }),
  );
  await lead.request("POST", `/api/tasks/${priv.id}/messages`, {
    body: "로그인 개인비밀값",
  });
  const found = await query(h, member.user);
  assert.ok(found.some((d) => d.key === "memory:" + shared.id));
  assert.ok(!JSON.stringify(found).includes("민트값"));
  assert.ok(!JSON.stringify(found).includes("개인비밀값"));
  const otherProject = await query(h, member.user, {
    project: "다른 프로젝트",
  });
  assert.equal(otherProject.length, 0);
  const rejected = await lead.request("POST", "/api/memories", {
    agentId: "review",
    visibility: "private",
    audience: "project",
    project: "인증",
    title: "개인",
    body: "개인 메모",
    source: "메모",
  });
  assert.equal(rejected.statusCode, 400);
});
test("a scheduled replacement preserves old and new policy at the correct effective time", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const old = await remember(lead, {
    audience: "project",
    validFrom: "2026-01-01T00:00:00Z",
  });
  const next = await remember(lead, {
    audience: "project",
    validFrom: "2026-11-01T00:00:00Z",
    supersedesId: old.id,
    body: "로그인 세션은 50분입니다.",
  });
  let docs = await query(h, lead.user, { asOf: "2026-10-18T00:00:00Z" });
  assert.ok(docs.some((d) => d.key === "memory:" + old.id));
  assert.ok(!docs.some((d) => d.key === "memory:" + next.id));
  docs = await query(h, lead.user, { asOf: "2026-11-01T00:00:00Z" });
  assert.ok(docs.some((d) => d.key === "memory:" + next.id));
  assert.ok(!docs.some((d) => d.key === "memory:" + old.id));
  const read = await lead.request(
    "GET",
    "/api/memory/sources/" + encodeURIComponent("memory:" + old.id),
  );
  assert.equal(read.statusCode, 200);
  assert.match(read.json().item.validTo, /2026-11-01/);
  const duplicate = await lead.request("POST", "/api/memories", {
    agentId: "review",
    visibility: "team",
    title: "중복",
    body: "새 결정",
    source: "합의",
    project: "인증",
    audience: "project",
    supersedesId: old.id,
    validFrom: "2026-11-01T00:00:00Z",
  });
  assert.equal(duplicate.statusCode, 409);
});
test("native proposals require exact source evidence and do not become memory before explicit acceptance", async (t) => {
  const { h, lead, task, run, action } = await proposalRun(t);
  await assert.rejects(
    recallForRun(h.pool, run, "proposal-test", {
      ...action,
      quote: "원문에 없는 다른 합의입니다.",
    }),
    (e) => e.code === "MEMORY_PROOF_REQUIRED",
  );
  const proposal = await recallForRun(h.pool, run, "proposal-test", action);
  assert.equal(proposal.status, "pending");
  for (let i = 0; i < 3; i++) {
    const duplicate = await recallForRun(h.pool, run, "proposal-test", action);
    assert.equal(duplicate.proposalId, proposal.proposalId);
  }
  await assert.rejects(
    recallForRun(h.pool, run, "proposal-test", action),
    (e) => e.code === "MEMORY_LOOKUP_LIMIT",
  );

  assert.equal(
    (await h.pool.query("SELECT count(*) FROM cr_memories")).rows[0].count,
    "0",
  );
  const list = (await lead.request("GET", "/api/memory/proposals")).json()
    .items;
  assert.equal(list.length, 1);
  assert.equal(list[0].source_quote, action.quote);
  const accepted = await lead.request(
    "POST",
    "/api/memory/proposals/" + proposal.proposalId,
    { action: "accept" },
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  const repeated = await lead.request(
    "POST",
    "/api/memory/proposals/" + proposal.proposalId,
    { action: "accept" },
  );
  assert.equal(repeated.json().memoryId, accepted.json().memoryId);
  assert.equal(
    (await h.pool.query("SELECT count(*) FROM cr_memories")).rows[0].count,
    "1",
  );
  const found = await query(h, lead.user);
  assert.ok(found.some((d) => d.key === "memory:" + accepted.json().memoryId));
  const doc = (
    await documentsByKeys(h.pool, ["memory:" + accepted.json().memoryId])
  )
    .values()
    .next().value;
  assert.equal(doc.source_key, action.key);
});
test("private proposals remain private and cannot promote into project memory", async (t) => {
  const { h, lead, member, run, action } = await proposalRun(t, "private");
  await assert.rejects(
    recallForRun(h.pool, run, "proposal-test", {
      ...action,
      audience: "project",
    }),
    (e) => e.code === "MEMORY_AUDIENCE",
  );
  const p = await recallForRun(h.pool, run, "proposal-test", action);
  assert.equal(
    (await member.request("GET", "/api/memory/proposals")).json().items.length,
    0,
  );
  assert.equal(
    (
      await member.request("POST", "/api/memory/proposals/" + p.proposalId, {
        action: "accept",
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await lead.request("POST", "/api/memory/proposals/" + p.proposalId, {
        action: "accept",
      })
    ).statusCode,
    200,
  );
  assert.ok(
    !JSON.stringify(await query(h, member.user, { query: "35분" })).includes(
      "35분",
    ),
  );
});
test("changed source blocks proposal promotion without leaving an orphan memory", async (t) => {
  const { h, lead, run, action } = await proposalRun(t);
  const p = await recallForRun(h.pool, run, "proposal-test", action);
  await h.pool.query("UPDATE cr_messages SET body=$2 WHERE id=$1", [
    action.key.slice(8),
    "정정된 원문",
  ]);
  const res = await lead.request(
    "POST",
    "/api/memory/proposals/" + p.proposalId,
    { action: "accept" },
  );
  assert.equal(res.statusCode, 409);
  assert.equal(
    (await h.pool.query("SELECT count(*) FROM cr_memories")).rows[0].count,
    "0",
  );
  const list = (await lead.request("GET", "/api/memory/proposals")).json()
    .items;
  assert.equal(list[0].unavailable, true);
  assert.equal(list[0].body, undefined);
  assert.equal(
    (
      await lead.request("POST", "/api/memory/proposals/" + p.proposalId, {
        action: "dismiss",
      })
    ).statusCode,
    200,
  );
});
test("correcting a source-linked proposal suppresses that passage while unrelated answers survive", async (t) => {
  const { h, lead, run, action, task } = await proposalRun(t);
  const a = await insertArtifact(h.pool, task, 0, {
    origin: "external",
    result: result("다른독립답변은 보존됩니다."),
  });
  const p = await recallForRun(h.pool, run, "proposal-test", action),
    saved = (
      await lead.request("POST", "/api/memory/proposals/" + p.proposalId, {
        action: "accept",
      })
    ).json();
  await lead.request("PATCH", "/api/memories/" + saved.memoryId, {
    revision: 1,
    title: action.title,
    body: "새로운 로그인 결정은 45분입니다.",
    reason: "기존 원문 정정",
  });
  assert.equal(
    (
      await lead.request(
        "GET",
        "/api/memory/sources/" + encodeURIComponent(action.key),
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await lead.request(
        "GET",
        "/api/memory/sources/" +
          encodeURIComponent(`artifact:${a.id}:summary:1`),
      )
    ).statusCode,
    200,
  );
});
test("native Claude protocol loop can propose a memory and finish without silently publishing it", async (t) => {
  const { h, lead, run, action } = await proposalRun(t);
  const { modelProfile } = await import("../../server/config.js");
  const config = {
    ...h.config,
    provider: "anthropic",
    model: "fixture-model",
    modelEndpoint: "http://127.0.0.1:19888/messages",
    allowFixture: false,
  };
  run.snapshot.providerProfile = modelProfile(config);
  run.snapshot.provider = "anthropic";
  run.snapshot.model = config.model;
  await h.pool.query("UPDATE cr_runs SET snapshot=$2 WHERE id=$1", [
    run.id,
    run.snapshot,
  ]);
  let calls = 0;
  await processRun(h.pool, run, "proposal-test", config, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                calls++ === 0 ? action : result("기억 제안을 만들었습니다."),
              ),
            },
          ],
          stop_reason: "end_turn",
        }),
      ),
  });
  assert.equal(calls, 2);
  assert.equal(
    (await h.pool.query("SELECT status FROM cr_runs WHERE id=$1", [run.id]))
      .rows[0].status,
    "succeeded",
  );
  assert.equal(
    (await h.pool.query("SELECT status FROM cr_memory_candidates")).rows[0]
      .status,
    "pending",
  );
  assert.equal(
    (await h.pool.query("SELECT count(*) FROM cr_memories")).rows[0].count,
    "0",
  );
});

test("default memory and message fingerprints survive the 0.7 to 0.8 view upgrade", async (t) => {
  const { readFile } = await import("node:fs/promises"),
    { validReferences } = await import("../../server/memory.js");
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const note = await remember(lead),
    task = await newTask(
      lead,
      values({ workType: "chat", agentId: "review", project: "인증" }),
    );
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "업그레이드 전 원문입니다.",
  });
  const sql5 = await readFile(
    new URL(
      "../../server/migrations/005_long_term_memory.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await h.pool.query("DROP VIEW cr_recall_documents");
  await h.pool.query(
    sql5.slice(sql5.indexOf("CREATE VIEW cr_recall_documents")),
  );
  const old = (
    await h.pool.query("SELECT key,revision FROM cr_recall_documents")
  ).rows;
  const sql6 = await readFile(
    new URL("../../server/migrations/006_memory_learning.sql", import.meta.url),
    "utf8",
  );
  await h.pool.query("DROP VIEW cr_recall_documents");
  await h.pool.query(
    sql6.slice(
      sql6.indexOf("CREATE VIEW cr_recall_documents"),
      sql6.indexOf("CREATE UNIQUE INDEX"),
    ),
  );
  assert.equal(
    await validReferences(h.pool, { ...lead.user, active: true }, task, old),
    true,
  );
});
