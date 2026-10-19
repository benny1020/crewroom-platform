import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values, command } from "./helpers.js";
import { randomUUID } from "node:crypto";

test("long conversations page without gaps, bind cursors to task and query, and recheck access", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const task = await newTask(
    lead,
    values({ workType: "chat", agentId: "review" }),
  );
  await h.pool.query(
    "INSERT INTO cr_messages(task_id,user_id,body,target_version,created_at) SELECT $1,$2,'old-marker '||n,$3,'2026-01-01 01:01:01.123456+00'::timestamptz FROM generate_series(1,1007)n",
    [task.id, lead.user.id, task.target_version],
  );
  const initial = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal(initial.messages.length, 40);
  assert.equal(initial.history.messages.hasMore, true);
  const original = initial.history.messages.nextCursor;
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "new-after-first-page",
  });
  let cursor = original,
    all = [...initial.messages];
  while (cursor) {
    const response = await lead.request(
      "GET",
      `/api/tasks/${task.id}/history/messages?cursor=${cursor}`,
    );
    assert.equal(response.statusCode, 200);
    const page = response.json();
    assert.ok(page.items.length <= 40);
    all.push(...page.items);
    cursor = page.nextCursor;
  }
  assert.equal(all.length, 1007);
  assert.equal(new Set(all.map((x) => x.id)).size, 1007);
  assert.ok(!all.some((x) => x.body === "new-after-first-page"));
  let r = await lead.request(
    "GET",
    `/api/tasks/${task.id}/history/messages?q=old-marker&cursor=${original}`,
  );
  assert.equal(r.statusCode, 400);
  r = await lead.request(
    "GET",
    `/api/tasks/${task.id}/history/messages?q=${encodeURIComponent("old-marker 1")}`,
  );
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().items.every((x) => x.body.includes("old-marker 1")));
  const second = await newTask(lead, values());
  assert.equal(
    (
      await lead.request(
        "GET",
        `/api/tasks/${second.id}/history/messages?cursor=${original}`,
      )
    ).statusCode,
    400,
  );
  await h.pool.query("UPDATE cr_tasks SET visibility='private' WHERE id=$1", [
    task.id,
  ]);
  assert.equal(
    (
      await member.request(
        "GET",
        `/api/tasks/${task.id}/history/messages?cursor=${original}`,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await lead.request(
        "GET",
        `/api/tasks/${task.id}/history/messages?cursor=not-valid`,
      )
    ).statusCode,
    400,
  );
});

test("UUID history preserves microsecond positions, current references and safe metadata outside the latest page", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead, values({ workType: "chat", agentId: "review" }));
  const snapshot = {
    agent: { id: "review", name: "review", configVersion: 1 },
    skill: { id: "conversation", name: "chat", version: 1 },
    questionRevision: 0,
    messages: [{ body: "PRIVATE_SNAPSHOT_MUST_NOT_LEAK" }],
    execution: { mode: "edit", checkpoint: { patch: "PRIVATE_PATCH" } },
  };
  await h.pool.query(
    "INSERT INTO cr_runs(id,task_id,step_index,agent_id,requested_by,status,snapshot,created_at) SELECT gen_random_uuid(),$1,0,'review',$2,'succeeded',$3::jsonb,'2026-01-01 01:01:01.123456+00'::timestamptz FROM generate_series(1,93)",
    [task.id, lead.user.id, JSON.stringify(snapshot)],
  );
  const runs = (
    await h.pool.query(
      "SELECT id FROM cr_runs WHERE task_id=$1 ORDER BY created_at,id",
      [task.id],
    )
  ).rows;
  for (let i = 0; i < runs.length; i++)
    await h.pool.query(
      "INSERT INTO cr_artifacts(id,task_id,step_index,run_id,version,target_version,origin,result,content_hash,created_at) VALUES($1,$2,0,$3,$4,$5,'fixture',$6,'synthetic','2026-01-01 01:01:01.123456+00')",
      [
        randomUUID(),
        task.id,
        runs[i].id,
        i + 1,
        task.target_version,
        JSON.stringify({
          summary: "result " + i,
          evidence: [],
          unknowns: [],
          nextActions: [],
        }),
      ],
    );
  const pinned = (
    await h.pool.query(
      "SELECT * FROM cr_artifacts WHERE task_id=$1 ORDER BY created_at,id LIMIT 2",
      [task.id],
    )
  ).rows;
  await h.pool.query("UPDATE cr_tasks SET current_run_id=$2 WHERE id=$1", [
    task.id,
    pinned[0].run_id,
  ]);
  await h.pool.query(
    "UPDATE cr_steps SET current_artifact_id=$2,input_artifact_id=$3 WHERE task_id=$1",
    [task.id, pinned[0].id, pinned[1].id],
  );
  const r = await lead.request("GET", `/api/tasks/${task.id}`);
  assert.equal(r.statusCode, 200);
  const detail = r.json().task;
  assert.ok(detail.artifacts.some((x) => x.id === pinned[0].id));
  assert.ok(detail.artifacts.some((x) => x.id === pinned[1].id));
  assert.ok(detail.runs.some((x) => x.id === pinned[0].run_id));
  assert.ok(detail.runs.length <= 15);
  assert.ok(detail.artifacts.length <= 11);
  assert.doesNotMatch(r.body, /PRIVATE_SNAPSHOT|PRIVATE_PATCH/);
  let cursor = "",
    ids = [];
  do {
    const p = (
      await lead.request(
        "GET",
        `/api/tasks/${task.id}/history/runs${cursor ? "?cursor=" + cursor : ""}`,
      )
    ).json();
    assert.ok(p.items.length <= 12);
    ids.push(...p.items.map((x) => x.id));
    cursor = p.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 93);
  assert.equal(new Set(ids).size, 93);
});

