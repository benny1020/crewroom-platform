import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, event, lockContextMutation } from "./db.js";
import { HttpError } from "./errors.js";
import { canRead, requireRead } from "./permissions.js";
import { getTask } from "./tasks.js";
import {
  documentsByKeys,
  sourceAllowed,
  validReferences,
  reference,
  agentSourceAllowed,
  effectiveAt,
  sourceProvenance,
} from "./memory.js";
import { createMemory } from "./resources.js";

import { proposalSchema } from "./memory-protocol.js";
export async function recordProposal(db, user, task, run, input, sequence) {
  const v = proposalSchema.parse(input),
    doc = (await documentsByKeys(db, [v.key])).get(v.key);
  const provenance = doc ? await sourceProvenance(db, doc) : null;
  if (
    !doc ||
    doc.kind === "workspace" ||
    (doc.kind === "episode" && doc.task_id === task.id) ||
    !sourceAllowed(user, task, doc) ||
    !agentSourceAllowed(doc, run.agent_id) ||
    !effectiveAt({
      valid_from: provenance?.validFrom,
      valid_to: provenance?.validTo,
    }) ||
    new Date(doc.created_at) > new Date(run.created_at) ||
    !doc.body.includes(v.quote) ||
    !(await validReferences(
      db,
      user,
      task,
      [reference(doc), ...(doc.dependencies || [])],
      { lock: true },
    ))
  )
    throw new HttpError(
      409,
      "MEMORY_PROOF_REQUIRED",
      "현재 접근 가능한 원문의 정확한 인용이 필요해요.",
    );
  if (v.audience === "project" && task.visibility === "private")
    throw new HttpError(
      400,
      "MEMORY_AUDIENCE",
      "개인 대화에서 프로젝트 공통 기억을 만들 수 없어요.",
    );
  await db.query(
    "INSERT INTO cr_memory_reads(run_id,generation,sequence,query,refs) VALUES($1,$2,$3,$4,$5)",
    [
      run.id,
      run.generation,
      sequence,
      v.title,
      JSON.stringify([reference(doc), ...(doc.dependencies || [])]),
    ],
  );
  const existing = (
    await db.query(
      "SELECT id,status FROM cr_memory_candidates WHERE run_id=$1 AND generation=$2 AND source_key=$3 AND title=$4",
      [run.id, run.generation, v.key, v.title],
    )
  ).rows[0];
  if (existing)
    return {
      proposalId: existing.id,
      status: existing.status,
      notice: "이미 저장한 기억 제안입니다.",
    };
  const count = Number(
    (
      await db.query(
        "SELECT count(*) FROM cr_memory_candidates WHERE run_id=$1 AND generation=$2",
        [run.id, run.generation],
      )
    ).rows[0].count,
  );
  if (count >= 2)
    throw new HttpError(
      409,
      "MEMORY_PROPOSAL_LIMIT",
      "실행당 기억 제안은 두 개까지 만들 수 있어요.",
    );
  const id = randomUUID();
  const result = await db.query(
    `INSERT INTO cr_memory_candidates(id,run_id,generation,agent_id,owner_id,task_id,visibility,department,project,audience,title,body,kind,source_key,source_revision,source_quote,valid_from,valid_to)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
 ON CONFLICT(run_id,generation,source_key,title) DO NOTHING RETURNING id`,
    [
      id,
      run.id,
      run.generation,
      run.agent_id,
      user.id,
      task.id,
      task.visibility,
      task.department,
      task.project,
      v.audience,
      v.title,
      v.body,
      v.kind,
      doc.key,
      doc.revision,
      v.quote,
      provenance.validFrom,
      provenance.validTo,
    ],
  );
  return {
    proposalId: result.rows[0]?.id || null,
    status: "pending",
    notice:
      "기억 제안으로만 저장했습니다. 사람이 원문을 확인해 저장하기 전에는 다른 실행의 기억으로 사용하지 않습니다.",
  };
}
export async function listProposals(db, user) {
  const rows = (
    await db.query(
      `SELECT c.* FROM cr_memory_candidates c JOIN cr_tasks t ON t.id=c.task_id WHERE c.status='pending'
 AND (c.owner_id=$1 OR (c.visibility<>'private' AND $2='lead'))
 AND (t.owner_id=$1 OR t.visibility='team' OR (t.visibility='department' AND t.department=$3))
 ORDER BY c.created_at DESC LIMIT 50`,
      [user.id, user.role, user.department],
    )
  ).rows;
  const docs = await documentsByKeys(db, [
    ...new Set(rows.map((c) => c.source_key)),
  ]);
  const items = [];
  for (const c of rows) {
    const doc = docs.get(c.source_key);
    const provenance = doc ? await sourceProvenance(db, doc) : null;
    if (
      doc &&
      doc.revision === c.source_revision &&
      sourceAllowed(user, c, doc) &&
      agentSourceAllowed(doc, c.agent_id) &&
      effectiveAt(c) &&
      effectiveAt({
        valid_from: provenance.validFrom,
        valid_to: provenance.validTo,
      }) &&
      (await validReferences(db, user, c, doc.dependencies || []))
    )
      items.push(c);
    else
      items.push({
        id: c.id,
        task_id: c.task_id,
        unavailable: true,
        status: c.status,
      });
  }
  return items;
}
export async function resolveProposal(pool, user, id, input) {
  const v = z
    .object({ action: z.enum(["accept", "dismiss"]) })
    .strict()
    .parse(input);
  return transaction(pool, async (db) => {
    await lockContextMutation(db);
    const ref = (
      await db.query("SELECT task_id FROM cr_memory_candidates WHERE id=$1", [
        id,
      ])
    ).rows[0];
    if (!ref)
      throw new HttpError(404, "NOT_FOUND", "기억 제안을 찾을 수 없어요.");
    const task = await getTask(db, user, ref.task_id, true);
    const c = (
      await db.query(
        "SELECT * FROM cr_memory_candidates WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    requireRead(user, c);
    if (
      c.owner_id !== user.id &&
      !(user.role === "lead" && c.visibility !== "private")
    )
      throw new HttpError(
        403,
        "MEMORY_OWNER_REQUIRED",
        "기억 제안의 요청자 또는 공유 기억 관리자가 처리할 수 있어요.",
      );
    if (c.status !== "pending")
      return { status: c.status, memoryId: c.memory_id };
    let memoryId = null;
    if (v.action === "accept") {
      const doc = (await documentsByKeys(db, [c.source_key])).get(c.source_key);
      const provenance = doc ? await sourceProvenance(db, doc) : null;
      if (
        !doc ||
        !sourceAllowed(user, task, doc) ||
        !agentSourceAllowed(doc, c.agent_id) ||
        !effectiveAt(c) ||
        !effectiveAt({
          valid_from: provenance?.validFrom,
          valid_to: provenance?.validTo,
        }) ||
        doc.revision !== c.source_revision ||
        !doc.body.includes(c.source_quote) ||
        !(await validReferences(
          db,
          user,
          task,
          [reference(doc), ...(doc.dependencies || [])],
          { lock: true },
        ))
      )
        throw new HttpError(
          409,
          "MEMORY_PROOF_CHANGED",
          "제안의 원문이 변경됐어요. 새 근거를 확인해주세요.",
        );
      // Use the existing transaction: a failed promotion must not leave an orphan memory.
      const saved = await createMemory(
        null,
        user,
        {
          agentId: c.agent_id,
          visibility: c.visibility,
          title: c.title,
          body: c.body,
          source: "검토한 기억 제안 · " + doc.source,
          sourceTaskId: c.task_id,
          sourceKey: c.source_key,
          validFrom: c.valid_from?.toISOString() || null,
          validTo: c.valid_to?.toISOString() || null,
          kind: c.kind,
          audience: c.audience,
          project: c.project,
        },
        db,
      );
      memoryId = saved.id;
    }
    const status = v.action === "accept" ? "accepted" : "dismissed";
    await db.query(
      "UPDATE cr_memory_candidates SET status=$2,memory_id=$3,resolved_at=now() WHERE id=$1",
      [id, status, memoryId],
    );
    await event(
      db,
      c.task_id,
      { type: "user", id: user.id },
      "memory_proposal_resolved",
      { proposalId: id, status },
    );
    return { status, memoryId };
  });
}
