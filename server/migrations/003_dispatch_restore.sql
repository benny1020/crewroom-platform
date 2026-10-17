CREATE TABLE cr_model_dispatches (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES cr_runs(id), generation integer NOT NULL,
  input_hash text, state text NOT NULL CHECK(state IN ('prepared','launched','responded','completed','aborted','unknown')),
  response_status integer, request_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,generation)
);
CREATE TABLE cr_runtime_control (id integer PRIMARY KEY CHECK(id=1), restore_blocked boolean NOT NULL DEFAULT false);
INSERT INTO cr_runtime_control(id,restore_blocked) VALUES(1,false);
