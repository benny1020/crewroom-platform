import { fail } from "./errors.js";
import { validReferences } from "./memory.js";
import { workspaceReadRefs } from "./agent-workspace.js";

// Called inside the task/context transaction before copying a verified patch.
// Old retries may contain a patch/sourceRunId without inherited provenance.
export async function checkpointReferences(db, user, task, sourceRun) {
  const refs = [],
    seen = new Set();
  let run = sourceRun;
  const revoked = () =>
    fail(
      409,
      "CHECKPOINT_CONTEXT_REVOKED",
      "수정본의 이전 근거·권한을 확인할 수 없어요. 기존 수정본은 보존했어요. 현재 자료로 새 업무를 시작해주세요.",
    );
  while (run) {
    if (run.task_id !== task.id || seen.has(run.id) || seen.size >= 64)
      revoked();
    seen.add(run.id);
    const snapshot = run.snapshot || {},
      inherited = snapshot.execution?.checkpoint;
    refs.push(
      ...(snapshot.memoryContext?.refs || []),
      ...(snapshot.inheritedRefs || []),
      ...(snapshot.memories || []).map((m) => ({
        key: "memory:" + m.id,
        legacyRevision: m.revision,
      })),
      ...(
        await db.query("SELECT refs FROM cr_memory_reads WHERE run_id=$1", [
          run.id,
        ])
      ).rows.flatMap((r) => r.refs),
      ...(await workspaceReadRefs(db, run.id)),
    );
    if (
      inherited?.contextVersion === 1 &&
      Array.isArray(inherited.sourceRefs)
    ) {
      refs.push(...inherited.sourceRefs);
      break;
    }
    if (!inherited?.sourceRunId) break;
    if (!/^[a-f0-9-]{36}$/i.test(inherited.sourceRunId)) revoked();
    run = (
      await db.query("SELECT id,task_id,snapshot FROM cr_runs WHERE id=$1", [
        inherited.sourceRunId,
      ])
    ).rows[0];
    if (!run) revoked();
  }
  // Validate every observed version before deduplicating. Prefer a modern
  // fingerprint over a legacy numeric revision for the same memory key.
  if (!(await validReferences(db, user, task, refs, { lock: true }))) revoked();
  const byKey = new Map();
  for (const ref of refs)
    if (!byKey.has(ref.key) || ref.revision) byKey.set(ref.key, ref);
  if (byKey.size > 500) revoked();
  return [...byKey.values()];
}
