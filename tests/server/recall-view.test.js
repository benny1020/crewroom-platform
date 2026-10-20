import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, actInWorkspace, completeRun } from "../../server/worker.js";
import {
  reference,
  validReferences,
  documentsByKeys,
} from "../../server/memory.js";

test("013 to 014 keeps complete recall rows, dependency order and stored fingerprints through mixed generations", async (t) => {
  const h = await harness(t),
    user = await h.client("lead@example.com");
  const response = await user.request("POST", "/api/memories", {
    agentId: "chief",
    visibility: "team",
    title: "회귀 원문",
    body: "현재 정책 37분",
    source: "explicit synthetic fixture",
    kind: "fact",
    audience: "agent",
    project: "view-upgrade",
  });
  assert.equal(response.statusCode, 201, response.body);
  const memory = response.json(),
    source = (await documentsByKeys(h.pool, ["memory:" + memory.id])).get(
      "memory:" + memory.id,
    );
  const old = await readFile(
      new URL(
        "../../server/migrations/013_agent_workspace.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    next = await readFile(
      new URL(
        "../../server/migrations/014_recall_source_planning.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    oldView = old.slice(old.indexOf("CREATE OR REPLACE VIEW")),
    nextView = next.slice(next.indexOf("CREATE OR REPLACE VIEW"));
  assert.equal(
    nextView,
    oldView.replace(
      "WITH run_sources AS (",
      "WITH run_sources AS NOT MATERIALIZED (",
    ),
  );
  await h.pool.query(oldView);
  for (let n = 0; n < 3; n++) {
    const task = await newTask(
      user,
      values({
        workType: "chat",
        agentId: "chief",
        project: "view-upgrade",
        title: "합성 업무 " + n,
      }),
    );
    await user.request("POST", `/api/tasks/${task.id}/messages`, {
      body: "원문 메시지 " + n,
    });
    const latest = (await user.request("GET", `/api/tasks/${task.id}`)).json()
      .task;
    assert.equal((await command(user, latest, "start")).statusCode, 200);
    const run = await claimRun(h.pool, "view-upgrade", h.config);
    for (const [path, body] of [
      ["A.md", "계획"],
      ["B.md", "진행"],
    ])
      await actInWorkspace(h.pool, run, "view-upgrade", {
        action: "write_workspace",
        path,
        content: body,
        expectedRevision: 0,
      });
    const reads = (
      await h.pool.query(
        "SELECT * FROM cr_workspace_reads WHERE run_id=$1 ORDER BY document_id",
        [run.id],
      )
    ).rows;
    // Old generations deliberately contain obsolete revisions. DISTINCT ON
    // must keep current-generation refs and preserve their aggregate order.
    for (const row of reads)
      await h.pool.query(
        "INSERT INTO cr_workspace_reads(run_id,generation,document_id,refs) VALUES($1,0,$2,$3)",
        [
          run.id,
          row.document_id,
          JSON.stringify([{ key: "memory:" + memory.id, legacyRevision: 0 }]),
        ],
      );
    await h.pool.query(
      "INSERT INTO cr_memory_reads(run_id,generation,sequence,query,refs) VALUES($1,0,1,'legacy',$2),($1,1,1,'modern',$3)",
      [
        run.id,
        JSON.stringify([
          {
            key: "memory:" + memory.id,
            legacyRevision: source.record_revision,
          },
        ]),
        JSON.stringify([reference(source)]),
      ],
    );
    assert.ok(
      await completeRun(h.pool, run.id, "view-upgrade", run.generation, {
        origin: "fixture",
        result: {
          summary: "결과 " + n,
          evidence: ["근거 1", "근거 2"],
          unknowns: ["미확인"],
          nextActions: ["다음 단계"],
        },
        receipt: {},
      }),
    );
  }
  const before = (
      await h.pool.query("SELECT * FROM cr_recall_documents ORDER BY key")
    ).rows,
    refs = before.map(reference),
    scope = { visibility: "team", department: user.user.department };
  assert.ok(
    before.some((r) => r.kind === "answer" && r.dependencies.length >= 4),
  );
  assert.ok(before.some((r) => r.kind === "episode"));
  assert.ok(before.some((r) => r.kind === "conversation"));
  assert.equal(await validReferences(h.pool, user.user, scope, refs), true);
  await h.pool.query(nextView);
  assert.deepEqual(
    (await h.pool.query("SELECT * FROM cr_recall_documents ORDER BY key")).rows,
    before,
  );
  assert.equal(await validReferences(h.pool, user.user, scope, refs), true);
});
