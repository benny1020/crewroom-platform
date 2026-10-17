import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values, command } from "./helpers.js";
import {
  claimRun,
  processRun,
  recallForRun,
  contextAllowed,
} from "../../server/worker.js";
import {
  searchMemory,
  buildMemoryContext,
  validReferences,
} from "../../server/memory.js";
import {
  indexNextMemoryDocument,
  embeddingProfile,
} from "../../server/memory-embedding.js";
import { digest } from "../../server/db.js";

const remember = (client, extra = {}) =>
  client.request("POST", "/api/memories", {
    agentId: "review",
    title: "규칙",
    body: "출처를 확인합니다.",
    source: "팀 합의",
    visibility: "team",
    ...extra,
  });

test("a memory older than a thousand newer notes is selected by relevance and project", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const old = (
    await remember(lead, {
      title: "세션 만료 결정",
      body: "세션 만료기간은 35분입니다.",
      project: "보안",
    })
  ).json();
  await h.pool.query(
    "UPDATE cr_memories SET updated_at=now()-interval '90 days' WHERE id=$1",
    [old.id],
  );
  await h.pool.query(
    `INSERT INTO cr_memories(id,agent_id,owner_id,visibility,department,title,body,source,project)
 SELECT gen_random_uuid(),'review',$1,'team','development','점심 메뉴 '||i,'오늘의 메뉴는 샐러드','잡담','보안' FROM generate_series(1,1200) i`,
    [lead.user.id],
  );
  const task = await newTask(
    lead,
    values({ project: "보안", goal: "세션 만료기간을 확인해주세요." }),
  );
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "recall-test", h.config);
  assert.ok(
    run.snapshot.memoryContext.items.some((m) => m.key === "memory:" + old.id),
  );
  assert.ok(run.snapshot.memoryContext.characters <= 16000);
  assert.equal(
    (await lead.request("GET", `/api/tasks/${task.id}`)).json().task.runs[0]
      .snapshot.memoryContext.count,
    run.snapshot.memoryContext.items.length,
  );
});
test("raw conversation from beyond the recent window is retrievable without a manual memory", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  let task = await newTask(
    lead,
    values({ workType: "chat", agentId: "review", goal: "쿠키 정책 결정" }),
  );
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "결정: 갱신 토큰 만료는 37일로 정했습니다.",
  });
  for (let i = 0; i < 35; i++)
    await lead.request("POST", `/api/tasks/${task.id}/messages`, {
      body: "다른 이야기 " + i,
    });
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "older-chat", h.config);
  assert.ok(!JSON.stringify(run.snapshot.messages).includes("37일"));
  const result = await recallForRun(h.pool, run, "older-chat", {
    action: "search_memory",
    query: "갱신 토큰 만료",
  });
  assert.ok(JSON.stringify(result).includes("37일"));
  assert.ok(
    (
      await h.pool.query("SELECT refs FROM cr_memory_reads WHERE run_id=$1", [
        run.id,
      ])
    ).rowCount,
  );
  const message = (
    await searchMemory(h.pool, lead.user, task, { query: "37일" })
  ).find((d) => d.kind === "conversation");
  const reader = await h.pool.connect(),
    writer = await h.pool.connect();
  try {
    await reader.query("BEGIN");
    assert.equal(
      await validReferences(
        reader,
        lead.user,
        task,
        [{ key: message.key, revision: message.revision }],
        { lock: true },
      ),
      true,
    );
    await assert.rejects(
      writer.query("SELECT id FROM cr_tasks WHERE id=$1 FOR UPDATE NOWAIT", [
        task.id,
      ]),
      (e) => e.code === "55P03",
    );
  } finally {
    await reader.query("ROLLBACK");
    reader.release();
    writer.release();
  }
});
test("archives, direct source reads, and pinned memory all retain personal/department/agent boundaries", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const privateTask = await newTask(lead, values({ visibility: "private" }));
  const msg = (
    await lead.request("POST", `/api/tasks/${privateTask.id}/messages`, {
      body: "숨겨진암호정책 고유구문",
    })
  ).json();
  await remember(lead, {
    title: "숨겨진암호정책",
    body: "개인메모",
    visibility: "private",
    pinned: true,
  });
  const response = await member.request(
    "GET",
    "/api/memory/search?q=숨겨진암호정책",
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items.length, 0);
  const rawId = (
    await h.pool.query("SELECT id FROM cr_messages WHERE task_id=$1", [
      privateTask.id,
    ])
  ).rows[0].id;
  assert.equal(
    (
      await member.request(
        "GET",
        "/api/memory/sources/" + encodeURIComponent("message:" + rawId),
      )
    ).statusCode,
    404,
  );
  const shared = await newTask(lead);
  await command(lead, shared, "start");
  const run = await claimRun(h.pool, "scope", h.config);
  assert.ok(!JSON.stringify(run.snapshot.memoryContext).includes("개인메모"));
});
test("an automatic work episode preserves a summary and source, with no invented test approval", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const task = await newTask(lead, values({ goal: "상관 추적키 정책 검토" }));
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "episode", h.config);
  await processRun(h.pool, run, "episode", h.config, {
    runModel: async () => ({
      origin: "fixture",
      result: {
        summary: "상관 추적키는 request_id를 사용합니다.",
        evidence: [],
        unknowns: ["실제 배포는 미확인"],
        nextActions: [],
      },
      receipt: {},
    }),
  });
  const response = await lead.request("GET", "/api/memory/search?q=request_id");
  const episode = response.json().items.find((m) => m.kind === "episode");
  assert.ok(episode);
  assert.equal(episode.taskId, task.id);
  assert.match(episode.body, /미확인/);
  assert.match(episode.body, /원본/);
});
test("correcting a recalled source invalidates queued input and dependent automatic episodes", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    note = (
      await remember(lead, {
        title: "서명 정책",
        body: "서명 정책은 ALPHA 입니다.",
        pinned: true,
      })
    ).json();
  let task = await newTask(lead, values({ goal: "서명 정책 확인" }));
  await command(lead, task, "start");
  let run = await claimRun(h.pool, "first", h.config);
  await processRun(h.pool, run, "first", h.config, {
    runModel: async () => ({
      origin: "fixture",
      result: {
        summary: "서명 정책 ALPHA",
        evidence: [],
        unknowns: [],
        nextActions: [],
      },
      receipt: {},
    }),
  });
  const before = (
    await lead.request("GET", "/api/memory/search?q=ALPHA")
  ).json().items;
  assert.ok(before.some((i) => i.kind === "episode"));
  task = await newTask(lead, values({ goal: "서명 정책 재확인" }));
  await command(lead, task, "start");
  await lead.request("PATCH", "/api/memories/" + note.id, {
    revision: 1,
    title: "서명 정책",
    body: "서명 정책은 BETA로 변경했습니다.",
    reason: "팀 합의 변경",
  });
  assert.equal(await claimRun(h.pool, "second", h.config), null);
  const after = (await lead.request("GET", "/api/memory/search?q=ALPHA")).json()
    .items;
  assert.ok(!after.some((i) => i.kind === "episode"));
  const used = (
    await lead.request("GET", `/api/tasks/${task.id}/memory`)
  ).json();
  assert.ok(!JSON.stringify(used.items).includes("ALPHA"));
  assert.ok(used.unavailable > 0);
});
test("a source read during a run is revalidated before any later model dispatch", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const note = (
    await remember(lead, {
      title: "희귀콜백규약",
      body: "콜백 서명은 CHERRY입니다.",
    })
  ).json();
  const task = await newTask(lead, values({ goal: "일반 검토" }));
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "read-validation", h.config);
  await recallForRun(h.pool, run, "read-validation", {
    action: "read_memory",
    key: "memory:" + note.id,
  });
  await lead.request("DELETE", "/api/memories/" + note.id, { revision: 1 });
  assert.equal(await contextAllowed(h.pool, run, task), false);
  await assert.rejects(
    recallForRun(h.pool, run, "read-validation", {
      action: "search_memory",
      query: "콜백",
    }),
    (e) => e.code === "CONTEXT_REVOKED",
  );
});
test("optional vector indexing finds a synonym and rejects stale cached vectors after correction", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    note = (
      await remember(lead, {
        title: "서버실",
        body: "인프라 담당은 다연입니다.",
      })
    ).json();
  const config = {
    ...h.config,
    embeddingUrl: "http://127.0.0.1:18900/embeddings",
    embeddingModel: "test-vector",
  };
  const options = {
    apiKey: "",
    fetchImpl: async (_, request) => {
      const body = JSON.parse(request.body);
      return new Response(
        JSON.stringify({
          data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
        }),
      );
    },
  };
  await indexNextMemoryDocument(h.pool, config, options);
  const docs = await searchMemory(
    h.pool,
    { ...lead.user, active: true },
    { visibility: "private", department: lead.user.department },
    {
      query: "datacenter owner",
      agentId: "review",
      vector: [1, 0],
      profileId: embeddingProfile(config).id,
    },
  );
  assert.ok(docs.some((d) => d.key === "memory:" + note.id));
  await lead.request("PATCH", "/api/memories/" + note.id, {
    revision: 1,
    title: "서버실",
    body: "인프라 담당은 수아로 변경했습니다.",
    reason: "담당 변경",
  });
  assert.equal(
    (
      await h.pool.query(
        "SELECT * FROM cr_memory_embeddings WHERE source_key=$1",
        ["memory:" + note.id],
      )
    ).rowCount,
    0,
  );
  const after = await searchMemory(
    h.pool,
    { ...lead.user, active: true },
    { visibility: "private", department: lead.user.department },
    {
      query: "datacenter owner",
      agentId: "review",
      vector: [1, 0],
      profileId: embeddingProfile(config).id,
    },
  );
  assert.ok(!after.some((d) => d.key === "memory:" + note.id));
});
test("a private-derived source is excluded when its manual source task memory is deleted", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const task = await newTask(lead, values({ visibility: "private" }));
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "삭제대상 결정문",
  });
  const note = (
    await remember(lead, {
      sourceTaskId: task.id,
      visibility: "private",
      body: "삭제대상 결정문",
    })
  ).json();
  await lead.request("DELETE", "/api/memories/" + note.id, { revision: 1 });
  const response = await lead.request("GET", "/api/memory/search?q=삭제대상");
  assert.equal(response.json().items.length, 0);
});

