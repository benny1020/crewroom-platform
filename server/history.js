import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import { requireRead, readPredicate } from "./permissions.js";

export const HISTORY_LIMIT = 40;
const definitions = {
  messages: {
    table: "cr_messages",
    fields: "h.*,u.name AS author",
    join: "JOIN cr_members u ON u.id=h.user_id",
    numeric: true,
  },
  events: { table: "cr_events", numeric: true },
  runs: {
    limit: 12,
    table: "cr_runs",
    fields:
      "h.id,h.task_id,h.agent_id,h.step_index,h.status,h.generation,h.lease_owner,h.lease_until,h.progress,h.error_code,h.error_message,h.created_at,h.started_at,h.finished_at,jsonb_build_object('agent',jsonb_build_object('id',h.snapshot->'agent'->'id','name',h.snapshot->'agent'->'name','configVersion',h.snapshot->'agent'->'configVersion'),'skill',jsonb_build_object('id',h.snapshot->'skill'->'id','name',h.snapshot->'skill'->'name','version',h.snapshot->'skill'->'version'),'targetVersion',h.snapshot->'targetVersion','inputArtifactId',h.snapshot->'inputArtifactId','provider',h.snapshot->'provider','model',h.snapshot->'model','inputHash',h.snapshot->'inputHash','questionRevision',coalesce(h.snapshot->'questionRevision','0'::jsonb),'rework',h.snapshot->'rework','memoryContext',CASE WHEN h.snapshot ? 'memoryContext' THEN jsonb_build_object('version',h.snapshot->'memoryContext'->'version','count',jsonb_array_length(h.snapshot->'memoryContext'->'items'),'method',h.snapshot->'memoryContext'->'method','semanticStatus',h.snapshot->'memoryContext'->'semanticStatus','characters',h.snapshot->'memoryContext'->'characters') ELSE NULL END,'execution',CASE WHEN h.snapshot ? 'execution' THEN jsonb_build_object('mode',h.snapshot->'execution'->'mode') ELSE NULL END,'source',CASE WHEN h.snapshot ? 'source' THEN jsonb_build_object('url',h.snapshot->'source'->'url','sha',h.snapshot->'source'->'sha','hash',h.snapshot->'source'->'hash') ELSE NULL END) AS snapshot",
  },
  artifacts: { limit: 8, table: "cr_artifacts" },
  questions: { limit: 20, table: "cr_questions" },
  briefs: {
    limit: 12,
    table: "cr_brief_revisions",
    fields: "h.id,h.body",
    numeric: true,
  },
  acceptances: { limit: 12, table: "cr_acceptances" },
};
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const key = (row, definition) =>
  definition.numeric ? [String(row.id)] : [row.history_time, row.id];
