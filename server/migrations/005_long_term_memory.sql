ALTER TABLE cr_memories ADD COLUMN kind text NOT NULL DEFAULT 'fact' CHECK(kind IN ('fact','decision','preference','procedure'));
ALTER TABLE cr_memories ADD COLUMN pinned boolean NOT NULL DEFAULT false;
ALTER TABLE cr_memories ADD COLUMN project text NOT NULL DEFAULT '';
ALTER TABLE cr_messages ADD COLUMN target_version text NOT NULL DEFAULT '';
CREATE INDEX cr_message_search ON cr_messages USING gin(to_tsvector('simple',body));
CREATE TABLE cr_memory_reads (
 run_id uuid NOT NULL REFERENCES cr_runs(id), generation integer NOT NULL, sequence integer NOT NULL,
 query text NOT NULL, refs jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,generation,sequence)
);
CREATE INDEX ON cr_memory_reads(run_id);
-- Exact vector search deliberately needs no extension; optional indexing is a cache.
CREATE TABLE cr_memory_embeddings (
 source_key text PRIMARY KEY, source_revision text NOT NULL, profile_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('indexing','ready','failed')), vectors jsonb,
 attempts integer NOT NULL DEFAULT 1, lease_until timestamptz NOT NULL,
 error_code text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW cr_recall_documents AS
WITH documents AS (
 SELECT 'memory:'||m.id AS key,m.kind,m.id AS memory_id,ARRAY[m.agent_id] AS agents,a.owner_id AS agent_owner_id,
 m.owner_id,m.visibility,m.department,m.project,m.source_task_id AS task_id,m.title,m.body,m.source,
 m.pinned,m.revision AS record_revision,m.updated_at AS created_at,''::text AS target_version,'[]'::jsonb AS dependencies
 FROM cr_memories m JOIN cr_agents a ON a.id=m.agent_id WHERE m.deleted_at IS NULL
 UNION ALL
 SELECT 'message:'||m.id,'conversation',NULL::uuid,ARRAY(SELECT DISTINCT s.agent_id FROM cr_steps s WHERE s.task_id=t.id),NULL::uuid,
 t.owner_id,t.visibility,t.department,t.project,t.id,t.title||' · '||u.name,m.body,'업무방 메시지 #'||m.id,
 false,1,m.created_at,m.target_version,'[]'::jsonb
 FROM cr_messages m JOIN cr_tasks t ON t.id=m.task_id JOIN cr_members u ON u.id=m.user_id
 WHERE NOT EXISTS(SELECT 1 FROM cr_memories forgotten WHERE forgotten.source_task_id=t.id AND (forgotten.deleted_at IS NOT NULL OR forgotten.revision>1))
 UNION ALL
 SELECT 'episode:'||t.id,'episode',NULL::uuid,ARRAY(SELECT DISTINCT s.agent_id FROM cr_steps s WHERE s.task_id=t.id),NULL::uuid,
 t.owner_id,t.visibility,t.department,t.project,t.id,t.title,
 concat_ws(E'\n','요청: '||t.goal,'업무 요약: '||(t.brief->>'text'),'결과 요약: '||(a.result->>'summary'),
 '미확인: '||coalesce((a.result->'unknowns')::text,'[]'),'결과 출처: '||a.origin||' · 버전 '||a.version||' · '||a.target_version,
 '검사·수용 상태는 원본 업무의 현재 기록을 확인하세요.'),
 '업무 결과의 자동 발췌 요약',false,1,a.created_at,a.target_version,
 coalesce(r.snapshot->'memoryContext'->'refs','[]'::jsonb)
 ||coalesce((SELECT jsonb_agg(jsonb_build_object('key','memory:'||(m->>'id'),'legacyRevision',m->'revision')) FROM jsonb_array_elements(coalesce(r.snapshot->'memories','[]'::jsonb)) m),'[]'::jsonb)
 ||coalesce((SELECT jsonb_agg(ref ORDER BY mr.generation,mr.sequence,ref->>'key') FROM cr_memory_reads mr CROSS JOIN LATERAL jsonb_array_elements(mr.refs) ref WHERE mr.run_id=r.id),'[]'::jsonb)
 FROM cr_tasks t JOIN LATERAL(SELECT * FROM cr_artifacts a WHERE a.task_id=t.id AND a.target_version=t.target_version ORDER BY a.created_at DESC LIMIT 1) a ON true
 LEFT JOIN cr_runs r ON r.id=a.run_id
 WHERE NOT EXISTS(SELECT 1 FROM cr_memories forgotten WHERE forgotten.source_task_id=t.id AND (forgotten.deleted_at IS NOT NULL OR forgotten.revision>1))
)
SELECT *,md5(concat_ws(E'\n',key,title,body,source,visibility,department,owner_id::text,project,record_revision::text,target_version,dependencies::text)) AS revision
FROM documents;
