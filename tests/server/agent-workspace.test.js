import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { harness, newTask, values, command } from "./helpers.js";
import {
  recallForRun,
  claimRun,
  processRun,
  actInWorkspace,
  contextAllowed,
  completeRun,
  failRun,
} from "../../server/worker.js";
import {
  searchMemory,
  documentsByKeys,
  validReferences,
} from "../../server/memory.js";
import { indexNextMemoryDocument } from "../../server/memory-embedding.js";
const write = (
  path = "plan.md",
  content = "진행 중 초안",
  expectedRevision = 0,
) => ({ action: "write_workspace", path, content, expectedRevision });
async function started(t, overrides = {}, config = {}) {
  const h = await harness(t, config),
    user = await h.client("lead@example.com");
  const task = await newTask(
    user,
    values({ workType: "chat", agentId: "chief", ...overrides }),
  );
  assert.equal((await command(user, task, "start")).statusCode, 200);
  const run = await claimRun(h.pool, "workspace-test", h.config);
  return {
    ...h,
    user,
    task,
    run,
    act: (a, op) => actInWorkspace(h.pool, run, "workspace-test", a, op),
  };
}
test("persistent workspace CAS, idempotent receipts, path validation and immutable history", async (t) => {
  const h = await started(t);
  const saved = await h.act(write(), "main-op");
  assert.equal(saved.revision, 1);
  assert.deepEqual(await h.act(write(), "main-op"), saved);
  await assert.rejects(h.act(write("plan.md", "changed", 0)), {
    code: "WORKSPACE_CONFLICT",
  });
  await assert.rejects(h.act(write("../escape.md")), { name: "ZodError" });
  await assert.rejects(h.act(write("plan.md", "different", 0), "main-op"), {
    code: "WORKSPACE_OPERATION_MISMATCH",
  });
  const read = await h.act({ action: "read_workspace", id: saved.id });
  assert.equal(read.content, "진행 중 초안");
  const changed = await h.act(write("plan.md", "계획 완료 · 검사는 미실행", 1));
  assert.equal(changed.revision, 2);
  assert.equal(await contextAllowed(h.pool, h.run, h.task), true);
  const moved = await h.act({
    action: "move_workspace",
    id: saved.id,
    path: "notes/plan.md",
    expectedRevision: 2,
  });
  assert.equal(moved.id, saved.id);
  const old = await h.user.request(
    "GET",
    `/api/workspace/documents/${saved.id}?revision=1`,
  );
  assert.equal(old.statusCode, 200, old.body);
  assert.equal(old.json().content, "진행 중 초안");
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*) FROM cr_workspace_versions WHERE document_id=$1",
        [saved.id],
      )
    ).rows[0].count,
    "3",
  );
  assert.ok(
    Number(
      (await h.pool.query("SELECT count(*) FROM cr_workspace_observations"))
        .rows[0].count,
    ) >= 4,
  );
});
test("saved draft survives failure and a fresh run actually reads it; late generation, expired lease and cancellation cannot write", async (t) => {
  const h = await started(t);
  const saved = await h.act(write());
  await failRun(
    h.pool,
    h.run.id,
    "workspace-test",
    h.run.generation,
    new Error("synthetic"),
  );
  // Worker stop acknowledgement normally releases the lease in processRun.finally.
  await h.pool.query(
    "UPDATE cr_runs SET lease_owner=NULL,lease_until=NULL WHERE id=$1",
    [h.run.id],
  );
  let task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  assert.equal((await command(h.user, task, "start")).statusCode, 200);
  const run = await claimRun(h.pool, "restart", h.config);
  const act = (a) => actInWorkspace(h.pool, run, "restart", a);
  assert.equal(
    (await act({ action: "read_workspace", id: saved.id })).content,
    "진행 중 초안",
  );
  await assert.rejects(h.act(write("late.md")), { code: "STALE_EXECUTION" });
  await assert.rejects(
    actInWorkspace(
      h.pool,
      { ...run, generation: run.generation - 1 },
      "restart",
      write("old-generation.md"),
    ),
    { code: "STALE_EXECUTION" },
  );
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  await assert.rejects(act(write("expired.md")), { code: "STALE_EXECUTION" });
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1",
    [run.id],
  );
  task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json().task;
  await command(h.user, task, "cancel");
  await assert.rejects(act(write("after-cancel.md")), {
    code: "STALE_EXECUTION",
  });
  assert.equal(
    (await h.user.request("GET", `/api/workspace/documents/${saved.id}`))
      .statusCode,
    200,
  );
  assert.equal(
    (await h.pool.query("SELECT count(*) FROM cr_workspace_documents")).rows[0]
      .count,
    "1",
  );
});
test("shared agent never exposes private documents or department titles, bodies and versions", async (t) => {
  const h = await started(t, { visibility: "private" });
  const saved = await h.act(write("private-secret.md", "PRIVATE_NEEDLE"));
  const member = await h.client("member@example.com", true);
  const list = await member.request(
    "GET",
    "/api/agents/chief/workspace?query=PRIVATE_NEEDLE",
  );
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 0);
  for (const path of [
    `/api/workspace/documents/${saved.id}`,
    `/api/workspace/documents/${saved.id}?revision=1`,
    `/api/tasks/${h.task.id}/workspace`,
  ])
    assert.equal((await member.request("GET", path)).statusCode, 404);
  await h.pool.query(
    "UPDATE cr_tasks SET visibility='department' WHERE id=$1",
    [h.task.id],
  );
  assert.equal(
    (await member.request("GET", "/api/agents/chief/workspace")).json().items
      .length,
    0,
  );
});
test("workspace provenance reaches final answer and source corrections revoke draft and derived recall", async (t) => {
  const h = await started(t);
  const memory = await h.user.request("POST", "/api/memories", {
    agentId: "chief",
    visibility: "team",
    title: "원래 정책",
    body: "원문 정책 35분",
    source: "명시 입력",
    kind: "fact",
    audience: "agent",
    project: h.task.project,
  });
  assert.equal(memory.statusCode, 201, memory.body);
  const mem = memory.json();
  const doc = (await documentsByKeys(h.pool, ["memory:" + mem.id])).get(
    "memory:" + mem.id,
  );
  await h.pool.query(
    "INSERT INTO cr_memory_reads(run_id,generation,sequence,query,refs) VALUES($1,$2,1,'policy',$3)",
    [
      h.run.id,
      h.run.generation,
      JSON.stringify([{ key: doc.key, revision: doc.revision }]),
    ],
  );
  const saved = await h.act(write());
  const result = await completeRun(
    h.pool,
    h.run.id,
    "workspace-test",
    h.run.generation,
    {
      origin: "model",
      result: {
        summary: "문서 기반 결과",
        evidence: [],
        unknowns: [],
        nextActions: [],
      },
      receipt: {},
    },
  );
  assert.ok(result.id);
  const answer = (
    await documentsByKeys(h.pool, [`artifact:${result.id}:summary:1`])
  ).get(`artifact:${result.id}:summary:1`);
  assert.ok(answer.dependencies.some((r) => r.key === "workspace:" + saved.id));
  assert.equal(
    await validReferences(h.pool, h.user.user, h.task, answer.dependencies),
    true,
  );
  await h.pool.query(
    "UPDATE cr_memories SET body='정정된 정책',revision=revision+1 WHERE id=$1",
    [mem.id],
  );
  assert.equal(
    (await h.user.request("GET", `/api/workspace/documents/${saved.id}`))
      .statusCode,
    404,
  );
  assert.equal(
    (await h.user.request("GET", "/api/agents/chief/workspace")).json().items
      .length,
    0,
  );
  assert.equal(
    await validReferences(h.pool, h.user.user, h.task, answer.dependencies),
    false,
  );
});
test("documents stay outside memory search and embeddings, with bounded pages and partial reads", async (t) => {
  const h = await started(t);
  const saved = await h.act(write("notes.md", "x".repeat(14000)));
  const before = await searchMemory(h.pool, h.user.user, h.task, { query: "" });
  assert.ok(!before.some((d) => d.kind === "workspace"));
  assert.equal(
    (
      await searchMemory(h.pool, h.user.user, h.task, {
        keys: ["workspace:" + saved.id],
      })
    ).length,
    0,
  );
  const first = await h.act({ action: "read_workspace", id: saved.id });
  assert.equal(first.content.length, 6000);
  assert.equal(first.nextOffset, 6000);
  const second = await h.act({
    action: "read_workspace",
    id: saved.id,
    offset: 6000,
  });
  assert.equal(second.nextOffset, 12000);
  for (let i = 0; i < 22; i++) await h.act(write(`docs/${i}.md`));
  const page = await h.user.request("GET", "/api/agents/chief/workspace");
  assert.equal(page.json().items.length, 20);
  assert.ok(page.json().nextCursor);
  assert.equal(
    (
      await h.user.request(
        "GET",
        "/api/agents/chief/workspace?cursor=" + page.json().nextCursor,
      )
    ).json().items.length,
    3,
  );
  // The only source to index is not a workspace document.
  await indexNextMemoryDocument(
    h.pool,
    {
      ...h.config,
      embeddingUrl: "http://127.0.0.1:1/embeddings",
      embeddingModel: "test",
    },
    {
      fetchImpl: async () => {
        throw new Error("synthetic");
      },
    },
  );
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*) FROM cr_memory_embeddings WHERE source_key LIKE 'workspace:%'",
      )
    ).rows[0].count,
    "0",
  );
});
test("loopback HTTP model saves, reads and revises actual documents before final result", async (t) => {
  let calls = 0,
    savedId,
    requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    calls++;
    const last = JSON.parse(requests.at(-1).messages.at(-1).content);
    let action;
    if (calls === 1) action = { action: "list_workspace" };
    else if (calls === 2) action = write();
    else if (calls === 3) {
      savedId = last.workspaceResult.id;
      action = { action: "read_workspace", id: savedId };
    } else if (calls === 4) {
      assert.equal(last.workspaceResult.content, "진행 중 초안");
      action = write("plan.md", "수정된 최종 초안", 1);
    } else {
      assert.equal(last.workspaceResult.revision, 2);
      action = {
        summary: "문서 저장 완료 · 검사는 미실행",
        evidence: [savedId],
        unknowns: [],
        nextActions: [],
      };
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(action) } }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const h = await started(
    t,
    {},
    {
      provider: "openai-compatible",
      model: "loopback",
      modelBase: `http://127.0.0.1:${server.address().port}/v1`,
      allowFixture: false,
    },
  );
  await processRun(h.pool, h.run, "workspace-test", h.config);
  const task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  assert.equal(
    task.status,
    "result_ready",
    JSON.stringify(
      task.runs.map((r) => ({ status: r.status, error: r.error_code })),
    ),
  );
  assert.equal(calls, 5);
  assert.equal(task.artifacts[0].result.receipt.workspaceActions, 4);
  assert.equal(
    (await h.user.request("GET", `/api/workspace/documents/${savedId}`)).json()
      .content,
    "수정된 최종 초안",
  );
});

