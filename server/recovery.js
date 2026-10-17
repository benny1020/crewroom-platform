import { transaction, event, digest } from "./db.js";
import { fail } from "./errors.js";
import { configuration } from "./config.js";
import { stopExecutionJob } from "./runner-client.js";

// Operator-only CLI: does not expose task titles, prompts, memories or results.
export async function confirmStopped(pool, runId, evidence) {
  if (typeof evidence !== "string" || evidence.trim().length < 10)
    fail(
      400,
      "EVIDENCE_REQUIRED",
      "기존 실행 종료를 확인한 근거 파일이 필요합니다.",
    );
  const jobs = (
    await pool.query(
      "SELECT * FROM cr_execution_jobs WHERE run_id=$1 AND status<>'stopped'",
      [runId],
    )
  ).rows;
  for (const job of jobs) {
    const result = await stopExecutionJob(
      { ...configuration(), runnerUrl: job.endpoint },
      job.job_id,
    );
    await pool.query(
      "UPDATE cr_execution_jobs SET status='stopped',checkpoint=$3,updated_at=now() WHERE run_id=$1 AND generation=$2",
      [runId, job.generation, result.checkpoint || null],
    );
  }
  return transaction(pool, async (db) => {
    const ref = (
      await db.query("SELECT task_id FROM cr_runs WHERE id=$1", [runId])
    ).rows[0];
    if (!ref) fail(404, "NOT_FOUND", "Run ID를 찾을 수 없습니다.");
    await db.query("SELECT id FROM cr_tasks WHERE id=$1 FOR UPDATE", [
      ref.task_id,
    ]);
    const run = (
      await db.query(
        "SELECT *,lease_until>clock_timestamp() AS lease_valid FROM cr_runs WHERE id=$1 FOR UPDATE",
        [runId],
      )
    ).rows[0];
    if (
      !["paused", "failed", "cancelled"].includes(run.status) ||
      run.lease_valid
    )
      fail(409, "NOT_STOPPED", "종료 상태와 임대 만료를 먼저 확인해야 합니다.");
    await db.query(
      "UPDATE cr_runs SET lease_owner=NULL,lease_until=NULL,generation=generation+1 WHERE id=$1",
      [runId],
    );
    await db.query(
      "UPDATE cr_model_dispatches SET state='aborted',updated_at=clock_timestamp() WHERE run_id=$1 AND state IN ('prepared','launched','unknown')",
      [runId],
    );
    await event(
      db,
      ref.task_id,
      { type: "system", id: "operator-cli" },
      "execution_stop_confirmed",
      {
        runId,
        previousWorker: run.lease_owner,
        evidenceHash: digest(evidence),
      },
    );
    return { runId, cleared: true };
  });
}

export async function checkpointJobs(pool) {
  const jobs = (
    await pool.query(
      "SELECT * FROM cr_execution_jobs WHERE status<>'stopped' ORDER BY run_id,generation",
    )
  ).rows;
  for (const job of jobs) {
    const result = await stopExecutionJob(
      { ...configuration(), runnerUrl: job.endpoint },
      job.job_id,
    );
    await pool.query(
      "UPDATE cr_execution_jobs SET status='stopped',checkpoint=$3,updated_at=now() WHERE run_id=$1 AND generation=$2",
      [job.run_id, job.generation, result.checkpoint || null],
    );
  }
  return { stoppedJobs: jobs.length };
}
