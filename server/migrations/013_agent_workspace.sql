-- Agent homes are permission-filtered views of task-owned documents, not OS mounts.
CREATE TABLE cr_workspace_documents (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES cr_tasks(id), agent_id text NOT NULL REFERENCES cr_agents(id),
 path text NOT NULL CHECK(length(path) BETWEEN 1 AND 180), revision integer NOT NULL CHECK(revision>0),
 target_version text NOT NULL, archived boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(task_id,path)
);
CREATE INDEX cr_workspace_agent_recent ON cr_workspace_documents(agent_id,updated_at DESC,id);
CREATE INDEX cr_workspace_task_recent ON cr_workspace_documents(task_id,updated_at DESC,id);
CREATE TABLE cr_workspace_versions (
 document_id uuid NOT NULL REFERENCES cr_workspace_documents(id), revision integer NOT NULL,
 path text NOT NULL, body text NOT NULL CHECK(octet_length(body)<=65536), archived boolean NOT NULL,
 source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array'),
 run_id uuid NOT NULL REFERENCES cr_runs(id), generation integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(document_id,revision)
);
CREATE TABLE cr_workspace_reads (
 run_id uuid NOT NULL REFERENCES cr_runs(id), generation integer NOT NULL, document_id uuid NOT NULL REFERENCES cr_workspace_documents(id),
 refs jsonb NOT NULL CHECK(jsonb_typeof(refs)='array'), PRIMARY KEY(run_id,generation,document_id)
);
CREATE INDEX cr_workspace_body_search ON cr_workspace_versions USING gin(body public.gin_trgm_ops);

CREATE TABLE cr_workspace_operations (
 run_id uuid NOT NULL REFERENCES cr_runs(id), generation integer NOT NULL, operation_id text NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(run_id,generation,operation_id)
);
CREATE TABLE cr_workspace_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id uuid NOT NULL REFERENCES cr_runs(id), generation integer NOT NULL,
 document_id uuid NOT NULL REFERENCES cr_workspace_documents(id), refs jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cr_workspace_observation_run ON cr_workspace_observations(run_id,id);
CREATE OR REPLACE VIEW cr_recall_documents AS
WITH run_sources AS (
 SELECT r.id,coalesce(r.snapshot->'memoryContext'->'refs','[]'::jsonb)||coalesce(r.snapshot->'inheritedRefs','[]'::jsonb)
 ||coalesce((SELECT jsonb_agg(jsonb_build_object('key','memory:'||(m->>'id'),'legacyRevision',m->'revision')) FROM jsonb_array_elements(coalesce(r.snapshot->'memories','[]'::jsonb)) m),'[]'::jsonb)
 ||coalesce((SELECT jsonb_agg(ref ORDER BY mr.generation,mr.sequence,ref->>'key') FROM cr_memory_reads mr CROSS JOIN LATERAL jsonb_array_elements(mr.refs) ref WHERE mr.run_id=r.id),'[]'::jsonb)
 ||coalesce((SELECT jsonb_agg(ref) FROM (SELECT DISTINCT ON(document_id) refs FROM cr_workspace_reads WHERE run_id=r.id ORDER BY document_id,generation DESC) wr CROSS JOIN LATERAL jsonb_array_elements(wr.refs) ref),'[]'::jsonb) AS dependencies
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
 UNION ALL
 SELECT 'workspace:'||w.id,'workspace',NULL::uuid,ARRAY[w.agent_id],ag.owner_id,
 t.owner_id,t.visibility,t.department,t.project,t.id,w.path,v.body,'작업 문서 · 초안 v'||w.revision,
 false,w.revision,w.updated_at,w.target_version,v.source_refs,
 'agent',NULL::timestamptz,NULL::timestamptz,NULL::text,NULL::text
 FROM cr_workspace_documents w JOIN cr_workspace_versions v ON v.document_id=w.id AND v.revision=w.revision
 JOIN cr_tasks t ON t.id=w.task_id JOIN cr_agents ag ON ag.id=w.agent_id
 WHERE t.target_version=w.target_version
)
-- Preserve 0.7 fingerprints when default metadata has not changed. Existing Run provenance stays valid.
SELECT *,md5(concat_ws(E'\n',key,title,body,source,visibility,department,owner_id::text,project,record_revision::text,target_version,dependencies::text)
 ||CASE WHEN memory_id IS NOT NULL AND (audience<>'agent' OR valid_from IS NOT NULL OR valid_to IS NOT NULL OR supersedes_id IS NOT NULL OR source_key IS NOT NULL)
 THEN concat_ws(E'\n','metadata-v2',audience,extract(epoch FROM valid_from)::text,extract(epoch FROM valid_to)::text,supersedes_id,source_key) ELSE '' END) AS revision
FROM documents;
