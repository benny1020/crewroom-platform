-- Better Auth's core model requires unique user.email and session.token.
-- Use their existing exact text values: no normalization, merging, deletion,
-- password changes or token rotation. Preserve published 0395 unchanged.
-- https://better-auth.com/docs/concepts/database
DO $$
DECLARE
  duplicate_email_groups bigint;
  duplicate_token_groups bigint;
BEGIN
  -- Every upgrade takes these locks in the same fixed order. Both preflights
  -- precede all DDL, and writes cannot race the checks/index creation.
  LOCK TABLE "user" IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO duplicate_email_groups
  FROM (SELECT 1 FROM "user" GROUP BY "email" HAVING count(*) > 1) AS duplicate_emails;
  SELECT count(*) INTO duplicate_token_groups
  FROM (SELECT 1 FROM "session" GROUP BY "token" HAVING count(*) > 1) AS duplicate_tokens;
  IF duplicate_email_groups > 0 OR duplicate_token_groups > 0 THEN
    -- Counts only. Neither emails nor authentication tokens enter this error.
    RAISE EXCEPTION 'Better Auth upgrade blocked: % duplicate email key group(s), % duplicate session token key group(s). Resolve identities before retrying.', duplicate_email_groups, duplicate_token_groups;
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS "user_email_uq" ON "user" USING btree ("email");
  CREATE UNIQUE INDEX IF NOT EXISTS "session_token_uq" ON "session" USING btree ("token");
END $$;