test("brief correction history is normalized, retained and paged instead of growing the Task row", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  let task = await newTask(lead, values());
  for (let i = 0; i < 85; i++)
    task = (
      await command(lead, task, "brief", {
        text: "summary " + i,
        reason: "correction " + i,
        source: "request",
      })
    ).json().task;
  const stored = (
    await h.pool.query("SELECT brief_history FROM cr_tasks WHERE id=$1", [
      task.id,
    ])
  ).rows[0];
  assert.deepEqual(stored.brief_history, []);
  const d = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
  assert.ok(d.brief_history.length <= 12);
  assert.equal(d.brief_history.at(-1).text, "summary 83");
  assert.ok(d.history.briefs.hasMore);
  let count = d.brief_history.length,
    cursor = d.history.briefs.nextCursor;
  while (cursor) {
    const p = (
      await lead.request(
        "GET",
        `/api/tasks/${task.id}/history/briefs?cursor=${cursor}`,
      )
    ).json();
    count += p.items.length;
    cursor = p.nextCursor;
  }
  assert.ok(count >= 85);
});

test("task archive navigates past the office window, keeps scope and filters before pagination", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const original = await newTask(lead, values());
  await h.pool.query(
    "INSERT INTO cr_tasks(id,title,work_type,owner_id,responsible_id,visibility,department,project,target,target_version,goal,done_criteria,brief) SELECT gen_random_uuid(),'old archive '||n,'review',$1,$1,CASE WHEN n%2=0 THEN 'private' ELSE 'team' END,'development','archive-project','archive target','v1','goal','done','{}'::jsonb FROM generate_series(1,230)n",
    [lead.user.id],
  );
  await h.pool.query(
    "INSERT INTO cr_steps(task_id,position,name,agent_id,skill_id) SELECT id,0,'review','review','review' FROM cr_tasks WHERE id<>$1",
    [original.id],
  );
  let cursor = "",
    items = [];
  do {
    const p = (
      await member.request(
        "GET",
        `/api/tasks?q=old%20archive${cursor ? "&cursor=" + cursor : ""}`,
      )
    ).json();
    assert.ok(p.tasks.length <= 40);
    items.push(...p.tasks);
    cursor = p.nextCursor;
  } while (cursor);
  assert.equal(items.length, 115);
  assert.ok(items.every((x) => x.visibility === "team"));
  assert.equal(new Set(items.map((x) => x.id)).size, 115);
  const first = (
    await lead.request("GET", "/api/tasks?q=old%20archive")
  ).json();
  assert.ok(first.hasMore);
  assert.equal(
    (
      await lead.request(
        "GET",
        `/api/tasks?q=different&cursor=${first.nextCursor}`,
      )
    ).statusCode,
    400,
  );
});
