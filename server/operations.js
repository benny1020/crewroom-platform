import { requireLead, readPredicate } from "./permissions.js";

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
      (SELECT coalesce(jsonb_agg(value),'[]') FROM calls WHERE jsonb_typeof(value)='object') AS receipts
  `,
    [user.id, user.department],
  );
  let inputTokens = 0,
    outputTokens = 0,
    usageReported = 0;
  for (const r of data.receipts) {
    const u = r?.usage;
    if (
      u &&
      Number.isSafeInteger(u.promptTokens) &&
      u.promptTokens >= 0 &&
      Number.isSafeInteger(u.completionTokens) &&
      u.completionTokens >= 0
    ) {
      usageReported++;
      inputTokens += u.promptTokens;
      outputTokens += u.completionTokens;
    }
  }
  const { receipts, ...metrics } = data;
  return {
    ...metrics,
    scope: "readable-tasks",
    windowHours: 24,
    generatedAt: new Date().toISOString(),
    capacity: { global: 2, perAgent: 1 },
    usage: {
      recordedCalls: receipts.length,
      usageReported,
      usageMissing: receipts.length - usageReported,
      inputTokens: usageReported ? inputTokens : null,
      outputTokens: usageReported ? outputTokens : null,
      cost: null,
      coverage: "successful-artifact-receipts-only",
    },
  };
}
