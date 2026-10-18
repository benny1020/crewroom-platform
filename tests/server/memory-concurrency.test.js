import test from "node:test";
import assert from "node:assert/strict";
import { harness, newTask, values, command } from "./helpers.js";
import { claimRun, recallForRun, dispatchRun } from "../../server/worker.js";

async function sharedRuns(t) {
  const h = await harness(t),
    c = await h.client("lead@example.com");
  const tasks = [];
  for (const agentId of ["review", "qa"])
    tasks.push(
      await newTask(
        c,
        values({
          workType: "chat",
          agentId,
          project: "audit",
          goal: "Policy alpha",
        }),
      ),
    );
  for (const task of tasks)
    assert.equal(
      (
        await c.request("POST", `/api/tasks/${task.id}/messages`, {
          body: "Policy alpha shared evidence " + task.id,
        })
      ).statusCode,
      200,
    );
  for (const task of tasks)
    assert.equal((await command(c, task, "start")).statusCode, 200);
  const first = await claimRun(h.pool, "concurrency-a", h.config),
    second = await claimRun(h.pool, "concurrency-b", h.config);
  assert.ok(first && second);
  assert.equal(first.snapshot.memoryContext.refs.length, 2);
  assert.equal(second.snapshot.memoryContext.refs.length, 2);
  return { h, first, second };
}

test("cross-task recalls enter the context gate before taking row locks", async (t) => {
  const { h, first, second } = await sharedRuns(t);
  let arrived = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const pool = {
    connect: async () => {
      const db = await h.pool.connect();
      let gated = false;
      return {
        release: () => db.release(),
        query: async (sql, args) => {
          if (sql.includes("crewroom-context-mutation") && !gated) {
            if (++arrived === 2) release();
            await barrier;
            const result = await db.query(sql, args);
            gated = true;
            return result;
          }
          if (/FOR (UPDATE|SHARE)/.test(sql))
            assert.ok(gated, "gate must precede the first row lock");
          return db.query(sql, args);
        },
      };
    },
  };
  const outcomes = await Promise.all([
    recallForRun(pool, first, "concurrency-a", {
      action: "search_memory",
      query: "Policy",
    }),
    recallForRun(pool, second, "concurrency-b", {
      action: "search_memory",
      query: "Policy",
    }),
  ]);
  assert.ok(outcomes.every((outcome) => outcome.found > 0));
});

test("context gate releases while a dispatched model response remains pending", async (t) => {
  const { h, first, second } = await sharedRuns(t);
  let respond, launched;
  const response = new Promise((resolve) => {
      respond = resolve;
    }),
    started = new Promise((resolve) => {
      launched = resolve;
    });
  const pending = dispatchRun(h.pool, first, "concurrency-a", () => {
    launched();
    return response;
  });
  await started;
  let timer;
  try {
    const recalled = await Promise.race([
      recallForRun(h.pool, second, "concurrency-b", {
        action: "search_memory",
        query: "Policy",
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("response wait retained the context gate")),
          3000,
        );
      }),
    ]);
    assert.ok(recalled.found > 0);
  } finally {
    clearTimeout(timer);
    respond(new Response("{}"));
    await pending;
  }
});
