-- Hot paths contain only live work even after years of completed Runs.
CREATE INDEX cr_runs_capacity ON cr_runs(agent_id,id)
 WHERE status='running' OR (status='paused' AND started_at IS NOT NULL) OR lease_owner IS NOT NULL;
CREATE INDEX cr_auth_attempts_expiry ON cr_auth_attempts(window_start,key);
CREATE INDEX cr_workers_recent ON cr_workers(heartbeat_at DESC);

-- A late embedding response cannot overwrite a newer lease of the same source.
ALTER TABLE cr_memory_embeddings ADD COLUMN lease_token uuid;

-- A heartbeat alone does not prove the queue loop is making progress.
ALTER TABLE cr_workers ADD COLUMN last_tick_at timestamptz;
ALTER TABLE cr_workers ADD COLUMN last_error_code text;
ALTER TABLE cr_workers ADD COLUMN maintenance_at timestamptz;
ALTER TABLE cr_workers ADD COLUMN maintenance jsonb;
ALTER TABLE cr_workers ADD COLUMN maintenance_error_code text;
