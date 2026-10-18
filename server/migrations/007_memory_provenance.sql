-- Preserve the evidence captured when a proposal was made, never bless its latest revision.
ALTER TABLE cr_memories ADD COLUMN source_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(source_refs)='array');
ALTER TABLE cr_memories ADD COLUMN source_corrected boolean NOT NULL DEFAULT false;
UPDATE cr_memories m SET source_corrected=true WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(m.history) h WHERE h->>'body' IS DISTINCT FROM m.body);
ALTER TABLE cr_memories ADD COLUMN origin_task_id uuid REFERENCES cr_tasks(id);
ALTER TABLE cr_memory_candidates ADD COLUMN valid_from timestamptz;
ALTER TABLE cr_memory_candidates ADD COLUMN valid_to timestamptz;
UPDATE cr_memory_candidates c SET valid_from=d.valid_from, valid_to=d.valid_to
FROM cr_recall_documents d WHERE d.key=c.source_key AND d.revision=c.source_revision;
UPDATE cr_memories m SET
 source_refs=jsonb_build_array(jsonb_build_object('key',c.source_key,'revision',c.source_revision)) ||
 coalesce((SELECT mr.refs FROM cr_memory_reads mr WHERE mr.run_id=c.run_id AND mr.generation=c.generation
 AND mr.refs @> jsonb_build_array(jsonb_build_object('key',c.source_key,'revision',c.source_revision))
 ORDER BY mr.sequence LIMIT 1),'[]'::jsonb),
 valid_from=coalesce(m.valid_from,c.valid_from),valid_to=coalesce(m.valid_to,c.valid_to)
FROM cr_memory_candidates c WHERE c.memory_id=m.id AND c.status='accepted' AND NOT m.source_corrected;
UPDATE cr_memories m SET origin_task_id=d.task_id FROM cr_recall_documents d WHERE d.key=m.source_key;
-- Unreviewed legacy source links have no captured revision: quarantine until a human correction.
UPDATE cr_memories SET source_refs=jsonb_build_array(jsonb_build_object('key',source_key,'revision','unverified-before-007'))
WHERE source_key IS NOT NULL AND NOT source_corrected AND source_refs='[]'::jsonb;
-- Old history did not capture evidence. Detaching the current fact must never
-- reveal those unverifiable prior bodies (or correction reasons) afterwards.
UPDATE cr_memories m SET history=(SELECT jsonb_agg(
 CASE WHEN h ? 'sourceRefs' THEN h ELSE h || jsonb_build_object('sourceRefs',
 jsonb_build_array(jsonb_build_object('key',m.source_key,'revision','unverified-before-007'))) END ORDER BY ordinal)
 FROM jsonb_array_elements(m.history) WITH ORDINALITY AS item(h,ordinal))
