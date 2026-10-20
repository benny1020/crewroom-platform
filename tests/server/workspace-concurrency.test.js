import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, actInWorkspace } from "../../server/worker.js";

async function workspace(t) {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true, {
      department: "development",
    }),
    task = await newTask(
      lead,
      values({ workType: "chat", agentId: "chief", visibility: "department" }),
    );
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "workspace-reader", h.config),
    doc = await actInWorkspace(h.pool, run, "workspace-reader", {
      action: "write_workspace",
      path: "plan.md",
      content: "CONFIDENTIAL_CURRENT_BODY",
      expectedRevision: 0,
    });
  return { ...h, lead, member, task, run, doc };
}

function intercept(h, onQuery) {
  const original = h.pool.connect.bind(h.pool);
  h.pool.connect = async (...args) => {
    if (typeof args[0] === "function") return original(...args);
    const client = await original(...args),
      query = client.query.bind(client),
      release = client.release.bind(client);
    client.query = async (...q) => onQuery(query, q);
    client.release = (...a) => {
      client.query = query;
      client.release = release;
      return release(...a);
    };
    return client;
  };
  return () => {
    h.pool.connect = original;
  };
}

test("independent document GETs overlap while a writer waits and both retain the same source/head revision", async (t) => {
  const h = await workspace(t);
  let count = 0,
    enter,
    resume;
  const entered = new Promise((r) => {
      enter = r;
    }),
    released = new Promise((r) => {
      resume = r;
    });
  const restore = intercept(h, async (query, args) => {
    const result = await query(...args);
    if (
      typeof args[0] === "string" &&
      args[0].includes(
        "SELECT d.* FROM cr_recall_documents d JOIN cr_workspace_documents",
      ) &&
      count < 2
    ) {
      if (++count === 2) enter();
      await released;
    }
    return result;
  });
  const reads = [h.lead, h.member].map((c) =>
    c.request("GET", `/api/workspace/documents/${h.doc.id}`),
  );
  let timer;
  try {
    await Promise.race([
      entered,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("GETs serialized behind an exclusive context gate"),
            ),
          1500,
        );
      }),
    ]);
    let written = false;
    const writing = actInWorkspace(h.pool, h.run, "workspace-reader", {
      action: "write_workspace",
      path: "plan.md",
      content: "NEXT_BODY",
      expectedRevision: 1,
    }).then((r) => {
      written = true;
      return r;
    });
    await delay(25);
    assert.equal(written, false);
    resume();
    const responses = await Promise.all(reads);
    assert.ok(
      responses.every(
        (r) =>
          r.statusCode === 200 &&
          r.json().revision === 1 &&
          r.json().content === "CONFIDENTIAL_CURRENT_BODY",
      ),
    );
    assert.equal((await writing).revision, 2);
  } finally {
    clearTimeout(timer);
    resume();
    await Promise.allSettled(reads);
    restore();
  }
});

for (const revoke of ["department", "deactivate"])
  test(`a queued workspace GET reauthenticates after ${revoke} revocation instead of using the old member`, async (t) => {
    const h = await workspace(t);
    let enter,
      resume,
      armed = true;
    const entered = new Promise((r) => {
        enter = r;
      }),
      released = new Promise((r) => {
        resume = r;
      });
    const restore = intercept(h, async (query, args) => {
      if (
        armed &&
        typeof args[0] === "string" &&
        args[0].includes("crewroom-context-mutation")
      ) {
        armed = false;
        enter();
        await released;
      }
      return query(...args);
    });
    const reading = h.member.request(
      "GET",
      `/api/workspace/documents/${h.doc.id}`,
    );
    try {
      await entered;
      const changed = await h.lead.request(
        "PATCH",
        `/api/members/${h.member.user.id}`,
        {
          role: "member",
          department: revoke === "department" ? "qa" : "development",
          active: revoke !== "deactivate",
        },
      );
      assert.equal(changed.statusCode, 200, changed.body);
      resume();
      const response = await reading;
      assert.equal(
        response.statusCode,
        revoke === "department" ? 404 : 401,
        response.body,
      );
      assert.ok(!response.body.includes("CONFIDENTIAL_CURRENT_BODY"));
      assert.ok(!response.body.includes("plan.md"));
    } finally {
      resume();
      await reading;
      restore();
    }
  });