test("cross-project recall is explicit and still cannot widen a team request into private notes", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const other = (
    await remember(lead, {
      project: "다른 프로젝트",
      title: "사파이어규약",
      body: "합의된 재시도는 9회입니다.",
    })
  ).json();
  const privateId = (
    await remember(lead, {
      project: "다른 프로젝트",
      title: "사파이어규약",
      body: "비공개 값은 99회입니다.",
      visibility: "private",
    })
  ).json();
  const task = await newTask(
    lead,
    values({ project: "현재 프로젝트", goal: "사파이어규약 사례 검색" }),
  );
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "cross-project", h.config);
  const normal = await recallForRun(h.pool, run, "cross-project", {
    action: "search_memory",
    query: "사파이어규약",
  });
  assert.equal(normal.items.length, 0);
  const broad = await recallForRun(h.pool, run, "cross-project", {
    action: "search_memory",
    query: "사파이어규약",
    project: "*",
  });
  assert.ok(broad.items.some((d) => d.key === "memory:" + other.id));
  assert.ok(!broad.items.some((d) => d.key === "memory:" + privateId.id));
  const original = await recallForRun(h.pool, run, "cross-project", {
    action: "read_memory",
    key: "memory:" + other.id,
  });
  assert.match(original.items[0].body, /9회/);
});
test("failed embedding indexing retries are bounded and a profile change rebuilds the cache", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  await remember(lead);
  const config = {
    ...h.config,
    embeddingUrl: "http://127.0.0.1:18900/embeddings",
    embeddingModel: "bad-vector",
  };
  let calls = 0;
  const options = {
    apiKey: "",
    fetchImpl: async () => {
      calls++;
      return new Response("{}", { status: 503 });
    },
  };
  for (let i = 0; i < 4; i++) {
    await indexNextMemoryDocument(h.pool, config, options);
    await h.pool.query(
      "UPDATE cr_memory_embeddings SET lease_until=now()-interval '1 minute'",
    );
  }
  assert.equal(calls, 3);
  await indexNextMemoryDocument(
    h.pool,
    { ...config, embeddingModel: "new-vector" },
    options,
  );
  assert.equal(calls, 4);
});

