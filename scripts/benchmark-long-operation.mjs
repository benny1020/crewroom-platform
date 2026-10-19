// Explicitly isolated synthetic scale test. Never uses DATABASE_URL.
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { harness, newTask, values } from "../tests/server/helpers.js";
import { taskDetail } from "../server/tasks.js";
import { taskArchive, historyPage } from "../server/history.js";
import { searchMemory } from "../server/memory.js";
if (!process.env.BENCHMARK_DATABASE_URL)
  throw Error(
    "BENCHMARK_DATABASE_URL required; use a disposable development database",
  );
process.env.TEST_DATABASE_URL = process.env.BENCHMARK_DATABASE_URL;
const cleanup = [],
  h = await harness({ after: (fn) => cleanup.push(fn) });
try {
  const lead = await h.client("lead@example.com");
  const task = await newTask(
    lead,
    values({ workType: "chat", agentId: "review", project: "scale-fixture" }),
  );
  const messages = Number(process.env.BENCHMARK_MESSAGES || 1000000),
    tasks = Number(process.env.BENCHMARK_TASKS || 100000);
  if (
    !Number.isSafeInteger(messages) ||
    messages < 1000 ||
    messages > 2000000 ||
    !Number.isSafeInteger(tasks) ||
    tasks < 100 ||
    tasks > 200000
  )
    throw Error("Invalid corpus sizes");
  const start = performance.now();
  await h.pool.query(
    `INSERT INTO cr_tasks(id,owner_id,responsible_id,visibility,department,title,project,target,target_version,work_type,goal,done_criteria,brief)
 SELECT gen_random_uuid(),owner_id,responsible_id,'team',department,'Archive task '||n,'scale-fixture','target '||n,'v1','chat','synthetic archive','review',brief FROM cr_tasks CROSS JOIN generate_series(1,$2)n WHERE id=$1`,
    [task.id, tasks],
  );
  await h.pool.query(
    `INSERT INTO cr_steps(task_id,position,name,agent_id,skill_id) SELECT id,0,'review','review','conversation' FROM cr_tasks WHERE id<>$1`,
    [task.id],
  );
  for (let offset = 0; offset < messages; offset += 10000) {
    await h.pool.query(
      `INSERT INTO cr_messages(task_id,user_id,body,target_version,created_at) SELECT $1,$2,
   CASE WHEN n=1 THEN 'ANCIENT_1875 initial receipt preserved 한글원문합의 유효기간은 37일' ELSE 'ordinary operational conversation number '||n||' release verification source retained.' END,
   'v1','2020-01-01'::timestamptz+n*interval '1 second' FROM generate_series($3::int,$4::int)n`,
      [task.id, lead.user.id, offset + 1, Math.min(messages, offset + 10000)],
    );
    if (offset % 100000 === 0)
      console.log(
        JSON.stringify({
          inserted: Math.min(messages, offset + 10000),
          elapsedSeconds: Math.round((performance.now() - start) / 1000),
        }),
      );
  }
  await h.pool.query("ANALYZE");
  const report = {
    synthetic: true,
    release: "0.11.0",
    node: process.version,
    tasks: tasks + 1,
    messages,
    ingestionSeconds: Math.round((performance.now() - start) / 100) / 10,
    measurements: [],
  };
  for (const [name, fn] of [
    ["detail_recent", () => taskDetail(h.pool, lead.user, task.id)],
    ["archive_recent", () => taskArchive(h.pool, lead.user, {})],
    ["messages_recent", () => historyPage(h.pool, task.id, "messages")],
    [
      "old_message_search",
      () => historyPage(h.pool, task.id, "messages", { q: "ANCIENT_1875" }),
    ],
    [
      "recent_memory_archive",
      () => searchMemory(h.pool, lead.user, task, { query: "" }),
    ],
    [
      "korean_memory_search",
      () => searchMemory(h.pool, lead.user, task, { query: "유효기간" }),
    ],
    [
      "concurrent_detail_8",
      () =>
        Promise.all(
          Array.from({ length: 8 }, () =>
            taskDetail(h.pool, lead.user, task.id),
          ),
        ),
    ],
    [
      "old_memory_search",
      () => searchMemory(h.pool, lead.user, task, { query: "ANCIENT_1875" }),
    ],
  ]) {
    const samples = [];
    let bytes = 0,
      count = 0;
    for (let i = 0; i < 10; i++) {
      const t = performance.now(),
        v = await fn();
      samples.push(performance.now() - t);
      bytes = Buffer.byteLength(JSON.stringify(v));
      count = (v.items || v.messages || v.tasks || v).length;
    }
    samples.sort((a, b) => a - b);
    report.measurements.push({
      name,
      p50Ms: Math.round(samples[4] * 10) / 10,
      p95Ms: Math.round(samples[9] * 10) / 10,
      responseBytes: bytes,
      items: count,
    });
    console.log(JSON.stringify(report.measurements.at(-1)));
  }
  report.schemaBytes = (
    await h.pool.query(
      "SELECT sum(pg_total_relation_size(c.oid))::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'",
    )
  ).rows[0].bytes;
  report.limits = [
    "Single local PostgreSQL, warm sequential requests; not production SLO or concurrent multi-year proof.",
    "Synthetic short text; no actual inference, embeddings or large artifact payloads.",
    "Corpus inserted through synchronous index triggers; originals kept.",
  ];
  report.sourceFiles = await Promise.all(
    [
      "server/tasks.js",
      "server/history.js",
      "server/recall-index.js",
      "server/memory.js",
      "server/migrations/009_long_operation.sql",
      "server/migrations/010_recall_index.sql",
    ].map(async (file) => ({
      file,
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    })),
  );
  report.at = new Date().toISOString();
  const path =
    process.env.BENCHMARK_REPORT || ".local/longevity-20261019/scale.json";
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log("Report written: " + path);
} finally {
  for (const fn of cleanup.reverse()) await fn();
}
