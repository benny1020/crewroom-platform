import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, event, digest, lockContextMutation } from "./db.js";
import {
  requireLead,
  requireRead,
  readPredicate,
  canRead,
} from "./permissions.js";
import { conflict, fail } from "./errors.js";
import { getTask } from "./tasks.js";
import { department, revision, memoryInput } from "./validation.js";
import {
  readMemorySource,
  sourceProvenance,
  validReferences,
  agentSourceAllowed,
} from "./memory.js";

export async function agents(db, user) {
  return (
    await db.query(
      "SELECT a.*,coalesce(jsonb_agg(jsonb_build_object('skillId',b.skill_id,'version',b.version)) FILTER(WHERE b.skill_id IS NOT NULL),'[]') AS skills FROM cr_agents a LEFT JOIN cr_skill_bindings b ON b.agent_id=a.id WHERE a.owner_id IS NULL OR a.owner_id=$1 GROUP BY a.id ORDER BY a.created_at",
      [user.id],
    )
  ).rows;
}
export async function updateAgent(pool, user, id, input) {
  const v = z
    .object({
      revision,
      name: z.string().trim().min(1).max(40),
      instructions: z.string().trim().min(1).max(6000),
      runtime: z.enum(["readonly", "hermes"]),
    })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    const a = (
      await db.query("SELECT * FROM cr_agents WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!a || (a.owner_id && a.owner_id !== user.id))
      fail(404, "NOT_FOUND", "동료를 찾을 수 없어요.");
    if (a.owner_id !== user.id) requireLead(user);
    if (a.config_version !== v.revision) conflict();
    const result = (
      await db.query(
        "UPDATE cr_agents SET name=$2,instructions=$3,runtime=$4,config_version=config_version+1 WHERE id=$1 RETURNING *",
        [id, v.name, v.instructions, v.runtime],
      )
    ).rows[0];
    await event(db, null, { type: "user", id: user.id }, "agent_updated", {
      agentId: id,
      configVersion: result.config_version,
    });
    return result;
  });
}
export async function listSkills(db, user) {
  return (
    await db.query(
      "SELECT s.*,v.instructions,v.done_criteria,v.content_hash FROM cr_skills s JOIN cr_skill_versions v ON v.skill_id=s.id AND v.version=s.current_version WHERE s.owner_id IS NULL OR s.owner_id=$1 ORDER BY s.name",
      [user.id],
    )
  ).rows;
}
export async function publishSkill(pool, user, id, input) {
  const v = z
    .object({
      revision,
      instructions: z.string().trim().min(1).max(12000),
      doneCriteria: z.string().trim().min(1).max(2000),
    })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    const skill = (
      await db.query("SELECT * FROM cr_skills WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!skill || (skill.owner_id && skill.owner_id !== user.id))
      fail(404, "NOT_FOUND", "스킬을 찾을 수 없어요.");
    if (
      user.role !== "lead" &&
      skill.owner_id !== user.id &&
      skill.steward_id !== user.id
    )
      fail(403, "SKILL_STEWARD_REQUIRED", "이 스킬의 관리 권한이 필요해요.");
    if (skill.current_version !== v.revision) conflict();
    const version = skill.current_version + 1;
    await db.query(
      "INSERT INTO cr_skill_versions(skill_id,version,instructions,done_criteria,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        version,
        v.instructions,
        v.doneCriteria,
        digest({ instructions: v.instructions, done: v.doneCriteria }),
        user.id,
      ],
    );
    await db.query("UPDATE cr_skills SET current_version=$2 WHERE id=$1", [
      id,
      version,
    ]);
    await event(db, null, { type: "user", id: user.id }, "skill_published", {
      skillId: id,
      version,
    });
    return { id, version };
  });
}
export async function bindSkill(pool, user, agentId, input) {
  const v = z
    .object({
      skillId: z.string().max(80),
      version: revision,
      agentRevision: revision,
    })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    const a = (
      await db.query("SELECT * FROM cr_agents WHERE id=$1 FOR UPDATE", [
        agentId,
      ])
    ).rows[0];
    if (!a || (a.owner_id && a.owner_id !== user.id))
      fail(404, "NOT_FOUND", "동료를 찾을 수 없어요.");
    if (a.owner_id !== user.id) requireLead(user);
    if (a.config_version !== v.agentRevision) conflict();
    const skill = (
      await db.query(
        "SELECT s.id,s.owner_id FROM cr_skills s JOIN cr_skill_versions v ON v.skill_id=s.id AND v.version=$2 WHERE s.id=$1",
        [v.skillId, v.version],
      )
    ).rows[0];
    if (
      !skill ||
      (skill.owner_id && skill.owner_id !== user.id) ||
      (skill.owner_id && !a.owner_id)
    )
      fail(
        400,
        "SKILL_SCOPE",
        "이 동료에 적용할 수 있는 스킬 버전을 선택해주세요.",
      );
    await db.query(
      "INSERT INTO cr_skill_bindings(agent_id,skill_id,version) VALUES($1,$2,$3) ON CONFLICT(agent_id,skill_id) DO UPDATE SET version=excluded.version",
      [agentId, v.skillId, v.version],
    );
    await db.query(
      "UPDATE cr_agents SET config_version=config_version+1 WHERE id=$1",
      [agentId],
    );
    await event(db, null, { type: "user", id: user.id }, "skill_bound", {
      agentId,
      skillId: v.skillId,
      version: v.version,
    });
    return { ok: true };
  });
}
export async function updateMember(pool, user, id, input) {
  requireLead(user);
  const v = z
    .object({
      role: z.enum(["lead", "member"]),
      department,
      active: z.boolean(),
    })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('crewroom-members'))",
    );
    const m = (
      await db.query("SELECT * FROM cr_members WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!m) fail(404, "NOT_FOUND", "구성원을 찾을 수 없어요.");
    if (
      m.role === "lead" &&
      m.active &&
      (v.role !== "lead" || !v.active) &&
      Number(
        (
          await db.query(
            "SELECT count(*) FROM cr_members WHERE role='lead' AND active",
          )
        ).rows[0].count,
      ) <= 1
    )
      fail(409, "LAST_LEAD", "팀장은 한 명 이상 필요해요.");
    await db.query(
      "UPDATE cr_members SET role=$2,department=$3,active=$4,lead_requested=CASE WHEN $2='lead' THEN false ELSE lead_requested END WHERE id=$1",
      [id, v.role, v.department, v.active],
    );
    if (!v.active)
      await db.query("DELETE FROM cr_sessions WHERE user_id=$1", [id]);
    await event(db, null, { type: "user", id: user.id }, "member_updated", {
      memberId: id,
      ...v,
    });
    return { ok: true };
  });
}
export async function setSteward(pool, user, skillId, stewardId) {
  requireLead(user);
  if (stewardId !== null && !z.uuid().safeParse(stewardId).success)
    fail(400, "INVALID_MEMBER", "구성원을 선택해주세요.");
  return transaction(pool, async (db) => {
    if (
      stewardId &&
      !(
        await db.query("SELECT 1 FROM cr_members WHERE id=$1 AND active", [
          stewardId,
        ])
      ).rowCount
    )
      fail(400, "INVALID_MEMBER", "활성 구성원을 선택해주세요.");
    if (
      !(
        await db.query(
          "UPDATE cr_skills SET steward_id=$2 WHERE id=$1 AND owner_id IS NULL RETURNING id",
          [skillId, stewardId],
        )
      ).rowCount
    )
      fail(404, "NOT_FOUND", "공용 스킬을 찾을 수 없어요.");
    await event(db, null, { type: "user", id: user.id }, "steward_updated", {
      skillId,
      stewardId,
    });
    return { ok: true };
  });
}
export async function listMemories(db, user, query = "") {
  const rows = (
    await db.query(
      `SELECT m.* FROM cr_memories m JOIN cr_agents a ON a.id=m.agent_id WHERE m.deleted_at IS NULL AND (a.owner_id IS NULL OR a.owner_id=$1) AND ${readPredicate("m")} AND ($3='' OR m.title ILIKE $4 OR m.body ILIKE $4) ORDER BY m.updated_at DESC LIMIT 100`,
      [
        user.id,
        user.department,
        query,
        `%${query.replace(/[\\%_]/g, "\\$&")}%`,
      ],
    )
  ).rows;
  const items = [];
  for (const m of rows) {
    // A revoked origin must not leak via the management list or its history.
    if (await validReferences(db, user, m, m.source_refs)) {
      const history = [];
      for (const h of m.history) {
        history.push(
          (await validReferences(db, user, m, h.sourceRefs || []))
            ? h
            : {
                ...h,
                title: "열람할 수 없는 이전 출처",
                reason: "이전 출처 재검토 필요",
                body: "이전 근거를 다시 확인해야 합니다.",
                sourceRefs: [],
              },
        );
      }
      items.push({ ...m, history });
    } else
      items.push({
        ...m,
        title: "출처 재검토가 필요한 기억",
        body: "출처가 변경되었거나 현재 열람할 수 없습니다. 새 근거로 바로잡아주세요.",
        source: "출처 확인 필요",
        history: [],
        source_refs: [],
        unavailable: true,
      });
  }
  return items;
}
export async function createMemory(pool, user, input, existingDb = null) {
  const v = memoryInput.parse(input);
  const execute = async (db) => {
    await lockContextMutation(db);
    const a = (
      await db.query("SELECT * FROM cr_agents WHERE id=$1", [v.agentId])
    ).rows[0];
    if (!a || (a.owner_id && a.owner_id !== user.id))
      fail(404, "NOT_FOUND", "동료를 찾을 수 없어요.");
    if (a.owner_id && v.visibility !== "private")
      fail(400, "PERSONAL_SCOPE", "개인 비서의 기억은 비공개로 저장해주세요.");
    const source = v.sourceTaskId
      ? await getTask(db, user, v.sourceTaskId, true)
      : null;
    if (source && source.visibility !== v.visibility)
      fail(400, "SOURCE_SCOPE", "원본 업무와 같은 공개 범위를 사용해주세요.");
    if (
      v.visibility !== "private" &&
      user.role !== "lead" &&
      source?.responsible_id !== user.id
    )
      fail(
        403,
        "MEMORY_STEWARD_REQUIRED",
        "공유 기억은 업무 책임자 또는 팀장이 저장할 수 있어요.",
      );
    const project = source?.project || v.project;
    if (
      v.audience === "project" &&
      (v.visibility === "private" || !project || a.owner_id)
    )
      fail(
        400,
        "MEMORY_AUDIENCE",
        "프로젝트 공통 기억은 공유 업무에만 적용할 수 있어요.",
      );
    if (
      v.validFrom &&
      v.validTo &&
      new Date(v.validFrom) >= new Date(v.validTo)
    )
      fail(400, "MEMORY_INTERVAL", "적용 종료는 시작 이후로 지정해주세요.");
    let provenance = { refs: [], validFrom: null, validTo: null },
      originTaskId = null;
    if (v.sourceKey) {
      const scope = {
        visibility: v.visibility,
        department: source?.department || user.department,
      };
      const doc = await readMemorySource(db, user, scope, v.sourceKey);
      if (!agentSourceAllowed(doc, v.agentId))
        fail(
          409,
          "MEMORY_PROOF_REQUIRED",
          "이 동료가 사용할 수 있는 출처를 선택해주세요.",
        );
      provenance = await sourceProvenance(db, doc);
      if (
        !(await validReferences(db, user, scope, provenance.refs, {
          lock: true,
        }))
      )
        fail(409, "MEMORY_PROOF_CHANGED", "출처를 다시 확인해주세요.");
      originTaskId = doc.task_id;
      // A derived fact cannot outlive its evidence. Keep any narrower user bounds.
      const starts = [v.validFrom, provenance.validFrom]
        .filter(Boolean)
        .map((x) => +new Date(x));
      const ends = [v.validTo, provenance.validTo]
        .filter(Boolean)
        .map((x) => +new Date(x));
      v.validFrom = starts.length
        ? new Date(Math.max(...starts)).toISOString()
        : null;
      v.validTo = ends.length
        ? new Date(Math.min(...ends)).toISOString()
        : null;
      if (
        v.validFrom &&
        v.validTo &&
        new Date(v.validFrom) >= new Date(v.validTo)
      )
        fail(400, "MEMORY_INTERVAL", "출처와 겹치는 적용 기간이 필요해요.");
    }
    if (v.supersedesId) {
      if (provenance.refs.some((r) => r.key === "memory:" + v.supersedesId))
        fail(
          409,
          "MEMORY_REPLACEMENT_SOURCE",
          "대체할 결정에 의존하지 않는 새 근거가 필요해요.",
        );
      const ref = (
        await db.query("SELECT source_task_id FROM cr_memories WHERE id=$1", [
          v.supersedesId,
        ])
      ).rows[0];
      if (ref?.source_task_id)
        await getTask(db, user, ref.source_task_id, true);
      const old = (
        await db.query(
          "SELECT * FROM cr_memories WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [v.supersedesId],
        )
      ).rows[0];
      requireRead(user, old);
      if (
        (
          await db.query(
            "SELECT 1 FROM cr_memories WHERE supersedes_id=$1 AND deleted_at IS NULL",
            [old.id],
          )
        ).rowCount
      )
        fail(
          409,
          "MEMORY_REPLACED",
          "이미 대체된 결정입니다. 현재 결정을 선택해주세요.",
        );
      if (
        old.owner_id !== user.id &&
        !(user.role === "lead" && old.visibility !== "private")
      )
        fail(
          403,
          "MEMORY_OWNER_REQUIRED",
          "대체할 기억의 관리 권한이 필요해요.",
        );
      if (
        old.agent_id !== v.agentId ||
        old.visibility !== v.visibility ||
        (v.visibility === "department" &&
          old.department !== (source?.department || user.department)) ||
        old.project !== project ||
        old.audience !== v.audience
      )
        fail(
          400,
          "MEMORY_REPLACEMENT_SCOPE",
          "같은 동료·프로젝트·공개 범위의 기억을 대체해주세요.",
        );
      if (
        !v.validFrom ||
        (old.valid_from && new Date(v.validFrom) <= new Date(old.valid_from)) ||
        (old.valid_to && new Date(v.validFrom) > new Date(old.valid_to))
      )
        fail(
          400,
          "MEMORY_INTERVAL",
          "기존 기억의 적용 기간 안에서 새 적용 시작을 지정해주세요.",
        );
      await db.query("UPDATE cr_memories SET valid_to=$2 WHERE id=$1", [
        old.id,
        v.validFrom,
      ]);
    }
    const id = randomUUID();
    await db.query(
      "INSERT INTO cr_memories(id,agent_id,owner_id,visibility,department,source_task_id,title,body,source,kind,pinned,project,audience,valid_from,valid_to,supersedes_id,source_key,source_refs,origin_task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
      [
        id,
        v.agentId,
        user.id,
        v.visibility,
        source?.department || user.department,
        source?.id || null,
        v.title,
        v.body,
        v.source,
        v.kind,
        v.pinned,
        project,
        v.audience,
        v.validFrom,
        v.validTo,
        v.supersedesId,
        v.sourceKey,
        JSON.stringify(provenance.refs),
        originTaskId,
      ],
    );
    // Private content is intentionally absent from global activity payloads.
    await event(
      db,
      source?.id || null,
      { type: "user", id: user.id },
      "memory_created",
      { memoryId: id },
    );
    return { id };
  };
  return existingDb ? execute(existingDb) : transaction(pool, execute);
}
export async function changeMemory(pool, user, id, input, deleting = false) {
  const v = deleting
    ? z.object({ revision }).strict().parse(input)
    : z
        .object({
          revision,
          title: z.string().trim().min(1).max(120),
          body: z.string().trim().min(1).max(10000),
          reason: z.string().trim().min(1).max(300),
          pinned: z.boolean().optional(),
          kind: z
            .enum(["fact", "decision", "preference", "procedure"])
            .optional(),
        })
        .strict()
        .parse(input);
  return transaction(pool, async (db) => {
    await lockContextMutation(db);
    const ref = (
      await db.query("SELECT source_task_id FROM cr_memories WHERE id=$1", [id])
    ).rows[0];
    if (ref?.source_task_id) await getTask(db, user, ref.source_task_id, true);
    const m = (
      await db.query(
        "SELECT * FROM cr_memories WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [id],
      )
    ).rows[0];
    requireRead(user, m);
    if (
      m.owner_id !== user.id &&
      !(user.role === "lead" && m.visibility !== "private")
    )
      fail(
        403,
        "MEMORY_OWNER_REQUIRED",
        "기억 작성자 또는 공유 기억 관리자만 수정할 수 있어요.",
      );
    if (m.revision !== v.revision) conflict();
    if (
      deleting &&
      (m.supersedes_id ||
        (
          await db.query(
            "SELECT 1 FROM cr_memories WHERE supersedes_id=$1 AND deleted_at IS NULL",
            [m.id],
          )
        ).rowCount)
    )
      fail(
        409,
        "MEMORY_DECISION_CHAIN",
        "대체 이력이 있는 결정은 삭제할 수 없어요. 바로잡거나 새 결정으로 대체해주세요.",
      );
    const detaching = !deleting && v.body !== m.body;
    const history = JSON.stringify([
      {
        revision: m.revision,
        title: m.title,
        body: m.body,
        actor: user.id,
        reason: v.reason || "삭제",
        sourceRefs: m.source_refs,
        originTaskId: m.origin_task_id,
        provenanceDetached: detaching && m.source_refs.length > 0,
        at: new Date().toISOString(),
      },
    ]);
    await db.query(
      "UPDATE cr_memories SET title=$2,body=$3,history=history || $4::jsonb,revision=revision+1,updated_at=now(),deleted_at=CASE WHEN $5 THEN now() ELSE NULL END,pinned=$6,kind=$7,source_refs=CASE WHEN $8 THEN '[]'::jsonb ELSE source_refs END,source_corrected=source_corrected OR $8 WHERE id=$1",
      [
        id,
        v.title || m.title,
        v.body || m.body,
        history,
        deleting,
        v.pinned ?? m.pinned,
        v.kind || m.kind,
        detaching,
      ],
    );
    await db.query(
      "DELETE FROM cr_memory_embeddings WHERE source_key=$1 OR source_key IN (SELECT key FROM cr_recall_documents WHERE dependencies @>jsonb_build_array(jsonb_build_object('key',$1::text)))",
      ["memory:" + id],
    );
    await db.query(
      "DELETE FROM cr_memory_embeddings e WHERE NOT EXISTS(SELECT 1 FROM cr_recall_documents d WHERE d.key=e.source_key AND d.revision=e.source_revision)",
    );
    await event(
      db,
      m.source_task_id,
      { type: "user", id: user.id },
      deleting ? "memory_deleted" : "memory_corrected",
      { memoryId: id },
    );
    return { ok: true };
  });
}

export async function createSkill(pool, user, input) {
  const v = z
    .object({
      name: z.string().trim().min(1).max(80),
      scope: z.enum(["private", "team"]),
      instructions: z.string().trim().min(1).max(12000),
      doneCriteria: z.string().trim().min(1).max(2000),
    })
    .strict()
    .parse(input);
  if (v.scope === "team") requireLead(user);
  const id = "custom-" + randomUUID();
  return transaction(pool, async (db) => {
    await db.query("INSERT INTO cr_skills(id,name,owner_id) VALUES($1,$2,$3)", [
      id,
      v.name,
      v.scope === "private" ? user.id : null,
    ]);
    await db.query(
      "INSERT INTO cr_skill_versions(skill_id,version,instructions,done_criteria,content_hash,created_by) VALUES($1,1,$2,$3,$4,$5)",
      [
        id,
        v.instructions,
        v.doneCriteria,
        digest({ instructions: v.instructions, done: v.doneCriteria }),
        user.id,
      ],
    );
    await event(db, null, { type: "user", id: user.id }, "skill_created", {
      skillId: id,
      scope: v.scope,
    });
    return { id, version: 1 };
  });
}
