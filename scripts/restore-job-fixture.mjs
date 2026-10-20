// Synthetic restore drill only. Mounted into the Worker by verify-restore.mjs.
import assert from "node:assert/strict";
import { secret, configuration, modelProfile } from "../server/config.js";
import { database, digest } from "../server/db.js";
import { createTask, executeCommand } from "../server/tasks.js";
import {
  actInWorkspace,
  failRun,
  claimRun,
  processRun,
} from "../server/worker.js";
import { createSkillStudio, saveSkillStudio } from "../server/skill-studio.js";
import { randomUUID } from "node:crypto";
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
  if (process.argv[2] === "workspace") {
    const user = (
      await db.query("SELECT * FROM cr_members ORDER BY created_at LIMIT 1")
    ).rows[0];
    const config = {
      ...configuration(),
      provider: "fixture",
      model: "restore-workspace",
      allowFixture: true,
    };
    const task = await createTask(
      db,
      user,
      {
        workType: "chat",
        agentId: "dev",
        project: "restore-documents",
        target: "synthetic",
        targetVersion: "v1",
        goal: "문서 복원",
        visibility: "private",
      },
      randomUUID(),
    );
    await executeCommand(
      db,
      user,
      task.id,
      { action: "start", revision: task.revision },
      config,
    );
    const run = await claimRun(db, "restore-documents", config);
    const write = (path, content, expectedRevision) =>
      actInWorkspace(db, run, "restore-documents", {
        action: "write_workspace",
        path,
        content,
        expectedRevision,
      });
    const doc = await write("plan.md", "first persisted draft", 0);
    await write("plan.md", "second persisted draft", 1);
    const archived = await write("archive.md", "retained tombstone bytes", 0);
    await actInWorkspace(db, run, "restore-documents", {
      action: "archive_workspace",
      id: archived.id,
      expectedRevision: 1,
    });
    await failRun(
      db,
      run.id,
      "restore-documents",
      run.generation,
      new Error("synthetic draft failure"),
    );
    await db.query(
      "UPDATE cr_runs SET lease_owner=NULL,lease_until=NULL WHERE id=$1",
      [run.id],
    );
    console.log(
      JSON.stringify({ taskId: task.id, documentId: doc.id, runId: run.id }),
    );
  } else if (process.argv[2] === "skill-studio") {
    const user = (
      await db.query("SELECT * FROM cr_members ORDER BY created_at LIMIT 1")
    ).rows[0];
    const config = {
      ...configuration(),
      provider: "fixture",
      model: "restore-studio-fixture",
      allowFixture: true,
    };
    let task = await createSkillStudio(
      db,
      user,
      { message: "복원 훈련용 반복 업무 스킬" },
      randomUUID(),
      config,
    );
    const run = await claimRun(db, "restore-studio-worker", config);
    assert.equal(run.task_id, task.id);
    await processRun(db, run, "restore-studio-worker", config);
    task = (await db.query("SELECT * FROM cr_tasks WHERE id=$1", [task.id]))
      .rows[0];
    const draft = {
      ...task.skill_design.draft,
      instructions: "수동 수정도 복원하는 합성 스킬 지침입니다.",
    };
    const saved = await saveSkillStudio(db, user, task.id, {
      revision: task.revision,
      draft,
      scope: "private",
      agentId: `personal-${user.id}`,
    });
    console.log(
      JSON.stringify({
        taskId: task.id,
        skillId: saved.id,
        version: saved.version,
      }),
    );
  } else if (process.argv[2] === "stage") {
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
