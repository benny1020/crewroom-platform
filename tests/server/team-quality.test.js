import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, processRun, actInWorkspace } from "../../server/worker.js";
import { confirmStopped } from "../../server/recovery.js";

const detail = async (client, task) =>
  (await client.request("GET", `/api/tasks/${task.id}`)).json().task;

async function document(h, task, runId, id, path, body) {
  await h.pool.query(
    "INSERT INTO cr_workspace_documents(id,task_id,agent_id,path,revision,target_version) VALUES($1,$2,'chief',$3,1,$4)",
    [id, task.id, path, task.target_version],
  );
  await h.pool.query(
    "INSERT INTO cr_workspace_versions(document_id,revision,path,body,archived,source_refs,run_id,generation) VALUES($1,1,$2,$3,false,'[]',$4,1)",
    [id, path, body, runId],
  );
}

test("current-task workspace remains discoverable after 400 earlier project documents; explicit project search keeps ACL", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  let current = await newTask(
    lead,
    values({ workType: "chat", agentId: "chief", project: "workspace-scale" }),
  );
  await command(lead, current, "start");
  const run = await claimRun(h.pool, "task-workspace", h.config);
  for (let group = 0; group < 4; group++) {
    const foreign = await newTask(
        lead,
        values({
          workType: "chat",
          agentId: "chief",
          project: current.project,
        }),
      ),
      runId = randomUUID();
    await h.pool.query(
      "INSERT INTO cr_runs(id,task_id,step_index,agent_id,requested_by,status,snapshot) VALUES($1,$2,0,'chief',$3,'failed','{}')",
      [runId, foreign.id, lead.user.id],
    );
    for (let i = 1; i <= 100; i++) {
      const n = group * 100 + i;
      await document(
        h,
        foreign,
        runId,
        `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`,
        `archive-${n}.md`,
        "Other task draft " + n,
      );
    }
  }
  const ownId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await document(
    h,
    current,
    run.id,
    ownId,
    "notes/plan.md",
    "OWN_CURRENT_PLAN",
  );
  const privateTask = await newTask(
      member,
      values({
        workType: "chat",
        agentId: "chief",
        project: current.project,
        visibility: "private",
      }),
    ),
    privateRun = randomUUID();
  await h.pool.query(
    "INSERT INTO cr_runs(id,task_id,step_index,agent_id,requested_by,status,snapshot) VALUES($1,$2,0,'chief',$3,'failed','{}')",
    [privateRun, privateTask.id, member.user.id],
  );
  await document(
    h,
    privateTask,
    privateRun,
    "00000000-0000-4000-8000-000000000000",
    "PRIVATE_FILENAME.md",
    "PRIVATE_WORKSPACE_BODY",
  );
  const act = (action) => actInWorkspace(h.pool, run, "task-workspace", action);
  const first = await act({ action: "list_workspace" });
  assert.deepEqual(
    first.items.map((d) => d.id),
    [ownId],
  );
  assert.equal(first.nextCursor, null);
  const read = await act({ action: "read_workspace", id: ownId });
  assert.equal(read.content, "OWN_CURRENT_PLAN");
  assert.equal(
    (
      await act({
        action: "write_workspace",
        path: read.path,
        content: read.content + "\nCONTINUED_FROM_CURRENT_PLAN",
        expectedRevision: read.revision,
      })
    ).revision,
    2,
  );
  const project = await act({ action: "list_workspace", scope: "project" });
  assert.equal(project.items.length, 20);
  assert.ok(project.items.every((d) => d.task_id !== privateTask.id));
  assert.ok(!JSON.stringify(project).includes("PRIVATE_"));
  const outside = await act({
    action: "list_workspace",
    scope: "project",
    query: "archive-400",
  });
  assert.equal(outside.items.length, 1);
  current = await detail(lead, current);
  assert.equal(current.status, "running");
});

test("queued responsibility transfer creates a fresh request instead of retaining a deactivated requester's snapshot", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  let task = await newTask(
    lead,
    values({ workType: "chat", agentId: "chief" }),
  );
  task = (await command(lead, task, "start")).json().task;
  const oldId = task.current_run_id;
  task = (
    await command(lead, task, "assign", { responsibleId: member.user.id })
  ).json().task;
  await h.pool.query("UPDATE cr_members SET active=false WHERE id=$1", [
    lead.user.id,
  ]);
  const started = await command(member, task, "start");
  assert.equal(started.statusCode, 200, started.body);
  const run = await claimRun(h.pool, "handoff-queued", h.config);
  assert.ok(run);
  assert.notEqual(run.id, oldId);
  assert.equal(run.requested_by, member.user.id);
  await processRun(h.pool, run, "handoff-queued", h.config);
  task = await detail(member, task);
  assert.equal(task.status, "result_ready");
  assert.equal(task.artifacts.length, 1);
  assert.equal((await command(member, task, "accept")).statusCode, 200);
  assert.equal(
    (await h.pool.query("SELECT status FROM cr_runs WHERE id=$1", [oldId]))
      .rows[0].status,
    "cancelled",
  );
});