test("real HTTP embedding + native analysis lookup + result storage retain evidence and scopes", async (t) => {
  const { createServer } = await import("node:http"),
    requests = [];
  const proxy = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push({ url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/embeddings")
      return res.end(
        JSON.stringify({
          data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
        }),
      );
    const isLookup = body.messages.some((m) => m.role === "assistant");
    return res.end(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              isLookup
                ? {
                    summary: "과거 인프라 담당은 다연입니다.",
                    evidence: ["원문 기억 조회"],
                    unknowns: ["실제 모델 추론은 미검증"],
                    nextActions: [],
                  }
                : { action: "search_memory", query: "datacenter owner" },
            ),
          },
        ],
        stop_reason: "end_turn",
      }),
    );
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + proxy.address().port;
  t.after(() => new Promise((r) => proxy.close(r)));
  const h = await harness(t, {
      provider: "anthropic",
      model: "local-protocol",
      modelEndpoint: base + "/messages",
      embeddingUrl: base + "/embeddings",
      embeddingModel: "local-vector",
    }),
    lead = await h.client("lead@example.com");
  await remember(lead, {
    title: "인프라",
    body: "private-only-needle",
    visibility: "private",
  });
  const shared = (
    await remember(lead, {
      title: "서버실 담당",
      body: "인프라 담당자는 다연입니다.",
    })
  ).json();
  await indexNextMemoryDocument(h.pool, h.config, { apiKey: "" });
  const task = await newTask(lead, values({ goal: "datacenter owner" }));
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "http-recall", h.config);
  await processRun(h.pool, run, "http-recall", h.config);
  const detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal(detail.status, "result_ready", JSON.stringify(detail.runs));
  assert.match(detail.artifacts[0].result.summary, /다연/);
  const persisted = (
    await h.pool.query("SELECT snapshot FROM cr_runs WHERE id=$1", [run.id])
  ).rows[0].snapshot;
  assert.equal(persisted.memoryContext.method, "hybrid");
  assert.ok(
    !JSON.stringify(requests.filter((r) => r.url === "/messages")).includes(
      "private-only-needle",
    ),
  );
  assert.ok(requests.filter((r) => r.url === "/embeddings").length >= 3);
  assert.equal(
    (
      await h.pool.query("SELECT * FROM cr_memory_reads WHERE run_id=$1", [
        run.id,
      ])
    ).rowCount,
    1,
  );
  const evidence = (
    await lead.request("GET", `/api/tasks/${task.id}/memory`)
  ).json();
  assert.ok(evidence.items.some((m) => m.key === "memory:" + shared.id));
});
