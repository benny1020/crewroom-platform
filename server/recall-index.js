// The text table narrows candidates; callers must read/revalidate live source rows.
export async function indexedRecallCandidates(
  db,
  user,
  scope,
  { terms, patterns, agentId, project, before, asOf },
) {
  const args = [
    user.id,
    user.department,
    scope.visibility,
    scope.department || user.department,
    agentId,
    project,
    patterns,
    before,
    terms.map((t) => "'" + t + "':*").join(" | "),
    asOf,
  ];
  const matchSql = terms.length
    ? `SELECT i.* FROM cr_recall_text i WHERE i.title ILIKE ANY($7) OR i.body ILIKE ANY($7) OR i.search@@to_tsquery('simple',$9)
       UNION SELECT i.* FROM cr_recall_text i JOIN cr_memories m ON m.id=i.memory_id WHERE m.pinned AND m.deleted_at IS NULL`
    : "SELECT * FROM cr_recall_text WHERE $7::text[] IS NOT NULL AND $9::text IS NOT NULL";
  const ending = terms.length
    ? ` ), scored AS (
 SELECT key,created_at,pinned,md5(title||E'\\n'||body) AS content_fingerprint,(SELECT count(*) FROM unnest($7::text[])p WHERE title ILIKE p)*6
 +(SELECT count(*) FROM unnest($7::text[])p WHERE body ILIKE p)*2+ts_rank_cd(search,to_tsquery('simple',$9))*4 AS lexical
 FROM candidates WHERE (owner_id=$1 OR visibility='team' OR (visibility='department' AND department=$2))
 AND ($3='private' OR visibility='team' OR ($3='department' AND visibility='department' AND department=$4))
 ) SELECT key,lexical,pinned,content_fingerprint FROM scored ORDER BY pinned DESC,lexical DESC,created_at DESC,key LIMIT 160`
    : ` ), allowed AS NOT MATERIALIZED (SELECT * FROM candidates WHERE (owner_id=$1 OR visibility='team' OR (visibility='department' AND department=$2)) AND ($3='private' OR visibility='team' OR ($3='department' AND visibility='department' AND department=$4))), latest AS (
 (SELECT * FROM allowed WHERE pinned AND memory_id IS NOT NULL ORDER BY created_at DESC,key LIMIT 160)
 UNION (SELECT * FROM allowed ORDER BY created_at DESC,key LIMIT 160)
 ) SELECT key,0 AS lexical,pinned,md5(title||E'\\n'||body) AS content_fingerprint FROM latest ORDER BY pinned DESC,created_at DESC,key LIMIT 160`;
  return (
    await db.query(
      `WITH matched AS NOT MATERIALIZED (
 ${matchSql}
 ), candidates AS NOT MATERIALIZED (
 SELECT i.*,CASE WHEN i.memory_id IS NOT NULL THEN m.owner_id ELSE t.owner_id END AS owner_id,
 CASE WHEN i.memory_id IS NOT NULL THEN m.visibility ELSE t.visibility END AS visibility,
 CASE WHEN i.memory_id IS NOT NULL THEN m.department ELSE t.department END AS department,
 coalesce(m.pinned,false) AS pinned
 FROM matched i LEFT JOIN cr_tasks t ON t.id=i.task_id LEFT JOIN cr_memories m ON m.id=i.memory_id LEFT JOIN cr_agents a ON a.id=m.agent_id
 WHERE ((i.memory_id IS NOT NULL AND m.deleted_at IS NULL AND m.id IS NOT NULL) OR (i.memory_id IS NULL AND t.id IS NOT NULL))
 AND (a.owner_id IS NULL OR a.owner_id=$1)
 AND ($5='' OR (i.memory_id IS NOT NULL AND (m.agent_id=$5 OR (m.audience='project' AND ($6='' OR m.project=$6))))
 OR (i.memory_id IS NULL AND (EXISTS(SELECT 1 FROM cr_steps s WHERE s.task_id=i.task_id AND s.agent_id=$5) OR (t.visibility<>'private' AND ($6='' OR t.project=$6)))))
 AND ($6='' OR CASE WHEN i.memory_id IS NOT NULL THEN m.project ELSE t.project END IN ('',$6))
 AND ($8::timestamptz IS NULL OR i.created_at<=$8)
 AND ((i.memory_id IS NOT NULL AND (m.valid_from IS NULL OR m.valid_from<=$10::timestamptz) AND (m.valid_to IS NULL OR m.valid_to>$10::timestamptz)) OR (i.memory_id IS NULL AND i.created_at<=$10::timestamptz))
 AND (i.memory_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM cr_memories f WHERE (f.source_key=i.key OR (f.source_key IS NULL AND f.source_task_id=i.task_id)) AND (f.deleted_at IS NOT NULL OR f.source_corrected)))

${ending}`,
      args,
    )
  ).rows;
}
