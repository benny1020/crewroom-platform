import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, processRun } from "../../server/worker.js";
import { embeddingProfile } from "../../server/memory-embedding.js";
const result = {
  origin: "model",
  result: {
    summary: "확인한 결과",
    evidence: [],
    unknowns: [],
    nextActions: [],
  },
  receipt: { provider: "fixture", model: "quality-protocol" },
};
async function setup(t) {
  const h = await harness(t, {
      embeddingUrl: "http://quality.invalid/embeddings",
      embeddingModel: "quality-vector",
    }),
    lead = await h.client("lead@example.com");
  const task = await newTask(
    lead,
    values({
      workType: "chat",
      agentId: "review",
      goal: "과거 담당자를 확인해주세요",
    }),
  );
  assert.equal((await command(lead, task, "start")).statusCode, 200);
  const owner = "quality-test",
    run = await claimRun(h.pool, owner, h.config);
  return { ...h, lead, task, owner, run };
}
async function exceed(h) {
  await h.pool.query(
    `INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) SELECT 'quality:'||i,'rev',$1,'ready','[{"text":"synthetic","vector":[1,0]}]'::jsonb,now() FROM generate_series(1,2001)i`,
    [embeddingProfile(h.config).id],
  );
}
const embeddingResponse = () =>
  new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
    status: 200,
  });
