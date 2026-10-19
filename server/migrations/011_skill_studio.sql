ALTER TABLE cr_tasks DROP CONSTRAINT cr_tasks_work_type_check;
ALTER TABLE cr_tasks ADD CHECK(work_type IN ('pr-qa','review','ops','chat','code-qa','analysis','skill-design'));
ALTER TABLE cr_tasks ADD COLUMN skill_design jsonb;
ALTER TABLE cr_tasks ADD CHECK(work_type <> 'skill-design' OR (visibility='private' AND skill_design IS NOT NULL));
CREATE INDEX cr_skill_studio_recent ON cr_tasks(owner_id,updated_at DESC) WHERE work_type='skill-design';
