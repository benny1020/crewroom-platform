// Synthetic, disposable-schema load/quality check. Never selects DATABASE_URL.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { harness, newTask, values, command } from "../tests/server/helpers.js";
import {
  claimRun,
  renewRun,
  completeRun,
  processRun,
  actInWorkspace,
} from "../server/worker.js";
import {
  documentsByKeys,
  reference,
  validReferences,
} from "../server/memory.js";

if (!process.env.BENCHMARK_DATABASE_URL)
  throw Error(
    "BENCHMARK_DATABASE_URL is required; use a disposable test database",
  );
const documents = Number(process.env.WORKSPACE_BENCHMARK_DOCUMENTS || 20000),
  versions = Number(process.env.WORKSPACE_BENCHMARK_VERSIONS || 8),
  historicalRuns = Number(process.env.WORKSPACE_BENCHMARK_RUNS || 100000),
  rounds = Number(process.env.WORKSPACE_BENCHMARK_ROUNDS || 10);
if (
  !Number.isInteger(documents) ||
  documents < 100 ||
  documents > 100000 ||
  !Number.isInteger(versions) ||
  versions < 1 ||
  versions > 32 ||
  !Number.isInteger(historicalRuns) ||
  historicalRuns < 100 ||
  historicalRuns > 200000 ||
  !Number.isInteger(rounds) ||
  rounds < 3 ||
  rounds > 30
)
  throw Error("Invalid bounded workspace corpus size");
process.env.TEST_DATABASE_URL = process.env.BENCHMARK_DATABASE_URL;
const cleanup = [],
  h = await harness({ after: (fn) => cleanup.push(fn) }),
  output = resolve(
    process.env.WORKSPACE_BENCHMARK_OUTPUT || ".local/workspace-benchmark.json",
  ),
  report = {
    synthetic: true,
    release: JSON.parse(
      await readFile(new URL("../package.json", import.meta.url)),
    ).version,
    at: new Date().toISOString(),
    corpus: {
      documents,
      versionsPerArchive: versions,
      historicalRuns,
      currentDocuments: 20,
      currentHistoryPerDocument: 32,
      sourceRefsPerDocument: 20,
      activeReadSetRefs: 420,
      bodyCharacters: 512,
    },
    concurrency: 8,
    rounds,
    measurements: [],
    checks: {},
    completed: false,
    actualExternalModelCalls: 0,
    limits: [
      "One local PostgreSQL18 and Fastify inject API; fixture responses, not model quality or public-network performance.",
      "Short synthetic bodies and bounded read-set; not multi-year uptime, full 64KB bodies, HA or production SLO.",
      "Source/permission/renewal/completion assertions are independent of latency measurements.",
      "Gate wait is included in response latency, not separately instrumented.",
    ],
  };
