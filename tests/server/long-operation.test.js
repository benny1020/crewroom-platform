import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values } from "./helpers.js";
import {
  searchMemory,
  EXACT_VECTOR_DOCUMENT_LIMIT,
} from "../../server/memory.js";
import {
  indexNextMemoryDocument,
  embeddingProfile,
} from "../../server/memory-embedding.js";
import { operationStats, maintain } from "../../server/operations.js";

test("recall projection tracks corrections, rollback, membership names and live source ACL", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const task = await newTask(
    lead,
    values({ workType: "chat", agentId: "review" }),
  );
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "ANCIENT_RECEIPT exact source",
  });
  let docs = await searchMemory(h.pool, member.user, task, {
    query: "ANCIENT_RECEIPT",
  });
  assert.equal(docs.length, 1);
  const id = docs[0].key.slice(8),
    db = await h.pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("UPDATE cr_messages SET body=$2 WHERE id=$1", [
      id,
      "CORRECTED_RECEIPT",
    ]);
    assert.equal(
      (await searchMemory(db, member.user, task, { query: "ANCIENT_RECEIPT" }))
        .length,
      0,
    );
    assert.equal(
      (
        await searchMemory(db, member.user, task, {
          query: "CORRECTED_RECEIPT",
        })
      ).length,
      1,
    );
    await db.query("ROLLBACK");
  } finally {
    db.release();
  }
  assert.equal(
    (
      await searchMemory(h.pool, member.user, task, {
        query: "ANCIENT_RECEIPT",
      })
    ).length,
    1,
  );
  await h.pool.query("UPDATE cr_tasks SET visibility='private' WHERE id=$1", [
    task.id,
  ]);
  assert.equal(
    (
      await searchMemory(h.pool, member.user, task, {
        query: "ANCIENT_RECEIPT",
      })
    ).length,
    0,
  );
  await h.pool.query("UPDATE cr_members SET name='Changed' WHERE id=$1", [
    lead.user.id,
  ]);
  docs = await searchMemory(
    h.pool,
    lead.user,
    { ...task, visibility: "private" },
    { query: "Changed" },
  );
  assert.ok(docs.some((d) => d.title.includes("Changed")));
});

test("exact semantic search stops at corpus ceiling without reading vector bodies and reports fallback", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead);
  await h.pool.query(
    `INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) SELECT 'synthetic:'||i,'rev','capacity-profile','ready','[{"text":"x","vector":[1,0]}]'::jsonb,now() FROM generate_series(1,$1)i`,
    [EXACT_VECTOR_DOCUMENT_LIMIT + 1],
  );
  const sql = [],
    db = {
      query: async (q, args) => {
        sql.push(q);
        return h.pool.query(q, args);
      },
    };
  const docs = await searchMemory(db, lead.user, task, {
    query: "needle",
    vector: [1, 0],
    profileId: "capacity-profile",
  });
  assert.equal(docs.semanticStatus, "capacity_limited");
  const cfg = {
    embeddingUrl: "http://127.0.0.1:1/embeddings",
    embeddingModel: "capacity-test",
  };
  await h.pool.query("UPDATE cr_memory_embeddings SET profile_id=$1", [
    embeddingProfile(cfg).id,
  ]);
  let calls = 0;
  assert.equal(
    await indexNextMemoryDocument(h.pool, cfg, {
      fetchImpl: async () => {
        calls++;
        throw Error("unexpected fetch");
      },
    }),
    false,
  );
  assert.equal(calls, 0);

  assert.equal(docs.length, 0);
  assert.equal(
    sql.filter((q) => q.includes("capacity CROSS JOIN coverage")).length,
    1,
  );
  assert.equal(
    (await operationStats(h.pool)).vectorProfiles[0].mode,
    "semantic_capacity_blocked",
  );
});

