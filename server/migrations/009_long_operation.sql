-- Stable history access paths. Original bodies and immutable Run inputs remain intact.
CREATE INDEX cr_messages_task_history ON cr_messages(task_id,id DESC);
CREATE INDEX cr_runs_task_history ON cr_runs(task_id,created_at DESC,id DESC);
CREATE INDEX cr_artifacts_task_history ON cr_artifacts(task_id,created_at DESC,id DESC);
CREATE INDEX cr_acceptances_task_history ON cr_acceptances(task_id,created_at DESC,id DESC);
CREATE INDEX cr_questions_task_history ON cr_questions(task_id,created_at DESC,id DESC);
CREATE INDEX cr_tasks_archive ON cr_tasks(number DESC);
CREATE INDEX cr_tasks_responsible_archive ON cr_tasks(responsible_id,number DESC);
CREATE INDEX cr_events_actor_history ON cr_events(actor_id,id DESC) WHERE task_id IS NULL;
CREATE INDEX cr_artifacts_recent_models ON cr_artifacts(created_at) WHERE origin='model';

-- Keep growing correction history out of the frequently loaded Task row.
CREATE TABLE cr_brief_revisions(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,task_id uuid NOT NULL REFERENCES cr_tasks(id),body jsonb NOT NULL);
CREATE INDEX cr_brief_task_history ON cr_brief_revisions(task_id,id DESC);
INSERT INTO cr_brief_revisions(task_id,body) SELECT t.id,h.body FROM cr_tasks t CROSS JOIN LATERAL jsonb_array_elements(t.brief_history) WITH ORDINALITY AS h(body,position) ORDER BY t.number,h.position;
UPDATE cr_tasks SET brief_history='[]'::jsonb WHERE brief_history<>'[]'::jsonb;
CREATE FUNCTION cr_store_brief_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF jsonb_array_length(NEW.brief_history)>0 THEN
  INSERT INTO cr_brief_revisions(task_id,body) SELECT NEW.id,x FROM jsonb_array_elements(NEW.brief_history) x;
  UPDATE cr_tasks SET brief_history='[]'::jsonb WHERE id=NEW.id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER cr_capture_briefs AFTER INSERT OR UPDATE OF brief_history ON cr_tasks FOR EACH ROW EXECUTE FUNCTION cr_store_brief_history();

-- Delivered at commit, including when a lower event ID commits after a higher ID.
CREATE FUNCTION cr_notify_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('crewroom_events_v1',json_build_object('schema',TG_TABLE_SCHEMA,'id',NEW.id::text)::text);
 RETURN NULL;
END $$;
CREATE TRIGGER cr_event_wakeup AFTER INSERT ON cr_events FOR EACH ROW EXECUTE FUNCTION cr_notify_event();
