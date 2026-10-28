import { createHash } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0395_better_auth_provider_account_identity.sql", import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

async function legacyDatabase() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-account-provider-upgrade-");
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1 });
  cleanups.push(async () => sql.end());
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}`;
  await sql`DROP INDEX "account_provider_account_id_uq"`;
  await sql`ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL`;
  await sql`CREATE UNIQUE INDEX "account_issuer_account_id_uq" ON "account" ("issuer", "account_id")`;
  await sql`INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at") VALUES ('legacy-user', 'Legacy', 'legacy@example.invalid', now(), now())`;
  return { sql, url: database.connectionString };
}

describePostgres("Better Auth provider/account identity forward migration", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("preserves different providers sharing an account ID and can be retried", async () => {
    const { sql, url } = await legacyDatabase();
    await sql`INSERT INTO "account" ("id", "issuer", "account_id", "provider_id", "user_id", "access_token", "created_at", "updated_at") VALUES
      ('provider-a', 'issuer-a', 'shared-subject', 'provider-a', 'legacy-user', 'synthetic-token-a', now(), now()),
      ('provider-b', 'issuer-b', 'shared-subject', 'provider-b', 'legacy-user', 'synthetic-token-b', now(), now())`;
    const before = await sql`SELECT * FROM "account" ORDER BY "id"`;
    await applyPendingMigrations(url);
    await applyPendingMigrations(url);
    expect(await sql`SELECT * FROM "account" ORDER BY "id"`).toEqual(before);
    const [column] = await sql`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'issuer'`;
    expect(column?.is_nullable).toBe("YES");
    expect(await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'account_issuer_account_id_uq'`).toHaveLength(0);
    await sql`INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "created_at", "updated_at") VALUES
      ('provider-c', 'shared-subject', 'provider-c', 'legacy-user', now(), now())`;
    expect(await sql`SELECT "id" FROM "account" WHERE "account_id" = 'shared-subject'`).toHaveLength(3);
  }, 30_000);

  it("rejects duplicate provider/account keys atomically without merging users or changing rows", async () => {
    const { sql, url } = await legacyDatabase();
    await sql`INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at") VALUES ('other-user', 'Other', 'other@example.invalid', now(), now())`;
    const usersBefore = await sql`SELECT * FROM "user" ORDER BY "id"`;
    await sql`INSERT INTO "account" ("id", "issuer", "account_id", "provider_id", "user_id", "created_at", "updated_at") VALUES
      ('duplicate-a', 'issuer-a', 'private-subject', 'provider-a', 'legacy-user', now(), now()),
      ('duplicate-b', 'issuer-b', 'private-subject', 'provider-a', 'other-user', now(), now())`;
    const before = await sql`SELECT * FROM "account" ORDER BY "id"`;
    await expect(applyPendingMigrations(url)).rejects.toMatchObject({
      code: "P0001",
      message: "Better Auth upgrade blocked: 1 duplicate provider/account key group(s). Resolve account identities before retrying.",
    });
    expect(await sql`SELECT * FROM "account" ORDER BY "id"`).toEqual(before);
    expect(await sql`SELECT * FROM "user" ORDER BY "id"`).toEqual(usersBefore);
    const [column] = await sql`SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'issuer'`;
    expect(column?.is_nullable).toBe("NO");
    expect(await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'account_issuer_account_id_uq'`).toHaveLength(1);
    expect(await sql`SELECT hash FROM "drizzle"."__drizzle_migrations" WHERE hash = ${migrationHash}`).toHaveLength(0);
  }, 30_000);

  it("allows exactly one of two concurrent inserts for the same current identity", async () => {
    const { sql, url } = await legacyDatabase();
    await applyPendingMigrations(url);
    const competitor = postgres(url, { max: 1 });
    cleanups.push(async () => competitor.end());
    // Distinct backend connections start together; a DB constraint arbitrates
    // the race independently of Better Auth's read-before-create behavior.
    const [firstPid] = await sql`SELECT pg_backend_pid() AS pid`;
    const [secondPid] = await competitor`SELECT pg_backend_pid() AS pid`;
    expect(firstPid?.pid).not.toBe(secondPid?.pid);
    const results = await Promise.allSettled([
      sql`INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "created_at", "updated_at") VALUES
        ('concurrent-a', 'same-subject', 'same-provider', 'legacy-user', now(), now())`,
      competitor`INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "created_at", "updated_at") VALUES
        ('concurrent-b', 'same-subject', 'same-provider', 'legacy-user', now(), now())`,
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "23505", constraint_name: "account_provider_account_id_uq" });
    expect(await sql`SELECT "id" FROM "account" WHERE "provider_id" = 'same-provider' AND "account_id" = 'same-subject'`).toHaveLength(1);
  }, 30_000);

});
