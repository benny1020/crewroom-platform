import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { transaction } from "../../server/db.js";
import { createMember } from "../../server/auth.js";
import { database, migrate } from "../../server/db.js";
import { seed } from "../../server/seed.js";
import { bootstrap } from "../../server/auth.js";
import { configuration } from "../../server/config.js";
import { buildApp } from "../../server/app.js";

export const password = "test-only-passphrase-2026";
export const values = (overrides = {}) => ({
  workType: "pr-qa",
  target: "요청에서 제공한 검토 자료",
  targetVersion: "abc1234",
  project: "통합 검증",
  goal: "로그인 세션 검토와 QA 계획",
  visibility: "team",
  ...overrides,
});
export async function harness(t, options = {}) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "TEST_DATABASE_URL is required; tests never select a production DB automatically",
    );
  const root = database(url),
    schema = `cr_test_${randomUUID().replaceAll("-", "")}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const testUrl = new URL(url);
  testUrl.searchParams.set("options", `-c search_path=${schema}`);
  const pool = database(testUrl.href);
  await migrate(pool);
  await seed(pool);
  const config = {
    ...configuration({
      PUBLIC_ORIGIN: "http://localhost:4180",
      MODEL_PROVIDER: "fixture",
      MODEL_NAME: "fixture",
      CREWROOM_TEST_FIXTURE: "1",
      SERVE_DIST: "0",
      ALLOWED_EMAILS: "member@example.com,third@example.com",
      DATA_DIR: `.local/server-tests/${schema}`,
    }),
    ...options,
  };
  await bootstrap(pool, {
    email: "lead@example.com",
    name: "팀장",
    password,
    department: "development",
  });
  const app = buildApp(pool, config);
  await app.ready();
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
    await app.close();
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  });
  async function client(email, provision = false, extra = {}) {
    if (provision)
      await transaction(pool, (db) =>
        createMember(db, {
          email,
          password,
          name: "팀원",
          department: "qa",
          leadRequested: true,
          ...extra,
        }),
      );
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: config.origin, "content-type": "application/json" },
      payload: { email, password },
    });
    if (response.statusCode !== 200)
      throw new Error(`Auth failed ${response.statusCode}: ${response.body}`);
    const result = response.json(),
      cookie = response.headers["set-cookie"].split(";")[0];
    return {
      user: result.user,
      csrf: result.csrfToken,
      cookie,
      async request(method, url, payload, headers = {}) {
        return app.inject({
          method,
          url,
          headers: {
            cookie,
            origin: config.origin,
            "content-type": "application/json",
            "x-csrf-token": result.csrfToken,
            ...headers,
          },
          ...(payload === undefined ? {} : { payload }),
        });
      },
    };
  }
  return { pool, app, config, client, cleanup };
}
export async function newTask(client, input = values()) {
  const response = await client.request("POST", "/api/tasks", input, {
    "idempotency-key": randomUUID(),
  });
  if (response.statusCode !== 201) throw new Error(response.body);
  return response.json().task;
}
export async function command(client, task, action, extra = {}) {
  return client.request("POST", `/api/tasks/${task.id}/commands`, {
    action,
    revision: task.revision,
    ...extra,
  });
}
export async function waitFor(fn, predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (predicate(value)) return value;
    await delay(40);
  }
  throw new Error("Condition did not become true");
}
