-- Searchable text is a rebuildable projection; source rows remain authoritative.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE TABLE cr_recall_text (
 key text PRIMARY KEY,kind text NOT NULL,task_id uuid REFERENCES cr_tasks(id),memory_id uuid REFERENCES cr_memories(id),
 title text NOT NULL,title_suffix text NOT NULL DEFAULT '',body text NOT NULL,created_at timestamptz NOT NULL,
 search tsvector GENERATED ALWAYS AS (to_tsvector('simple',title||' '||body)) STORED
);
CREATE INDEX cr_recall_text_fts ON cr_recall_text USING gin(search);
CREATE INDEX cr_recall_text_title ON cr_recall_text USING gin(title public.gin_trgm_ops);
CREATE INDEX cr_recall_text_body ON cr_recall_text USING gin(body public.gin_trgm_ops);
CREATE INDEX cr_recall_text_task ON cr_recall_text(task_id);
CREATE INDEX cr_recall_text_memory ON cr_recall_text(memory_id);
CREATE INDEX cr_recall_text_recent ON cr_recall_text(created_at DESC,key);
CREATE INDEX cr_message_source_key ON cr_messages(('message:'||id::text));
CREATE INDEX cr_memory_source_key ON cr_memories(('memory:'||id::text));
CREATE INDEX cr_episode_source_key ON cr_tasks(('episode:'||id::text));
CREATE INDEX cr_memory_recall_exclusions ON cr_memories(source_key,source_task_id) WHERE deleted_at IS NOT NULL OR source_corrected;

INSERT INTO cr_recall_text(key,kind,task_id,memory_id,title,title_suffix,body,created_at)
SELECT d.key,d.kind,d.task_id,d.memory_id,d.title,
 CASE WHEN d.kind='conversation' THEN substring(d.title from length(t.title)+1) WHEN d.kind='answer' THEN ' · '||split_part(d.key,':',3) ELSE '' END,
 d.body,d.created_at FROM cr_recall_documents d LEFT JOIN cr_tasks t ON t.id=d.task_id;

CREATE FUNCTION cr_index_episode(tid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM cr_recall_text WHERE key='episode:'||tid;
 INSERT INTO cr_recall_text(key,kind,task_id,title,body,created_at)
 SELECT 'episode:'||t.id,'episode',t.id,t.title,
 concat_ws(E'\n','요청: '||t.goal,'업무 요약: '||(t.brief->>'text'),'결과 요약: '||(a.result->>'summary'),
 '미확인: '||coalesce((a.result->'unknowns')::text,'[]'),'결과 출처: '||a.origin||' · 버전 '||a.version||' · '||a.target_version,
 '검사·수용 상태는 원본 업무의 현재 기록을 확인하세요.'),a.created_at
 FROM cr_tasks t JOIN LATERAL(SELECT * FROM cr_artifacts a WHERE a.task_id=t.id AND a.target_version=t.target_version ORDER BY a.created_at DESC LIMIT 1)a ON true WHERE t.id=tid;
END $$;
CREATE FUNCTION cr_index_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN DELETE FROM cr_recall_text WHERE key='message:'||OLD.id; END IF;
 IF TG_OP<>'DELETE' THEN
  INSERT INTO cr_recall_text(key,kind,task_id,title,title_suffix,body,created_at)
  SELECT 'message:'||NEW.id,'conversation',t.id,t.title||' · '||u.name,' · '||u.name,NEW.body,NEW.created_at FROM cr_tasks t,cr_members u WHERE t.id=NEW.task_id AND u.id=NEW.user_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER cr_message_index AFTER INSERT OR UPDATE OR DELETE ON cr_messages FOR EACH ROW EXECUTE FUNCTION cr_index_message();
CREATE FUNCTION cr_index_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN DELETE FROM cr_recall_text WHERE key='memory:'||OLD.id; END IF;
 IF TG_OP<>'DELETE' AND NEW.deleted_at IS NULL THEN
  INSERT INTO cr_recall_text(key,kind,task_id,memory_id,title,body,created_at) VALUES('memory:'||NEW.id,NEW.kind,NEW.source_task_id,NEW.id,NEW.title,NEW.body,NEW.updated_at);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER cr_memory_index AFTER INSERT OR UPDATE OR DELETE ON cr_memories FOR EACH ROW EXECUTE FUNCTION cr_index_memory();
CREATE FUNCTION cr_index_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN DELETE FROM cr_recall_text WHERE task_id=OLD.task_id AND key LIKE 'artifact:'||OLD.id||':%'; END IF;
 IF TG_OP<>'DELETE' THEN
  INSERT INTO cr_recall_text(key,kind,task_id,title,title_suffix,body,created_at)
  SELECT 'artifact:'||NEW.id||':'||p.section||':'||p.ordinal,'answer',NEW.task_id,t.title||' · '||p.section,' · '||p.section,p.body,NEW.created_at
  FROM cr_tasks t CROSS JOIN LATERAL (
   SELECT 'summary' AS section,1::bigint AS ordinal,NEW.result->>'summary' AS body
   UNION ALL SELECT section,ordinal,value FROM (VALUES('evidence'),('unknowns'),('nextActions'))sections(section)
   CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(NEW.result->section)='array' THEN NEW.result->section ELSE '[]'::jsonb END) WITH ORDINALITY item(value,ordinal)
  )p WHERE t.id=NEW.task_id AND p.body IS NOT NULL AND p.body<>'';
  PERFORM cr_index_episode(NEW.task_id);
 ELSE PERFORM cr_index_episode(OLD.task_id);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER cr_artifact_index AFTER INSERT OR UPDATE OR DELETE ON cr_artifacts FOR EACH ROW EXECUTE FUNCTION cr_index_artifact();