test("confirmed paused handoff refreshes the requesting user and instructions; an unconfirmed stop cannot transfer", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  let task = await newTask(
    lead,
    values({ workType: "chat", agentId: "chief" }),
  );
  await command(lead, task, "start");
  const old = await claimRun(h.pool, "handoff-paused", h.config);
  task = await detail(lead, task);
  task = (await command(lead, task, "pause")).json().task;
  const pending = await command(lead, task, "assign", {
    responsibleId: member.user.id,
  });
  assert.equal(pending.statusCode, 409);
  assert.equal(pending.json().code, "STOP_CONFIRMATION_REQUIRED");
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [old.id],
  );
  await confirmStopped(
    h.pool,
    old.id,
    "Synthetic operator confirmed that no execution is left running",
  );
  task = await detail(lead, task);
  task = (
    await command(lead, task, "assign", { responsibleId: member.user.id })
  ).json().task;
  await h.pool.query(
    "UPDATE cr_agents SET instructions='FRESH_HANDOFF_INSTRUCTIONS',config_version=config_version+1 WHERE id='chief'",
  );
  await h.pool.query("UPDATE cr_members SET active=false WHERE id=$1", [
    lead.user.id,
  ]);
  assert.equal((await command(member, task, "start")).statusCode, 200);
  const run = await claimRun(h.pool, "handoff-new", h.config);
  assert.ok(run);
  assert.notEqual(run.id, old.id);
  assert.equal(run.requested_by, member.user.id);
  assert.equal(run.snapshot.agent.instructions, "FRESH_HANDOFF_INSTRUCTIONS");
  await processRun(h.pool, run, "handoff-new", h.config);
  assert.equal((await detail(member, task)).status, "result_ready");
});

test("parallel workers drain shared queues without duplicate results or exceeding global/per-agent capacity", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const agents = ["chief", "research", "review", "dev", "ops", "qa"],
    tasks = [];
  for (let i = 0; i < 24; i++)
    tasks.push(
      await newTask(
        lead,
        values({
          workType: "chat",
          agentId: agents[i % agents.length],
          project: "concurrent-queue",
        }),
      ),
    );
  const starts = await Promise.all(
    tasks.map((task) => command(lead, task, "start")),
  );
  assert.ok(starts.every((r) => r.statusCode === 200));
  const seen = new Set();
  for (
    let batch = 0;
    seen.size < tasks.length && batch < tasks.length;
    batch++
  ) {
    const availableAgents = Number(
      (
        await h.pool.query(
          "SELECT count(DISTINCT agent_id) AS n FROM cr_runs WHERE status='queued'",
        )
      ).rows[0].n,
    );
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        claimRun(h.pool, `parallel-${batch}-${i}`, h.config),
      ),
    );
    const claimed = outcomes
      .map((run, i) => ({ run, owner: `parallel-${batch}-${i}` }))
      .filter((x) => x.run);
    // Concurrent submissions do not promise balanced FIFO ordering. The tail
    // may contain only one agent, whose per-agent cap must still be respected.
    const expected = Math.min(2, availableAgents);
    assert.ok(expected > 0);
    assert.equal(claimed.length, expected);
    assert.equal(new Set(claimed.map((x) => x.run.agent_id)).size, expected);
    for (const { run } of claimed) {
      assert.ok(!seen.has(run.id));
      seen.add(run.id);
    }
    await Promise.all(
      claimed.map(({ run, owner }) => processRun(h.pool, run, owner, h.config)),
    );
  }
  assert.equal(seen.size, 24);
  assert.equal(await claimRun(h.pool, "drained", h.config), null);
  const rows = (
    await h.pool.query(
      "SELECT t.status,count(a.id)::int AS artifacts FROM cr_tasks t LEFT JOIN cr_artifacts a ON a.task_id=t.id GROUP BY t.id",
    )
  ).rows;
  assert.equal(rows.length, 24);
  assert.ok(
    rows.every((r) => r.status === "result_ready" && r.artifacts === 1),
  );
});

test("simultaneous workspace response-loss retries and competing revisions keep one committed result", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead, values({ workType: "chat", agentId: "chief" }));
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "workspace-cas", h.config),
    action = {
      action: "write_workspace",
      path: "progress.md",
      content: "Initial checkpoint",
      expectedRevision: 0,
    };
  const retries = await Promise.all(
    Array.from({ length: 12 }, () =>
      actInWorkspace(h.pool, run, "workspace-cas", action, "lost-response"),
    ),
  );
  assert.ok(retries.every((r) => r.id === retries[0].id && r.revision === 1));
  const competing = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      actInWorkspace(
        h.pool,
        run,
        "workspace-cas",
        {
          ...action,
          content: `Revision from request ${i}`,
          expectedRevision: 1,
        },
        `revision-${i}`,
      ),
    ),
  );
  assert.equal(competing.filter((x) => x.status === "fulfilled").length, 1);
  assert.ok(
    competing
      .filter((x) => x.status === "rejected")
      .every((x) => x.reason.code === "WORKSPACE_CONFLICT"),
  );
  assert.equal(
    (await h.pool.query("SELECT count(*)::int AS n FROM cr_workspace_versions"))
      .rows[0].n,
    2,
  );
  assert.equal(
    (
      await h.pool.query(
        "SELECT count(*)::int AS n FROM cr_workspace_operations",
      )
    ).rows[0].n,
    2,
  );
});