WHERE m.source_key IS NOT NULL AND jsonb_array_length(m.history)>0;
DROP VIEW cr_recall_documents;
CREATE VIEW cr_recall_documents AS
WITH run_sources AS (
 SELECT r.id,coalesce(r.snapshot->'memoryContext'->'refs','[]'::jsonb)
 ||coalesce((SELECT jsonb_agg(jsonb_build_object('key','memory:'||(m->>'id'),'legacyRevision',m->'revision')) FROM jsonb_array_elements(coalesce(r.snapshot->'memories','[]'::jsonb)) m),'[]'::jsonb)
 ||coalesce((SELECT jsonb_agg(ref ORDER BY mr.generation,mr.sequence,ref->>'key') FROM cr_memory_reads mr CROSS JOIN LATERAL jsonb_array_elements(mr.refs) ref WHERE mr.run_id=r.id),'[]'::jsonb) AS dependencies
 FROM cr_runs r
), documents AS (
 SELECT 'memory:'||m.id AS key,m.kind,m.id AS memory_id,ARRAY[m.agent_id] AS agents,a.owner_id AS agent_owner_id,
 m.owner_id,m.visibility,m.department,m.project,m.source_task_id AS task_id,m.title,m.body,m.source,
 m.pinned,m.revision AS record_revision,m.updated_at AS created_at,''::text AS target_version,m.source_refs AS dependencies,
 m.audience,m.valid_from,m.valid_to,m.supersedes_id::text,m.source_key
 FROM cr_memories m JOIN cr_agents a ON a.id=m.agent_id WHERE m.deleted_at IS NULL
 UNION ALL
 SELECT 'message:'||m.id,'conversation',NULL::uuid,ARRAY(SELECT DISTINCT s.agent_id FROM cr_steps s WHERE s.task_id=t.id),NULL::uuid,
 t.owner_id,t.visibility,t.department,t.project,t.id,t.title||' · '||u.name,m.body,'업무방 메시지 #'||m.id,
 false,1,m.created_at,m.target_version,'[]'::jsonb,
 CASE WHEN t.visibility='private' THEN 'agent' ELSE 'project' END,NULL::timestamptz,NULL::timestamptz,NULL::text,NULL::text
 FROM cr_messages m JOIN cr_tasks t ON t.id=m.task_id JOIN cr_members u ON u.id=m.user_id
 WHERE NOT EXISTS(SELECT 1 FROM cr_memories f WHERE (f.source_key='message:'||m.id OR (f.source_key IS NULL AND f.source_task_id=t.id)) AND (f.deleted_at IS NOT NULL OR f.source_corrected))
 UNION ALL
 SELECT 'episode:'||t.id,'episode',NULL::uuid,ARRAY(SELECT DISTINCT s.agent_id FROM cr_steps s WHERE s.task_id=t.id),NULL::uuid,
 t.owner_id,t.visibility,t.department,t.project,t.id,t.title,
 concat_ws(E'\n','요청: '||t.goal,'업무 요약: '||(t.brief->>'text'),'결과 요약: '||(a.result->>'summary'),
 '미확인: '||coalesce((a.result->'unknowns')::text,'[]'),'결과 출처: '||a.origin||' · 버전 '||a.version||' · '||a.target_version,
 '검사·수용 상태는 원본 업무의 현재 기록을 확인하세요.'),
 '업무 결과의 자동 발췌 요약',false,1,a.created_at,a.target_version,coalesce(r.dependencies,'[]'::jsonb),
 CASE WHEN t.visibility='private' THEN 'agent' ELSE 'project' END,NULL::timestamptz,NULL::timestamptz,NULL::text,NULL::text
 FROM cr_tasks t JOIN LATERAL(SELECT * FROM cr_artifacts a WHERE a.task_id=t.id AND a.target_version=t.target_version ORDER BY a.created_at DESC LIMIT 1) a ON true
 LEFT JOIN run_sources r ON r.id=a.run_id
 WHERE NOT EXISTS(SELECT 1 FROM cr_memories f WHERE (f.source_key='episode:'||t.id OR (f.source_key IS NULL AND f.source_task_id=t.id)) AND (f.deleted_at IS NOT NULL OR f.source_corrected))
 UNION ALL
 SELECT 'artifact:'||a.id||':'||part.section||':'||part.ordinal,'answer',NULL::uuid,
 ARRAY(SELECT DISTINCT s.agent_id FROM cr_steps s WHERE s.task_id=t.id),NULL::uuid,
 t.owner_id,t.visibility,t.department,t.project,t.id,t.title||' · '||part.section,
 part.body,'에이전트 답변 v'||a.version||' · '||part.section||' · '||a.origin,
 false,1,a.created_at,a.target_version,coalesce(r.dependencies,'[]'::jsonb),
 CASE WHEN t.visibility='private' THEN 'agent' ELSE 'project' END,NULL::timestamptz,NULL::timestamptz,NULL::text,NULL::text
 FROM cr_artifacts a JOIN cr_tasks t ON t.id=a.task_id LEFT JOIN run_sources r ON r.id=a.run_id
 CROSS JOIN LATERAL (
 SELECT 'summary' AS section,1::bigint AS ordinal,a.result->>'summary' AS body
 UNION ALL
 SELECT section,ordinal,value FROM (VALUES('evidence'),('unknowns'),('nextActions')) AS sections(section)
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.result->section)='array' THEN a.result->section ELSE '[]'::jsonb END) WITH ORDINALITY AS item(value,ordinal)
 ) part
 WHERE part.body IS NOT NULL AND part.body<>'' AND NOT EXISTS(SELECT 1 FROM cr_memories f WHERE
 (f.source_key='artifact:'||a.id||':'||part.section||':'||part.ordinal OR (f.source_key IS NULL AND f.source_task_id=t.id)) AND (f.deleted_at IS NOT NULL OR f.source_corrected))
)
-- Preserve 0.7 fingerprints when default metadata has not changed. Existing Run provenance stays valid.
SELECT *,md5(concat_ws(E'\n',key,title,body,source,visibility,department,owner_id::text,project,record_revision::text,target_version,dependencies::text)
 ||CASE WHEN memory_id IS NOT NULL AND (audience<>'agent' OR valid_from IS NOT NULL OR valid_to IS NOT NULL OR supersedes_id IS NOT NULL OR source_key IS NOT NULL)
 THEN concat_ws(E'\n','metadata-v2',audience,extract(epoch FROM valid_from)::text,extract(epoch FROM valid_to)::text,supersedes_id,source_key) ELSE '' END) AS revision
FROM documents;
