import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { harness, newTask, command, values } from "./helpers.js";
import { claimRun, processRun } from "../../server/worker.js";

test("real Worker wires a private GitLab MR through a local Claude protocol proxy and saves one pinned result", async (t) => {
  const names = [
      "MODEL_API_KEY",
      "MODEL_API_KEY_FILE",
      "GITLAB_TOKEN",
      "GITLAB_TOKEN_FILE",
    ],
    previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
  process.env.MODEL_API_KEY = "test-only-claude-key";
  process.env.GITLAB_TOKEN = "test-only-gitlab-key";
  delete process.env.MODEL_API_KEY_FILE;
  delete process.env.GITLAB_TOKEN_FILE;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const sha = "b".repeat(40),
    baseSha = "a".repeat(40),
    requests = [];
  const proxy = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    });
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/merge_requests/"))
      res.end(
        JSON.stringify({
          title: "합성 GitLab MR",
          description: "고정 입력 확인",
          sha,
          diff_refs: { head_sha: sha, base_sha: baseSha },
          changes_count: "1",
        }),
      );
    else if (req.url.includes("/repository/compare"))
      res.end(
        JSON.stringify({
          diffs: [
            {
              old_path: "session.js",
              new_path: "session.js",
              diff: "@@\n-old\n+custom-protocol-only-marker",
            },
          ],
        }),
      );
    else if (req.url === "/proxy/v1/messages")
      res.end(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "로컬 HTTP 계약 검증",
                evidence: ["합성 GitLab diff"],
                unknowns: ["실제 원격 연결·추론 검증 아님"],
                nextActions: ["사람의 확인"],
              }),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
      );
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const h = await harness(t, {
      provider: "anthropic",
      model: "protocol-only-claude",
      modelEndpoint: origin + "/proxy/v1/messages",
      gitlabBase: origin + "/gitlab",
      gitlabProjects: ["team/app"],
      gitlabSharedProjects: [],
      githubEnabled: false,
      allowFixture: false,
    }),
    lead = await h.client("lead@example.com");
  const input = values({
      target: origin + "/gitlab/team/app/-/merge_requests/7",
      targetVersion: sha,
      visibility: "private",
    }),
    task = await newTask(lead, input);
  await command(lead, task, "start");
  const run = await claimRun(h.pool, "endpoint-worker", h.config);
  assert.ok(run.snapshot.sourceProfile.id);
  await processRun(h.pool, run, "endpoint-worker", h.config);
  const detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
    .task;
  assert.equal(detail.status, "result_ready");
  assert.equal(detail.artifacts.length, 1);
  assert.equal(detail.artifacts[0].result.receipt.provider, "anthropic");
  assert.equal(detail.runs[0].snapshot.source.sha, sha);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers["private-token"], "test-only-gitlab-key");
  assert.equal(requests[2].headers["x-api-key"], "test-only-claude-key");
  assert.ok(
    JSON.stringify(requests[2].body).includes("custom-protocol-only-marker"),
  );
  const persisted = JSON.stringify(
    (await h.pool.query("SELECT snapshot FROM cr_runs WHERE id=$1", [run.id]))
      .rows[0],
  );
  assert.ok(!persisted.includes("test-only-claude-key"));
  assert.ok(!persisted.includes("test-only-gitlab-key"));
  const shared = await newTask(lead, { ...input, visibility: "team" });
  await command(lead, shared, "start");
  const denied = await claimRun(h.pool, "endpoint-worker", h.config);
  await processRun(h.pool, denied, "endpoint-worker", h.config);
  const failed = (await lead.request("GET", `/api/tasks/${shared.id}`)).json()
    .task;
  assert.equal(failed.runs[0].error_code, "GITLAB_SHARING_DENIED");
  assert.equal(failed.artifacts.length, 0);
  assert.equal(requests.length, 3);
});