test("a successful conversation continues by reading current documents and updating the same path", async (t) => {
  const h = await started(t);
  const saved = await h.act(write());
  await completeRun(h.pool, h.run.id, "workspace-test", h.run.generation, {
    origin: "model",
    result: {
      summary: "OLD_ANSWER_DO_NOT_INJECT",
      evidence: [],
      unknowns: [],
      nextActions: [],
    },
    receipt: {},
  });
  let task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  await command(h.user, task, "continue");
  task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json().task;
  await command(h.user, task, "start");
  const next = await claimRun(h.pool, "continue", h.config);
  const { modelMessages } = await import("../../server/provider.js");
  assert.equal(next.snapshot.workspaceContinuation, true);
  assert.ok(
    !JSON.stringify(modelMessages(next.snapshot)).includes(
      "OLD_ANSWER_DO_NOT_INJECT",
    ),
  );
  const act = (a) => actInWorkspace(h.pool, next, "continue", a);
  assert.equal(
    (await act({ action: "read_workspace", id: saved.id })).revision,
    1,
  );
  await act(write("plan.md", "이어서 수정", 1));
  const done = await completeRun(h.pool, next.id, "continue", next.generation, {
    origin: "model",
    result: {
      summary: "이어서 저장 성공",
      evidence: [],
      unknowns: [],
      nextActions: [],
    },
    receipt: {},
  });
  assert.ok(done.id);
  assert.equal(
    (await h.user.request("GET", `/api/workspace/documents/${saved.id}`)).json()
      .revision,
    2,
  );
});

