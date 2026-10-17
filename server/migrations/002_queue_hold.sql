DROP INDEX cr_one_active_agent;
CREATE UNIQUE INDEX cr_one_active_agent ON cr_runs(agent_id)
WHERE status='running' OR (status='paused' AND started_at IS NOT NULL);
