import { z } from "zod";
import { transaction, digest, event, lockContextMutation } from "./db.js";
import { getTask, createTask, executeCommand } from "./tasks.js";
import { createSkill, publishSkill, bindSkill } from "./resources.js";
import { skillDraftSchema } from "./skill-designer.js";
import { fail, conflict } from "./errors.js";
import { revision } from "./validation.js";
import { modelEndpoint } from "./config.js";
import {
  readMemorySource,
  sourceProvenance,
  validReferences,
} from "./memory.js";

export async function listSkillStudios(db, user) {
  return (
    await db.query(
      "SELECT id,title,status,updated_at,skill_design->'saved' AS saved FROM cr_tasks WHERE work_type='skill-design' AND owner_id=$1 ORDER BY updated_at DESC LIMIT 12",
      [user.id],
    )
  ).rows;
}
async function editableSkill(db, user, id) {
  const s = (
    await db.query(
      "SELECT s.*,v.instructions,v.done_criteria FROM cr_skills s JOIN cr_skill_versions v ON v.skill_id=s.id AND v.version=s.current_version WHERE s.id=$1 FOR UPDATE OF s",
      [id],
    )
  ).rows[0];
  if (!s || (s.owner_id && s.owner_id !== user.id))
    fail(404, "NOT_FOUND", "스킬을 찾을 수 없어요.");
  if (
    user.role !== "lead" &&
    s.owner_id !== user.id &&
    s.steward_id !== user.id
  )
    fail(403, "SKILL_STEWARD_REQUIRED", "이 스킬의 관리 권한이 필요해요.");
  return s;
}
async function studioTask(db, user, id, expectedRevision) {
  const t = await getTask(db, user, id, true);
  if (t.work_type !== "skill-design" || t.owner_id !== user.id)
    fail(404, "NOT_FOUND", "스킬 만들기 대화를 찾을 수 없어요.");
  if (t.revision !== expectedRevision) conflict();
  if (t.current_run_id) {
    const r = (
      await db.query("SELECT status,lease_owner FROM cr_runs WHERE id=$1", [
        t.current_run_id,
      ])
    ).rows[0];
    if (r.lease_owner || ["queued", "running", "paused"].includes(r.status))
      fail(
        409,
        "RUN_ACTIVE",
        "진행 중인 답변이 끝난 뒤 이어가세요. 종료 확인이 필요하면 실행 기록을 확인해주세요.",
      );
  }
  return t;
}
export async function createSkillStudio(pool, user, input, key, config) {
  const v = z
    .object({
      message: z.string().trim().min(1).max(4000),
      baseSkillId: z.string().max(80).optional(),
      sourceTaskId: z.uuid().optional(),
      draft: skillDraftSchema.optional(),
    })
    .strict()
    .parse(input);
  if (
    !(config.allowFixture && config.provider === "fixture") &&
    !(config.model && modelEndpoint(config))
  )
    fail(
      503,
      "MODEL_NOT_CONFIGURED",
      "AI 모델 주소와 이름을 설정한 뒤 초안을 만들 수 있어요. 직접 작성도 사용할 수 있습니다.",
    );
  if (!key || !/^[\w-]{8,100}$/.test(key))
    fail(400, "IDEMPOTENCY_REQUIRED", "요청 식별자가 필요해요.");
  return transaction(pool, async (db) => {
    await lockContextMutation(db);
    // Same durable task idempotency and lock order as ordinary agent work.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${user.id}:${key}`,
    ]);
    const prior = (
      await db.query(
        "SELECT request_hash,resource_id FROM cr_idempotency WHERE user_id=$1 AND key=$2",
        [user.id, key],
      )
    ).rows[0];
    if (prior) {
      const t = await getTask(db, user, prior.resource_id, true);
      if (
        t.work_type !== "skill-design" ||
        t.skill_design.requestHash !== digest(v)
      )
        fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 식별자로 다른 내용을 보낼 수 없어요.",
        );
      return t;
    }
    const base = v.baseSkillId
      ? await editableSkill(db, user, v.baseSkillId)
      : null;
    let draft =
      v.draft ||
      (base
        ? {
            name: base.name,
            instructions: base.instructions,
            doneCriteria: base.done_criteria,
          }
        : null);
    let sourceExample = null,
      sourceRefs = [];
    if (v.sourceTaskId) {
      const source = await getTask(db, user, v.sourceTaskId, true);
      if (source.status !== "done")
        fail(
          409,
          "ACCEPTED_WORK_REQUIRED",
          "수용을 완료한 업무에서 시작해주세요.",
        );
      draft ||= {
        name: source.title.slice(0, 80),
        instructions:
          "새 업무의 대상과 필요한 입력을 먼저 확인하고, 근거·미확인 사항·다음 행동을 구분해 결과를 작성하세요. 과거 업무의 검사·수용을 새 업무의 승인으로 재사용하지 마세요.",
        doneCriteria: source.done_criteria,
      };
      const accepted = (
        await db.query(
          "SELECT a.* FROM cr_acceptances c JOIN cr_artifacts a ON a.id=c.artifact_id WHERE c.task_id=$1 AND c.revoked_at IS NULL AND a.target_version=$2",
          [source.id, source.target_version],
        )
      ).rows[0];
      if (!accepted)
        fail(
          409,
          "ACCEPTED_WORK_REQUIRED",
          "현재 수용된 결과를 다시 확인해주세요.",
        );
      const doc = await readMemorySource(
        db,
        user,
        { visibility: "private", department: user.department },
        `artifact:${accepted.id}:summary:1`,
      );
      sourceRefs = (await sourceProvenance(db, doc)).refs;
      sourceExample = {
        taskId: source.id,
        taskNumber: String(source.number),
        artifactId: accepted.id,
        artifactVersion: accepted.version,
        contentHash: accepted.content_hash,
        targetVersion: accepted.target_version,
        goal: source.goal,
        doneCriteria: source.done_criteria,
        summary: accepted.result.summary.slice(0, 6000),
        evidence: (accepted.result.evidence || []).slice(0, 8),
        unknowns: (accepted.result.unknowns || []).slice(0, 8),
      };
    }
    const a = (
      await db.query(
        "SELECT id FROM cr_agents WHERE owner_id=$1 ORDER BY created_at LIMIT 1",
        [user.id],
      )
    ).rows[0];
    if (!a) fail(409, "ASSISTANT_REQUIRED", "나의 비서를 먼저 준비해주세요.");
    const t = await createTask(
      pool,
      user,
      {
        workType: "skill-design",
        agentId: a.id,
        skillId: "conversation",
        visibility: "private",
        project: "스킬 만들기",
        target: "반복 업무 스킬 설계",
        targetVersion: "draft-v1",
        title: (base ? base.name + " · 다듬기" : v.message).slice(0, 110),
        goal: v.message,
        skillDesign: {
          version: 1,
          baseSkillId: base?.id || null,
          baseVersion: base?.current_version || null,
          scope: base ? (base.owner_id ? "private" : "team") : "private",
          draft,
          mode: "design",
          sample: "",
          saved: null,
          requestHash: digest(v),
          sourceExample,
          sourceRefs,
          baseDraft: base
            ? {
                name: base.name,
                instructions: base.instructions,
                doneCriteria: base.done_criteria,
              }
            : null,
        },
      },
      key,
      db,
    );
    await db.query(
      "INSERT INTO cr_messages(task_id,user_id,body,target_version) VALUES($1,$2,$3,$4)",
      [t.id, user.id, v.message, t.target_version],
    );
    return executeCommand(
      pool,
      user,
      t.id,
      { action: "start", revision: t.revision },
      config,
      db,
    );
  });
}
export async function skillStudioTurn(pool, user, id, input, config) {
  const v = z
    .object({
      revision,
      message: z.string().trim().min(1).max(4000),
      draft: skillDraftSchema.optional(),
      mode: z.enum(["design", "try"]).default("design"),
      sample: z.string().trim().max(2000).default(""),
    })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    let t = await studioTask(db, user, id, v.revision);
    const draft = v.draft || t.skill_design.draft;
    if (v.mode === "try" && (!draft || !v.sample))
      fail(400, "SAMPLE_REQUIRED", "스킬 초안과 예시 입력을 준비해주세요.");
    if (["result_ready", "done"].includes(t.status))
      t = await executeCommand(
        pool,
        user,
        id,
        { action: "continue", revision: t.revision },
        config,
        db,
      );
    if (!["queued", "failed"].includes(t.status))
      fail(409, "INVALID_STATE", "업무 상태를 확인한 뒤 이어가세요.");
    await db.query("UPDATE cr_tasks SET skill_design=$2 WHERE id=$1", [
      id,
      { ...t.skill_design, draft, mode: v.mode, sample: v.sample },
    ]);
    await db.query(
      "INSERT INTO cr_messages(task_id,user_id,body,target_version) VALUES($1,$2,$3,$4)",
      [id, user.id, v.message, t.target_version],
    );
    return executeCommand(
      pool,
      user,
      id,
      { action: "start", revision: t.revision },
      config,
      db,
    );
  });
}
export async function saveSkillStudio(pool, user, id, input) {
  const v = z
    .object({
      revision,
      draft: skillDraftSchema,
      scope: z.enum(["private", "team"]),
      agentId: z.string().max(80).optional(),
    })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    const t = await getTask(db, user, id, true);
    if (t.work_type !== "skill-design" || t.owner_id !== user.id)
      fail(404, "NOT_FOUND", "스킬 만들기 대화를 찾을 수 없어요.");
    const saveHash = digest({
      draft: v.draft,
      scope: v.scope,
      agentId: v.agentId || null,
    });
    const base = t.skill_design.baseSkillId
      ? await editableSkill(db, user, t.skill_design.baseSkillId)
      : null;
    if (
      !(await validReferences(db, user, t, t.skill_design.sourceRefs || [], {
        lock: true,
      }))
    )
      fail(
        409,
        "SOURCE_CHANGED",
        "참고한 결과의 출처가 바뀌었어요. 새 근거로 스킬 만들기를 시작해주세요.",
      );
    if (t.skill_design.saved?.hash === saveHash) return t.skill_design.saved;
    await studioTask(db, user, id, v.revision);
    if (!["result_ready", "done", "failed"].includes(t.status))
      fail(409, "DRAFT_REQUIRED", "초안을 받은 뒤 저장해주세요.");
    // A current permission check still applies to idempotent and new publication.
    if (
      base &&
      ((base.owner_id ? "private" : "team") !== v.scope ||
        base.current_version !== t.skill_design.baseVersion)
    )
      conflict();
    const skill = base
      ? await publishSkill(
          pool,
          user,
          base.id,
          {
            revision: base.current_version,
            instructions: v.draft.instructions,
            doneCriteria: v.draft.doneCriteria,
          },
          db,
        )
      : await createSkill(pool, user, { ...v.draft, scope: v.scope }, db);
    if (base && v.draft.name !== base.name)
      await db.query("UPDATE cr_skills SET name=$2 WHERE id=$1", [
        base.id,
        v.draft.name,
      ]);
    if (v.agentId) {
      const a = (
        await db.query(
          "SELECT config_version FROM cr_agents WHERE id=$1 FOR UPDATE",
          [v.agentId],
        )
      ).rows[0];
      if (!a) fail(404, "NOT_FOUND", "적용할 동료를 찾을 수 없어요.");
      await bindSkill(
        pool,
        user,
        v.agentId,
        {
          skillId: skill.id,
          version: skill.version,
          agentRevision: a.config_version,
        },
        db,
      );
    }
    const saved = {
      ...skill,
      hash: saveHash,
      agentId: v.agentId || null,
      scope: v.scope,
    };
    await db.query(
      "UPDATE cr_tasks SET skill_design=$2,status='done',revision=revision+1,updated_at=now() WHERE id=$1",
      [
        id,
        {
          ...t.skill_design,
          baseSkillId: skill.id,
          baseVersion: skill.version,
          scope: v.scope,
          draft: v.draft,
          saved,
        },
      ],
    );
    await event(db, id, { type: "user", id: user.id }, "skill_studio_saved", {
      skillId: skill.id,
      version: skill.version,
    });
    return saved;
  });
}
