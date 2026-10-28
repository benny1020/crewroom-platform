import { createHash } from "node:crypto";
import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { authSessions, authUsers } from "./schema/auth.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationSql = fs.readFileSync(new URL("./migrations/0396_better_auth_unique_identity_keys.sql", import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

async function legacyDatabase() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-auth-unique-upgrade-");
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1 });
  cleanups.push(async () => sql.end());
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}`;
  await sql`DROP INDEX "user_email_uq"`;
  await sql`DROP INDEX "session_token_uq"`;
  await sql`INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at") VALUES
    ('existing-user', 'Existing', 'existing@example.invalid', now(), now())`;
  return { sql, url: database.connectionString };
}

describe("Better Auth required identity keys", () => {
  it("declares unique email and session token indexes without changing their text columns", () => {
    for (const [table, indexName, columnName] of [[authUsers, "user_email_uq", "email"], [authSessions, "session_token_uq", "token"]] as const) {
      const config = getTableConfig(table);
      const index = config.indexes.find((entry) => entry.config.name === indexName);
      expect(index?.config.unique).toBe(true);
      expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual([columnName]);
      expect(config.columns.find((column) => column.name === columnName)?.notNull).toBe(true);
    }
  });
});

describePostgres("Better Auth unique identity key forward migration", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("preserves exact text and all existing rows when applying or retrying the migration", async () => {
    const { sql, url } = await legacyDatabase();
    await sql`INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at") VALUES
      ('upper-user', 'Upper', 'Case@example.invalid', now(), now()),
      ('lower-user', 'Lower', 'case@example.invalid', now(), now())`;
    await sql`INSERT INTO "session" ("id", "token", "user_id", "expires_at", "created_at", "updated_at") VALUES
      ('upper-session', 'synthetic-token-A', 'upper-user', now() + interval '1 day', now(), now()),
      ('lower-session', 'synthetic-token-a', 'lower-user', now() + interval '1 day', now(), now())`;
    const users = await sql`SELECT * FROM "user" ORDER BY "id"`;
    const sessions = await sql`SELECT * FROM "session" ORDER BY "id"`;
    await applyPendingMigrations(url);
    await applyPendingMigrations(url);
    await sql.unsafe(migrationSql);
    expect(await sql`SELECT * FROM "user" ORDER BY "id"`).toEqual(users);
    expect(await sql`SELECT * FROM "session" ORDER BY "id"`).toEqual(sessions);
    expect(await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('user_email_uq', 'session_token_uq')`).toHaveLength(2);
  }, 30_000);

  it.each(["email", "token"] as const)("refuses existing duplicate %s values without changing rows, indexes or journal", async (key) => {
    const { sql, url } = await legacyDatabase();
    await sql`INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at") VALUES
      ('other-user', 'Other', ${key === "email" ? "existing@example.invalid" : "other@example.invalid"}, now(), now())`;
    await sql`INSERT INTO "session" ("id", "token", "user_id", "expires_at", "created_at", "updated_at") VALUES
      ('existing-session', 'synthetic-duplicate', 'existing-user', now() + interval '1 day', now(), now()),
      ('other-session', ${key === "token" ? "synthetic-duplicate" : "synthetic-other"}, 'other-user', now() + interval '1 day', now(), now())`;
    const users = await sql`SELECT * FROM "user" ORDER BY "id"`;
    const sessions = await sql`SELECT * FROM "session" ORDER BY "id"`;
    const journal = await sql`SELECT * FROM "drizzle"."__drizzle_migrations" ORDER BY "id"`;
    await expect(applyPendingMigrations(url)).rejects.toMatchObject({
      code: "P0001",
      message: `Better Auth upgrade blocked: ${key === "email" ? 1 : 0} duplicate email key group(s), ${key === "token" ? 1 : 0} duplicate session token key group(s). Resolve identities before retrying.`,
    });
    expect(await sql`SELECT * FROM "user" ORDER BY "id"`).toEqual(users);
    expect(await sql`SELECT * FROM "session" ORDER BY "id"`).toEqual(sessions);
    expect(await sql`SELECT * FROM "drizzle"."__drizzle_migrations" ORDER BY "id"`).toEqual(journal);
    expect(await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('user_email_uq', 'session_token_uq')`).toHaveLength(0);
  }, 30_000);

  it.each(["email", "token"] as const)("arbitrates concurrent %s inserts across two connections", async (key) => {
    const { sql, url } = await legacyDatabase();
    await applyPendingMigrations(url);
    const competitor = postgres(url, { max: 1 });
    cleanups.push(async () => competitor.end());
    const [first] = await sql`SELECT pg_backend_pid() AS pid`;
    const [second] = await competitor`SELECT pg_backend_pid() AS pid`;
    expect(first?.pid).not.toBe(second?.pid);
    const results = await Promise.allSettled([sql, competitor].map((connection, index) => key === "email"
      ? connection`INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at") VALUES
          (${`racing-user-${index}`}, 'Racing', 'racing@example.invalid', now(), now())`
      : connection`INSERT INTO "session" ("id", "token", "user_id", "expires_at", "created_at", "updated_at") VALUES
          (${`racing-session-${index}`}, 'synthetic-racing-token', 'existing-user', now() + interval '1 day', now(), now())`));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "23505", constraint_name: key === "email" ? "user_email_uq" : "session_token_uq" });
    expect(key === "email"
      ? await sql`SELECT "id" FROM "user" WHERE "email" = 'racing@example.invalid'`
      : await sql`SELECT "id" FROM "session" WHERE "token" = 'synthetic-racing-token'`).toHaveLength(1);
  }, 30_000);
});