async function assertFailed(h, code) {
  const detail = (await h.lead.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  assert.equal(detail.status, "failed");
  assert.equal(detail.artifacts.length, 0);
  assert.equal(detail.runs[0].error_code, code);
  assert.equal(detail.runs[0].lease_owner, null);
  assert.equal(
    (
      await h.pool.query("SELECT * FROM cr_memory_reads WHERE run_id=$1", [
        h.run.id,
      ])
    ).rowCount,
    0,
  );
}

test("semantic capacity stops before generation and cannot publish a keyword-only result", async (t) => {
  const h = await setup(t);
  await exceed(h);
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () => embeddingResponse(),
    runModel: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(calls, 0);
  await assertFailed(h, "MEMORY_SEARCH_CAPACITY");
});
test("configured embedding rejection stops before generation without a degraded answer", async (t) => {
  const h = await setup(t);
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () => new Response("{}", { status: 503 }),
    runModel: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(calls, 0);
  await assertFailed(h, "MEMORY_SEARCH_UNAVAILABLE");
});
test("an unavailable additional lookup stops the run rather than generating an answer from a failed lookup", async (t) => {
  const h = await setup(t);
  let embeds = 0,
    calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () =>
      ++embeds === 1
        ? embeddingResponse()
        : new Response("{}", { status: 503 }),
    runModel: async (_s, _c, options) => {
      calls++;
      await options.memoryTools({
        action: "search_memory",
        query: "old owner",
      });
      return result;
    },
  });
  assert.equal(calls, 1);
  assert.equal(embeds, 2);
  await assertFailed(h, "MEMORY_SEARCH_UNAVAILABLE");
});
test("capacity reached during a run stops an additional lookup and cannot save a final artifact", async (t) => {
  const h = await setup(t);
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () => embeddingResponse(),
    runModel: async (_s, _c, options) => {
      calls++;
      await exceed(h);
      await options.memoryTools({
        action: "search_memory",
        query: "old owner",
      });
      return result;
    },
  });
  assert.equal(calls, 1);
  await assertFailed(h, "MEMORY_SEARCH_CAPACITY");
});
test("a resumed legacy input with degraded retrieval cannot bypass the quality gate", async (t) => {
  const h = await setup(t);
  h.run.snapshot.inputHash = "synthetic-legacy-hash";
  h.run.snapshot.memoryContext.semanticStatus = "capacity_limited";
  await h.pool.query("UPDATE cr_runs SET snapshot=$2 WHERE id=$1", [
    h.run.id,
    h.run.snapshot,
  ]);
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () => embeddingResponse(),
    runModel: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(calls, 0);
  await assertFailed(h, "MEMORY_SEARCH_CAPACITY");
});
test("a successful semantic lookup with genuinely no matches can still produce a result", async (t) => {
  const h = await setup(t);
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () => embeddingResponse(),
    runModel: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(calls, 1);
  const detail = (await h.lead.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  assert.equal(detail.status, "result_ready");
  assert.equal(detail.artifacts.length, 1);
  const { snapshot } = (
    await h.pool.query("SELECT snapshot FROM cr_runs WHERE id=$1", [h.run.id])
  ).rows[0];
  assert.equal(snapshot.memoryContext.semanticStatus, "no_matches");
  assert.equal(snapshot.memoryContext.semanticCoverageVersion, 1);
});

for (const persisted of [false, true])
  test(`removing a configured embedding endpoint cannot silently switch ${persisted ? "a resumed" : "a queued"} run to keyword-only`, async (t) => {
    const h = await setup(t);
    if (persisted) {
      h.run.snapshot.inputHash = "synthetic-profile-hash";
      h.run.snapshot.memoryContext.semanticStatus = "matched";
      await h.pool.query("UPDATE cr_runs SET snapshot=$2 WHERE id=$1", [
        h.run.id,
        h.run.snapshot,
      ]);
    }
    let calls = 0;
    await processRun(
      h.pool,
      h.run,
      h.owner,
      { ...h.config, embeddingUrl: "" },
      {
        runModel: async () => {
          calls++;
          return result;
        },
      },
    );
    assert.equal(calls, 0);
    await assertFailed(h, "EMBEDDING_PROFILE_CHANGED");
  });

test("a resumed semantic input without retrieval verification must start a fresh lookup", async (t) => {
  const h = await setup(t);
  h.run.snapshot.inputHash = "synthetic-unverified-hash";
  delete h.run.snapshot.memoryContext.semanticStatus;
  await h.pool.query("UPDATE cr_runs SET snapshot=$2 WHERE id=$1", [
    h.run.id,
    h.run.snapshot,
  ]);
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    runModel: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(calls, 0);
  await assertFailed(h, "MEMORY_SEARCH_UNVERIFIED");
});

for (const state of ["missing", "failed", "indexing", "stale"])
  test(`an accessible old source with ${state} embedding is incomplete, not a successful no-match`, async (t) => {
    const h = await setup(t);
    const sourceTask = await newTask(
      h.lead,
      values({
        workType: "chat",
        agentId: "review",
        project: h.task.project,
        goal: "배송 담당 원문",
      }),
    );
    await h.pool.query(
      `INSERT INTO cr_messages(task_id,user_id,body,target_version,created_at) VALUES($1,$2,'배송 책임 담당자는 지민으로 확정','v1',now()-interval '1 day')`,
      [sourceTask.id, h.lead.user.id],
    );
    if (state !== "missing")
      await h.pool.query(
        `INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) SELECT key,CASE WHEN $2='stale' THEN 'old-revision' ELSE revision END,$1,CASE WHEN $2='stale' THEN 'ready' ELSE $2 END,'[{"text":"source","vector":[1,0]}]'::jsonb,now() FROM cr_recall_documents WHERE task_id=$3`,
        [embeddingProfile(h.config).id, state, sourceTask.id],
      );
    let calls = 0;
    await processRun(h.pool, h.run, h.owner, h.config, {
      fetchImpl: async () => embeddingResponse(),
      runModel: async () => {
        calls++;
        return result;
      },
    });
    assert.equal(calls, 0);
    await assertFailed(h, "MEMORY_INDEX_INCOMPLETE");
  });

test("a fully indexed accessible corpus with no semantic match can complete", async (t) => {
  const h = await setup(t),
    sourceTask = await newTask(
      h.lead,
      values({
        workType: "chat",
        agentId: "review",
        project: h.task.project,
        goal: "다른 기록",
      }),
    );
  await h.pool.query(
    `INSERT INTO cr_messages(task_id,user_id,body,target_version,created_at) VALUES($1,$2,'별도의 옛 합의','v1',now()-interval '1 day')`,
    [sourceTask.id, h.lead.user.id],
  );
  await h.pool.query(
    `INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) SELECT key,revision,$1,'ready','[{"text":"source","vector":[0,1]}]'::jsonb,now() FROM cr_recall_documents WHERE task_id=$2`,
    [embeddingProfile(h.config).id, sourceTask.id],
  );
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () => embeddingResponse(),
    runModel: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(calls, 1);
  const detail = (await h.lead.request("GET", `/api/tasks/${h.task.id}`)).json()
    .task;
  assert.equal(detail.status, "result_ready");
});

test("an unindexed source outside the task scope cannot block a shared run or enter its context", async (t) => {
  const h = await setup(t),
    sourceTask = await newTask(
      h.lead,
      values({
        workType: "chat",
        agentId: "personal-" + h.lead.user.id,
        visibility: "private",
        project: h.task.project,
      }),
    );
  await h.pool.query(
    `INSERT INTO cr_messages(task_id,user_id,body,target_version,created_at) VALUES($1,$2,'PRIVATE_SOURCE_DO_NOT_EXPOSE','v1',now()-interval '1 day')`,
    [sourceTask.id, h.lead.user.id],
  );
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () => embeddingResponse(),
    runModel: async (snapshot) => {
      calls++;
      assert.ok(
        !JSON.stringify(snapshot.memoryContext).includes(
          "PRIVATE_SOURCE_DO_NOT_EXPOSE",
        ),
      );
      return result;
    },
  });
  assert.equal(calls, 1);
  assert.equal(
    (await h.lead.request("GET", `/api/tasks/${h.task.id}`)).json().task.status,
    "result_ready",
  );
});

