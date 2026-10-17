ALTER TABLE cr_tasks DROP CONSTRAINT cr_tasks_work_type_check;
ALTER TABLE cr_tasks ADD CHECK(work_type IN ('pr-qa','review','ops','chat','code-qa'));
ALTER TABLE cr_model_dispatches DROP CONSTRAINT cr_model_dispatches_run_id_generation_key;
ALTER TABLE cr_runs ADD COLUMN progress jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE cr_execution_jobs (
 run_id uuid NOT NULL REFERENCES cr_runs(id), generation integer NOT NULL,
 job_id text NOT NULL, capability text, endpoint text NOT NULL, profile_id text NOT NULL,
 status text NOT NULL DEFAULT 'preparing', checkpoint jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,generation)
);
