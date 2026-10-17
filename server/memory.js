import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";

export const MEMORY_CHARS = 16000;
export function queryTerms(query) {
  const words = [
    ...new Set(
      String(query)
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]{2,64}/gu) || [],
    ),
  ].slice(0, 24);
  // Korean inflections/spacing differ; short Hangul anchors complement exact/FTS terms.
  const anchors = words
    .filter((w) => /^[가-힣]{3,}$/.test(w))
    .flatMap((w) => [w.slice(0, 2), w.slice(0, 3)]);
  return [...new Set([...words, ...anchors])].slice(0, 40);
}
const patterns = (terms) =>
  terms.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`);
export function sourceAllowed(user, scope, doc) {
  return (
    canRead(user, doc) &&
    (!doc.agent_owner_id || doc.agent_owner_id === user.id) &&
    (scope.visibility === "private" ||
      doc.visibility === "team" ||
      (scope.visibility === "department" &&
        doc.visibility === "department" &&
        scope.department === doc.department))
  );
}
export const reference = (doc) => ({ key: doc.key, revision: doc.revision });
export async function documentsByKeys(db, keys) {
  if (!keys.length) return new Map();
  return new Map(
    (
      await db.query(
        "SELECT * FROM cr_recall_documents WHERE key=ANY($1::text[])",
        [keys],
      )
    ).rows.map((d) => [d.key, d]),
  );
}
export async function validReferences(
  db,
  user,
  scope,
  refs,
  { lock = false } = {},
) {
  const keys = [...new Set(refs.map((r) => r.key))];
  if (keys.length > 600) return false;
  if (lock) {
    const taskIds = (
      await db.query(
        "SELECT DISTINCT task_id FROM cr_recall_documents WHERE key=ANY($1::text[]) AND task_id IS NOT NULL ORDER BY task_id",
        [keys],
      )
    ).rows.map((r) => r.task_id);
    if (taskIds.length)
      await db.query(
        "SELECT id FROM cr_tasks WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
        [taskIds],
      );
    const ids = keys
      .filter((k) => k.startsWith("memory:"))
      .map((k) => k.slice(7))
      .sort();
    if (ids.length)
      await db.query(
        "SELECT id FROM cr_memories WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE",
        [ids],
      );
  }
  const docs = await documentsByKeys(db, keys);
  return refs.every((ref) => {
    const doc = docs.get(ref.key);
    return (
      doc &&
      sourceAllowed(user, scope, doc) &&
      (ref.legacyRevision
        ? doc.record_revision === Number(ref.legacyRevision)
        : doc.revision === ref.revision)
    );
  });
}
export function excerpt(body, terms, max = 1400) {
  if (body.length <= max) return body;
  const lower = body.toLowerCase();
  const match = terms
    .map((term) => ({ term, position: lower.indexOf(term) }))
    .filter((m) => m.position >= 0)
    .sort(
      (a, b) => b.term.length - a.term.length || a.position - b.position,
    )[0];
  const start = match ? Math.max(0, match.position - 160) : 0;
  return (
    (start ? "…" : "") +
    body.slice(start, start + max) +
    (start + max < body.length ? "…" : "")
  );
}
export async function searchMemory(
  db,
  user,
  scope,
  {
    query = "",
    agentId = "",
    project = "",
    keys = null,
    limit = 40,
    vector = null,
    profileId = "",
    before = null,
  } = {},
) {
  const terms = queryTerms(query),
    args = [
      user.id,
      user.department,
      scope.visibility,
      scope.department || user.department,
      agentId,
      project,
      patterns(terms),
      keys,
      before,
      terms.map((t) => "'" + t + "':*").join(" | "),
    ];
  // Scope filters precede ranking. No recency preselection: an old exact match can win.
  const rows = (
    await db.query(
      `WITH allowed AS (
    SELECT d.* FROM cr_recall_documents d WHERE
    (d.owner_id=$1 OR d.visibility='team' OR (d.visibility='department' AND d.department=$2))
    AND (d.agent_owner_id IS NULL OR d.agent_owner_id=$1)
    AND ($3='private' OR d.visibility='team' OR ($3='department' AND d.visibility='department' AND d.department=$4))
    AND ($5='' OR $5=ANY(d.agents)) AND ($6='' OR d.project='' OR d.project=$6)
    AND ($8::text[] IS NULL OR d.key=ANY($8)) AND ($9::timestamptz IS NULL OR d.created_at<=$9)
  ), scored AS (
    SELECT d.*, (SELECT count(*) FROM unnest($7::text[]) p WHERE d.title ILIKE p)*6
     +(SELECT count(*) FROM unnest($7::text[]) p WHERE d.body ILIKE p)*2
     +ts_rank_cd(to_tsvector('simple',d.title||' '||d.body),to_tsquery('simple',$10))*4 AS lexical
    FROM allowed d
  ) SELECT * FROM scored WHERE cardinality($7::text[])=0 OR lexical>0 OR pinned
    ORDER BY pinned DESC,lexical DESC,created_at DESC,key LIMIT 160`,
      args,
    )
  ).rows;
  if (vector && profileId) {
    // Caches may lag or contain revoked documents: join live documents and reapply ACLs.
    const semantic = (
      await db.query(
        `SELECT d.*,e.vectors FROM cr_memory_embeddings e JOIN cr_recall_documents d ON d.key=e.source_key AND d.revision=e.source_revision
      WHERE e.status='ready' AND e.profile_id=$1 AND ($2='' OR $2=ANY(d.agents)) AND ($3='' OR d.project='' OR d.project=$3)
      AND (d.owner_id=$4 OR d.visibility='team' OR (d.visibility='department' AND d.department=$5))
      AND (d.agent_owner_id IS NULL OR d.agent_owner_id=$4)
      AND ($6='private' OR d.visibility='team' OR ($6='department' AND d.visibility='department' AND d.department=$7)) AND ($8::timestamptz IS NULL OR d.created_at<=$8)`,
        [
          profileId,
          agentId,
          project,
          user.id,
          user.department,
          scope.visibility,
          scope.department || user.department,
          before,
        ],
      )
    ).rows;
    for (const doc of semantic) {
      const best = doc.vectors
        .map((v) => ({ ...v, score: cosine(vector, v.vector) }))
        .sort((a, b) => b.score - a.score)[0];
      doc.semantic = best.score;
      doc.semanticExcerpt = best.text;
      if (doc.semantic < 0.35) continue;
      const found = rows.find((r) => r.key === doc.key);
      if (found) {
        found.semantic = doc.semantic;
        found.semanticExcerpt = doc.semanticExcerpt;
      } else rows.push({ ...doc, lexical: 0 });
    }
  }
  rows.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.lexical) +
        Number(b.semantic || 0) * 8 -
        (Number(a.lexical) + Number(a.semantic || 0) * 8) ||
      new Date(b.created_at) - new Date(a.created_at),
  );
  const dependencies = [
      ...new Set(rows.flatMap((d) => (d.dependencies || []).map((r) => r.key))),
    ],
    dependencyDocs = await documentsByKeys(db, dependencies);
  const valid = rows.filter(
    (d) =>
      sourceAllowed(user, scope, d) &&
      (d.dependencies || []).every((r) => {
        const source = dependencyDocs.get(r.key);
        return (
          source &&
          sourceAllowed(user, scope, source) &&
          (r.legacyRevision
            ? source.record_revision === Number(r.legacyRevision)
            : source.revision === r.revision)
        );
      }),
  );
  return valid.slice(0, limit).map((d) => ({
    ...d,
    excerpt: d.lexical
      ? excerpt(d.body, terms)
      : d.semanticExcerpt || excerpt(d.body, terms),
    vectors: undefined,
  }));
}
export function cosine(a, b) {
  if (a.length !== b.length || !a.length) return -1;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  const score = aa && bb ? dot / Math.sqrt(aa * bb) : -1;
  return Number.isFinite(score) ? score : -1;
}
export function contextFromDocuments(docs, budget = MEMORY_CHARS) {
  const items = [],
    refs = new Map();
  let used = 0;
  for (const doc of docs) {
    const body = doc.excerpt || excerpt(doc.body, [], doc.pinned ? 3000 : 1600),
      item = {
        key: doc.key,
        revision: doc.revision,
        kind: doc.kind,
        title: doc.title,
        body,
        source: doc.source,
        taskId: doc.task_id,
        project: doc.project,
        targetVersion: doc.target_version,
        createdAt: doc.created_at,
        recordRevision: doc.record_revision,
      };
    const size = JSON.stringify(item).length;
    if (used + size > budget) continue;
    const own = [reference(doc), ...(doc.dependencies || [])];
    if (new Set([...refs.keys(), ...own.map((r) => r.key)]).size > 300)
      continue;
    items.push(item);
    used += size;
    for (const r of own) refs.set(r.key, r);
  }
  return {
    version: 1,
    items,
    refs: [...refs.values()],
    characters: used,
    budget,
    method: "keyword",
  };
}
export async function buildMemoryContext(db, user, task, agentId) {
  const query = [
    task.recallQuery,
    task.goal,
    task.target,
    task.project,
    task.brief?.text,
  ]
    .filter(Boolean)
    .join(" ");
  const docs = await searchMemory(db, user, task, {
    query,
    agentId,
    project: task.project,
    limit: 60,
  });
  // A few unpinned manual facts remain useful even when the request has no shared word.
  if (!docs.some((d) => d.memory_id)) {
    const core = await searchMemory(db, user, task, {
      agentId,
      project: task.project,
      limit: 6,
    });
    docs.push(
      ...core.filter((d) => d.memory_id && !docs.some((s) => s.key === d.key)),
    );
  }
  return contextFromDocuments(
    docs.filter(
      (d) =>
        !(d.kind === "episode" && d.task_id === task.id) &&
        !d.dependencies?.some((r) => r.key === "episode:" + task.id),
    ),
  );
}
export async function readMemorySource(db, user, scope, key) {
  const docs = await searchMemory(db, user, scope, { keys: [key], limit: 1 });
  if (!docs[0])
    throw new HttpError(
      404,
      "MEMORY_NOT_FOUND",
      "기억의 출처를 찾을 수 없어요.",
    );
  return docs[0];
}