test("A to B to A cannot launder a stale dependency or commit a partial revision", async (t) => {
  const h = await started(t);
  const a = await h.act(write("A.md", "원래 계획"));
  const b = await h.act(write("B.md", "A를 따른 초안"));
  const stored = (
    await h.pool.query(
      "SELECT source_refs FROM cr_workspace_versions WHERE document_id=$1",
      [b.id],
    )
  ).rows[0];
  assert.ok(stored.source_refs.some((r) => r.key === "workspace:" + a.id));
  await assert.rejects(h.act(write("A.md", "변경한 계획", 1)), {
    code: "WORKSPACE_DEPENDENCY_CONFLICT",
  });
  assert.equal(
    (await h.user.request("GET", `/api/workspace/documents/${a.id}`)).json()
      .revision,
    1,
  );
  assert.equal(
    (await h.user.request("GET", `/api/workspace/documents/${b.id}`))
      .statusCode,
    200,
  );
  assert.equal(await contextAllowed(h.pool, h.run, h.task), true);
});

test("a saved draft survives a later HTTP model failure through actual processRun", async (t) => {
  const h = await started(
    t,
    {},
    {
      provider: "openai-compatible",
      model: "loopback",
      modelEndpoint: "http://loopback.invalid/messages",
      allowFixture: false,
    },
  );
  let calls = 0;
  await processRun(h.pool, h.run, "workspace-test", h.config, {
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify(write("saved-before-error.md")),
                  },
                },
              ],
            }),
            { status: 200 },
          )
        : new Response("synthetic unavailable", { status: 503 });
    },
  });
  const task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  assert.equal(task.status, "failed");
  assert.equal(task.runs[0].error_code, "MODEL_ENDPOINT_FAILED");
  const files = (
    await h.user.request("GET", `/api/tasks/${h.task.id}/workspace`)
  ).json();
  assert.equal(files.items[0].path, "saved-before-error.md");
  assert.equal(task.artifacts.length, 0);
});

