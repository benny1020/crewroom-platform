import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { harness, newTask, command, values, waitFor } from "./helpers.js";
import {
  claimRun,
  processRun,
  dispatchRun,
  completeRun,
  renewRun,
  startWorker,
  expireRuns,
} from "../../server/worker.js";
import { confirmStopped } from "../../server/recovery.js";

const result = {
  origin: "fixture",
  result: {
    summary: "테스트 결과",
    evidence: [],
    unknowns: ["fixture"],
    nextActions: [],
  },
  receipt: { provider: "fixture" },
};
test("public signup cannot claim a known colleague email or assign a department", async (t) => {
  const h = await harness(t);
  const response = await h.app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: h.config.origin, "content-type": "application/json" },
    payload: {
      email: "member@example.com",
      password: "attacker-passphrase",
      department: "development",
      name: "이메일 소유자 사칭",
      leadRequested: true,
    },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "PROVISIONING_REQUIRED");
  assert.equal(
    Number(
      (
        await h.pool.query(
          "SELECT count(*) FROM cr_members WHERE email='member@example.com'",
        )
      ).rows[0].count,
    ),
    0,
  );
});
test("a real HTTP provider request includes pre-start comments and brief, while later edits cannot alter the pinned context", async (t) => {
  let received;
  const provider = createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    received = JSON.parse(text);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(result.result) } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const h = await harness(t, {
      provider: "openai-compatible",
      modelBase: `http://127.0.0.1:${provider.address().port}/v1`,
      model: "protocol-fixture",
      allowFixture: false,
    }),
    lead = await h.client("lead@example.com");
  let task = await newTask(lead);
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "인계 전 고유 조건: 다중 탭",
  });
  task = (
    await command(lead, task, "brief", {
      text: "요약 정정 고유 조건",
      reason: "근거 보완",
      source: "request",
    })
  ).json().task;
  await command(lead, task, "start");
  await lead.request("POST", `/api/tasks/${task.id}/messages`, {
    body: "시작 후 추가 내용은 다음 실행에만",
  });
  const run = await claimRun(h.pool, "protocol-worker", h.config);
  await processRun(h.pool, run, "protocol-worker", h.config);
  const body = JSON.stringify(received);
  assert.ok(body.includes("인계 전 고유 조건"));
  assert.ok(body.includes("요약 정정 고유 조건"));
  assert.ok(!body.includes("시작 후 추가 내용"));
  assert.deepEqual(received.tools, []);
  assert.equal(received.tool_choice, "none");
  const detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal(detail.status, "result_ready");
  assert.equal(detail.artifacts[0].result.receipt.model, "protocol-fixture");
});
test("provider profile changes fail explicitly instead of sending queued private data to a new endpoint", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead, values({ visibility: "private" }));
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "profile-worker", h.config);
  let calls = 0;
  await processRun(
    h.pool,
    run,
    "profile-worker",
    { ...h.config, modelBase: "https://new-endpoint.invalid/v1" },
    {
      fetchImpl: async () => {
        calls++;
        throw new Error("must not send");
      },
    },
  );
  assert.equal(calls, 0);
  const detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal(detail.runs[0].error_code, "PROVIDER_PROFILE_CHANGED");
  assert.equal(detail.artifacts.length, 0);
});
test("revocation before dispatch produces zero model calls; admitted calls leave receipts but cannot publish after cancellation", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  const memory = (
    await lead.request("POST", "/api/memories", {
      agentId: "review",
      visibility: "team",
      title: "팀 기준",
      body: "고유 규칙",
      source: "합의",
    })
  ).json();
  let task = await newTask(lead);
  await command(lead, task, "start");
  let run = await claimRun(h.pool, "dispatch-worker", h.config),
    calls = 0;
  await lead.request("DELETE", `/api/memories/${memory.id}`, { revision: 1 });
  await assert.rejects(
    () =>
      dispatchRun(h.pool, run, "dispatch-worker", () => {
        calls++;
        return Promise.resolve(result);
      }),
    { code: "DISPATCH_REVOKED" },
  );
  assert.equal(calls, 0);
  await h.pool.query(
    "UPDATE cr_runs SET status='cancelled',lease_owner=NULL WHERE id=$1",
    [run.id],
  );
  task = await newTask(lead);
  await command(lead, task, "start");
  run = await claimRun(h.pool, "dispatch-worker", h.config);
  let resolve;
  const held = new Promise((r) => (resolve = r)),
    sent = dispatchRun(h.pool, run, "dispatch-worker", () => {
      calls++;
      return held;
    });
  await waitFor(
    async () => calls,
    (x) => x === 1,
  );
  const current = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal((await command(lead, current, "cancel")).statusCode, 200);
  resolve(result);
  await sent;
  assert.equal(
    await completeRun(
      h.pool,
      run.id,
      "dispatch-worker",
      run.generation,
      result,
    ),
    false,
  );
  assert.equal(
    Number(
      (
        await h.pool.query(
          "SELECT count(*) FROM cr_events WHERE task_id=$1 AND type='model_dispatched'",
          [task.id],
        )
      ).rows[0].count,
    ),
    1,
  );
});
test("queued holds do not claim an agent slot and private recovery works through an opaque operator Run ID", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true);
  let first = await newTask(lead),
    second = await newTask(lead);
  await command(lead, first, "start");
  await command(lead, second, "start");
  const run = await claimRun(h.pool, "active-worker", h.config);
  second = (await lead.request("GET", `/api/tasks/${second.id}`)).json().task;
  assert.equal((await command(lead, second, "pause")).statusCode, 200);
  assert.equal(await claimRun(h.pool, "other-worker", h.config), null);
  assert.ok(
    await completeRun(h.pool, run.id, "active-worker", run.generation, result),
  );
  assert.equal(await claimRun(h.pool, "other-worker", h.config), null);
  const privateTask = await newTask(member, values({ visibility: "private" }));
  await command(member, privateTask, "start");
  const privateRun = await claimRun(h.pool, "dead-private-worker", h.config);
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [privateRun.id],
  );
  await expireRuns(h.pool);
  assert.equal(
    (await lead.request("GET", `/api/tasks/${privateTask.id}`)).statusCode,
    404,
  );
  assert.deepEqual(
    await confirmStopped(
      h.pool,
      privateRun.id,
      "fixture: old worker has been terminated",
    ),
    { runId: privateRun.id, cleared: true },
  );
  const fresh = (
    await member.request("GET", `/api/tasks/${privateTask.id}`)
  ).json().task;
  assert.equal((await command(member, fresh, "start")).statusCode, 200);
});
test("renew, completion and dispatch reject leases that expire while waiting for a task lock", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  for (const operation of ["renew", "complete", "dispatch"]) {
    const task = await newTask(lead);
    await command(lead, task, "start");
    const run = await claimRun(h.pool, "clock-worker", h.config);
    await h.pool.query(
      "UPDATE cr_runs SET lease_until=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",
      [run.id],
    );
    const blocker = await h.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM cr_tasks WHERE id=$1 FOR UPDATE", [
      task.id,
    ]);
    let calls = 0;
    const pending = (
      operation === "renew"
        ? renewRun(h.pool, run.id, "clock-worker", run.generation, h.config)
        : operation === "complete"
          ? completeRun(h.pool, run.id, "clock-worker", run.generation, result)
          : dispatchRun(h.pool, run, "clock-worker", () => {
              calls++;
              return Promise.resolve(result);
            })
    ).catch((e) => e);
    await delay(400);
    await blocker.query("COMMIT");
    blocker.release();
    const answer = await pending;
    if (operation === "dispatch") assert.equal(answer.code, "DISPATCH_REVOKED");
    else assert.equal(answer, false);
    assert.equal(calls, 0);
    assert.equal(
      Number(
        (
          await h.pool.query(
            "SELECT count(*) FROM cr_artifacts WHERE task_id=$1",
            [task.id],
          )
        ).rows[0].count,
      ),
      0,
    );
    await h.pool.query(
      "UPDATE cr_runs SET status='cancelled',lease_owner=NULL WHERE id=$1",
      [run.id],
    );
  }
});
test("graceful Worker stop waits for an in-flight tick and dispatches nothing after stop begins", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com");
  let heartbeats = 0,
    release,
    entered,
    calls = 0;
  const gate = new Promise((r) => (release = r)),
    arrived = new Promise((r) => (entered = r));
  const wrapped = {
    connect: h.pool.connect.bind(h.pool),
    query: async (sql, args) => {
      if (sql.startsWith("UPDATE cr_workers") && ++heartbeats === 2) {
        entered();
        await gate;
      }
      return h.pool.query(sql, args);
    },
  };
  const worker = await startWorker(wrapped, h.config, {
    runModel: async () => {
      calls++;
      return result;
    },
  });
  h.cleanup.push(() => worker.stop());
  const task = await newTask(lead);
  await command(lead, task, "start");
  await arrived;
  let stopped = false;
  const stopping = worker.stop().then(() => (stopped = true));
  await delay(50);
  assert.equal(stopped, false);
  release();
  await stopping;
  await delay(50);
  assert.equal(calls, 0);
  assert.equal(
    (
      await h.pool.query("SELECT state FROM cr_workers WHERE id=$1", [
        worker.owner,
      ])
    ).rows[0].state,
    "stopped",
  );
});
test("a failed dispatch commit retains a durable intent and quarantines the possibly sent request", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead);
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "uncertain-worker", h.config);
  let commits = 0,
    calls = 0;
  const wrapped = {
    query: h.pool.query.bind(h.pool),
    connect: async () => {
      const client = await h.pool.connect();
      return {
        release: () => client.release(),
        query: async (sql, args) => {
          if (sql === "COMMIT" && ++commits === 2)
            throw new Error("injected commit connection failure");
          return client.query(sql, args);
        },
      };
    },
  };
  let failure;
  try {
    await dispatchRun(wrapped, run, "uncertain-worker", () => {
      calls++;
      return Promise.resolve(result);
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, "DISPATCH_UNKNOWN");
  assert.equal(calls, 1);
  const { failRun } = await import("../../server/worker.js");
  await failRun(h.pool, run.id, "uncertain-worker", run.generation, failure);
  const stored = (
    await h.pool.query("SELECT * FROM cr_runs WHERE id=$1", [run.id])
  ).rows[0];
  assert.equal(stored.error_code, "DISPATCH_UNKNOWN");
  assert.equal(stored.lease_owner, "uncertain-worker");
  assert.equal(
    (
      await h.pool.query(
        "SELECT state FROM cr_model_dispatches WHERE run_id=$1",
        [run.id],
      )
    ).rows[0].state,
    "unknown",
  );
  const fresh = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal((await command(lead, fresh, "start")).statusCode, 409);
});
test("an incomplete restore blocks API and Worker startup, and restored runs require the operator CLI", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead);
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "before-restore", h.config);
  await h.pool.query("UPDATE cr_runtime_control SET restore_blocked=true");
  assert.equal((await lead.request("GET", "/api/workspace")).statusCode, 503);
  await assert.rejects(() => startWorker(h.pool, h.config), {
    code: "RESTORE_INCOMPLETE",
  });
  await h.pool.query("UPDATE cr_runtime_control SET restore_blocked=false");
  await h.pool.query(
    "UPDATE cr_runs SET status='failed',error_code='RESTORE_CONFIRMATION_REQUIRED',lease_owner='restored-unverified',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  const response = await lead.request(
    "POST",
    `/api/runs/${run.id}/confirm-stopped`,
    { confirmedStopped: true },
  );
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "OPERATOR_CLI_REQUIRED");
});
test("pause during an admitted request retains unknown-dispatch quarantine until operator confirmation", async (t) => {
  const h = await harness(t),
    lead = await h.client("lead@example.com"),
    task = await newTask(lead);
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "paused-worker", h.config);
  let sent, abort;
  const entered = new Promise((r) => (sent = r)),
    request = new Promise((_, reject) => (abort = reject));
  const pending = processRun(h.pool, run, "paused-worker", h.config, {
    runModel: async (_snapshot, _config, { dispatch }) =>
      dispatch(() => {
        sent();
        return request;
      }),
  });
  await entered;
  const fresh = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  await command(lead, fresh, "pause");
  abort(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await pending;
  const stored = (
    await h.pool.query("SELECT * FROM cr_runs WHERE id=$1", [run.id])
  ).rows[0];
  assert.equal(stored.status, "paused");
  assert.equal(stored.error_code, "DISPATCH_UNKNOWN");
  assert.equal(stored.lease_owner, "paused-worker");
  const paused = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal((await command(lead, paused, "start")).statusCode, 409);
  assert.equal(
    (
      await lead.request("POST", `/api/runs/${run.id}/confirm-stopped`, {
        confirmedStopped: true,
      })
    ).json().code,
    "OPERATOR_CLI_REQUIRED",
  );
  await h.pool.query(
    "UPDATE cr_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  await confirmStopped(
    h.pool,
    run.id,
    "test operator confirmed provider request and worker stopped",
  );
  const ready = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal((await command(lead, ready, "start")).statusCode, 200);
});
