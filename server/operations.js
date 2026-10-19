import { requireLead, readPredicate } from "./permissions.js";

export async function workerStatus(db) {
  return (
    await db.query(
      "SELECT id,heartbeat_at,last_tick_at,last_error_code,maintenance_at,maintenance,maintenance_error_code,version,state,coalesce((heartbeat_at>now()-interval '45 seconds' AND last_tick_at>now()-interval '45 seconds' AND state='ready'),false) AS healthy FROM cr_workers ORDER BY heartbeat_at DESC LIMIT 10",
    )
  ).rows;
}

// Only tasks visible to this operator participate, including historical runs.
export async function operations(db, user) {
  requireLead(user);
  const {
    rows: [data],
  } = await db.query(
    `
    WITH visible AS (SELECT t.* FROM cr_tasks t WHERE ${readPredicate()}),
    runs AS (SELECT r.* FROM cr_runs r JOIN visible t ON t.id=r.task_id),
    calls AS (
      SELECT c.value FROM cr_artifacts a JOIN visible t ON t.id=a.task_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.result->'receipt'->'requests')='array'
          THEN a.result->'receipt'->'requests'
          ELSE jsonb_build_array(a.result->'receipt') END
      ) c(value)
      WHERE a.origin='model' AND a.created_at>=now()-interval '24 hours'
    ), usage_rows AS (
      SELECT value,
       CASE WHEN jsonb_typeof(value->'usage'->'promptTokens')='number' AND jsonb_typeof(value->'usage'->'completionTokens')='number'
        AND (value->'usage'->>'promptTokens')~'^[0-9]{1,16}$' AND (value->'usage'->>'completionTokens')~'^[0-9]{1,16}$'
       THEN (value->'usage'->>'promptTokens')::numeric<=9007199254740991 AND (value->'usage'->>'completionTokens')::numeric<=9007199254740991 ELSE false END AS valid
      FROM calls WHERE jsonb_typeof(value)='object'
    )
    SELECT
      (SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM
        (SELECT status,count(*)::int n FROM visible GROUP BY status) s) AS tasks,
      (SELECT count(*)::int FROM runs WHERE status='queued') AS queued,
      (SELECT count(*)::int FROM runs WHERE status='running') AS running,
      (SELECT min(created_at) FROM runs WHERE status='queued') AS oldest_queued_at,
      (SELECT count(*)::int FROM runs WHERE finished_at>=now()-interval '24 hours') AS finished,
      (SELECT count(*)::int FROM runs WHERE status='failed' AND finished_at>=now()-interval '24 hours') AS failed,
      (SELECT round(avg(extract(epoch FROM (finished_at-started_at))*1000))::float
        FROM runs WHERE started_at IS NOT NULL AND finished_at>=started_at
          AND finished_at>=now()-interval '24 hours') AS mean_duration_ms,
      (SELECT coalesce(jsonb_agg(x ORDER BY x.updated_at DESC),'[]') FROM
        (SELECT t.id,t.number,t.title,t.status,t.updated_at,r.error_code
         FROM visible t LEFT JOIN runs r ON r.id=t.current_run_id
         WHERE t.status IN ('failed','paused') ORDER BY t.updated_at DESC LIMIT 8) x) AS attention,
      (SELECT jsonb_build_object('recordedCalls',count(*),'usageReported',count(*) FILTER(WHERE valid),
        'inputTokens',sum(CASE WHEN valid THEN (value->'usage'->>'promptTokens')::numeric END),
        'outputTokens',sum(CASE WHEN valid THEN (value->'usage'->>'completionTokens')::numeric END)) FROM usage_rows) AS token_usage
  `,
    [user.id, user.department],
  );
  const { token_usage: usage, ...metrics } = data;
  return {
    ...metrics,
    scope: "readable-tasks",
    windowHours: 24,
    generatedAt: new Date().toISOString(),
    capacity: { global: 2, perAgent: 1 },
    usage: {
      ...usage,
      usageMissing: usage.recordedCalls - usage.usageReported,
      cost: null,
      coverage: "successful-artifact-receipts-only",
    },
  };
}

import { statfs } from "node:fs/promises";
import { pruneStaleEmbeddings } from "./memory-embedding.js";
import {
  EXACT_VECTOR_DOCUMENT_LIMIT,
  EXACT_VECTOR_VALUE_LIMIT,
  EXACT_VECTOR_BYTE_LIMIT,
} from "./memory.js";

