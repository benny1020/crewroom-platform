// Synthetic restore drill only. Mounted into the Worker by verify-restore.mjs.
import assert from "node:assert/strict";
import { secret, configuration, modelProfile } from "../server/config.js";
import { database, digest } from "../server/db.js";
import { executeCommand } from "../server/tasks.js";
import { claimRun, processRun } from "../server/worker.js";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(input),
  url = process.env.RUNNER_URL,
  token = await secret("RUNNER_TOKEN");
const request = async (path, body, key = token) => {
  const response = await fetch(url + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + key,
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
};
const db = database();
try {
  if (process.argv[2] === "stage") {
    const profile = await (await fetch(url + "/v1/profile")).json(),
      job = await request("/v1/jobs", {
        runId: data.runId,
        generation: 1,
        baseSha: "a".repeat(40),
        mode: "edit",
        profileId: profile.id,
        archive: data.archive,
      });
    await request(
      "/v1/jobs/" + job.id + "/actions",
      {
        sequence: 1,
        action: "write_file",
        path: "sample.js",
        content: "module.exports = 2;\n",
      },
      job.capability,
    );
    await db.query(
      "INSERT INTO cr_execution_jobs(run_id,generation,job_id,capability,endpoint,profile_id) VALUES($1,1,$2,$3,$4,$5)",
      [data.runId, job.id, job.capability, url, profile.id],
    );
    console.log(JSON.stringify({ staged: true }));
  } else if (process.argv[2] === "resume") {
    const config = {
        ...configuration(),
        provider: "anthropic",
        model: "restore-protocol-fixture",
        modelEndpoint: "http://model.invalid/messages",
      },
      task = (
        await db.query("SELECT * FROM cr_tasks WHERE id=$1", [data.taskId])
      ).rows[0],
      user = (
        await db.query("SELECT * FROM cr_members WHERE id=$1", [
          task.responsible_id,
        ])
      ).rows[0];
    await executeCommand(
      db,
      user,
      task.id,
      { action: "start", revision: task.revision },
      config,
    );
    const run = await claimRun(db, "restore-drill-worker", config);
    assert.ok(run.snapshot.execution.checkpoint);
    assert.equal(run.snapshot.execution.checkpoint.patchHash, data.patchHash);
    assert.notEqual(run.id, data.oldRunId);
    run.snapshot.source = {
      kind: "gitlab-code-archive",
      url: run.snapshot.target,
      sha: "a".repeat(40),
      hash: digest(data.archive),
      archive: data.archive,
    };
    let fileRestored = false;
    await processRun(db, run, "restore-drill-worker", config, {
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body),
          actions = payload.messages
            .filter((m) => m.role === "assistant")
            .map((m) => JSON.parse(m.content));
        let action;
        if (!actions.length)
          action = { action: "read_file", path: "sample.js" };
        else if (!actions.some((a) => a.action === "run_check")) {
          const content = JSON.parse(payload.messages.at(-1).content).toolResult
            .content;
          assert.equal(content, "module.exports = 2;\n");
          fileRestored = true;
          action = { action: "run_check", checkId: "test" };
        } else
          action = {
            action: "finish",
            result: {
              summary: "복원한 실제 수정본의 테스트 통과",
              evidence: ["sample.test.js 실제 실행"],
              unknowns: ["합성 모델 계약 검사"],
              nextActions: [],
            },
          };
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: JSON.stringify(action) }],
            stop_reason: "end_turn",
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = (
      await db.query("SELECT result FROM cr_artifacts WHERE run_id=$1", [
        run.id,
      ])
    ).rows[0]?.result;
    if (!result)
      throw new Error(
        JSON.stringify(
          (
            await db.query(
              "SELECT error_code,error_message FROM cr_runs WHERE id=$1",
              [run.id],
            )
          ).rows[0],
        ),
      );
    assert.ok(fileRestored);
    assert.equal(result.execution.passed, true);
    assert.match(result.execution.checks[0].stdout, /tests 1/);
    assert.equal(result.execution.patchHash, data.patchHash);
    console.log(
      JSON.stringify({
        newRunId: run.id,
        fileRestored,
        passed: true,
        patchHash: result.execution.patchHash,
      }),
    );
  } else throw new Error("Unknown drill action");
} finally {
  await db.end();
}
