CREATE TABLE cr_members (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
  password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('lead','member')),
  department text NOT NULL CHECK(department IN ('direct','development','operations','qa')),
  lead_requested boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cr_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES cr_members(id),
  csrf_hash text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cr_sessions(expires_at);
CREATE TABLE cr_auth_attempts (key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL DEFAULT now());
CREATE TABLE cr_agents (
  id text PRIMARY KEY, owner_id uuid REFERENCES cr_members(id), department text NOT NULL,
  name text NOT NULL, role text NOT NULL, character text NOT NULL, instructions text NOT NULL,
  runtime text NOT NULL DEFAULT 'readonly', config_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cr_skills (
  id text PRIMARY KEY, owner_id uuid REFERENCES cr_members(id), name text NOT NULL,
  steward_id uuid REFERENCES cr_members(id), current_version integer NOT NULL DEFAULT 1
);
CREATE TABLE cr_skill_versions (
  skill_id text NOT NULL REFERENCES cr_skills(id), version integer NOT NULL,
  instructions text NOT NULL, done_criteria text NOT NULL, content_hash text NOT NULL,
  created_by uuid REFERENCES cr_members(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(skill_id,version)
);
CREATE TABLE cr_skill_bindings (
  agent_id text NOT NULL REFERENCES cr_agents(id), skill_id text NOT NULL,
  version integer NOT NULL, PRIMARY KEY(agent_id,skill_id),
  FOREIGN KEY(skill_id,version) REFERENCES cr_skill_versions(skill_id,version)
);
CREATE TABLE cr_tasks (
  id uuid PRIMARY KEY, number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id uuid NOT NULL REFERENCES cr_members(id), responsible_id uuid NOT NULL REFERENCES cr_members(id),
  visibility text NOT NULL CHECK(visibility IN ('private','department','team')), department text NOT NULL,
  title text NOT NULL, project text NOT NULL, target text NOT NULL, target_version text NOT NULL,
  work_type text NOT NULL CHECK(work_type IN ('pr-qa','review','ops','chat')),
  goal text NOT NULL, done_criteria text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','result_ready','done','failed','cancelled')),
  step_index integer NOT NULL DEFAULT 0, revision integer NOT NULL DEFAULT 1,
  brief jsonb NOT NULL, brief_history jsonb NOT NULL DEFAULT '[]', current_run_id uuid,
  example_artifact_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cr_tasks(updated_at DESC);
CREATE TABLE cr_steps (
  task_id uuid NOT NULL REFERENCES cr_tasks(id), position integer NOT NULL,
  name text NOT NULL, agent_id text NOT NULL REFERENCES cr_agents(id), skill_id text NOT NULL REFERENCES cr_skills(id),
  input_artifact_id uuid, current_artifact_id uuid, PRIMARY KEY(task_id,position)
);
CREATE TABLE cr_runs (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES cr_tasks(id), step_index integer NOT NULL,
  agent_id text NOT NULL REFERENCES cr_agents(id), requested_by uuid NOT NULL REFERENCES cr_members(id),
  status text NOT NULL CHECK(status IN ('queued','running','paused','succeeded','failed','cancelled')),
  generation integer NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz,
  snapshot jsonb NOT NULL, error_code text, error_message text,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  FOREIGN KEY(task_id,step_index) REFERENCES cr_steps(task_id,position)
);
CREATE INDEX ON cr_runs(created_at) WHERE status='queued';
CREATE UNIQUE INDEX cr_one_active_agent ON cr_runs(agent_id) WHERE status IN ('running','paused');
CREATE UNIQUE INDEX cr_one_pending_task ON cr_runs(task_id) WHERE status IN ('queued','running','paused');
ALTER TABLE cr_tasks ADD FOREIGN KEY(current_run_id) REFERENCES cr_runs(id);
CREATE TABLE cr_artifacts (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES cr_tasks(id), step_index integer NOT NULL,
  run_id uuid UNIQUE REFERENCES cr_runs(id), version integer NOT NULL, target_version text NOT NULL,
  origin text NOT NULL CHECK(origin IN ('external','model','fixture')), result jsonb NOT NULL,
  content_hash text NOT NULL, imported_by uuid REFERENCES cr_members(id), source text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,step_index,version)
);
ALTER TABLE cr_steps ADD FOREIGN KEY(input_artifact_id) REFERENCES cr_artifacts(id);
ALTER TABLE cr_steps ADD FOREIGN KEY(current_artifact_id) REFERENCES cr_artifacts(id);
ALTER TABLE cr_tasks ADD FOREIGN KEY(example_artifact_id) REFERENCES cr_artifacts(id);
CREATE TABLE cr_acceptances (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES cr_tasks(id), artifact_id uuid NOT NULL REFERENCES cr_artifacts(id),
  accepted_by uuid NOT NULL REFERENCES cr_members(id), target_version text NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cr_one_current_acceptance ON cr_acceptances(task_id) WHERE revoked_at IS NULL;
CREATE TABLE cr_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, task_id uuid NOT NULL REFERENCES cr_tasks(id),
  user_id uuid NOT NULL REFERENCES cr_members(id), body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cr_claims (task_id uuid REFERENCES cr_tasks(id), user_id uuid REFERENCES cr_members(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,user_id));
CREATE TABLE cr_memories (
  id uuid PRIMARY KEY, agent_id text NOT NULL REFERENCES cr_agents(id), owner_id uuid NOT NULL REFERENCES cr_members(id),
  visibility text NOT NULL CHECK(visibility IN ('private','department','team')), department text NOT NULL,
  source_task_id uuid REFERENCES cr_tasks(id), title text NOT NULL, body text NOT NULL, source text NOT NULL,
  revision integer NOT NULL DEFAULT 1, history jsonb NOT NULL DEFAULT '[]', deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cr_memory_search ON cr_memories USING gin(to_tsvector('simple',title || ' ' || body));
CREATE TABLE cr_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, task_id uuid REFERENCES cr_tasks(id),
  actor_type text NOT NULL CHECK(actor_type IN ('user','run','system')), actor_id text NOT NULL,
  type text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cr_events(task_id,id);
CREATE TABLE cr_idempotency (
  user_id uuid NOT NULL REFERENCES cr_members(id), key text NOT NULL, request_hash text NOT NULL,
  resource_id uuid NOT NULL REFERENCES cr_tasks(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,key)
);
CREATE TABLE cr_workers (id text PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now(), version text NOT NULL, state text NOT NULL);