test("archive invalidates prior answer dependencies and retains a tombstone without erasing versions", async (t) => {
  const h = await started(t);
  const saved = await h.act(write());
  await completeRun(h.pool, h.run.id, "workspace-test", h.run.generation, {
    origin: "model",
    result: {
      summary: "작성 결과",
      evidence: [],
      unknowns: [],
      nextActions: [],
    },
    receipt: {},
  });
  const sourceKey = `artifact:${(await h.pool.query("SELECT id FROM cr_artifacts WHERE run_id=$1", [h.run.id])).rows[0].id}:summary:1`;
  const prior = (await documentsByKeys(h.pool, [sourceKey])).get(sourceKey);
  let task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  await command(h.user, task, "continue");
  task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json().task;
  await command(h.user, task, "start");
  const run = await claimRun(h.pool, "archive", h.config);
  await actInWorkspace(h.pool, run, "archive", {
    action: "archive_workspace",
    id: saved.id,
    expectedRevision: 1,
  });
  assert.equal(
    (await h.user.request("GET", `/api/workspace/documents/${saved.id}`))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*) FROM cr_workspace_versions WHERE document_id=$1",
        [saved.id],
      )
    ).rows[0].count,
    "2",
  );
  assert.equal(
    await validReferences(h.pool, h.user.user, h.task, prior.dependencies),
    false,
  );
});

