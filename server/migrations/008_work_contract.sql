ALTER TABLE cr_tasks DROP CONSTRAINT cr_tasks_work_type_check;
ALTER TABLE cr_tasks ADD CHECK(work_type IN ('pr-qa','review','ops','chat','code-qa','analysis'));
ALTER TABLE cr_tasks ADD COLUMN rework jsonb;
ALTER TABLE cr_tasks ADD COLUMN question_revision integer NOT NULL DEFAULT 0;
-- Preserve explicit legacy rework instructions from their recorded user event.
-- Old immutable Run snapshots remain untouched.
UPDATE cr_tasks t SET rework = (
 SELECT jsonb_build_object('reason',e.data->>'reason','targetVersion',t.target_version,
 'requestedBy',e.actor_id,'requestedAt',e.created_at,'previous',NULL,
 'notice','이전 검사와 수용은 현재 대상의 검증 근거가 아닙니다.')
 FROM cr_events e WHERE e.task_id=t.id AND e.type='rework' AND e.actor_type='user'
 AND e.data->>'targetVersion'=t.target_version AND e.data ? 'reason'
 ORDER BY e.id DESC LIMIT 1
);
CREATE TABLE cr_questions (
 id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES cr_tasks(id),
 target_version text NOT NULL, asked_by uuid NOT NULL REFERENCES cr_members(id),
 assignee_id uuid NOT NULL REFERENCES cr_members(id), prompt text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','closed','superseded')),
 answer text, answered_by uuid REFERENCES cr_members(id),
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
);
CREATE INDEX ON cr_questions(task_id,created_at);
CREATE INDEX ON cr_questions(assignee_id) WHERE status='pending';
