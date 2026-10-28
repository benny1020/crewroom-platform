-- Better Auth 1.7.3+ writes provider_id/account_id, no longer issuer.
-- Preserve all legacy issuer values, password hashes, accounts and sessions.
-- Official migration: https://www.better-auth.com/docs/guides/1-7-upgrade-guide
-- Keep the check and DDL atomic; prevent account writes racing the preflight.
DO $$
DECLARE
  duplicate_key_groups bigint;
BEGIN
  LOCK TABLE "account" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO duplicate_key_groups
  FROM (
    SELECT 1 FROM "account"
    GROUP BY "provider_id", "account_id"
    HAVING count(*) > 1
  ) AS duplicate_keys;
  IF duplicate_key_groups > 0 THEN
    -- Counts only: identities, issuer URLs and tokens must not enter logs.
    RAISE EXCEPTION 'Better Auth upgrade blocked: % duplicate provider/account key group(s). Resolve account identities before retrying.', duplicate_key_groups;
  END IF;
  ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
  DROP INDEX IF EXISTS "account_issuer_account_id_uq";
  -- Current account identity must remain unique after the upgrade as well.
  -- Provider IDs remain part of the key: equal subjects at different providers
  -- are separate identities, and one user can retain multiple linked accounts.
  CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_account_id_uq"
    ON "account" USING btree ("provider_id", "account_id");
END $$;
