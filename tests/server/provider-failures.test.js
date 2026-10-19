import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { harness, newTask, command, values } from "./helpers.js";
import { claimRun, processRun } from "../../server/worker.js";

for (const provider of ["openai-compatible", "anthropic"])
  test(`${provider} HTTP rejection never publishes an artifact or automatically resends a model request`, async (t) => {
    let status = 401,
      requests = 0;
    const result = {
      summary: "MUST_NOT_PUBLISH",
      evidence: [],
      unknowns: [],
      nextActions: [],
    };
    const endpoint = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      requests++;
      if (status === 0) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          provider === "anthropic"
            ? {
                content: [{ type: "text", text: JSON.stringify(result) }],
                stop_reason: "end_turn",
              }
            : {
                choices: [
                  {
                    message: { content: JSON.stringify(result) },
                    finish_reason: "stop",
                  },
                ],
              },
        ),
      );
    });
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    t.after(() => {
      endpoint.closeAllConnections();
      return new Promise((r) => endpoint.close(r));
    });
    const h = await harness(t, {
      provider,
      model: "protocol-fixture",
      modelEndpoint: `http://127.0.0.1:${endpoint.address().port}/model`,
      allowFixture: false,
    });
    const lead = await h.client("lead@example.com");
    for (const [httpStatus, errorCode] of [
      [401, "MODEL_AUTH_REJECTED"],
      [429, "MODEL_RATE_LIMITED"],
      [500, "MODEL_ENDPOINT_FAILED"],
    ]) {
      status = httpStatus;
      const task = await newTask(
        lead,
        values({ workType: "chat", agentId: "review" }),
      );
      assert.equal((await command(lead, task, "start")).statusCode, 200);
      const owner = `reject-${provider}-${status}`,
        run = await claimRun(h.pool, owner, h.config);
      await processRun(h.pool, run, owner, h.config);
      const detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
        .task;
      assert.equal(detail.status, "failed");
      assert.equal(detail.runs[0].error_code, errorCode);
      assert.equal(detail.artifacts.length, 0);
      assert.equal(detail.runs.length, 1);
      const receipt = (
        await h.pool.query(
          "SELECT state,response_status FROM cr_model_dispatches WHERE run_id=$1",
          [run.id],
        )
      ).rows;
      assert.deepEqual(receipt, [
        { state: "responded", response_status: status },
      ]);
    }
    assert.equal(requests, 3);
    assert.equal(await claimRun(h.pool, "no-retry", h.config), null);
    status = 0;
    h.config.modelTimeoutMs = 50;
    const timedTask = await newTask(
      lead,
      values({ workType: "chat", agentId: "review" }),
    );
    await command(lead, timedTask, "start");
    const timedRun = await claimRun(h.pool, "timeout-worker", h.config);
    await processRun(h.pool, timedRun, "timeout-worker", h.config);
    const timedDetail = (
      await lead.request("GET", `/api/tasks/${timedTask.id}`)
    ).json().task;
    assert.equal(timedDetail.runs[0].error_code, "DISPATCH_UNKNOWN");
    assert.equal(timedDetail.artifacts.length, 0);
    assert.equal(
      (
        await h.pool.query(
          "SELECT state FROM cr_model_dispatches WHERE run_id=$1",
          [timedRun.id],
        )
      ).rows[0].state,
      "unknown",
    );
    assert.equal(requests, 4);
    assert.equal(await claimRun(h.pool, "no-unsafe-retry", h.config), null);
  });
