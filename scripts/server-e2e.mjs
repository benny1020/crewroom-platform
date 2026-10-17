import { randomUUID } from "node:crypto";
import { database, migrate, transaction } from "../server/db.js";
import { seed } from "../server/seed.js";
import { bootstrap, createMember } from "../server/auth.js";
import { configuration } from "../server/config.js";
import { buildApp } from "../server/app.js";
import { startWorker } from "../server/worker.js";
if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL is required for the isolated E2E server");
const root = database(process.env.TEST_DATABASE_URL),
  schema = `cr_e2e_${randomUUID().replaceAll("-", "")}`;
await root.query(`CREATE SCHEMA ${schema}`);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = database(url.href);
await migrate(pool);
await seed(pool);
const password = "test-only-e2e-passphrase";
await bootstrap(pool, {
  email: "lead@e2e.invalid",
  name: "로프레",
  password,
  department: "development",
});
await transaction(pool, (db) =>
  createMember(db, {
    email: "member@e2e.invalid",
    name: "민지",
    password,
    department: "qa",
  }),
);
const config = configuration({
  NODE_ENV: "test",
  PUBLIC_ORIGIN: "http://127.0.0.1:4186",
  HOST: "127.0.0.1",
  PORT: "4186",
  DATA_DIR: `.local/server-e2e/${schema}`,
  MODEL_PROVIDER: "fixture",
  MODEL_NAME: "deterministic-e2e",
  CREWROOM_TEST_FIXTURE: "1",
});
const app = buildApp(pool, config),
  worker = await startWorker(pool, config);
await app.listen({ host: config.host, port: config.port });
console.log("Isolated server E2E fixture ready");
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await worker.stop();
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
    process.exit(0);
  });