test("the actual Worker keeps a committed draft but rejects a write returned after cancellation", async (t) => {
  const h = await started(
    t,
    {},
    {
      provider: "openai-compatible",
      model: "loopback",
      modelEndpoint: "http://loopback.invalid/messages",
      allowFixture: false,
    },
  );
  let calls = 0;
  await processRun(h.pool, h.run, "workspace-test", h.config, {
    fetchImpl: async () => {
      if (++calls === 2) {
        const task = (
          await h.user.request("GET", `/api/tasks/${h.task.id}`)
        ).json().task;
        assert.equal((await command(h.user, task, "cancel")).statusCode, 200);
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  write(calls === 1 ? "before-cancel.md" : "after-cancel.md"),
                ),
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  const task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  assert.equal(task.status, "cancelled");
  const files = (
    await h.user.request("GET", `/api/tasks/${h.task.id}/workspace`)
  ).json();
  assert.deepEqual(
    files.items.map((d) => d.path),
    ["before-cancel.md"],
  );
  assert.equal(task.artifacts.length, 0);
});

test("document GET serializes its source and version against a concurrent successful save", async (t) => {
  const h = await started(t),
    saved = await h.act(write());
  const original = h.pool.connect.bind(h.pool);
  let pause, enter;
  const entered = new Promise((r) => (enter = r)),
    resume = new Promise((r) => (pause = r));
  let armed = true;
  h.pool.connect = async (...args) => {
    if (typeof args[0] === "function") return original(...args);
    const client = await original(...args),
      query = client.query.bind(client);
    client.query = async (...q) => {
      const response = await query(...q);
      if (
        armed &&
        typeof q[0] === "string" &&
        q[0].includes(
          "SELECT d.* FROM cr_recall_documents d JOIN cr_workspace_documents",
        )
      ) {
        armed = false;
        enter();
        await resume;
      }
      return response;
    };
    const release = client.release.bind(client);
    client.release = (...a) => {
      client.query = query;
      client.release = release;
      return release(...a);
    };
    return client;
  };
  t.after(() => {
    h.pool.connect = original;
    pause();
  });
  const reading = h.user.request("GET", `/api/workspace/documents/${saved.id}`);
  await entered;
  const writing = h.act(write("plan.md", "second body", 1));
  pause();
  const response = await reading;
  await writing;
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().revision, 1);
  assert.equal(response.json().content, "진행 중 초안");
  assert.equal(
    (await h.user.request("GET", `/api/workspace/documents/${saved.id}`)).json()
      .revision,
    2,
  );
});

test("a new run cannot promote an archived workspace body through propose_memory", async (t) => {
  const h = await started(t);
  const saved = await h.act(write("to-archive.md", "ARCHIVED_QUOTE"));
  await h.act({
    action: "archive_workspace",
    id: saved.id,
    expectedRevision: 1,
  });
  await completeRun(h.pool, h.run.id, "workspace-test", h.run.generation, {
    origin: "model",
    result: {
      summary: "보관 완료",
      evidence: [],
      unknowns: [],
      nextActions: [],
    },
    receipt: {},
  });
  const task = await newTask(
    h.user,
    values({ workType: "chat", agentId: "chief" }),
  );
  await command(h.user, task, "start");
  const run = await claimRun(h.pool, "proposal", h.config);
  await assert.rejects(
    recallForRun(h.pool, run, "proposal", {
      action: "propose_memory",
      key: "workspace:" + saved.id,
      quote: "ARCHIVED_QUOTE",
      title: "보관 우회",
      body: "ARCHIVED_QUOTE",
      kind: "fact",
      audience: "agent",
    }),
    { code: "MEMORY_PROOF_REQUIRED" },
  );
  assert.equal(
    (await h.pool.query("SELECT count(*) FROM cr_memory_candidates")).rows[0]
      .count,
    "0",
  );
  assert.equal(
    (await h.pool.query("SELECT count(*) FROM cr_memories")).rows[0].count,
    "0",
  );
});

test("revoking only the previous answer's summary cannot resurrect it through continuation input", async (t) => {
  const h = await started(t);
  const artifact = await completeRun(
    h.pool,
    h.run.id,
    "workspace-test",
    h.run.generation,
    {
      origin: "model",
      result: {
        summary: "OLD_REVOKED_SUMMARY",
        evidence: ["still present evidence"],
        unknowns: [],
        nextActions: [],
      },
      receipt: {},
    },
  );
  const memory = await h.user.request("POST", "/api/memories", {
    agentId: "chief",
    visibility: "team",
    title: "source revocation",
    body: "OLD_REVOKED_SUMMARY",
    source: "explicit regression",
    sourceKey: `artifact:${artifact.id}:summary:1`,
  });
  assert.equal(memory.statusCode, 201, memory.body);
  assert.equal(
    (
      await h.user.request("DELETE", "/api/memories/" + memory.json().id, {
        revision: 1,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await documentsByKeys(h.pool, [`artifact:${artifact.id}:summary:1`])).size,
    0,
  );
  assert.equal(
    (await documentsByKeys(h.pool, [`artifact:${artifact.id}:evidence:1`]))
      .size,
    1,
  );
  let task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  await command(h.user, task, "continue");
  task = (await h.user.request("GET", `/api/tasks/${h.task.id}`)).json().task;
  const response = await command(h.user, task, "start");
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "CONTEXT_REVOKED");
  assert.equal(
    (
      await h.pool.query("SELECT count(*) FROM cr_runs WHERE task_id=$1", [
        task.id,
      ])
    ).rows[0].count,
    "1",
  );
});