function decode(value, scope, numeric) {
  if (!value) return null;
  try {
    if (value.length > 900 || !/^[\w-]+$/.test(value)) throw Error();
    const c = JSON.parse(Buffer.from(value, "base64url").toString());
    const valid = (a) =>
      Array.isArray(a) &&
      (numeric
        ? a.length === 1 &&
          /^[1-9]\d{0,18}$/.test(a[0]) &&
          BigInt(a[0]) <= 9223372036854775807n
        : a.length === 2 &&
          typeof a[0] === "string" &&
          Number.isFinite(Date.parse(a[0])) &&
          /^[a-f0-9-]{36}$/.test(a[1]));
    if (c.v !== 1 || c.scope !== scope || !valid(c.before) || !valid(c.ceiling))
      throw Error();
    return c;
  } catch {
    fail(
      400,
      "INVALID_CURSOR",
      "이력 위치가 유효하지 않아요. 최근 기록부터 다시 열어주세요.",
    );
  }
}
export async function historyPage(
  db,
  taskId,
  kind,
  { cursor = "", q = "" } = {},
) {
  const d = definitions[kind];
  if (!d) fail(404, "NOT_FOUND", "이력 종류를 찾을 수 없어요.");
  q = String(q).trim();
  if (q.length > 200 || (q && (kind !== "messages" || q.length < 2)))
    fail(400, "INVALID_SEARCH", "대화 검색어는 2~200자로 입력해주세요.");
  const scope = hash(`${taskId}:${kind}:${q}:descending-v1`),
    c = decode(String(cursor), scope, d.numeric),
    args = [taskId];
  let where = "h.task_id=$1";
  if (q) {
    args.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    where += ` AND h.body ILIKE $${args.length}`;
  }
  if (c) {
    if (d.numeric) {
      args.push(c.before[0], c.ceiling[0]);
      where += ` AND h.id<$${args.length - 1}::bigint AND h.id<=$${args.length}::bigint`;
    } else {
      args.push(...c.before, ...c.ceiling);
      const n = args.length;
      where += ` AND (h.created_at,h.id)<($${n - 3}::timestamptz,$${n - 2}::uuid) AND (h.created_at,h.id)<=($${n - 1}::timestamptz,$${n}::uuid)`;
    }
  }
  const pageLimit = d.limit || HISTORY_LIMIT;
  const rows = (
    await db.query(
      `SELECT ${d.fields || "h.*"}${d.numeric ? "" : ",h.created_at::text AS history_time"} FROM ${d.table} h ${d.join || ""} WHERE ${where} ORDER BY ${d.numeric ? "h.id" : "h.created_at DESC,h.id"} DESC LIMIT ${pageLimit + 1}`,
      args,
    )
  ).rows;
  const hasMore = rows.length > pageLimit,
    items = rows.slice(0, pageLimit),
    ceiling = c?.ceiling || (items.length && key(items[0], d)),
    before = items.length && key(items.at(-1), d);
  return {
    kind,
    items: items.reverse(),
    hasMore,
    nextCursor: hasMore ? encode({ v: 1, scope, before, ceiling }) : null,
    query: q,
  };
}
export async function taskHistory(db, user, taskId, kind, options) {
  const task = (
    await db.query(
      "SELECT owner_id,visibility,department FROM cr_tasks WHERE id=$1",
      [taskId],
    )
  ).rows[0];
  requireRead(user, task);
  return historyPage(db, taskId, kind, options);
}
export async function pinnedHistory(db, taskId, kind, ids) {
  if (!ids.length) return [];
  const d = definitions[kind];
  return (
    await db.query(
      `SELECT ${d.fields || "h.*"}${d.numeric ? "" : ",h.created_at::text AS history_time"} FROM ${d.table} h ${d.join || ""} WHERE h.task_id=$1 AND h.id=ANY($2::uuid[])`,
      [taskId, ids],
    )
  ).rows;
}
export async function taskArchive(
  db,
  user,
  { cursor = "", q = "", status = "all" } = {},
) {
  q = String(q).trim();
  if (
    q.length > 200 ||
    ![
      "all",
      "mine",
      "queued",
      "running",
      "paused",
      "result_ready",
      "done",
      "failed",
      "cancelled",
    ].includes(status)
  )
    fail(400, "INVALID_SEARCH", "업무 검색 조건을 확인해주세요.");
  const scope = hash(`tasks:${user.id}:${q}:${status}:number-desc-v1`),
    c = decode(String(cursor), scope, true),
    args = [user.id, user.department];
  let where = readPredicate();
  if (q) {
    args.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    where += ` AND (t.title ILIKE $${args.length} OR t.target ILIKE $${args.length} OR t.project ILIKE $${args.length})`;
  }
  if (status === "mine")
    where +=
      " AND t.responsible_id=$1 AND t.status IN ('result_ready','failed','paused')";
  else if (status !== "all") {
    args.push(status);
    where += ` AND t.status=$${args.length}`;
  }
  if (c) {
    args.push(c.before[0], c.ceiling[0]);
    where += ` AND t.number<$${args.length - 1}::bigint AND t.number<=$${args.length}::bigint`;
  }
  const rows = (
    await db.query(
      `SELECT t.id,t.number,t.title,t.work_type,t.owner_id,t.responsible_id,t.visibility,t.department,t.project,t.target,t.target_version,t.status,t.step_index,t.revision,t.created_at,t.updated_at,a.name AS agent_name,s.agent_id,s.name AS step_name FROM cr_tasks t JOIN cr_steps s ON s.task_id=t.id AND s.position=t.step_index JOIN cr_agents a ON a.id=s.agent_id WHERE ${where} ORDER BY t.number DESC LIMIT ${HISTORY_LIMIT + 1}`,
      args,
    )
  ).rows;
  const hasMore = rows.length > HISTORY_LIMIT,
    items = rows.slice(0, HISTORY_LIMIT);
  return {
    tasks: items,
    hasMore,
    nextCursor: hasMore
      ? encode({
          v: 1,
          scope,
          before: [String(items.at(-1).number)],
          ceiling: c?.ceiling || [String(items[0].number)],
        })
      : null,
    query: q,
    status,
    order: "created-desc",
  };
}