for (const status of ["no_matches", "matched"])
  test(`a legacy ${status} marker without coverage proof cannot authorize resumed generation`, async (t) => {
    const h = await setup(t);
    h.run.snapshot.inputHash = "synthetic-legacy-coverage-hash";
    h.run.snapshot.memoryContext.semanticStatus = status;
    await h.pool.query("UPDATE cr_runs SET snapshot=$2 WHERE id=$1", [
      h.run.id,
      h.run.snapshot,
    ]);
    let calls = 0;
    await processRun(h.pool, h.run, h.owner, h.config, {
      runModel: async () => {
        calls++;
        return result;
      },
    });
    assert.equal(calls, 0);
    await assertFailed(h, "MEMORY_SEARCH_UNVERIFIED");
    const { snapshot } = (
      await h.pool.query("SELECT snapshot FROM cr_runs WHERE id=$1", [h.run.id])
    ).rows[0];
    assert.equal(snapshot.memoryContext.semanticCoverageVersion, undefined);
  });

test("dimension drift under an unchanged embedding profile cannot masquerade as no matches", async (t) => {
  const h = await setup(t),
    sourceTask = await newTask(
      h.lead,
      values({ workType: "chat", agentId: "review", project: h.task.project }),
    );
  await h.pool.query(
    `INSERT INTO cr_messages(task_id,user_id,body,target_version,created_at) VALUES($1,$2,'dimension source','v1',now()-interval '1 day'),($1,$2,'matching source','v1',now()-interval '1 day')`,
    [sourceTask.id, h.lead.user.id],
  );
  await h.pool.query(
    `INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) SELECT key,revision,$1,'ready',CASE WHEN body='dimension source' THEN '[{"text":"source","vector":[1,0,0]}]'::jsonb ELSE '[{"text":"matching","vector":[1,0]}]'::jsonb END,now() FROM cr_recall_documents WHERE task_id=$2`,
    [embeddingProfile(h.config).id, sourceTask.id],
  );
  let calls = 0;
  await processRun(h.pool, h.run, h.owner, h.config, {
    fetchImpl: async () => embeddingResponse(),
    runModel: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(calls, 0);
  await assertFailed(h, "EMBEDDING_DIMENSION_CHANGED");
});