// Read-only, administrative diagnostics. Never served through member APIs.
export async function operationStats(db, dataDir) {
  const tables = (
    await db.query(`SELECT c.relname AS name,
    greatest(c.reltuples,0)::bigint AS estimated_rows,pg_total_relation_size(c.oid)::text AS bytes,
    s.n_live_tup,s.n_dead_tup,s.last_autovacuum,s.last_autoanalyze
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
    WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname LIKE 'cr_%'
    ORDER BY pg_total_relation_size(c.oid) DESC`)
  ).rows;
  const storage = (
    await db.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
    pg_size_bytes(current_setting('shared_buffers'))::text AS shared_buffers_bytes,
    current_setting('autovacuum') AS autovacuum,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction') AS idle_transactions`)
  ).rows[0];
  const vectorProfiles = (
    await db.query(`SELECT profile_id,count(*)::int AS ready_documents,coalesce(sum(vector_values),0)::text AS vector_values,coalesce(sum(vector_bytes),0)::text AS vector_bytes
    FROM cr_memory_embeddings WHERE status='ready' GROUP BY profile_id`)
  ).rows.map((r) => ({
    ...r,
    mode:
      r.ready_documents > EXACT_VECTOR_DOCUMENT_LIMIT ||
      Number(r.vector_values) > EXACT_VECTOR_VALUE_LIMIT ||
      Number(r.vector_bytes) > EXACT_VECTOR_BYTE_LIMIT
        ? "semantic_capacity_blocked"
        : "bounded_exact_vectors",
  }));
  const embeddingIndex = (
    await db.query(
      "SELECT profile_id,status,error_code,count(*)::int AS documents FROM cr_memory_embeddings GROUP BY profile_id,status,error_code ORDER BY profile_id,status,error_code",
    )
  ).rows;
  let filesystem = null;
  if (dataDir) {
    try {
      const s = await statfs(dataDir, { bigint: true });
      filesystem = {
        availableBytes: String(s.bavail * s.bsize),
        totalBytes: String(s.blocks * s.bsize),
        usedPercent: Number(((s.blocks - s.bavail) * 100n) / s.blocks),
      };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return {
    at: new Date().toISOString(),
    storage,
    filesystem,
    tables,
    vectorProfiles,
    embeddingIndex,
    workers: await workerStatus(db),
    limits: {
      messagePage: 40,
      runPage: 12,
      resultPage: 8,
      exactVectorDocuments: EXACT_VECTOR_DOCUMENT_LIMIT,
      exactVectorValues: EXACT_VECTOR_VALUE_LIMIT,
      exactVectorBytes: EXACT_VECTOR_BYTE_LIMIT,
    },
    notices: [
      "Table rows are PostgreSQL estimates; run ANALYZE after bulk imports.",
      "Cache counts do not prove recall coverage; each semantic lookup verifies live scoped source revisions.",
      "Filesystem describes DATA_DIR's mounted filesystem, not every database/backup volume.",
      "No original conversations, results, memories or recovery records are pruned.",
    ],
  };
}
// Only expired authentication state is disposable. Preserve all work/recovery data.
export async function maintain(db, { apply = false, batch = 500 } = {}) {
  if (!Number.isInteger(batch) || batch < 1 || batch > 1000)
    throw Error("INVALID_MAINTENANCE_BATCH");
  const candidates = (
    await db.query(
      `SELECT token_hash FROM cr_sessions WHERE expires_at<clock_timestamp() ORDER BY expires_at,token_hash LIMIT $1`,
      [batch],
    )
  ).rows;
  let removed = 0;
  if (apply && candidates.length)
    removed = (
      await db.query(
        `DELETE FROM cr_sessions WHERE token_hash=ANY($1::text[]) AND expires_at<clock_timestamp()`,
        [candidates.map((r) => r.token_hash)],
      )
    ).rowCount;
  const attempts = (
    await db.query(
      "SELECT key FROM cr_auth_attempts WHERE window_start<clock_timestamp()-interval '24 hours' ORDER BY window_start,key LIMIT $1",
      [batch],
    )
  ).rows;
  let removedAuthAttempts = 0;
  if (apply && attempts.length)
    removedAuthAttempts = (
      await db.query(
        "DELETE FROM cr_auth_attempts WHERE key=ANY($1::text[]) AND window_start<clock_timestamp()-interval '24 hours'",
        [attempts.map((r) => r.key)],
      )
    ).rowCount;
  const cache = await pruneStaleEmbeddings(db, {
    apply,
    batch: Math.min(batch, 100),
  });
  return {
    mode: apply ? "apply" : "dry-run",
    expiredSessionCandidates: candidates.length,
    removed,
    expiredAuthAttemptCandidates: attempts.length,
    removedAuthAttempts,
    staleEmbeddingCandidates: cache.candidates,
    removedStaleEmbeddings: cache.removed,
    hasMore:
      candidates.length === batch || attempts.length === batch || cache.hasMore,
    batch,
  };
}
