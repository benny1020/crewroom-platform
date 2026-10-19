import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  database,
  transaction,
  event,
  digest,
  assertRuntimeReady,
  lockContextMutation,
} from "./db.js";
import { configuration } from "./config.js";
import { canRead } from "./permissions.js";
import { collectInput, collectCodeInput } from "./inputs.js";
import { runModel } from "./provider.js";
import { runMemoryAgent } from "./memory-agent.js";
import { recordProposal } from "./memory-learning.js";
import {
  searchMemory,
  contextFromDocuments,
  validReferences,
  documentsByKeys,
} from "./memory.js";
import {
  embeddingProfile,
  embedTexts,
  indexNextMemoryDocument,
} from "./memory-embedding.js";
import { runCodeAgent } from "./runner-client.js";
import { insertArtifact } from "./tasks.js";
import { HttpError } from "./errors.js";

export async function contextAllowed(db, run, task) {
  try {
    await assertRuntimeReady(db);
  } catch {
    return false;
  }
  const user = (
    await db.query("SELECT * FROM cr_members WHERE id=$1 FOR SHARE", [
      run.requested_by,
    ])
  ).rows[0];
  if (!canRead(user, task)) return false;
  const reads = (
    await db.query("SELECT refs FROM cr_memory_reads WHERE run_id=$1", [run.id])
  ).rows;
  const refs = [
    ...(run.snapshot.memoryContext?.refs || []),
    ...reads.flatMap((r) => r.refs),
  ];
  if (!(await validReferences(db, user, task, refs, { lock: true })))
    return false;
  for (const pinned of [...run.snapshot.memories].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const m = (
      await db.query("SELECT * FROM cr_memories WHERE id=$1 FOR SHARE", [
        pinned.id,
      ])
    ).rows[0];
    if (
      !m ||
      m.deleted_at ||
      m.revision !== pinned.revision ||
      !canRead(user, m)
    )
      return false;
    if (
      m.visibility !== "team" &&
      (task.visibility === "team" ||
        (task.visibility === "department" &&
          (m.visibility !== "department" || m.department !== task.department)))
    )
      return false;
  }
  return true;
}
async function lockedRun(db, id) {
  await lockContextMutation(db);
  const ref = (await db.query("SELECT task_id FROM cr_runs WHERE id=$1", [id]))
    .rows[0];
  if (!ref) return {};
  const task = (
    await db.query("SELECT * FROM cr_tasks WHERE id=$1 FOR UPDATE", [
      ref.task_id,
    ])
  ).rows[0];
  const run = (
    await db.query(
      "SELECT *,lease_until>clock_timestamp() AS lease_valid FROM cr_runs WHERE id=$1 FOR UPDATE",
      [id],
    )
  ).rows[0];
  return { task, run };
}
const owns = (run, owner, generation) =>
  run?.status === "running" &&
  run.lease_owner === owner &&
  run.generation === generation &&
  run.lease_valid === true;
