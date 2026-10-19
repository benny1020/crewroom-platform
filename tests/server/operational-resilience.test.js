import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values, waitFor, command } from "./helpers.js";
import { setTimeout as delay } from "node:timers/promises";
import { maintain } from "../../server/operations.js";
import { startWorker } from "../../server/worker.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  indexNextMemoryDocument,
  embeddingProfile,
  retryFailedEmbeddings,
} from "../../server/memory-embedding.js";

const cfg = {
  embeddingUrl: "http://fixture.invalid/embeddings",
  embeddingModel: "resilience-fixture",
};
const response = (vector = [1, 0]) =>
  new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }] }), {
    status: 200,
  });
async function source(t) {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead, values({ workType: "chat", agentId: "review" }));
  const message = (
    await h.pool.query(
      "INSERT INTO cr_messages(task_id,user_id,body,created_at) VALUES($1,$2,'ANCIENT_SOURCE','2020-01-01') RETURNING id",
      [task.id, lead.user.id],
    )
  ).rows[0];
  return { ...h, lead, task, key: "message:" + message.id };
}

test("maintenance bounds disposable data and rechecks an auth window refreshed during cleanup", async (t) => {
  const h = await source(t);
  await h.pool.query(
    "INSERT INTO cr_sessions(token_hash,user_id,csrf_hash,expires_at) SELECT 'old-'||i,$1,'x',now()-interval '1 day' FROM generate_series(1,7)i",
    [h.lead.user.id],
  );
  await h.pool.query(
    "INSERT INTO cr_auth_attempts(key,attempts,window_start) SELECT 'old-'||i,9,now()-interval '2 days' FROM generate_series(1,7)i",
  );
  await h.pool.query(
    "INSERT INTO cr_auth_attempts(key,attempts,window_start) VALUES('limited',16,now())",
  );
  const dry = await maintain(h.pool, { batch: 3 });
  assert.equal(dry.expiredSessionCandidates, 3);
  assert.equal(dry.expiredAuthAttemptCandidates, 3);
  assert.equal(dry.removedAuthAttempts, 0);
  let changed = false;
  const db = {
    query: async (sql, args) => {
      const result = await h.pool.query(sql, args);
      if (!changed && sql.startsWith("SELECT key FROM cr_auth_attempts")) {
        changed = true;
        await h.pool.query(
          "UPDATE cr_auth_attempts SET window_start=clock_timestamp(),attempts=16 WHERE key=$1",
          [result.rows[0].key],
        );
      }
      return result;
    },
  };
  assert.equal(
    (await maintain(db, { apply: true, batch: 3 })).removedAuthAttempts,
    2,
  );
  for (let i = 0; i < 3; i++) await maintain(h.pool, { apply: true, batch: 3 });
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*)::int n FROM cr_auth_attempts WHERE key LIKE 'old-%'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await h.pool.query(
        "SELECT attempts FROM cr_auth_attempts WHERE key='limited'",
      )
    ).rows[0].attempts,
    16,
  );
  assert.equal(
    (await h.lead.request("GET", `/api/tasks/${h.task.id}`)).statusCode,
    200,
  );
  assert.equal(
    (
      await h.pool.query("SELECT body FROM cr_messages WHERE task_id=$1", [
        h.task.id,
      ])
    ).rows[0].body,
    "ANCIENT_SOURCE",
  );
});

test("a failed queue tick is unhealthy and recovers with bounded automatic maintenance", async (t) => {
  const h = await source(t);
  await h.pool.query(
    "INSERT INTO cr_auth_attempts(key,attempts,window_start) VALUES('expired',1,now()-interval '2 days')",
  );
  let broken = true;
  const wrapped = {
    query: h.pool.query.bind(h.pool),
    connect: async () => {
      const c = await h.pool.connect();
      return {
        release: c.release.bind(c),
        query: (sql, args) => {
          if (broken && sql.includes("r.lease_until<clock_timestamp()")) {
            const e = Error("PRIVATE_DIAGNOSTIC_MUST_NOT_LEAK");
            e.code = "57014";
            throw e;
          }
          return c.query(sql, args);
        },
      };
    },
  };
  const worker = await startWorker(wrapped, h.config);
  h.cleanup.push(() => worker.stop());
  let w = (await h.lead.request("GET", "/api/workspace")).json().workers[0];
  assert.equal(w.state, "degraded");
  assert.equal(w.healthy, false);
  assert.equal(w.last_error_code, "57014");
  assert.equal(w.last_tick_at, null);
  assert.ok(!JSON.stringify(w).includes("PRIVATE_DIAGNOSTIC"));
  broken = false;
  await waitFor(
    async () =>
      (await h.lead.request("GET", "/api/workspace")).json().workers[0],
    (w) => w.healthy && w.maintenance_at,
  );
  w = (await h.lead.request("GET", "/api/workspace")).json().workers[0];
  assert.equal(w.state, "ready");
  assert.equal(w.last_error_code, null);
  assert.ok(w.maintenance_at);
  assert.equal(w.maintenance.removedAuthAttempts, 1);
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*)::int n FROM cr_auth_attempts WHERE key='expired'",
      )
    ).rows[0].n,
    0,
  );
});

