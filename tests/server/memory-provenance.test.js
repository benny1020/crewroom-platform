import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, recallForRun } from "../../server/worker.js";
import {
  searchMemory,
  documentsByKeys,
  validReferences,
  contextFromDocuments,
} from "../../server/memory.js";
import { migrate } from "../../server/db.js";
const body = "Retention policy lasts thirty five days.";
const note = async (c, extra = {}) => {
  const r = await c.request("POST", "/api/memories", {
    agentId: "review",
    visibility: "team",
    project: "audit",
    audience: "project",
    title: "Retention policy",
    body,
    source: "Team decision",
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id;
};
async function runFor(h, c, agentId = "review") {
  const task = await newTask(
    c,
    values({ workType: "chat", agentId, project: "audit" }),
  );
  assert.equal((await command(c, task, "start")).statusCode, 200);
  const run = await claimRun(h.pool, "provenance", h.config);
  assert.ok(run);
  return { task, run };
}
const proposal = (h, run, key, extra = {}) =>
  recallForRun(h.pool, run, "provenance", {
    action: "propose_memory",
    key,
    quote: body,
    title: "Reviewed retention",
    body,
    kind: "decision",
    audience: "project",
    ...extra,
  });
async function accept(c, p) {
  const r = await c.request("POST", `/api/memory/proposals/${p.proposalId}`, {
    action: "accept",
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().memoryId;
}
const find = (h, c) =>
  searchMemory(
    h.pool,
    { ...c.user, active: true },
    { visibility: "team", department: c.user.department },
    { query: "Retention", agentId: "qa", project: "audit" },
  );

for (const mutation of ["correct", "delete"]) {
  test(`promoted evidence follows source ${mutation}, including downstream contexts`, async (t) => {
    const h = await harness(t),
      c = await h.client("lead@example.com");
    const source = await note(c),
      { run, task } = await runFor(h, c);
    const id = await accept(c, await proposal(h, run, `memory:${source}`));
    const doc = (await documentsByKeys(h.pool, [`memory:${id}`])).get(
      `memory:${id}`,
    );
    assert.ok(doc.dependencies.some((r) => r.key === `memory:${source}`));
    const pinned = contextFromDocuments([doc]);
    assert.ok((await find(h, c)).some((d) => d.key === `memory:${id}`));
    const changed = await c.request(
      mutation === "correct" ? "PATCH" : "DELETE",
      `/api/memories/${source}`,
      mutation === "correct"
        ? {
            revision: 1,
            title: "Retention policy",
            body: "Retention policy lasts sixty days.",
            reason: "New evidence",
          }
        : { revision: 1 },
    );
    assert.equal(changed.statusCode, 200, changed.body);
    assert.ok(!(await find(h, c)).some((d) => d.key === `memory:${id}`));
    assert.equal(
      await validReferences(
        h.pool,
        { ...c.user, active: true },
        task,
        pinned.refs,
      ),
      false,
    );
    const list = (await c.request("GET", "/api/memories")).json().memories;
    assert.equal(list.find((m) => m.id === id).unavailable, true);
    assert.ok(!JSON.stringify(list.find((m) => m.id === id)).includes(body));
    // An explicit correction creates human-reviewed authority, retaining audit but
    // hiding the revoked earlier text from management history.
    const fixed = await c.request("PATCH", `/api/memories/${id}`, {
      revision: 1,
      title: "Reviewed retention",
      body: "Retention policy lasts sixty days.",
      reason: "Reviewed current decision",
    });
    assert.equal(fixed.statusCode, 200, fixed.body);
    assert.ok((await find(h, c)).some((d) => d.key === `memory:${id}`));
    const corrected = (await c.request("GET", "/api/memories"))
      .json()
      .memories.find((m) => m.id === id);
    assert.ok(!JSON.stringify(corrected).includes(body));
    const audit = (
      await h.pool.query(
        "SELECT history,source_refs FROM cr_memories WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(audit.history[0].provenanceDetached, true);
    assert.ok(audit.history[0].sourceRefs.length > 0);
    assert.deepEqual(audit.source_refs, []);
  });
}
test("cross-workroom evidence retains origin and follows ACL loss through a derived memory", async (t) => {
  const h = await harness(t),
    c = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  const origin = await newTask(
    c,
    values({ workType: "chat", agentId: "review", project: "source-project" }),
  );
  await c.request("POST", `/api/tasks/${origin.id}/messages`, { body });
  const key =
    "message:" +
    (
      await h.pool.query("SELECT id FROM cr_messages WHERE task_id=$1", [
        origin.id,
      ])
    ).rows[0].id;
  const { run, task } = await runFor(h, c);
  const first = await accept(c, await proposal(h, run, key));
  const second = await note(c, {
    sourceKey: `memory:${first}`,
    title: "Further derived retention",
  });
  const stored = (
    await h.pool.query("SELECT * FROM cr_memories WHERE id=$1", [first])
  ).rows[0];
  assert.equal(stored.source_task_id, task.id);
  assert.equal(stored.origin_task_id, origin.id);
  assert.equal(stored.project, "audit");
  assert.ok((await find(h, member)).some((d) => d.key === `memory:${second}`));
  await h.pool.query("UPDATE cr_tasks SET visibility='private' WHERE id=$1", [
    origin.id,
  ]);
  assert.ok(
    !(await find(h, member)).some((d) =>
      [first, second].some((id) => d.key === `memory:${id}`),
    ),
  );
  for (const id of [first, second]) {
    const list = (await member.request("GET", "/api/memories")).json().memories;
    assert.equal(list.find((m) => m.id === id).unavailable, true);
    assert.ok(!JSON.stringify(list.find((m) => m.id === id)).includes(body));
  }
});
for (const interval of [
  { validFrom: "2020-01-01T00:00:00Z", validTo: "2021-01-01T00:00:00Z" },
  { validFrom: "2099-01-01T00:00:00Z" },
]) {
  test(`historical reads cannot promote an ineffective decision ${JSON.stringify(interval)}`, async (t) => {
    const h = await harness(t),
      c = await h.client("lead@example.com"),
      id = await note(c, interval),
      { run } = await runFor(h, c);
    const read = await recallForRun(h.pool, run, "provenance", {
      action: "read_memory",
      key: `memory:${id}`,
    });
    assert.equal(read.items.length, 1);
    await assert.rejects(
      proposal(h, run, `memory:${id}`),
      (e) => e.code === "MEMORY_PROOF_REQUIRED",
    );
  });
}
test("proposal inherits validity and cannot be accepted after expiry", async (t) => {
  const h = await harness(t),
    c = await h.client("lead@example.com"),
    end = new Date(Date.now() + 2400).toISOString();
  const id = await note(c, { validFrom: "2020-01-01T00:00:00Z", validTo: end }),
    { run } = await runFor(h, c);
  const p = await proposal(h, run, `memory:${id}`);
  const candidate = (await c.request("GET", "/api/memory/proposals")).json()
    .items[0];
  assert.equal(candidate.valid_to, end);
  const saved = await accept(c, p);
  const doc = (await documentsByKeys(h.pool, [`memory:${saved}`])).get(
    `memory:${saved}`,
  );
  assert.equal(doc.valid_to.toISOString(), end);
  const pending = await proposal(h, run, `memory:${id}`, {
    title: "Another pending proposal",
  });
  await delay(Math.max(1, +new Date(end) - Date.now() + 30));
  const late = await c.request(
    "POST",
    `/api/memory/proposals/${pending.proposalId}`,
    { action: "accept" },
  );
  assert.equal(late.statusCode, 409, late.body);
  assert.ok(!(await find(h, c)).some((d) => d.key === `memory:${saved}`));
  const list = (await c.request("GET", "/api/memory/proposals")).json().items;
  assert.equal(list[0].unavailable, true);
});
test("proposal and read enforce the same agent-only boundary", async (t) => {
  const h = await harness(t),
    c = await h.client("lead@example.com"),
    id = await note(c, { agentId: "qa", audience: "agent" }),
    { run } = await runFor(h, c);
  assert.equal(
    (
      await recallForRun(h.pool, run, "provenance", {
        action: "read_memory",
        key: `memory:${id}`,
      })
    ).items.length,
    0,
  );
  await assert.rejects(
    proposal(h, run, `memory:${id}`),
    (e) => e.code === "MEMORY_PROOF_REQUIRED",
  );
});
test("decision chain deletion is rejected without silently reopening or losing a policy", async (t) => {
  const h = await harness(t),
    c = await h.client("lead@example.com");
  const first = await note(c, { validFrom: "2020-01-01T00:00:00Z" });
  const next = await note(c, {
    supersedesId: first,
    validFrom: "2021-01-01T00:00:00Z",
    body: "Retention policy lasts sixty days.",
  });
  for (const id of [first, next]) {
    const res = await c.request("DELETE", `/api/memories/${id}`, {
      revision: 1,
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, "MEMORY_DECISION_CHAIN");
  }
  assert.ok((await find(h, c)).some((d) => d.key === `memory:${next}`));
});
test("007 recovers captured evidence and quarantines legacy links with no revision proof", async (t) => {
  const h = await harness(t),
    c = await h.client("lead@example.com");
  const source = await note(c),
    { run } = await runFor(h, c),
    saved = await accept(c, await proposal(h, run, `memory:${source}`));
  // A legacy pin/rename was revision 2 but never changed the fact itself.
  const pinned = await c.request("PATCH", `/api/memories/${saved}`, {
    revision: 1,
    title: "Pinned retention",
    body,
    pinned: true,
    reason: "Pin evidence",
  });
  assert.equal(pinned.statusCode, 200, pinned.body);
  // Pre-007 history had no provenance fields, including metadata-only edits.
  await h.pool.query(
    "UPDATE cr_memories SET history=history #- '{0,sourceRefs}' WHERE id=$1",
    [saved],
  );
  const unverified = await note(c, {
    sourceKey: `memory:${source}`,
    title: "Legacy link",
  });
  const sql6 = await readFile(
    new URL("../../server/migrations/006_memory_learning.sql", import.meta.url),
    "utf8",
  );
  await h.pool.query("DROP VIEW cr_recall_documents");
  await h.pool.query(
    sql6.slice(
      sql6.indexOf("CREATE VIEW cr_recall_documents"),
      sql6.indexOf("CREATE UNIQUE INDEX"),
    ),
  );
  const before = (await documentsByKeys(h.pool, [`memory:${source}`])).get(
    `memory:${source}`,
  ).revision;
  await h.pool.query(
    "ALTER TABLE cr_memories DROP COLUMN source_refs, DROP COLUMN origin_task_id, DROP COLUMN source_corrected",
  );
  await h.pool.query(
    "ALTER TABLE cr_memory_candidates DROP COLUMN valid_from, DROP COLUMN valid_to",
  );
  await h.pool.query(
    "DELETE FROM cr_migrations WHERE name='007_memory_provenance.sql'",
  );
  await migrate(h.pool);
  const docs = await documentsByKeys(h.pool, [
    `memory:${source}`,
    `memory:${saved}`,
  ]);
  assert.equal(docs.get(`memory:${source}`).revision, before);
  assert.ok(
    docs
      .get(`memory:${saved}`)
      .dependencies.some(
        (r) => r.key === `memory:${source}` && r.revision === before,
      ),
  );
  assert.ok((await find(h, c)).some((d) => d.key === `memory:${saved}`));
  assert.ok(!(await find(h, c)).some((d) => d.key === `memory:${unverified}`));
  await c.request("PATCH", `/api/memories/${source}`, {
    revision: 1,
    title: "Retention",
    body: "Retention policy lasts sixty days.",
    reason: "Correction after upgrade",
  });
  assert.ok(!(await find(h, c)).some((d) => d.key === `memory:${saved}`));
  const corrected = await c.request("PATCH", `/api/memories/${saved}`, {
    revision: 2,
    title: "Corrected retention",
    body: "Retention policy lasts sixty days.",
    reason: "Reviewed updated evidence",
  });
  assert.equal(corrected.statusCode, 200, corrected.body);
  const management = (await c.request("GET", "/api/memories"))
    .json()
    .memories.find((m) => m.id === saved);
  assert.ok(!JSON.stringify(management).includes(body));
});

test("metadata edits retain evidence while self-dependent replacement is rejected", async (t) => {
  const h = await harness(t),
    c = await h.client("lead@example.com"),
    origin = await newTask(
      c,
      values({ workType: "chat", agentId: "review", project: "audit" }),
    );
  await c.request("POST", `/api/tasks/${origin.id}/messages`, { body });
  const key =
    "message:" +
    (
      await h.pool.query("SELECT id FROM cr_messages WHERE task_id=$1", [
        origin.id,
      ])
    ).rows[0].id;
  const id = await note(c, { sourceKey: key });
  const patch = await c.request("PATCH", `/api/memories/${id}`, {
    revision: 1,
    title: "Renamed retention",
    body,
    pinned: true,
    reason: "Pin important evidence",
  });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.ok((await find(h, c)).some((d) => d.key === `memory:${id}`));
  const stored = (
    await h.pool.query("SELECT * FROM cr_memories WHERE id=$1", [id])
  ).rows[0];
  assert.ok(stored.source_refs.length > 0);
  assert.equal(stored.source_corrected, false);
  const rejected = await c.request("POST", "/api/memories", {
    agentId: "review",
    visibility: "team",
    project: "audit",
    audience: "project",
    title: "Replacement",
    body: "New policy",
    source: "Review",
    sourceKey: `memory:${id}`,
    supersedesId: id,
    validFrom: "2026-01-01T00:00:00Z",
  });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().code, "MEMORY_REPLACEMENT_SOURCE");
});
