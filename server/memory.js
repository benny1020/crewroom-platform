import { createHash } from "node:crypto";
import { indexedRecallCandidates } from "./recall-index.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";

export const MEMORY_CHARS = 16000;
// Exact-vector search has an explicit corpus ceiling. Large installations keep
// indexed lexical recall rather than allocating every cached vector in the app.
export const EXACT_VECTOR_DOCUMENT_LIMIT = 2000;
export const EXACT_VECTOR_VALUE_LIMIT = 2000000;
export const EXACT_VECTOR_BYTE_LIMIT = 32000000;
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
// Explicit cross-project reads are supported; agent-only sources still belong to
// their assigned role. Derived, reviewed project facts may be shared across roles.
export const agentSourceAllowed = (doc, agentId) =>
  !agentId || doc.agents.includes(agentId) || doc.audience === "project";
export const effectiveAt = (doc, at = new Date()) =>
  (!doc.valid_from || new Date(doc.valid_from) <= at) &&
  (!doc.valid_to || new Date(doc.valid_to) > at);
export async function sourceProvenance(db, doc) {
  const refs = [reference(doc), ...(doc.dependencies || [])];
  const sources = [
    doc,
    ...(
      await documentsByKeys(
        db,
        refs.map((r) => r.key),
      )
    ).values(),
  ];
  const starts = sources
    .filter((d) => d.valid_from)
    .map((d) => +new Date(d.valid_from));
  const ends = sources
    .filter((d) => d.valid_to)
    .map((d) => +new Date(d.valid_to));
  return {
    refs,
    validFrom: starts.length
      ? new Date(Math.max(...starts)).toISOString()
      : null,
    validTo: ends.length ? new Date(Math.min(...ends)).toISOString() : null,
  };
}
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
    asOf = new Date().toISOString(),
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
      asOf,
    ];
  // Scope filters precede ranking. No recency preselection: an old exact match can win.
  const rows = keys
    ? (
        await db.query(
          `WITH allowed AS (
    SELECT d.* FROM cr_recall_documents d WHERE d.kind<>'workspace' AND
    (d.owner_id=$1 OR d.visibility='team' OR (d.visibility='department' AND d.department=$2))
    AND (d.agent_owner_id IS NULL OR d.agent_owner_id=$1)
    AND ($3='private' OR d.visibility='team' OR ($3='department' AND d.visibility='department' AND d.department=$4))
    AND ($5='' OR $5=ANY(d.agents) OR (d.audience='project' AND ($6='' OR d.project=$6))) AND ($6='' OR d.project='' OR d.project=$6)
    AND ($8::text[] IS NULL OR d.key=ANY($8)) AND ($9::timestamptz IS NULL OR d.created_at<=$9)
    AND ($8::text[] IS NOT NULL OR ((d.valid_from IS NULL OR d.valid_from<=$11::timestamptz) AND (d.valid_to IS NULL OR d.valid_to>$11::timestamptz) AND (d.memory_id IS NOT NULL OR d.created_at<=$11::timestamptz)))
  ), scored AS (
    SELECT d.*, (SELECT count(*) FROM unnest($7::text[]) p WHERE d.title ILIKE p)*6
     +(SELECT count(*) FROM unnest($7::text[]) p WHERE d.body ILIKE p)*2
     +ts_rank_cd(to_tsvector('simple',d.title||' '||d.body),to_tsquery('simple',$10))*4 AS lexical
    FROM allowed d
  ) SELECT * FROM scored WHERE cardinality($7::text[])=0 OR lexical>0 OR pinned
    ORDER BY pinned DESC,lexical DESC,created_at DESC,key LIMIT 160`,
          args,
        )
      ).rows
    : await (async () => {
        const candidates = await indexedRecallCandidates(db, user, scope, {
          terms,
          patterns: patterns(terms),
          agentId,
          project,
          before,
          asOf,
        });
        const live = await documentsByKeys(
          db,
          candidates.map((x) => x.key),
        );
        return candidates.flatMap((c) => {
          const d = live.get(c.key);
          return d &&
            c.content_fingerprint ===
              createHash("md5")
                .update(d.title + "\n" + d.body)
                .digest("hex") &&
            agentSourceAllowed(d, agentId) &&
            (!project || !d.project || d.project === project) &&
            (!before || new Date(d.created_at) <= new Date(before)) &&
            (d.memory_id || new Date(d.created_at) <= new Date(asOf)) &&
            effectiveAt(d, new Date(asOf))
            ? [{ ...d, lexical: c.lexical }]
            : [];
        });
      })();
  const rankedLists = [
    rows
      .slice()
      .sort(
        (a, b) =>
          Number(b.lexical) - Number(a.lexical) ||
          new Date(b.created_at) - new Date(a.created_at),
      ),
  ];
  let semanticStatus = vector && profileId ? "no_matches" : "disabled",
    semanticCoverageVersion = 0;
  if (vector && profileId) {
    // One statement snapshot decides capacity and reads its cache. There is no
    // check-then-search race with the embedding indexer.
    const result = (
      await db.query(
        `WITH bounded AS MATERIALIZED (
      SELECT * FROM cr_memory_embeddings WHERE status='ready' AND profile_id=$1 ORDER BY source_key LIMIT 2001
    ), sources AS MATERIALIZED (
      SELECT d.* FROM cr_recall_documents d WHERE d.kind<>'workspace' AND
      ($2='' OR $2=ANY(d.agents) OR (d.audience='project' AND ($3='' OR d.project=$3))) AND ($3='' OR d.project='' OR d.project=$3)
      AND (d.owner_id=$4 OR d.visibility='team' OR (d.visibility='department' AND d.department=$5))
      AND (d.agent_owner_id IS NULL OR d.agent_owner_id=$4)
      AND ($6='private' OR d.visibility='team' OR ($6='department' AND d.visibility='department' AND d.department=$7))
      AND ($8::timestamptz IS NULL OR d.created_at<=$8)
      AND (d.valid_from IS NULL OR d.valid_from<=$9::timestamptz) AND (d.valid_to IS NULL OR d.valid_to>$9::timestamptz) AND (d.memory_id IS NOT NULL OR d.created_at<=$9::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(d.dependencies) ref
        LEFT JOIN cr_recall_documents p ON p.key=ref->>'key'
        WHERE p.key IS NULL
        OR NOT ((p.owner_id=$4 OR p.visibility='team' OR (p.visibility='department' AND p.department=$5))
          AND (p.agent_owner_id IS NULL OR p.agent_owner_id=$4)
          AND ($6='private' OR p.visibility='team' OR ($6='department' AND p.visibility='department' AND p.department=$7)))
        OR NOT CASE WHEN ref ? 'legacyRevision' THEN p.record_revision::text=ref->>'legacyRevision' ELSE p.revision=ref->>'revision' END
      ) LIMIT 2001
    ), capacity AS MATERIALIZED (
      SELECT count(*)>2000 OR coalesce(sum(vector_values),0)>2000000 OR coalesce(sum(vector_bytes),0)>32000000
        OR (SELECT count(*)>2000 FROM sources) AS limited FROM bounded
    ), coverage AS MATERIALIZED (
      SELECT NOT EXISTS(SELECT 1 FROM sources d LEFT JOIN bounded e ON e.source_key=d.key AND e.source_revision=d.revision WHERE e.source_key IS NULL) AS complete,
      EXISTS(SELECT 1 FROM sources d JOIN bounded e ON e.source_key=d.key AND e.source_revision=d.revision WHERE jsonb_array_length(e.vectors->0->'vector') IS DISTINCT FROM $10::int) AS dimension_mismatch
    ), found AS (
      SELECT d.*,e.vectors FROM sources d JOIN bounded e ON d.key=e.source_key AND d.revision=e.source_revision
      CROSS JOIN capacity CROSS JOIN coverage WHERE NOT capacity.limited AND coverage.complete AND NOT coverage.dimension_mismatch
    ) SELECT CASE WHEN limited THEN 'capacity_limited' WHEN dimension_mismatch THEN 'profile_incompatible' WHEN NOT complete THEN 'index_incomplete' ELSE 'ready' END AS status,
      coalesce((SELECT jsonb_agg(to_jsonb(found)) FROM found),'[]'::jsonb) AS documents FROM capacity CROSS JOIN coverage`,
        [
          profileId,
          agentId,
          project,
          user.id,
          user.department,
          scope.visibility,
          scope.department || user.department,
          before,
          asOf,
          vector.length,
        ],
      )
    ).rows[0];
    if (result.status !== "ready") semanticStatus = result.status;
    else semanticCoverageVersion = 1;
    const semantic = result.documents;
    const semanticRank = [];
    for (const doc of semantic) {
      const best = doc.vectors
        .map((v) => ({ ...v, score: cosine(vector, v.vector) }))
        .sort((a, b) => b.score - a.score)[0];
      if (!best) continue;
      doc.semantic = best.score;
      doc.semanticExcerpt = best.text;
      if (doc.semantic < 0.35) continue;
      semanticRank.push(doc);
      const found = rows.find((r) => r.key === doc.key);
      if (found) {
        found.semantic = doc.semantic;
        found.semanticExcerpt = doc.semanticExcerpt;
      } else rows.push({ ...doc, lexical: 0 });
    }
    rankedLists.push(semanticRank.sort((a, b) => b.semantic - a.semantic));
    if (result.status === "ready" && semanticRank.length)
      semanticStatus = "matched";
  }
  const fused = reciprocalRankFusion(rankedLists);
  rows.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (fused.get(b.key) || 0) - (fused.get(a.key) || 0) ||
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
  const output = valid.slice(0, limit).map((d) => ({
    ...d,
    excerpt: d.lexical
      ? excerpt(d.body, terms)
      : d.semanticExcerpt || excerpt(d.body, terms),
    vectors: undefined,
  }));
  Object.defineProperty(output, "semanticStatus", { value: semanticStatus });
  Object.defineProperty(output, "semanticCoverageVersion", {
    value: semanticCoverageVersion,
  });
  return output;
}
export function reciprocalRankFusion(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    const seen = new Set();
    list.forEach((doc, index) => {
      if (seen.has(doc.key)) return;
      seen.add(doc.key);
      scores.set(doc.key, (scores.get(doc.key) || 0) + 1 / (k + index + 1));
    });
  }
  return scores;
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
    refs = new Map(),
    seenBodies = new Set();
  let used = 0,
    pinnedChars = 0;
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
        audience: doc.audience || "agent",
        validFrom: doc.valid_from,
        validTo: doc.valid_to,
        supersedesId: doc.supersedes_id,
      };
    const size = JSON.stringify(item).length;
    const normalized = body.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (seenBodies.has(normalized) || used + size > budget) continue;
    if (doc.pinned && pinnedChars + size > budget / 2 && items.length) continue;
    const own = [reference(doc), ...(doc.dependencies || [])];
    if (new Set([...refs.keys(), ...own.map((r) => r.key)]).size > 300)
      continue;
    items.push(item);
    seenBodies.add(normalized);
    if (doc.pinned) pinnedChars += size;
    used += size;
    for (const r of own) refs.set(r.key, r);
  }
  return {
    version: 1,
    items,
    refs: [...refs.values()],
    characters: used,
    budget,
    method: "rrf",
  };
}
// Working documents are re-read through workspace tools on continuation. Injecting
// old answers derived from those mutable heads would pin their obsolete revisions.
export async function automaticContextDocuments(db, task, docs) {
  const keys = (
    await db.query(
      "SELECT 'workspace:'||id AS key FROM cr_workspace_documents WHERE task_id=$1",
      [task.id],
    )
  ).rows.map((r) => r.key);
  if (!keys.length) return docs;
  return docs.filter(
    (d) =>
      !(d.task_id === task.id && ["answer", "episode"].includes(d.kind)) &&
      !(d.dependencies || []).some((r) => keys.includes(r.key)),
  );
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
    (await automaticContextDocuments(db, task, docs)).filter(
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
