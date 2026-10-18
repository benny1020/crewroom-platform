import { randomUUID } from "node:crypto";
import { transaction, digest, event, lockContextMutation } from "./db.js";
import {
  canRead,
  requireRead,
  requireOperator,
  canIntervene,
  readPredicate,
} from "./permissions.js";
import { fail, conflict } from "./errors.js";
import { modelProfile, sourceProfile } from "./config.js";
import { buildMemoryContext } from "./memory.js";
import { embeddingProfile } from "./memory-embedding.js";
import { WORK_TYPES } from "./work-types.js";

export async function getTask(db, user, id, lock = false) {
  if (lock) await lockContextMutation(db);
  const task = (
    await db.query(
      `SELECT * FROM cr_tasks WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  requireRead(user, task);
  return task;
}
export async function taskDetail(db, user, id) {
  const task = await getTask(db, user, id);
  const [steps, runs, artifacts, messages, events, claims, acceptances] =
    await Promise.all([
      db.query(
        "SELECT s.*,a.name AS agent_name FROM cr_steps s JOIN cr_agents a ON a.id=s.agent_id WHERE task_id=$1 ORDER BY position",
        [id],
      ),
      db.query(
        "SELECT id,task_id,agent_id,step_index,status,generation,lease_owner,lease_until,snapshot,progress,error_code,error_message,created_at,started_at,finished_at FROM cr_runs WHERE task_id=$1 ORDER BY created_at",
        [id],
      ),
      db.query(
        "SELECT * FROM cr_artifacts WHERE task_id=$1 ORDER BY created_at",
        [id],
      ),
      db.query(
        "SELECT m.*,u.name AS author FROM cr_messages m JOIN cr_members u ON u.id=m.user_id WHERE task_id=$1 ORDER BY id",
        [id],
      ),
      db.query("SELECT * FROM cr_events WHERE task_id=$1 ORDER BY id", [id]),
      db.query(
        "SELECT c.*,u.name FROM cr_claims c JOIN cr_members u ON u.id=c.user_id WHERE task_id=$1",
        [id],
      ),
      db.query(
        "SELECT * FROM cr_acceptances WHERE task_id=$1 ORDER BY created_at",
        [id],
      ),
    ]);
  // Context can contain personal memory. Run snapshots returned to viewers omit it.
  return {
    ...task,
    steps: steps.rows,
    runs: runs.rows.map((r) => ({
      ...r,
      snapshot: {
        agent: r.snapshot.agent,
        skill: r.snapshot.skill,
        targetVersion: r.snapshot.targetVersion,
        inputArtifactId: r.snapshot.inputArtifactId,
        provider: r.snapshot.provider,
        model: r.snapshot.model,
        outputSchema: r.snapshot.outputSchema,
        inputHash: r.snapshot.inputHash,
        memoryContext: r.snapshot.memoryContext
          ? {
              version: r.snapshot.memoryContext.version,
              count: r.snapshot.memoryContext.items.length,
              method: r.snapshot.memoryContext.method,
              characters: r.snapshot.memoryContext.characters,
            }
          : null,
        execution: r.snapshot.execution,
        source: r.snapshot.source
          ? {
              url: r.snapshot.source.url,
              sha: r.snapshot.source.sha,
              hash: r.snapshot.source.hash,
            }
          : null,
      },
    })),
    artifacts: artifacts.rows,
    messages: messages.rows,
    events: events.rows,
    claims: claims.rows,
    acceptances: acceptances.rows,
  };
}
export async function listTasks(db, user) {
  return (
    await db.query(
      `SELECT t.*,a.name AS agent_name,s.agent_id,s.name AS step_name FROM cr_tasks t JOIN cr_steps s ON s.task_id=t.id AND s.position=t.step_index JOIN cr_agents a ON a.id=s.agent_id WHERE ${readPredicate()} ORDER BY t.updated_at DESC LIMIT 200`,
      [user.id, user.department],
    )
  ).rows;
}
async function insertArtifact(db, task, stepIndex, value) {
  const version = Number(
    (
      await db.query(
        "SELECT coalesce(max(version),0)+1 AS n FROM cr_artifacts WHERE task_id=$1 AND step_index=$2",
        [task.id, stepIndex],
      )
    ).rows[0].n,
  );
  const artifact = (
    await db.query(
      "INSERT INTO cr_artifacts(id,task_id,step_index,run_id,version,target_version,origin,result,content_hash,imported_by,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
      [
        randomUUID(),
        task.id,
        stepIndex,
        value.runId || null,
        version,
        task.target_version,
        value.origin,
        value.result,
        digest(value.result),
        value.importedBy || null,
        value.source || null,
      ],
    )
  ).rows[0];
  await db.query(
    "UPDATE cr_steps SET current_artifact_id=$3 WHERE task_id=$1 AND position=$2",
    [task.id, stepIndex, artifact.id],
  );
  return artifact;
}
export { insertArtifact };
export async function createTask(pool, user, values, key) {
  if (!key || !/^[\w-]{8,100}$/.test(key))
    fail(400, "IDEMPOTENCY_REQUIRED", "요청 식별자가 필요해요.");
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${user.id}:${key}`,
    ]);
    const hash = digest(values),
      prior = (
        await db.query(
          "SELECT * FROM cr_idempotency WHERE user_id=$1 AND key=$2",
          [user.id, key],
        )
      ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash)
        fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 식별자로 다른 내용을 보낼 수 없어요.",
        );
      return getTask(db, user, prior.resource_id);
    }
    let steps = WORK_TYPES[values.workType]?.steps;
    if (values.workType === "chat") {
      const agent = (
        await db.query("SELECT * FROM cr_agents WHERE id=$1", [values.agentId])
      ).rows[0];
      if (!agent || (agent.owner_id && agent.owner_id !== user.id))
        fail(404, "AGENT_NOT_FOUND", "동료를 찾을 수 없어요.");
      if (agent.owner_id && values.visibility !== "private")
        fail(400, "PERSONAL_SCOPE", "개인 비서 대화는 비공개로 시작해주세요.");
      const skillId = values.skillId || "conversation";
      const binding = (
        await db.query(
          "SELECT 1 FROM cr_skill_bindings b JOIN cr_skills s ON s.id=b.skill_id WHERE b.agent_id=$1 AND b.skill_id=$2 AND (s.owner_id IS NULL OR s.owner_id=$3)",
          [agent.id, skillId, user.id],
        )
      ).rowCount;
      if (!binding)
        fail(400, "MISSING_BINDING", "이 동료에 적용한 스킬을 선택해주세요.");
      steps = [{ name: "업무 대화", agentId: agent.id, skill: skillId }];
    }
    if (!steps || (values.imported && values.workType !== "pr-qa"))
      fail(400, "WORK_TYPE", "업무 유형을 확인해주세요.");
    if (
      values.workType === "code-qa" &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(values.targetVersion)
    )
      fail(
        422,
        "FULL_COMMIT_REQUIRED",
        "코드 실행은 40자 또는 64자 전체 커밋 SHA가 필요해요.",
      );
    const id = randomUUID();
    let done =
      WORK_TYPES[values.workType]?.done ||
      "요청의 답변과 근거·미확인 사항을 확인하고 수용";
    if (values.exampleId) {
      const example = (
        await db.query(
          "SELECT a.*,t.owner_id,t.visibility,t.department,t.project,t.done_criteria FROM cr_artifacts a JOIN cr_tasks t ON t.id=a.task_id JOIN cr_acceptances c ON c.artifact_id=a.id AND c.revoked_at IS NULL WHERE a.id=$1",
          [values.exampleId],
        )
      ).rows[0];
      if (
        !canRead(user, example) ||
        example.project !== values.project ||
        example.visibility !== values.visibility ||
        (example.visibility === "department" &&
          example.department !== user.department) ||
        (example.visibility === "private" && example.owner_id !== user.id)
      )
        fail(
          403,
          "EXAMPLE_SCOPE",
          "같은 프로젝트와 공개 대상의 수용한 결과만 참고할 수 있어요.",
        );
      done = example.done_criteria;
    }
    const task = (
      await db.query(
        "INSERT INTO cr_tasks(id,owner_id,responsible_id,visibility,department,title,project,target,target_version,work_type,goal,done_criteria,brief,example_artifact_id) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
        [
          id,
          user.id,
          values.visibility,
          user.department,
          values.title || values.goal.slice(0, 110),
          values.project,
          values.target,
          values.targetVersion,
          values.workType,
          values.goal,
          done,
          {
            version: 1,
            targetVersion: values.targetVersion,
            text: values.goal,
            source: "request",
          },
          values.exampleId || null,
        ],
      )
    ).rows[0];
    for (const [i, step] of steps.entries())
      await db.query(
        "INSERT INTO cr_steps(task_id,position,name,agent_id,skill_id) VALUES($1,$2,$3,$4,$5)",
        [id, i, step.name, step.agentId, step.skill],
      );
    if (values.imported) {
      const a = await insertArtifact(db, task, 0, {
        origin: "external",
        result: {
          summary: values.imported.body,
          evidence: [],
          unknowns: ["외부 작성 내용과 검사 근거는 미검증입니다."],
          nextActions: ["출처와 대상 버전을 확인한 후 QA로 인계"],
        },
        importedBy: user.id,
        source: values.imported.source,
      });
      await db.query(
        "UPDATE cr_tasks SET status='result_ready',brief=jsonb_set(brief,'{source}',to_jsonb($2::text)) WHERE id=$1",
        [id, a.id],
      );
    }
    await db.query(
      "INSERT INTO cr_idempotency(user_id,key,request_hash,resource_id) VALUES($1,$2,$3,$4)",
      [user.id, key, hash, id],
    );
    await event(db, id, { type: "user", id: user.id }, "task_created", {
      targetVersion: task.target_version,
      imported: Boolean(values.imported),
    });
    return getTask(db, user, id);
  });
}
export async function executeCommand(pool, user, id, values, config) {
  const runner =
    values.action === "start"
      ? await optionalRunnerProfile(pool, user, id, config)
      : null;
  return transaction(pool, async (db) => {
    const task = await getTask(db, user, id, true);
    if (task.revision !== values.revision) conflict();
    const action = values.action,
      actor = { type: "user", id: user.id };
    if (!["claim", "assign", "cancel"].includes(action))
      requireOperator(user, task);
    const step = (
      await db.query(
        "SELECT * FROM cr_steps WHERE task_id=$1 AND position=$2",
        [id, task.step_index],
      )
    ).rows[0];
    const run = task.current_run_id
      ? (
          await db.query("SELECT * FROM cr_runs WHERE id=$1 FOR UPDATE", [
            task.current_run_id,
          ])
        ).rows[0]
      : null;
    if (action === "claim") {
      await db.query(
        "INSERT INTO cr_claims(task_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, user.id],
      );
    }
    if (action === "assign") {
      if (!(task.responsible_id === user.id || canIntervene(user, task)))
        fail(
          403,
          "ASSIGN_FORBIDDEN",
          "책임자 또는 팀장만 담당을 변경할 수 있어요.",
        );
      const member = (
        await db.query("SELECT * FROM cr_members WHERE id=$1", [
          values.responsibleId,
        ])
      ).rows[0];
      if (!canRead(member, task))
        fail(
          400,
          "ASSIGNEE_SCOPE",
          "이 업무를 볼 수 있는 구성원을 선택해주세요.",
        );
      if (run?.status === "running")
        fail(409, "RUN_ACTIVE", "실행을 일시정지한 뒤 책임자를 변경해주세요.");
      await db.query("UPDATE cr_tasks SET responsible_id=$2 WHERE id=$1", [
        id,
        member.id,
      ]);
      await db.query("DELETE FROM cr_claims WHERE task_id=$1 AND user_id=$2", [
        id,
        member.id,
      ]);
    }
    if (action === "continue") {
      if (
        task.work_type !== "chat" ||
        !["result_ready", "done"].includes(task.status) ||
        run?.lease_owner ||
        !step.current_artifact_id
      )
        fail(
          409,
          "CHAT_CONTINUATION",
          "답변이 준비된 대화에서 이어갈 수 있어요.",
        );
      await db.query(
        "UPDATE cr_steps SET input_artifact_id=current_artifact_id WHERE task_id=$1 AND position=$2",
        [id, task.step_index],
      );
      await db.query(
        "UPDATE cr_acceptances SET revoked_at=now() WHERE task_id=$1 AND revoked_at IS NULL",
        [id],
      );
      await db.query(
        "UPDATE cr_tasks SET current_run_id=NULL,status='queued' WHERE id=$1",
        [id],
      );
    }
    if (action === "start") {
      if (!["queued", "paused", "failed"].includes(task.status))
        fail(409, "INVALID_STATE", "현재 상태에서는 실행할 수 없어요.");
      if (run?.lease_owner)
        fail(
          409,
          "STOP_CONFIRMATION_REQUIRED",
          "이전 실행의 종료 확인이 필요해요.",
        );
      if (run?.status === "paused")
        await db.query(
          "UPDATE cr_runs SET status='queued',error_code=NULL,error_message=NULL WHERE id=$1",
          [run.id],
        );
      else {
        const agent = (
          await db.query("SELECT * FROM cr_agents WHERE id=$1", [step.agent_id])
        ).rows[0];
        const skill = (
          await db.query(
            "SELECT v.*,s.name FROM cr_skill_bindings b JOIN cr_skills s ON s.id=b.skill_id JOIN cr_skill_versions v ON v.skill_id=b.skill_id AND v.version=b.version WHERE b.agent_id=$1 AND b.skill_id=$2",
            [step.agent_id, step.skill_id],
          )
        ).rows[0];
        if (!agent || !skill)
          fail(
            409,
            "MISSING_BINDING",
            "필요한 동료와 스킬 적용 버전을 확인해주세요.",
          );
        const allMessages = (
          await db.query(
            "SELECT m.id,m.body,m.created_at,m.target_version,u.name AS author FROM cr_messages m JOIN cr_members u ON u.id=m.user_id WHERE m.task_id=$1 ORDER BY m.id DESC LIMIT 20",
            [id],
          )
        ).rows.reverse();
        let messageChars = 0;
        const messages = allMessages
          .slice()
          .reverse()
          .filter((m) => {
            messageChars += m.body.length;
            return messageChars <= 12000;
          })
          .reverse();
        const memoryContext = await buildMemoryContext(
          db,
          user,
          { ...task, recallQuery: allMessages.at(-1)?.body },
          agent.id,
        );
        const memories = memoryContext.items
          .filter((m) => m.key.startsWith("memory:"))
          .map((m) => ({
            id: m.key.slice(7),
            revision: m.recordRevision,
            title: m.title,
            body: m.body,
            source: m.source,
          }));
        const input = step.input_artifact_id
          ? (
              await db.query("SELECT * FROM cr_artifacts WHERE id=$1", [
                step.input_artifact_id,
              ])
            ).rows[0]
          : null;
        if (input && input.target_version !== task.target_version)
          fail(409, "STALE_HANDOFF", "현재 대상 버전의 입력 결과가 필요해요.");
        const checkpoint =
          task.work_type === "code-qa" && run
            ? (
                await db.query(
                  "SELECT checkpoint FROM cr_execution_jobs WHERE run_id=$1 AND checkpoint IS NOT NULL ORDER BY generation DESC LIMIT 1",
                  [run.id],
                )
              ).rows[0]?.checkpoint ||
              run.snapshot.execution?.checkpoint ||
              null
            : null;
        if (
          checkpoint &&
          (checkpoint.baselineSha.toLowerCase() !==
            task.target_version.toLowerCase() ||
            checkpoint.profileId !== runner.id)
        )
          fail(
            409,
            "CHECKPOINT_PROFILE_CHANGED",
            "저장한 수정분의 커밋·실행 설정이 달라요. 재작업으로 새 대상에서 시작해주세요.",
          );
        const snapshot = {
          agent: {
            id: agent.id,
            name: agent.name,
            instructions: agent.instructions,
            configVersion: agent.config_version,
            runtime: agent.runtime,
          },
          skill: {
            id: skill.skill_id,
            name: skill.name,
            version: skill.version,
            instructions: skill.instructions,
            done: skill.done_criteria,
            hash: skill.content_hash,
          },
          target: task.target,
          targetVersion: task.target_version,
          goal: task.goal,
          visibility: task.visibility,
          department: task.department,
          inputArtifactId: input?.id || null,
          inputArtifact: input?.result || null,
          inputArtifactHash: input?.content_hash || null,
          brief: task.brief,
          messages,
          example: task.example_artifact_id
            ? {
                artifactId: task.example_artifact_id,
                doneCriteria: task.done_criteria,
                outputFields: [
                  "summary",
                  "evidence",
                  "unknowns",
                  "nextActions",
                ],
              }
            : null,
          memories,
          memoryContext,
          embeddingProfile: embeddingProfile(config),
          project: task.project,
          providerProfile: modelProfile(config),
          sourceProfile: sourceProfile(config),
          provider: config.provider,
          model: config.model,
          outputSchema: 1,
          ...(task.work_type === "code-qa"
            ? {
                execution: {
                  mode: task.step_index === 0 ? "edit" : "verify",
                  profile: runner,
                  ...(checkpoint
                    ? {
                        checkpoint: {
                          patch: checkpoint.patch,
                          patchHash: checkpoint.patchHash,
                          baselineSha: checkpoint.baselineSha,
                          profileId: checkpoint.profileId,
                          sourceRunId: run.id,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        };
        const runId = randomUUID();
        await db.query(
          "INSERT INTO cr_runs(id,task_id,step_index,agent_id,requested_by,status,snapshot) VALUES($1,$2,$3,$4,$5,'queued',$6)",
          [runId, id, task.step_index, agent.id, user.id, snapshot],
        );
        await db.query("UPDATE cr_tasks SET current_run_id=$2 WHERE id=$1", [
          id,
          runId,
        ]);
      }
      await db.query("UPDATE cr_tasks SET status='queued' WHERE id=$1", [id]);
    }
    if (["pause", "cancel"].includes(action)) {
      if (
        action === "cancel" &&
        !(task.responsible_id === user.id || canIntervene(user, task))
      )
        fail(403, "CANCEL_FORBIDDEN", "업무 중단 권한이 필요해요.");
      if (!["running", "queued", "paused"].includes(task.status))
        fail(409, "INVALID_STATE", "현재 상태에서는 중단할 수 없어요.");
      const status = action === "pause" ? "paused" : "cancelled";
      if (run && ["queued", "running", "paused"].includes(run.status))
        await db.query(
          "UPDATE cr_runs SET status=$2,generation=generation+1 WHERE id=$1",
          [run.id, status],
        );
      await db.query("UPDATE cr_tasks SET status=$2 WHERE id=$1", [id, status]);
    }
    if (action === "handoff" || action === "accept") {
      const artifact = (
        await db.query("SELECT * FROM cr_artifacts WHERE id=$1", [
          step.current_artifact_id,
        ])
      ).rows[0];
      if (
        task.status !== "result_ready" ||
        !artifact ||
        artifact.target_version !== task.target_version
      )
        fail(409, "RESULT_REQUIRED", "현재 대상 버전의 결과를 확인해주세요.");
      if (task.work_type === "code-qa") assertExecutionResult(artifact, task);
      const next = (
        await db.query(
          "SELECT * FROM cr_steps WHERE task_id=$1 AND position=$2",
          [id, task.step_index + 1],
        )
      ).rows[0];
      if (action === "handoff") {
        if (!next)
          fail(409, "FINAL_STEP", "마지막 단계에서는 결과를 수용해주세요.");
        await db.query(
          "UPDATE cr_steps SET input_artifact_id=$3 WHERE task_id=$1 AND position=$2",
          [id, next.position, artifact.id],
        );
        await db.query(
          "UPDATE cr_tasks SET step_index=step_index+1,current_run_id=NULL,status='queued' WHERE id=$1",
          [id],
        );
      } else {
        if (next)
          fail(
            409,
            "HANDOFF_REQUIRED",
            "다음 단계로 인계한 뒤 최종 결과를 수용해주세요.",
          );
        await db.query(
          "INSERT INTO cr_acceptances(id,task_id,artifact_id,accepted_by,target_version) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), id, artifact.id, user.id, task.target_version],
        );
        await db.query("UPDATE cr_tasks SET status='done' WHERE id=$1", [id]);
      }
    }
    if (action === "rework") {
      if (
        !["result_ready", "done", "failed", "cancelled"].includes(
          task.status,
        ) ||
        run?.lease_owner
      )
        fail(
          409,
          "STOP_CONFIRMATION_REQUIRED",
          "결과 또는 이전 실행의 종료를 먼저 확인해주세요.",
        );
      await db.query(
        "UPDATE cr_acceptances SET revoked_at=now() WHERE task_id=$1 AND revoked_at IS NULL",
        [id],
      );
      await db.query(
        "UPDATE cr_steps SET input_artifact_id=NULL,current_artifact_id=NULL WHERE task_id=$1",
        [id],
      );
      const brief = {
        version: task.brief.version + 1,
        text: task.goal,
        source: "request",
        targetVersion: values.targetVersion,
      };
      await db.query(
        "UPDATE cr_tasks SET target_version=$2,brief_history=brief_history || $3::jsonb,brief=$4,step_index=0,current_run_id=NULL,status='queued' WHERE id=$1",
        [
          id,
          values.targetVersion,
          JSON.stringify([
            {
              ...task.brief,
              reason: values.reason,
              actor: user.id,
              at: new Date().toISOString(),
            },
          ]),
          brief,
        ],
      );
    }
    if (action === "brief") {
      if (
        values.source !== "request" &&
        !(
          await db.query(
            "SELECT 1 FROM cr_artifacts WHERE id::text=$1 AND task_id=$2",
            [values.source, id],
          )
        ).rowCount
      )
        fail(400, "SOURCE_REQUIRED", "이 업무의 근거를 선택해주세요.");
      await db.query(
        "UPDATE cr_tasks SET brief_history=brief_history || $2::jsonb,brief=$3 WHERE id=$1",
        [
          id,
          JSON.stringify([
            {
              ...task.brief,
              reason: values.reason,
              actor: user.id,
              at: new Date().toISOString(),
            },
          ]),
          {
            version: task.brief.version + 1,
            text: values.text,
            source: values.source,
            targetVersion: task.target_version,
          },
        ],
      );
    }
    await db.query(
      "UPDATE cr_tasks SET revision=revision+1,updated_at=now() WHERE id=$1",
      [id],
    );
    await event(db, id, actor, action, { ...values, revision: undefined });
    return getTask(db, user, id);
  });
}

async function optionalRunnerProfile(pool, user, id, config) {
  const task = await getTask(pool, user, id);
  if (task?.work_type !== "code-qa") return null;
  const { getRunnerProfile } = await import("./runner-client.js");
  return getRunnerProfile(config);
}
function assertExecutionResult(artifact, task) {
  const execution = artifact.result.execution;
  if (
    !execution?.passed ||
    execution.baselineSha.toLowerCase() !== task.target_version.toLowerCase() ||
    !execution.stopped ||
    !execution.checks?.length
  )
    fail(
      409,
      "CHECKS_REQUIRED",
      "현재 수정본의 실제 검사 통과와 실행 종료를 확인해야 인계·수용할 수 있어요.",
    );
  if (task.step_index > 0 && execution.mode !== "verify")
    fail(409, "QA_REQUIRED", "별도 QA 실행 결과가 필요해요.");
}
