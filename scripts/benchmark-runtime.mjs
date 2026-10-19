// Disposable schema only; production DATABASE_URL is never selected implicitly.
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { harness, newTask, values, command } from "../tests/server/helpers.js";
import { claimRun, expireRuns } from "../server/worker.js";
if (!process.env.BENCHMARK_DATABASE_URL)
  throw Error(
    "BENCHMARK_DATABASE_URL required; use an isolated development database",
  );
process.env.TEST_DATABASE_URL = process.env.BENCHMARK_DATABASE_URL;
const cleanup = [],
  h = await harness({ after: (fn) => cleanup.push(fn) });
try {
  const lead = await h.client("lead@example.com"),
    archive = await newTask(
      lead,
      values({ workType: "chat", agentId: "review" }),
    ),
    queued = await newTask(lead, values({ workType: "chat", agentId: "ops" }));
  await h.pool.query(
    `INSERT INTO cr_runs(id,task_id,step_index,agent_id,requested_by,status,snapshot,created_at,finished_at)
    SELECT gen_random_uuid(),$1,0,'review',$2,'succeeded','{"synthetic":true}',now()-interval '1 year',now()-interval '1 year' FROM generate_series(1,100000)`,
    [archive.id, lead.user.id],
  );
  // An unconfirmed old failure must continue occupying one slot.
  await h.pool.query(
    `INSERT INTO cr_runs(id,task_id,step_index,agent_id,requested_by,status,snapshot,lease_owner,lease_until)
    VALUES(gen_random_uuid(),$1,0,'review',$2,'failed','{}','unconfirmed-fixture',now()-interval '1 day')`,
    [archive.id, lead.user.id],
  );
  await command(lead, queued, "start");
  await h.pool.query("ANALYZE");
  const sql =
    "SELECT count(*) FROM (SELECT 1 FROM cr_runs WHERE status='running' OR (status='paused' AND started_at IS NOT NULL) OR lease_owner IS NOT NULL LIMIT 2) active";
  const db = await h.pool.connect();
  let before, after;
  try {
    await db.query("BEGIN");
    await db.query("DROP INDEX cr_runs_capacity");
    before = (await db.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql))
      .rows[0]["QUERY PLAN"][0];
    await db.query("ROLLBACK");
    after = (await db.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql))
      .rows[0]["QUERY PLAN"][0];
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  assert.match(JSON.stringify(before), /Seq Scan/);
  assert.match(JSON.stringify(after), /cr_runs_capacity/);
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now(),
      run = await claimRun(h.pool, "scale-runtime", h.config);
    assert.equal(run.task_id, queued.id);
    assert.equal(run.agent_id, "ops");
    assert.equal(await claimRun(h.pool, "scale-runtime", h.config), null);
    assert.equal(await expireRuns(h.pool), 0);
    samples.push(performance.now() - start);
    await h.pool.query(
      "UPDATE cr_runs SET status='queued',lease_owner=NULL,lease_until=NULL WHERE id=$1",
      [run.id],
    );
    await h.pool.query("UPDATE cr_tasks SET status='queued' WHERE id=$1", [
      queued.id,
    ]);
  }
  samples.sort((a, b) => a - b);
  const files = [
    "server/worker.js",
    "server/operations.js",
    "server/migrations/012_operational_resilience.sql",
  ];
  const report = {
    release: "0.13.0",
    at: new Date().toISOString(),
    synthetic: true,
    historicalRuns: 100000,
    unconfirmedOldRuns: 1,
    queuedRuns: 1,
    iterations: 20,
    sourceFiles: await Promise.all(
      files.map(async (path) => ({
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      })),
    ),
    activeQuery: { withoutNewIndex: before, withNewIndex: after },
    claimTwoAndExpiry: {
      p50Ms: Math.round(samples[9] * 10) / 10,
      p95Ms: Math.round(samples[18] * 10) / 10,
      maxMs: Math.round(samples[19] * 10) / 10,
    },
    checks: [
      "historical rows retained",
      "unconfirmed failure still occupies a slot",
      "second concurrent claim blocked at two slots",
      "new active index selected by PostgreSQL without planner overrides",
    ],
    limits: [
      "Single local PostgreSQL18; warm synthetic small snapshots; not production SLO or sustained concurrency proof.",
      "Does not measure full operational dashboard aggregation, real model quality, semantic indexing at large scale, online backup or HA.",
    ],
    actualExternalModelCalls: 0,
  };
  const output = resolve(
    process.env.RUNTIME_BENCHMARK_OUTPUT || ".local/runtime-benchmark.json",
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      historicalRuns: 100000,
      baselineMs: before["Execution Time"],
      indexedMs: after["Execution Time"],
      claimTwoAndExpiry: report.claimTwoAndExpiry,
    }),
  );
} finally {
  for (const fn of cleanup.reverse()) await fn();
}