let phase = "setup";
report.sourceFiles = await Promise.all(
  [
    "scripts/benchmark-workspace.mjs",
    "server/agent-workspace.js",
    "server/app.js",
    "server/db.js",
    "server/tasks.js",
    "server/worker.js",
    "server/memory.js",
    "server/memory-agent.js",
    "server/runner-client.js",
    "server/resources.js",
    "server/checkpoint-context.js",
    "server/migrations/013_agent_workspace.sql",
    "server/migrations/014_recall_source_planning.sql",
  ].map(async (path) => ({
    path,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  })),
);
async function measure(name, fn) {
  phase = "measure:" + name;
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    await fn(i);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p = (fraction) =>
    Math.round(samples[Math.ceil(samples.length * fraction) - 1] * 10) / 10;
  report.measurements.push({
    name,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    maxMs: p(1),
  });
  console.log(JSON.stringify(report.measurements.at(-1)));
}
try {
  const started = performance.now(),
    lead = await h.client("lead@example.com"),
    clients = [];
  for (let i = 0; i < 8; i++)
    clients.push(await h.client(`load-${i}@example.invalid`, true));
  let task = await newTask(
    lead,
    values({ workType: "chat", agentId: "chief", project: "workspace-load" }),
  );
  const queued = await newTask(
    lead,
    values({ workType: "chat", agentId: "ops", project: "workspace-load-ops" }),
  );
  await command(lead, task, "start");
  await command(lead, queued, "start");
  const run = await claimRun(h.pool, "workspace-load", h.config);
  assert.equal(run.task_id, task.id);
  phase = "seed";
  const memoryIds = (
    await h.pool.query(
      `INSERT INTO cr_memories(id,agent_id,owner_id,visibility,department,title,body,source,project)
     SELECT gen_random_uuid(),'chief',$1,'team','development','Reference '||n,'Synthetic source '||n,'explicit synthetic fixture','workspace-load'
     FROM generate_series(1,400)n RETURNING id`,
      [lead.user.id],
    )
  ).rows.map((r) => r.id);
  const sourceMap = await documentsByKeys(
      h.pool,
      memoryIds.map((id) => "memory:" + id),
    ),
    sources = memoryIds.map((id) => reference(sourceMap.get("memory:" + id)));
  const archiveTasks = Math.ceil(documents / 4);
  await h.pool.query(
    `INSERT INTO cr_tasks(id,owner_id,responsible_id,visibility,department,title,project,target,target_version,work_type,goal,done_criteria,brief)
     SELECT gen_random_uuid(),owner_id,responsible_id,'team',department,'Workspace archive '||n,project,'archive','v1','chat','Synthetic archive','review',brief
     FROM cr_tasks CROSS JOIN generate_series(1,$2)n WHERE id=$1`,
    [task.id, archiveTasks],
  );
  await h.pool.query(
    "INSERT INTO cr_steps(task_id,position,name,agent_id,skill_id) SELECT id,0,'archive','chief','conversation' FROM cr_tasks WHERE project='workspace-load' AND id<>$1",
    [task.id],
  );
  await h.pool.query(
    "INSERT INTO cr_runs(id,task_id,step_index,agent_id,requested_by,status,snapshot) SELECT gen_random_uuid(),id,0,'chief',$1,'succeeded','{}' FROM cr_tasks WHERE project='workspace-load' AND id<>$2",
    [lead.user.id, task.id],
  );
  const extraRuns = Math.max(0, historicalRuns - archiveTasks);
  await h.pool.query(
    "INSERT INTO cr_runs(id,task_id,step_index,agent_id,requested_by,status,snapshot) SELECT gen_random_uuid(),$1,0,'chief',$2,'failed','{}' FROM generate_series(1,$3)",
    [task.id, lead.user.id, extraRuns],
  );
  await h.pool.query(
    `INSERT INTO cr_artifacts(id,task_id,step_index,run_id,version,target_version,origin,result,content_hash)
     SELECT gen_random_uuid(),r.task_id,0,r.id,1,'v1','fixture','{"summary":"Synthetic archive","evidence":[],"unknowns":[],"nextActions":[]}','synthetic'
     FROM cr_runs r JOIN cr_tasks t ON t.id=r.task_id WHERE t.project='workspace-load' AND t.id<>$1`,
    [task.id],
  );
  await h.pool.query(
    `INSERT INTO cr_workspace_documents(id,task_id,agent_id,path,revision,target_version)
     SELECT gen_random_uuid(),t.id,'chief','archive-'||n||'.md',$2,'v1' FROM cr_tasks t CROSS JOIN generate_series(1,4)n WHERE t.project='workspace-load' AND t.id<>$1 LIMIT $3`,
    [task.id, versions, documents],
  );
  let cursor = "00000000-0000-0000-0000-000000000000",
    seeded = 0;
  while (seeded < documents) {
    const page = (
      await h.pool.query(
        "SELECT id,task_id,path FROM cr_workspace_documents WHERE id>$1 ORDER BY id LIMIT 500",
        [cursor],
      )
    ).rows;
    await h.pool.query(
      `INSERT INTO cr_workspace_versions(document_id,revision,path,body,archived,source_refs,run_id,generation)
       SELECT w.id,n,w.path,left('Archive '||w.path||' '||repeat('synthetic retained text ',30),512),false,'[]',r.id,1
       FROM cr_workspace_documents w JOIN cr_runs r ON r.task_id=w.task_id AND r.status='succeeded'
       CROSS JOIN generate_series(1,$2)n WHERE w.id=ANY($1::uuid[])`,
      [page.map((r) => r.id), versions],
    );
    seeded += page.length;
    cursor = page.at(-1).id;
  }
  const ownIds = [];
  for (let i = 0; i < 20; i++) {
    const id = randomUUID(),
      refs = sources.slice(i * 20, (i + 1) * 20);
    ownIds.push(id);
    await h.pool.query(
      "INSERT INTO cr_workspace_documents(id,task_id,agent_id,path,revision,target_version) VALUES($1,$2,'chief',$3,32,$4)",
      [id, task.id, `progress-${i}.md`, task.target_version],
    );
    await h.pool.query(
      "INSERT INTO cr_workspace_versions(document_id,revision,path,body,archived,source_refs,run_id,generation) SELECT $1,n,$2,left('CURRENT_WORKSPACE '||repeat('current retained draft ',30),512),false,$3,$4,$5 FROM generate_series(1,32)n",
      [id, `progress-${i}.md`, JSON.stringify(refs), run.id, run.generation],
    );
  }
  const own = await documentsByKeys(
    h.pool,
    ownIds.map((id) => "workspace:" + id),
  );
  for (let i = 0; i < ownIds.length; i++)
    await h.pool.query(
      "INSERT INTO cr_workspace_reads(run_id,generation,document_id,refs) VALUES($1,$2,$3,$4)",
      [
        run.id,
        run.generation,
        ownIds[i],
        JSON.stringify([
          reference(own.get("workspace:" + ownIds[i])),
          ...sources.slice(i * 20, (i + 1) * 20),
        ]),
      ],
    );
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1",
    [run.id],
  );
  await h.pool.query("ANALYZE");
  report.ingestionSeconds =
    Math.round((performance.now() - started) / 100) / 10;
  console.log(
    JSON.stringify({
      seededDocuments: documents + 20,
      ingestionSeconds: report.ingestionSeconds,
    }),
  );
  phase = "measure";
  const read = (client) =>
    client.request("GET", `/api/workspace/documents/${ownIds[0]}`);
  await measure("single_document_with_30_history_sources", async () => {
    const response = await read(clients[0]);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().revision, 32);
    assert.equal(response.json().versions.length, 30);
    assert.ok(response.json().content.startsWith("CURRENT_WORKSPACE"));
  });
  const list = (client) =>
    client.request("GET", `/api/tasks/${task.id}/workspace`);
  await measure("current_task_list_20_versioned_documents", async () => {
    const response = await list(clients[0]);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().items.length, 20);
    assert.ok(response.json().items.every((doc) => ownIds.includes(doc.id)));
  });
  await measure("model_list_bulk_provenance_plus_renew", async () => {
    await h.pool.query(
      "UPDATE cr_runs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1",
      [run.id],
    );
    const [page, renewed] = await Promise.all([
      actInWorkspace(h.pool, run, "workspace-load", {
        action: "list_workspace",
      }),
      renewRun(h.pool, run.id, "workspace-load", run.generation, h.config),
    ]);
    assert.equal(page.items.length, 20);
    assert.equal(renewed, true);
  });
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*)::int AS n FROM cr_workspace_observations WHERE run_id=$1",
        [run.id],
      )
    ).rows[0].n,
    20 * rounds,
  );
  report.checks.modelListsWithProvenance = rounds;
  let other = null,
    renewals = 0;
  await measure("eight_gets_plus_renew_and_claim", async () => {
    // Ingestion itself is not a running-job lease test. Renew before the burst.
    await h.pool.query(
      "UPDATE cr_runs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1",
      [run.id],
    );
    report.checks.renewalsAttempted =
      (report.checks.renewalsAttempted || 0) + 1;
    const outcomes = await Promise.allSettled([
      ...clients.map(read),
      renewRun(h.pool, run.id, "workspace-load", run.generation, h.config),
      claimRun(h.pool, "workspace-load-other", h.config),
    ]);
    report.checks.lastConcurrentStatuses = outcomes
      .slice(0, 8)
      .map((r) =>
        r.status === "fulfilled"
          ? r.value.statusCode
          : r.reason.code || r.reason.name,
      );
    assert.ok(
      outcomes
        .slice(0, 8)
        .every((r) => r.status === "fulfilled" && r.value.statusCode === 200),
    );
    assert.equal(
      outcomes[8].status === "fulfilled" && outcomes[8].value === true,
      true,
      "load must not expire the valid Run lease",
    );
    renewals++;
    assert.equal(outcomes[9].status, "fulfilled");
    other ||= outcomes[9].value;
  });
  report.checks.renewalsSucceeded = renewals;
  await measure("four_gets_four_lists_plus_renew", async () => {
    await h.pool.query(
      "UPDATE cr_runs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1",
      [run.id],
    );
    const results = await Promise.all([
      ...clients.slice(0, 4).map(read),
      ...clients.slice(4).map(list),
      renewRun(h.pool, run.id, "workspace-load", run.generation, h.config),
    ]);
    assert.ok(results.slice(0, 8).every((r) => r.statusCode === 200));
    assert.equal(results[8], true);
  });
  report.checks.mixedRenewalsSucceeded = rounds;
  assert.ok(other);
  const completed = await completeRun(
    h.pool,
    run.id,
    "workspace-load",
    run.generation,
    {
      origin: "fixture",
      result: {
        summary: "Synthetic workflow with retained sources",
        evidence: [],
        unknowns: ["No actual inference"],
        nextActions: [],
      },
      receipt: {},
    },
  );
  assert.ok(completed);
  // Other's lease may have aged while the measurement deliberately kept its slot.
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1",
    [other.id],
  );
  await processRun(h.pool, other, "workspace-load-other", h.config);
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*)::int AS n FROM cr_runs WHERE id=ANY($1::uuid[]) AND status='succeeded'",
        [[run.id, other.id]],
      )
    ).rows[0].n,
    2,
  );
  report.checks.workflowCompletions = 2;
  phase = "source-revocation";
  await h.pool.query(
    "UPDATE cr_memories SET body='CORRECTED_SOURCE',revision=revision+1 WHERE id=$1",
    [memoryIds[0]],
  );
  const invalid = await read(clients[0]);
  assert.equal(invalid.statusCode, 404);
  assert.ok(!invalid.body.includes("CURRENT_WORKSPACE"));
  const listing = await clients[0].request(
    "GET",
    `/api/tasks/${task.id}/workspace`,
  );
  assert.equal(listing.statusCode, 200);
  assert.ok(!listing.json().items.some((d) => d.id === ownIds[0]));
  const artifact = (
    await documentsByKeys(h.pool, [`artifact:${completed.id}:summary:1`])
  )
    .values()
    .next().value;
  assert.ok(artifact);
  assert.equal(
    await validReferences(h.pool, lead.user, task, artifact.dependencies),
    false,
  );
  report.checks.revokedSourceHidden = true;
  report.checks.derivedResultRevoked = true;
  report.checks.historyRetained =
    (
      await h.pool.query(
        "SELECT count(*)::int AS n FROM cr_workspace_versions WHERE document_id=$1",
        [ownIds[0]],
      )
    ).rows[0].n === 32;
  report.schemaBytes = (
    await h.pool.query(
      "SELECT sum(pg_total_relation_size(c.oid))::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'",
    )
  ).rows[0].bytes;
  report.completed = true;
} catch (error) {
  report.failure = {
    phase,
    code: error.code || error.name,
    actual:
      typeof error.actual === "number" || typeof error.actual === "boolean"
        ? error.actual
        : undefined,
    expected:
      typeof error.expected === "number" || typeof error.expected === "boolean"
        ? error.expected
        : undefined,
  };
  console.error(JSON.stringify({ failure: report.failure }));
  process.exitCode = 1;
} finally {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  for (const fn of cleanup.reverse()) await fn();
  console.log(
    JSON.stringify({
      completed: report.completed,
      report: output,
      checks: report.checks,
    }),
  );
}