CREATE FUNCTION cr_index_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.title IS DISTINCT FROM OLD.title THEN UPDATE cr_recall_text SET title=NEW.title||title_suffix WHERE task_id=NEW.id AND memory_id IS NULL; END IF;
 IF NEW.title IS DISTINCT FROM OLD.title OR NEW.goal IS DISTINCT FROM OLD.goal OR NEW.brief IS DISTINCT FROM OLD.brief OR NEW.target_version IS DISTINCT FROM OLD.target_version THEN PERFORM cr_index_episode(NEW.id); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER cr_task_index AFTER UPDATE OF title,goal,brief,target_version ON cr_tasks FOR EACH ROW EXECUTE FUNCTION cr_index_task();
CREATE FUNCTION cr_index_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.name IS DISTINCT FROM OLD.name THEN UPDATE cr_recall_text i SET title=t.title||' · '||NEW.name,title_suffix=' · '||NEW.name FROM cr_messages m,cr_tasks t WHERE i.key='message:'||m.id AND m.user_id=NEW.id AND t.id=m.task_id; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER cr_member_index AFTER UPDATE OF name ON cr_members FOR EACH ROW EXECUTE FUNCTION cr_index_member();

CREATE INDEX cr_embeddings_capacity ON cr_memory_embeddings(profile_id,source_key) WHERE status='ready';
CREATE INDEX cr_session_expiry ON cr_sessions(expires_at,token_hash);

ALTER TABLE cr_memory_embeddings ADD COLUMN vector_values bigint GENERATED ALWAYS AS (jsonb_array_length(vectors)::bigint*coalesce(jsonb_array_length(vectors->0->'vector'),0)) STORED;
ALTER TABLE cr_memory_embeddings ADD COLUMN vector_bytes integer GENERATED ALWAYS AS (octet_length(vectors::text)) STORED;

CREATE INDEX cr_messages_body_trgm ON cr_messages USING gin(body public.gin_trgm_ops);
CREATE INDEX cr_tasks_title_trgm ON cr_tasks USING gin(title public.gin_trgm_ops);
CREATE INDEX cr_tasks_target_trgm ON cr_tasks USING gin(target public.gin_trgm_ops);
CREATE INDEX cr_tasks_project_trgm ON cr_tasks USING gin(project public.gin_trgm_ops);

CREATE INDEX cr_memory_pinned_search ON cr_memories(updated_at DESC) WHERE pinned AND deleted_at IS NULL;
