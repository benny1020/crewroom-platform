/**
 * End-to-end coverage for the credential sign-up and sign-in that a
 * self-hosted install depends on, driven through the real Better Auth mount
 * against the real Drizzle schema and a migrated Postgres.
 *
 * The other Better Auth suites mount either a stub handler or the in-memory
 * adapter, so neither notices when Better Auth's `account` model grows a field
 * the Drizzle table does not have. The Drizzle adapter validates the model
 * against the schema on every write and throws
 * `The field "<name>" does not exist in the "account" Drizzle schema`, which
 * the mount turns into a 500 with an empty body — a fresh install cannot
 * create its first user at all. This suite is the one that fails when that
 * happens.
 */

import fs from "node:fs";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authAccounts, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41999";
const EMAIL = "founder@example.com";
const PASSWORD = "correct-horse-battery-staple";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  // Only the auth-relevant fields are read by `createBetterAuthInstance`; the
  // rest of `Config` describes storage, backups, and scheduling that the Better
  // Auth instance never looks at.
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41999,
  } as unknown as Config;
}

function sessionCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((cookie) => cookie.includes("session_token"));
}

describeEmbeddedPostgres("Better Auth credential sign-up against the real schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-credential-signup-tests";
    // The rate limiter is on by default in `authenticated` mode and would score
    // the sign-up and sign-in this suite issues back to back.
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-signup-");
    db = createDb(database.connectionString);

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    // Mounted exactly as `createApp` mounts it, and with no body parser in
    // front of it: Better Auth reads the raw request body itself.
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  it("creates the user and its credential account, then signs that user in", async () => {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD, name: "Founder" });

    // A missing `account` column fails here with a 500 and an empty body.
    expect(signUp.status).toBe(200);
    expect(signUp.body?.user?.email).toBe(EMAIL);

    // Sign-up has to leave a usable account row behind. A half-created user —
    // a `user` row with no `account` — cannot sign in, cannot sign up again,
    // and cannot reset its password.
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: "credential",
      issuer: null,
    });
    expect(accounts[0]?.password).toBeTruthy();

    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD });

    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.email).toBe(EMAIL);
    expect(sessionCookies(signIn).length).toBeGreaterThan(0);
  });

  it("preserves legacy credential hashes, issuer values and live sessions through the forward migration", async () => {
    const signUp = await request(app).post("/api/auth/sign-up/email").set("origin", ORIGIN)
      .send({ email: "legacy@example.com", password: PASSWORD, name: "Legacy" });
    expect(signUp.status).toBe(200);
    const cookies = sessionCookies(signUp).map((cookie) => cookie.split(";")[0]);
    expect(cookies.length).toBeGreaterThan(0);
    const sql = db.$client;
    // Recreate the 1.7.0–1.7.2 constraints on this disposable database.
    // These are real password hashes and signed session cookies; no provider
    // credentials or external identity services are involved.
    await sql`UPDATE "account" SET "issuer" = 'local:credential' WHERE "issuer" IS NULL`;
    await sql`DROP INDEX "account_provider_account_id_uq"`;
    await sql`ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL`;
    await sql`CREATE UNIQUE INDEX "account_issuer_account_id_uq" ON "account" ("issuer", "account_id")`;
    const accountsBefore = await sql`SELECT * FROM "account" ORDER BY "id"`;
    const sessionsBefore = await sql`SELECT * FROM "session" ORDER BY "id"`;
    const migration = fs.readFileSync(new URL("../../../packages/db/src/migrations/0395_better_auth_provider_account_identity.sql", import.meta.url), "utf8");
    await sql.unsafe(migration);
    await sql.unsafe(migration); // Retrying the SQL is harmless as well as journal retries.
    expect(await sql`SELECT * FROM "account" ORDER BY "id"`).toEqual(accountsBefore);
    expect(await sql`SELECT * FROM "session" ORDER BY "id"`).toEqual(sessionsBefore);
    const existingSession = await request(app).get("/api/auth/get-session").set("cookie", cookies);
    expect(existingSession.status).toBe(200);
    expect(existingSession.body?.user?.email).toBe("legacy@example.com");
    const signIn = await request(app).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email: "legacy@example.com", password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.email).toBe("legacy@example.com");
    const newSignUp = await request(app).post("/api/auth/sign-up/email").set("origin", ORIGIN)
      .send({ email: "after-upgrade@example.com", password: PASSWORD, name: "After upgrade" });
    expect(newSignUp.status).toBe(200);
    const [created] = await sql`SELECT "issuer" FROM "account" WHERE "user_id" = ${newSignUp.body.user.id}`;
    expect(created?.issuer).toBeNull();
  });

  it("preserves existing accounts, hashes and signed sessions through the email/token unique migration", async () => {
    const signUp = await request(app).post("/api/auth/sign-up/email").set("origin", ORIGIN)
      .send({ email: "before-unique@example.com", password: PASSWORD, name: "Before unique" });
    expect(signUp.status).toBe(200);
    const cookies = sessionCookies(signUp).map((cookie) => cookie.split(";")[0]);
    expect(cookies.length).toBeGreaterThan(0);
    const sql = db.$client;
    await sql`DROP INDEX "user_email_uq"`;
    await sql`DROP INDEX "session_token_uq"`;
    const usersBefore = await sql`SELECT * FROM "user" ORDER BY "id"`;
    const accountsBefore = await sql`SELECT * FROM "account" ORDER BY "id"`;
    const sessionsBefore = await sql`SELECT * FROM "session" ORDER BY "id"`;
    const migration = fs.readFileSync(new URL("../../../packages/db/src/migrations/0396_better_auth_unique_identity_keys.sql", import.meta.url), "utf8");
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    expect(await sql`SELECT * FROM "user" ORDER BY "id"`).toEqual(usersBefore);
    expect(await sql`SELECT * FROM "account" ORDER BY "id"`).toEqual(accountsBefore);
    expect(await sql`SELECT * FROM "session" ORDER BY "id"`).toEqual(sessionsBefore);
    const existingSession = await request(app).get("/api/auth/get-session").set("cookie", cookies);
    expect(existingSession.status).toBe(200);
    expect(existingSession.body?.user?.email).toBe("before-unique@example.com");
    const signIn = await request(app).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email: "before-unique@example.com", password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.email).toBe("before-unique@example.com");
  });

  it("keeps one user and one credential account after concurrent real sign-ups", async () => {
    const email = "concurrent-signup@example.com";
    const responses = await Promise.all(["First", "Second"].map((name) => request(app)
      .post("/api/auth/sign-up/email").set("origin", ORIGIN).send({ email, password: PASSWORD, name })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    const denied = responses.find((response) => response.status !== 200)!;
    expect(["FAILED_TO_CREATE_USER", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"]).toContain(denied.body?.code);
    expect(sessionCookies(denied)).toHaveLength(0);
    const sql = db.$client;
    const users = await sql`SELECT "id" FROM "user" WHERE "email" = ${email}`;
    expect(users).toHaveLength(1);
    const accounts = await sql`SELECT "user_id", "provider_id", "password" FROM "account" WHERE "user_id" = ${users[0]!.id}`;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider_id).toBe("credential");
    expect(accounts[0]?.password).toBeTruthy();
    const signIn = await request(app).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.id).toBe(users[0]!.id);
  });

});