test("maintenance is bounded, dry by default, expires sessions only and reports storage without contents", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead);
  await h.pool.query(
    `INSERT INTO cr_sessions(token_hash,user_id,csrf_hash,expires_at) SELECT 'expired-'||i,$1,'csrf',now()-interval '1 day' FROM generate_series(1,7)i`,
    [lead.user.id],
  );
  assert.deepEqual(await maintain(h.pool, { batch: 3 }), {
    mode: "dry-run",
    expiredSessionCandidates: 3,
    removed: 0,
    hasMore: true,
    batch: 3,
  });
  assert.equal((await maintain(h.pool, { apply: true, batch: 3 })).removed, 3);
  assert.equal(
    (await lead.request("GET", `/api/tasks/${task.id}`)).statusCode,
    200,
  );
  const stats = await operationStats(h.pool);
  assert.ok(stats.tables.some((r) => r.name === "cr_messages"));
  assert.ok(Number(stats.storage.database_bytes) > 0);
  assert.equal(stats.storage.autovacuum, "on");
  assert.ok(!JSON.stringify(stats).includes(task.goal));
  await assert.rejects(
    maintain(h.pool, { apply: true, batch: 1001 }),
    /INVALID_MAINTENANCE_BATCH/,
  );
});

test("a correction between indexed candidates and source read cannot reuse the old text score", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead, values({ workType: "chat", agentId: "review" }));
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "INTERLEAVED_MARKER original agreement",
  });
  let changed = false;
  const db = {
    query: async (q, args) => {
      const result = await h.pool.query(q, args);
      if (
        !changed &&
        q.includes("SELECT key,lexical,pinned,content_fingerprint")
      ) {
        changed = true;
        await h.pool.query(
          "UPDATE cr_messages SET body='different corrected text' WHERE task_id=$1",
          [task.id],
        );
      }
      return result;
    },
  };
  assert.equal(
    (await searchMemory(db, lead.user, task, { query: "INTERLEAVED_MARKER" }))
      .length,
    0,
  );
  assert.equal(changed, true);
});

test("coordinate and byte ceilings also agree with operator diagnostics below the document ceiling", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead);
  for (const [profile, n, text, value] of [
    ["coordinates", 31, "", 1],
    ["bytes", 26, "x".repeat(2400), 999999.1234567899],
  ]) {
    await h.pool.query(
      `WITH chunk AS (SELECT jsonb_build_object('text',$3::text,'vector',(SELECT jsonb_agg($4::numeric) FROM generate_series(1,4096))) AS v),payload AS (SELECT jsonb_agg(v) AS vectors FROM chunk CROSS JOIN generate_series(1,16))
   INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) SELECT $1||':'||i,'rev',$1,'ready',vectors,now() FROM payload CROSS JOIN generate_series(1,$2::int)i`,
      [profile, n, text, String(value)],
    );
    const result = await searchMemory(h.pool, lead.user, task, {
      query: "none",
      vector: [1, 0],
      profileId: profile,
    });
    assert.equal(result.semanticStatus, "capacity_limited", profile);
    const stats = (await operationStats(h.pool)).vectorProfiles.find(
      (r) => r.profile_id === profile,
    );
    assert.equal(stats.mode, "semantic_capacity_blocked");
    assert.equal(stats.ready_documents, n);
    const cfg = {
      embeddingUrl: "http://127.0.0.1:1/embeddings",
      embeddingModel: profile,
    };
    await h.pool.query(
      "UPDATE cr_memory_embeddings SET profile_id=$2 WHERE profile_id=$1",
      [profile, embeddingProfile(cfg).id],
    );
    let calls = 0;
    assert.equal(
      await indexNextMemoryDocument(h.pool, cfg, {
        fetchImpl: async () => {
          calls++;
          throw Error("unexpected fetch");
        },
      }),
      false,
    );
    assert.equal(calls, 0);

    if (profile === "coordinates")
      assert.ok(
        Number(stats.vector_values) > 2000000 &&
          Number(stats.vector_bytes) < 32000000,
      );
    else
      assert.ok(
        Number(stats.vector_values) < 2000000 &&
          Number(stats.vector_bytes) > 32000000,
      );
  }
});