test("continuous new messages do not put an older unindexed source behind the latest arrival", async (t) => {
  const h = await source(t),
    inputs = [];
  for (let i = 0; i < 3; i++) {
    await h.pool.query(
      "INSERT INTO cr_messages(task_id,user_id,body) VALUES($1,$2,$3)",
      [h.task.id, h.lead.user.id, "NEW_SOURCE_" + i],
    );
    assert.equal(
      await indexNextMemoryDocument(h.pool, cfg, {
        fetchImpl: async (_url, options) => {
          inputs.push(JSON.parse(options.body).input[0]);
          return response();
        },
      }),
      true,
    );
  }
  assert.match(inputs[0], /ANCIENT_SOURCE/);
  assert.match(inputs[1], /NEW_SOURCE_0/);
  assert.match(inputs[2], /NEW_SOURCE_1/);
});

test("three failed embedding attempts recover through explicit bounded requeue without changing the original", async (t) => {
  const h = await source(t);
  let calls = 0;
  for (let i = 0; i < 3; i++) {
    await indexNextMemoryDocument(h.pool, cfg, {
      fetchImpl: async () => {
        calls++;
        return new Response("{}", { status: 503 });
      },
    });
    await h.pool.query(
      "UPDATE cr_memory_embeddings SET lease_until=now()-interval '1 second'",
    );
  }
  assert.equal(
    await indexNextMemoryDocument(h.pool, cfg, {
      fetchImpl: async () => {
        calls++;
        return response();
      },
    }),
    false,
  );
  assert.equal(calls, 3);
  assert.equal((await retryFailedEmbeddings(h.pool, cfg)).candidates, 1);
  assert.equal(
    (await h.pool.query("SELECT attempts FROM cr_memory_embeddings")).rows[0]
      .attempts,
    3,
  );
  assert.equal(
    (await retryFailedEmbeddings(h.pool, cfg, { apply: true })).requeued,
    1,
  );
  await indexNextMemoryDocument(h.pool, cfg, {
    fetchImpl: async () => response(),
  });
  const row = (await h.pool.query("SELECT * FROM cr_memory_embeddings"))
    .rows[0];
  assert.equal(row.status, "ready");
  assert.equal(row.attempts, 1);
  assert.equal(
    (
      await h.pool.query("SELECT body FROM cr_messages WHERE task_id=$1", [
        h.task.id,
      ])
    ).rows[0].body,
    "ANCIENT_SOURCE",
  );
  await h.pool.query(
    "UPDATE cr_memory_embeddings SET status='indexing',attempts=3,lease_until=now()+interval '1 minute'",
  );
  assert.equal(
    (await retryFailedEmbeddings(h.pool, cfg, { apply: true })).candidates,
    0,
  );
  await h.pool.query(
    "UPDATE cr_memory_embeddings SET lease_until=now()-interval '1 second'",
  );
  assert.equal((await retryFailedEmbeddings(h.pool, cfg)).candidates, 1);
  assert.equal(
    (await h.pool.query("SELECT status FROM cr_memory_embeddings")).rows[0]
      .status,
    "indexing",
  );
  assert.equal(
    (await retryFailedEmbeddings(h.pool, cfg, { apply: true })).requeued,
    1,
  );
  await indexNextMemoryDocument(h.pool, cfg, {
    fetchImpl: async () => response(),
  });
  assert.equal(
    (await h.pool.query("SELECT status FROM cr_memory_embeddings")).rows[0]
      .status,
    "ready",
  );
});

test("capacity cleanup runs before early return and repairs a stale episode while retaining original artifacts", async (t) => {
  const h = await source(t),
    profile = embeddingProfile(cfg).id;
  await h.pool.query(
    "INSERT INTO cr_artifacts(id,task_id,step_index,version,target_version,origin,result,content_hash) VALUES(gen_random_uuid(),$1,0,1,$2,'fixture','{\"summary\":\"original result\"}', 'hash')",
    [h.task.id, h.task.target_version],
  );
  const old = (
    await h.pool.query("SELECT * FROM cr_recall_documents WHERE key=$1", [
      "episode:" + h.task.id,
    ])
  ).rows[0];
  await h.pool.query(
    'INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) VALUES($1,$2,$3,\'ready\',\'[{"text":"stale episode","vector":[1,0]}]\',now())',
    [old.key, old.revision, profile],
  );
  await h.pool.query(
    "INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) SELECT 'orphan:'||i,'missing',$1,'ready','[{\"text\":\"stale cache\",\"vector\":[1,0]}]',now() FROM generate_series(1,2001)i",
    [profile],
  );
  await h.pool.query(
    'UPDATE cr_tasks SET brief=brief || \'{"text":"CORRECTED_BRIEF"}\'::jsonb WHERE id=$1',
    [h.task.id],
  );
  let calls = 0;
  assert.equal(
    await indexNextMemoryDocument(h.pool, cfg, {
      fetchImpl: async () => {
        calls++;
        return response();
      },
    }),
    true,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await h.pool.query(
        "SELECT 1 FROM cr_memory_embeddings WHERE source_key=$1 AND source_revision=$2",
        [old.key, old.revision],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await h.pool.query(
        "SELECT result->>'summary' s FROM cr_artifacts WHERE task_id=$1",
        [h.task.id],
      )
    ).rows[0].s,
    "original result",
  );
  // No eligible source / no configured endpoint must still clean cold stale rows.
  for (let i = 0; i < 25; i++)
    await indexNextMemoryDocument(
      h.pool,
      {},
      {
        fetchImpl: () => {
          throw Error("unexpected call");
        },
      },
    );
  assert.equal(
    (
      await h.pool.query(
        "SELECT 1 FROM cr_memory_embeddings WHERE source_key LIKE 'orphan:%'",
      )
    ).rowCount,
    0,
  );
});