export async function claimRun(pool, owner, config) {
  return transaction(pool, async (db) => {
    await lockContextMutation(db);
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('crewroom-run-claim'))",
    );
    const active = Number(
      (
        await db.query(
          "SELECT count(*) FROM cr_runs WHERE status='running' OR (status='paused' AND started_at IS NOT NULL) OR lease_owner IS NOT NULL",
        )
      ).rows[0].count,
    );
    if (active >= 2) return null;
    const { rows } = await db.query(
      `SELECT r.* FROM cr_runs r JOIN cr_tasks t ON t.id=r.task_id AND t.current_run_id=r.id WHERE r.status='queued' AND NOT EXISTS(SELECT 1 FROM cr_runs other WHERE other.id<>r.id AND other.agent_id=r.agent_id AND (other.status='running' OR (other.status='paused' AND other.started_at IS NOT NULL) OR other.lease_owner IS NOT NULL)) ORDER BY r.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
    );
    const run = rows[0];
    if (!run) return null;
    const task = (
      await db.query("SELECT * FROM cr_tasks WHERE id=$1", [run.task_id])
    ).rows[0];
    if (!(await contextAllowed(db, run, task))) {
      await db.query(
        "UPDATE cr_runs SET status='failed',error_code='CONTEXT_REVOKED',error_message='권한 또는 기억이 변경되어 새 실행이 필요해요.',finished_at=now() WHERE id=$1",
        [run.id],
      );
      await db.query(
        "UPDATE cr_tasks SET status='failed',revision=revision+1,updated_at=now() WHERE id=$1",
        [task.id],
      );
      await event(db, task.id, { type: "run", id: run.id }, "context_revoked");
      return null;
    }
    const claimed = (
      await db.query(
        "UPDATE cr_runs SET status='running',generation=generation+1,lease_owner=$2,lease_until=clock_timestamp()+($3*interval '1 second'),started_at=coalesce(started_at,now()) WHERE id=$1 RETURNING *",
        [run.id, owner, config.workerLeaseSeconds],
      )
    ).rows[0];
    await db.query(
      "UPDATE cr_tasks SET status='running',revision=revision+1,updated_at=now() WHERE id=$1",
      [task.id],
    );
    await event(db, task.id, { type: "run", id: run.id }, "run_started", {
      generation: claimed.generation,
      agentId: run.agent_id,
    });
    return claimed;
  });
}
export async function renewRun(pool, id, owner, generation, config) {
  return transaction(pool, async (db) => {
    const { task, run } = await lockedRun(db, id);
    if (!owns(run, owner, generation) || !(await contextAllowed(db, run, task)))
      return false;
    return Boolean(
      (
        await db.query(
          "UPDATE cr_runs SET lease_until=clock_timestamp()+($2*interval '1 second') WHERE id=$1 AND lease_until>clock_timestamp() RETURNING id",
          [id, config.workerLeaseSeconds],
        )
      ).rowCount,
    );
  });
}
export async function completeRun(pool, id, owner, generation, value) {
  return transaction(pool, async (db) => {
    const { task, run } = await lockedRun(db, id);
    if (!owns(run, owner, generation) || !(await contextAllowed(db, run, task)))
      return false;
    const step = (
      await db.query(
        "SELECT * FROM cr_steps WHERE task_id=$1 AND position=$2",
        [task.id, task.step_index],
      )
    ).rows[0];
    if (
      task.current_run_id !== id ||
      task.step_index !== run.step_index ||
      task.target_version !== run.snapshot.targetVersion ||
      (step.input_artifact_id || null) !== run.snapshot.inputArtifactId
    )
      return false;
    if (
      !(
        await db.query(
          "UPDATE cr_runs SET status='succeeded',lease_owner=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=$1 AND lease_until>clock_timestamp() RETURNING id",
          [id],
        )
      ).rowCount
    )
      return false;
    const artifact = await insertArtifact(db, task, task.step_index, {
      runId: id,
      origin: value.origin,
      result: {
        ...value.result,
        receipt: value.receipt,
        inputHash: run.snapshot.inputHash,
        verification: value.result.execution
          ? value.result.execution.passed
            ? "checks_passed"
            : "checks_failed"
          : "unverified",
      },
    });
    await db.query(
      "UPDATE cr_tasks SET status='result_ready',revision=revision+1,updated_at=now() WHERE id=$1",
      [task.id],
    );
    await db.query(
      "UPDATE cr_model_dispatches SET state='completed',updated_at=clock_timestamp() WHERE run_id=$1 AND generation=$2",
      [id, generation],
    );
    await event(db, task.id, { type: "run", id }, "result_ready", {
      artifactId: artifact.id,
      version: artifact.version,
      origin: value.origin,
    });
    return artifact;
  });
}
export async function failRun(pool, id, owner, generation, error) {
  return transaction(pool, async (db) => {
    const { task, run } = await lockedRun(db, id);
    const code =
      error instanceof HttpError
        ? error.code
        : error.name === "AbortError"
          ? "RUN_ABORTED"
          : "EXECUTION_FAILED";
    const message =
      error instanceof HttpError
        ? error.message
        : "실행을 완료하지 못했어요. 설정과 실행 기록을 확인해주세요.";
    if (
      code === "DISPATCH_UNKNOWN" &&
      run?.lease_owner === owner &&
      (run.generation === generation ||
        (run.generation === generation + 1 &&
          ["paused", "cancelled", "failed"].includes(run.status) &&
          run.error_code !== "DISPATCH_UNKNOWN"))
    ) {
      await db.query(
        "UPDATE cr_runs SET status=CASE WHEN status='running' THEN 'failed' ELSE status END,generation=generation+1,error_code=$2,error_message=$3,finished_at=now() WHERE id=$1",
        [id, code, message],
      );
      await db.query(
        "UPDATE cr_tasks SET status=CASE WHEN status='running' THEN 'failed' ELSE status END,revision=revision+1,updated_at=now() WHERE id=$1",
        [task.id],
      );
      await event(
        db,
        task.id,
        { type: "run", id },
        "dispatch_confirmation_required",
        { code, message },
      );
      return true;
    }
    if (!owns(run, owner, generation)) return false;
    await db.query(
      "UPDATE cr_runs SET status='failed',lease_owner=NULL,lease_until=NULL,error_code=$2,error_message=$3,finished_at=now() WHERE id=$1",
      [id, code, message],
    );
    await db.query(
      "UPDATE cr_tasks SET status='failed',revision=revision+1,updated_at=now() WHERE id=$1",
      [task.id],
    );
    await event(db, task.id, { type: "run", id }, "run_failed", {
      code,
      message,
    });
    return true;
  });
}
export async function expireRuns(pool) {
  return transaction(pool, async (db) => {
    await lockContextMutation(db);
    const { rows } = await db.query(
      "SELECT r.id,r.task_id FROM cr_runs r JOIN cr_tasks t ON t.id=r.task_id WHERE r.status='running' AND r.lease_until<clock_timestamp() FOR UPDATE OF t SKIP LOCKED",
    );
    for (const ref of rows) {
      await db.query(
        "UPDATE cr_runs SET status='failed',generation=generation+1,error_code='LEASE_EXPIRED',error_message='이전 실행 종료를 확인한 뒤 다시 요청해주세요.',finished_at=now() WHERE id=$1 AND status='running' AND lease_until<clock_timestamp()",
        [ref.id],
      );
      await db.query(
        "UPDATE cr_tasks SET status='failed',revision=revision+1,updated_at=now() WHERE id=$1 AND current_run_id=$2",
        [ref.task_id, ref.id],
      );
      await event(
        db,
        ref.task_id,
        { type: "system", id: "lease-recovery" },
        "recovery_required",
        { runId: ref.id },
      );
    }
    return rows.length;
  });
}
async function acknowledgeStop(pool, run, owner) {
  await pool.query(
    "UPDATE cr_runs SET lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND status IN ('paused','cancelled','failed') AND generation>$3 AND coalesce(error_code,'') NOT IN ('DISPATCH_UNKNOWN','RESTORE_CONFIRMATION_REQUIRED') AND NOT EXISTS (SELECT 1 FROM cr_execution_jobs j WHERE j.run_id=cr_runs.id AND j.status<>'stopped') AND NOT EXISTS (SELECT 1 FROM cr_model_dispatches d WHERE d.run_id=cr_runs.id AND d.state IN ('prepared','launched','unknown'))",
    [run.id, owner, run.generation],
  );
}
export async function dispatchRun(pool, run, owner, send) {
  const intentId = randomUUID();
  await transaction(pool, async (db) => {
    const locked = await lockedRun(db, run.id);
    if (
      !owns(locked.run, owner, run.generation) ||
      !(await contextAllowed(db, locked.run, locked.task))
    )
      throw new HttpError(
        409,
        "DISPATCH_REVOKED",
        "실행 또는 자료 권한이 변경되어 모델 호출을 발송하지 않았어요.",
      );
    await db.query(
      "INSERT INTO cr_model_dispatches(id,run_id,generation,input_hash,state) VALUES($1,$2,$3,$4,'prepared')",
      [intentId, run.id, run.generation, run.snapshot.inputHash || null],
    );
  });
  let launched = false;
  try {
    const holder = await transaction(pool, async (db) => {
      const locked = await lockedRun(db, run.id);
      if (
        !owns(locked.run, owner, run.generation) ||
        !(await contextAllowed(db, locked.run, locked.task))
      )
        throw new HttpError(
          409,
          "DISPATCH_REVOKED",
          "실행 또는 자료 권한이 변경되어 모델 호출을 발송하지 않았어요.",
        );
      await db.query(
        "UPDATE cr_model_dispatches SET state='launched',updated_at=clock_timestamp() WHERE id=$1",
        [intentId],
      );
      await event(
        db,
        run.task_id,
        { type: "run", id: run.id },
        "model_dispatched",
        {
          generation: run.generation,
          inputHash: run.snapshot.inputHash,
          intentId,
        },
      );
      if (
        !(
          await db.query(
            "SELECT 1 FROM cr_runs WHERE id=$1 AND lease_until>clock_timestamp()",
            [run.id],
          )
        ).rowCount
      )
        throw new HttpError(409, "LEASE_EXPIRED", "실행 임대가 만료됐어요.");
      launched = true;
      const response = send();
      Promise.resolve(response).catch(() => {});
      return { response };
    });
    const response = await holder.response;
    await pool.query(
      "UPDATE cr_model_dispatches SET state='responded',response_status=$2,request_id=$3,updated_at=clock_timestamp() WHERE id=$1",
      [
        intentId,
        response?.status || null,
        response?.headers?.get("x-request-id") || null,
      ],
    );
    return response;
  } catch (error) {
    await pool
      .query(
        "UPDATE cr_model_dispatches SET state=$2,updated_at=clock_timestamp() WHERE id=$1",
        [intentId, launched ? "unknown" : "aborted"],
      )
      .catch(() => {});
    if (launched)
      throw new HttpError(
        503,
        "DISPATCH_UNKNOWN",
        "모델 요청의 발송 또는 응답 상태가 불명확해요. 운영 담당자가 이전 실행을 확인해야 합니다.",
      );
    throw error;
  }
}
export async function recallForRun(pool, run, owner, action, semantic = {}) {
  return transaction(pool, async (db) => {
    const locked = await lockedRun(db, run.id);
    if (
      !owns(locked.run, owner, run.generation) ||
      !(await contextAllowed(db, locked.run, locked.task))
    )
      throw new HttpError(
        409,
        "CONTEXT_REVOKED",
        "실행 또는 기억의 접근 범위가 변경됐어요.",
      );
    const user = (
      await db.query("SELECT * FROM cr_members WHERE id=$1", [run.requested_by])
    ).rows[0];
    const count = Number(
      (
        await db.query(
          "SELECT count(*) FROM cr_memory_reads WHERE run_id=$1 AND generation=$2",
          [run.id, run.generation],
        )
      ).rows[0].count,
    );
    if (count >= 4)
      throw new HttpError(
        409,
        "MEMORY_LOOKUP_LIMIT",
        "이번 실행의 기억 조회 한도에 도달했어요.",
      );
    if (action.action === "propose_memory")
      return recordProposal(db, user, locked.task, run, action, count + 1);
    const docs = await searchMemory(db, user, locked.task, {
      query: action.query || "",
      keys: action.action === "read_memory" ? [action.key] : null,
      agentId: run.agent_id,
      project:
        action.action === "read_memory" || action.project === "*"
          ? ""
          : action.project || locked.task.project,
      ...semantic,
      before: run.created_at,
      asOf: action.asOf || run.created_at,
      limit: action.action === "read_memory" ? 1 : 10,
    });
    if (action.action === "read_memory")
      for (const d of docs)
        d.excerpt = d.body.slice(
          action.offset || 0,
          (action.offset || 0) + 7000,
        );
    const context = contextFromDocuments(
      docs.filter(
        (d) =>
          !(d.kind === "episode" && d.task_id === run.task_id) &&
          !d.dependencies?.some((r) => r.key === "episode:" + run.task_id),
      ),
      action.action === "read_memory" ? 10000 : 6000,
    );
    if (
      !(await validReferences(db, user, locked.task, context.refs, {
        lock: true,
      }))
    )
      throw new HttpError(409, "CONTEXT_REVOKED", "기억의 원본이 변경됐어요.");
    await db.query(
      "INSERT INTO cr_memory_reads(run_id,generation,sequence,query,refs) VALUES($1,$2,$3,$4,$5)",
      [
        run.id,
        run.generation,
        count + 1,
        action.query || action.key,
        JSON.stringify(context.refs),
      ],
    );
    return {
      items: context.items,
      found: context.items.length,
      method: docs.some((d) => d.semantic > 0) ? "hybrid" : "keyword",
      semanticStatus: docs.semanticStatus,
      nextOffset:
        action.action === "read_memory" &&
        docs[0] &&
        (action.offset || 0) + 7000 < docs[0].body.length
          ? (action.offset || 0) + 7000
          : null,
      notice: "과거 기록입니다. 검사·승인·진행 상태는 현재 원본을 확인하세요.",
    };
  });
}
async function semanticContext(pool, run, owner, config, options) {
  const profile = embeddingProfile(config);
  if (!profile) return;
  if (profile.id !== run.snapshot.embeddingProfile?.id)
    throw new HttpError(
      409,
      "EMBEDDING_PROFILE_CHANGED",
      "의미 검색 연결이 변경됐어요. 새 실행을 시작해주세요.",
    );
  const query = [run.snapshot.messages?.at(-1)?.body, run.snapshot.goal]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2400);
  let vector;
  try {
    [vector] = await embedTexts([query], config, {
      ...options,
      dispatch: (send) => dispatchRun(pool, run, owner, send),
    });
  } catch (error) {
    if (error.code === "DISPATCH_UNKNOWN" || error.code === "DISPATCH_REVOKED")
      throw error;
    run.snapshot.memoryContext.semanticStatus = "unavailable";
    return;
  }
  await transaction(pool, async (db) => {
    const locked = await lockedRun(db, run.id),
      user = (
        await db.query("SELECT * FROM cr_members WHERE id=$1", [
          run.requested_by,
        ])
      ).rows[0];
    if (
      !owns(locked.run, owner, run.generation) ||
      !(await contextAllowed(db, locked.run, locked.task))
    )
      throw new HttpError(409, "CONTEXT_REVOKED", "실행 문맥이 변경됐어요.");
    const docs = await searchMemory(db, user, locked.task, {
      query,
      vector,
      profileId: profile.id,
      agentId: run.agent_id,
      project: locked.task.project,
      before: run.created_at,
      limit: 60,
    });
    const base = await documentsByKeys(
      db,
      run.snapshot.memoryContext.items.map((i) => i.key),
    );
    for (const d of base.values())
      if (!docs.some((s) => s.key === d.key)) docs.push(d);
    const context = contextFromDocuments(
      docs.filter(
        (d) =>
          !(d.kind === "episode" && d.task_id === run.task_id) &&
          !d.dependencies?.some((r) => r.key === "episode:" + run.task_id),
      ),
    );
    if (
      !(await validReferences(db, user, locked.task, context.refs, {
        lock: true,
      }))
    )
      throw new HttpError(409, "CONTEXT_REVOKED", "기억의 원본이 변경됐어요.");
    run.snapshot.memoryContext = {
      ...context,
      method: docs.some((d) => d.semantic > 0) ? "hybrid" : "keyword",
      semanticStatus: docs.semanticStatus,
    };
  });
}
export async function processRun(pool, run, owner, config, dependencies = {}) {
  const controller = new AbortController();
  const onShutdown = () => controller.abort();
  dependencies.workerSignal?.addEventListener("abort", onShutdown, {
    once: true,
  });
  if (dependencies.workerSignal?.aborted) controller.abort();
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (!(await renewRun(pool, run.id, owner, run.generation, config)))
        controller.abort();
    } catch {
      controller.abort();
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(check, Math.min(config.workerHeartbeatMs, 2000));
  try {
    const source = await (
      run.snapshot.execution ? collectCodeInput : collectInput
    )(run.snapshot, {
      config,
      signal: controller.signal,
      ...dependencies,
    });
    if (!run.snapshot.inputHash && run.snapshot.memoryContext)
      await semanticContext(pool, run, owner, config, {
        signal: controller.signal,
        ...dependencies,
      });
    run.snapshot = {
      ...run.snapshot,
      source,
      inputHash: digest({ ...run.snapshot, source }),
    };
    const stored = await transaction(pool, async (db) => {
      const locked = await lockedRun(db, run.id);
      if (
        !owns(locked.run, owner, run.generation) ||
        !(await contextAllowed(db, locked.run, locked.task))
      )
        return false;
      if (locked.run.snapshot.inputHash) {
        run.snapshot = locked.run.snapshot;
        return true;
      }
      const actor = (
        await db.query("SELECT * FROM cr_members WHERE id=$1", [
          run.requested_by,
        ])
      ).rows[0];
      if (
        !(await validReferences(
          db,
          actor,
          locked.task,
          run.snapshot.memoryContext?.refs || [],
          { lock: true },
        ))
      )
        return false;
      await db.query("UPDATE cr_runs SET snapshot=$2 WHERE id=$1", [
        run.id,
        run.snapshot,
      ]);
      return true;
    });
    if (!stored)
      throw new HttpError(409, "STALE_EXECUTION", "실행 소유권이 변경됐어요.");
    const folder = join(config.dataDir, "runs", run.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        join(folder, "input.json"),
        JSON.stringify(run.snapshot, null, 2),
        { flag: "wx", mode: 0o400 },
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = JSON.parse(
        await readFile(join(folder, "input.json"), "utf8"),
      );
      if (previous.inputHash !== run.snapshot.inputHash)
        throw new Error("Immutable input mismatch");
    }
    // Check immediately before dispatch as well as during the request.
    if (!(await renewRun(pool, run.id, owner, run.generation, config)))
      throw new HttpError(
        409,
        "STALE_EXECUTION",
        "실행 소유권 또는 자료 권한이 변경됐어요.",
      );
    const modelOptions = {
      signal: controller.signal,
      ...dependencies,
      dispatch: (send) => dispatchRun(pool, run, owner, send),
      memoryTools: async (action) => {
        let semantic = {};
        if (action.action === "search_memory" && config.embeddingUrl) {
          try {
            const [vector] = await embedTexts([action.query], config, {
              signal: controller.signal,
              ...dependencies,
              dispatch: (send) => dispatchRun(pool, run, owner, send),
            });
            semantic = { vector, profileId: embeddingProfile(config).id };
          } catch (error) {
            if (
              error.code === "DISPATCH_UNKNOWN" ||
              error.code === "DISPATCH_REVOKED"
            )
              throw error;
          }
        }
        return recallForRun(pool, run, owner, action, semantic);
      },
    };
    const value = run.snapshot.execution
      ? await runCodeAgent(pool, run, config, modelOptions)
      : await (dependencies.runModel || runMemoryAgent)(
          run.snapshot,
          config,
          modelOptions,
        );
    if (!(await completeRun(pool, run.id, owner, run.generation, value)))
      throw new HttpError(
        409,
        "STALE_EXECUTION",
        "이전 실행의 결과는 반영하지 않았어요.",
      );
  } catch (error) {
    await failRun(pool, run.id, owner, run.generation, error);
  } finally {
    clearInterval(timer);
    dependencies.workerSignal?.removeEventListener("abort", onShutdown);
    controller.abort();
    await acknowledgeStop(pool, run, owner);
  }
}
export async function startWorker(
  pool,
  config = configuration(),
  dependencies = {},
) {
  await assertRuntimeReady(pool);
  const owner = `worker-${randomUUID()}`,
    pending = new Set(),
    shutdown = new AbortController();
  let indexing = null,
    lastIndex = 0;
  let stopping = false,
    ticking = false,
    tickPromise = Promise.resolve();
  await pool.query(
    "INSERT INTO cr_workers(id,version,state) VALUES($1,$2,'ready')",
    [owner, config.release],
  );
  const tick = async () => {
    if (stopping || ticking) return;
    ticking = true;
    try {
      await pool.query(
        "UPDATE cr_workers SET heartbeat_at=now(),state='ready' WHERE id=$1",
        [owner],
      );
      await expireRuns(pool);
      if (config.embeddingUrl && !indexing && Date.now() - lastIndex >= 5000) {
        lastIndex = Date.now();
        indexing = indexNextMemoryDocument(pool, config, {
          signal: shutdown.signal,
          ...dependencies,
        })
          .catch(() => {})
          .finally(() => {
            indexing = null;
          });
      }
      if (!stopping && pending.size < 2) {
        const run = await claimRun(pool, owner, config);
        if (run && stopping) {
          await transaction(pool, async (db) => {
            const locked = await lockedRun(db, run.id);
            if (owns(locked.run, owner, run.generation)) {
              await db.query(
                "UPDATE cr_runs SET status='queued',lease_owner=NULL,lease_until=NULL,generation=generation+1 WHERE id=$1",
                [run.id],
              );
              await db.query(
                "UPDATE cr_tasks SET status='queued',revision=revision+1 WHERE id=$1",
                [run.task_id],
              );
            }
          });
        } else if (run) {
          const work = processRun(pool, run, owner, config, {
            ...dependencies,
            workerSignal: shutdown.signal,
          })
            .catch(() => {})
            .finally(() => pending.delete(work));
          pending.add(work);
        }
      }
    } finally {
      ticking = false;
    }
  };
  const schedule = () => {
    if (stopping || ticking) return tickPromise;
    tickPromise = tick().catch(() => {});
    return tickPromise;
  };
  const interval = setInterval(schedule, 500);
  await schedule();
  return {
    owner,
    async stop() {
      stopping = true;
      clearInterval(interval);
      shutdown.abort();
      await tickPromise;
      await Promise.allSettled([...pending, ...(indexing ? [indexing] : [])]);
      await pool.query(
        "UPDATE cr_workers SET state='stopped',heartbeat_at=now() WHERE id=$1",
        [owner],
      );
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const pool = database(),
    worker = await startWorker(pool);
  console.log("Crewroom worker ready");
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
      await worker.stop();
      await pool.end();
      process.exit(0);
    });
}
