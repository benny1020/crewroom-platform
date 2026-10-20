import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness, newTask, values, command } from "./helpers.js";
import { Broker, tarFiles } from "../../runner/broker.mjs";
import { runnerServer } from "../../runner/server.mjs";
import { claimRun, processRun } from "../../server/worker.js";
const listen = async (server) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
};
test(
  "native model loop changes code, runs Docker tests, fresh QA receives identical patch and teammate accepts",
  { skip: process.env.TEST_RUNNER_DOCKER !== "1" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "crewroom-execution-"));
    const broker = await new Broker({
      stateDir: directory,
      namespace: "crewroom-e2e-" + Date.now(),
    }).init();
    const token = "test-only-runner-token-32-characters-long",
      api = runnerServer(broker, token),
      runnerUrl = await listen(api),
      sha = "a".repeat(40);
    const files = new Map([
        [
          "sum.js",
          { bytes: Buffer.from("exports.sum = (a,b) => a-b;\n"), mode: 420 },
        ],
        [
          "sum.test.js",
          {
            bytes: Buffer.from(
              "const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(require('./sum').sum(2,3),5));\n",
            ),
            mode: 420,
          },
        ],
      ]),
      archive = tarFiles(files);
    const contexts = [];
    const upstream = createServer(async (req, res) => {
      if (req.url.includes("/repository/commits/")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ id: sha }));
      }
      if (req.url.includes("/repository/archive.tar.gz"))
        return res.end(archive);
      let body = "";
      for await (const c of req) body += c;
      const payload = JSON.parse(body),
        context = JSON.parse(payload.messages[0].content),
        actions = payload.messages
          .filter((m) => m.role === "assistant")
          .map((m) => JSON.parse(m.content)),
        summary = {
          summary: "합계 수정 및 실제 검사",
          evidence: ["sum.test.js 실제 실행"],
          unknowns: ["테스트용 모델 응답; 실제 모델 품질은 미검증"],
          nextActions: [],
        };
      let action;
      if (!actions.length) contexts.push(context);
      if (!actions.length)
        action = { action: "search_memory", query: "합계 함수 개발 규칙" };
      else if (
        context.mode === "edit" &&
        !actions.some((a) => a.action === "write_workspace")
      )
        action = {
          action: "write_workspace",
          path: "notes/execution.md",
          content: "구현 계획 · 실제 검사 전 초안",
          expectedRevision: 0,
        };
      else if (
        context.mode === "edit" &&
        actions.filter((a) => a.action === "write_workspace").length === 1
      )
        action = {
          action: "write_workspace",
          path: "notes/execution.md",
          content: "충돌로 덮어쓰면 안 되는 내용",
          expectedRevision: 0,
        };
      else if (!actions.some((a) => a.action === "list_workspace")) {
        if (context.mode === "edit")
          assert.equal(
            JSON.parse(payload.messages.at(-1).content).toolResult.error,
            "WORKSPACE_CONFLICT",
          );
        action = { action: "list_workspace" };
      } else if (!actions.some((a) => a.action === "read_workspace")) {
        const listing = payload.messages
          .filter((m) => m.role === "user")
          .map((m) => JSON.parse(m.content))
          .find((m) =>
            m.toolResult?.items?.some((d) => d.path === "notes/execution.md"),
          );
        assert.ok(
          listing,
          "QA must see the developer's saved document in the same task",
        );
        action = {
          action: "read_workspace",
          id: listing.toolResult.items.find(
            (d) => d.path === "notes/execution.md",
          ).id,
        };
      } else if (!actions.some((a) => a.action === "read_file")) {
        action = { action: "read_file", path: "sum.js" };
      } else if (
        context.mode === "edit" &&
        !actions.some((a) => a.action === "write_file")
      )
        action = {
          action: "write_file",
          path: "sum.js",
          content: "exports.sum = (a,b) => a+b;\n",
        };
      else if (!actions.some((a) => a.action === "run_check"))
        action = { action: "run_check", checkId: "test" };
      else action = { action: "finish", result: summary };
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(action) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 100 },
        }),
      );
    });
    const sourceUrl = await listen(upstream);
    const previous = {
      RUNNER_TOKEN: process.env.RUNNER_TOKEN,
      GITLAB_TOKEN: process.env.GITLAB_TOKEN,
    };
    process.env.RUNNER_TOKEN = token;
    process.env.GITLAB_TOKEN = "test-only-gitlab";
    t.after(async () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise((r) => api.close(r));
      await new Promise((r) => upstream.close(r));
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    });
    const h = await harness(t, {
      ...(process.env.CAPTURE_EXECUTION
        ? { serveDist: true, origin: "http://127.0.0.1:4188" }
        : {}),
      runnerUrl,
      provider: "anthropic",
      model: "local-protocol-fixture",
      modelEndpoint: sourceUrl + "/messages",
      gitlabBase: sourceUrl,
      gitlabProjects: ["team/app"],
      gitlabSharedProjects: ["team/app"],
    });
    const lead = await h.client("lead@example.com"),
      member = await h.client("member@example.com", true);
    let task = await newTask(
      lead,
      values({
        workType: "code-qa",
        target: sourceUrl + "/team/app",
        targetVersion: sha,
        goal: "합계 함수의 오류를 수정하고 실제 테스트를 통과시켜 주세요.",
        project: "합계 함수 · Docker 실행 검증",
      }),
    );
    assert.equal((await command(lead, task, "start")).statusCode, 200);
    let run = await claimRun(h.pool, "test-worker", h.config);
    await processRun(h.pool, run, "test-worker", h.config);
    let detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json()
      .task;
    assert.equal(detail.status, "result_ready", JSON.stringify(detail.runs));
    assert.equal(detail.artifacts[0].result.receipt.workspaceUsage.writes, 1);
    assert.equal(
      detail.artifacts[0].result.receipt.workspaceUsage.bodyReads,
      1,
    );
    assert.equal(
      Number(
        (
          await h.pool.query(
            "SELECT count(*) FROM cr_memory_reads WHERE run_id=$1",
            [run.id],
          )
        ).rows[0].count,
      ),
      1,
    );
    const question = (
      await lead.request("POST", `/api/tasks/${task.id}/questions`, {
        taskRevision: detail.revision,
        assigneeId: member.user.id,
        prompt: "어떤 검사를 추가 확인할까요?",
      })
    ).json().question;
    assert.equal(
      (
        await member.request(
          "PATCH",
          `/api/tasks/${task.id}/questions/${question.id}`,
          {
            action: "answer",
            revision: question.revision,
            answer: "NATIVE_ANSWER_PROBE 합계 검사를 확인해주세요",
          },
        )
      ).statusCode,
      200,
    );
    detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
    assert.equal(
      (await command(lead, detail, "handoff")).json().code,
      "ANSWERS_NOT_APPLIED",
    );
    detail = (
      await command(lead, detail, "rework", {
        reason: "NATIVE_REWORK_PROBE 답변을 반영해 다시 검사해주세요",
        targetVersion: sha,
      })
    ).json().task;
    assert.equal((await command(lead, detail, "start")).statusCode, 200);
    run = await claimRun(h.pool, "test-worker", h.config);
    await processRun(h.pool, run, "test-worker", h.config);
    detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
    assert.equal(detail.status, "result_ready", JSON.stringify(detail.runs));
    const secondContext = contexts.find((c) =>
      c.rework?.reason.includes("NATIVE_REWORK_PROBE"),
    );
    assert.ok(secondContext);
    assert.match(
      JSON.stringify(secondContext.questions),
      /NATIVE_ANSWER_PROBE/,
    );
    const dev = detail.artifacts.find(
      (a) => a.id === detail.steps[0].current_artifact_id,
    ).result.execution;
    assert.equal(dev.passed, true);
    assert.match(dev.patch, /a\+b/);
    assert.equal(dev.checks[0].exitCode, 0);
    assert.equal(dev.stopped, true);
    assert.equal((await command(lead, detail, "handoff")).statusCode, 200);
    detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
    assert.equal(
      (await command(lead, detail, "assign", { responsibleId: member.user.id }))
        .statusCode,
      200,
    );
    detail = (await member.request("GET", `/api/tasks/${task.id}`)).json().task;
    assert.equal((await command(member, detail, "start")).statusCode, 200);
    run = await claimRun(h.pool, "qa-worker", h.config);
    assert.ok(
      run.snapshot.inheritedRefs.some((r) => r.key.startsWith("workspace:")),
      "patch provenance is inherited before QA explicitly reads documents",
    );
    await processRun(h.pool, run, "qa-worker", h.config);
    detail = (await member.request("GET", `/api/tasks/${task.id}`)).json().task;
    assert.equal(detail.status, "result_ready", JSON.stringify(detail.runs));
    const qa = detail.artifacts.find((a) => a.step_index === 1).result
      .execution;
    const qaReceipt = detail.artifacts.find((a) => a.step_index === 1).result
      .receipt;
    assert.equal(qaReceipt.workspaceUsage.writes, 0);
    assert.equal(qaReceipt.workspaceUsage.bodyReads, 1);
    assert.equal(qa.passed, true);
    assert.equal(qa.mode, "verify");
    const qaContext = contexts.find((c) => c.mode === "verify");
    assert.match(qaContext.rework.reason, /NATIVE_REWORK_PROBE/);
    assert.match(JSON.stringify(qaContext.questions), /NATIVE_ANSWER_PROBE/);
    assert.equal(qa.patchHash, dev.patchHash);
    assert.notEqual(qa.jobId, dev.jobId);
    assert.equal((await command(member, detail, "accept")).statusCode, 200);
    detail = (await lead.request("GET", `/api/tasks/${task.id}`)).json().task;
    assert.equal(detail.status, "done");
    assert.equal(detail.acceptances[0].accepted_by, member.user.id);
    if (process.env.CAPTURE_EXECUTION) {
      await h.app.listen({ port: 4188, host: "127.0.0.1" });
      const { captureExecution } =
        await import("../../scripts/capture-execution.mjs");
      await captureExecution(h.config.origin, task.id);
    }
  },
);