for (const late of ["success", "failure"])
  test(`a reclaimed embedding lease rejects a late ${late} for the same source revision`, async (t) => {
    const h = await source(t);
    let release, arrived;
    const gate = new Promise((r) => (release = r)),
      entered = new Promise((r) => (arrived = r));
    const first = indexNextMemoryDocument(h.pool, cfg, {
      fetchImpl: async () => {
        arrived();
        await gate;
        return late === "success"
          ? response([1, 0])
          : new Response("{}", { status: 503 });
      },
    });
    try {
      await Promise.race([
        entered,
        first.then(() => {
          throw Error("Index claim did not reach fixture");
        }),
      ]);
      await h.pool.query(
        "UPDATE cr_memory_embeddings SET lease_until=now()-interval '1 second'",
      );
      await indexNextMemoryDocument(h.pool, cfg, {
        fetchImpl: async () => response([0, 1]),
      });
    } finally {
      release();
      await first;
    }
    const row = (
      await h.pool.query(
        "SELECT * FROM cr_memory_embeddings WHERE source_key=$1",
        [h.key],
      )
    ).rows[0];
    assert.equal(row.status, "ready");
    assert.equal(row.attempts, 2);
    assert.deepEqual(row.vectors[0].vector, [0, 1]);
  });

test("a real idle PostgreSQL connection failure keeps the process alive and the pool reconnects", async (t) => {
  const h = await harness(t);
  const script = `
    import { database } from './server/db.js';
    const pool=database(process.env.TEST_DATABASE_URL),client=await pool.connect();
    console.log((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    client.release();
    process.stdin.once('data',async()=>{
      try { await pool.query('SELECT 1');console.log('RECOVERED');await pool.end(); }
      catch { process.exitCode=1; }
    });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TEST_DATABASE_URL: h.pool.options.connectionString },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  let out = "",
    err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const done = once(child, "close");
  const pid = await waitFor(() => out.match(/^([0-9]+)\n/)?.[1], Boolean);
  await h.pool.query("SELECT pg_terminate_backend($1)", [Number(pid)]);
  await waitFor(
    () => err.includes("Database idle connection closed:"),
    Boolean,
  );
  child.stdin.end("continue\n");
  assert.equal((await done)[0], 0);
  assert.match(out, /RECOVERED/);
  assert.ok(!err.includes("connectionString"));
});

test("an index claim lock excludes its own schema and does not starve another isolated schema", async (t) => {
  const first = await source(t),
    second = await source(t),
    c = await first.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('crewroom-memory-index'))",
    );
    assert.equal(
      await indexNextMemoryDocument(first.pool, cfg, {
        fetchImpl: () => {
          throw Error("unexpected call");
        },
      }),
      false,
    );
    assert.equal(
      await indexNextMemoryDocument(second.pool, cfg, {
        fetchImpl: async () => response(),
      }),
      true,
    );
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});

test("slow or failed housekeeping cannot block a queued Run and retries wait for the next interval", async (t) => {
  const h = await source(t);
  assert.equal((await command(h.lead, h.task, "start")).statusCode, 200);
  let release,
    calls = 0;
  const gate = new Promise((r) => (release = r));
  const wrapped = {
    connect: h.pool.connect.bind(h.pool),
    query: async (sql, args) => {
      if (sql.startsWith("SELECT token_hash FROM cr_sessions")) {
        calls++;
        await gate;
        const error = Error("PRIVATE_MAINTENANCE_DETAIL");
        error.code = "57014";
        throw error;
      }
      return h.pool.query(sql, args);
    },
  };
  const worker = await startWorker(wrapped, h.config);
  h.cleanup.push(() => {
    release();
    return worker.stop();
  });
  try {
    await waitFor(
      async () =>
        (await h.lead.request("GET", `/api/tasks/${h.task.id}`)).json().task,
      (task) => task.status === "result_ready",
    );
    release();
    const w = await waitFor(
      async () =>
        (await h.lead.request("GET", "/api/workspace")).json().workers[0],
      (w) => w.maintenance_error_code === "57014",
    );
    assert.equal(w.healthy, true);
    assert.equal(w.last_error_code, null);
    assert.ok(!JSON.stringify(w).includes("PRIVATE_MAINTENANCE_DETAIL"));
    await delay(650);
    assert.equal(calls, 1);
  } finally {
    release();
  }
});
