import { randomUUID } from "node:crypto";
import { database, migrate, transaction } from "../server/db.js";
import { seed } from "../server/seed.js";
import { bootstrap, createMember } from "../server/auth.js";
import { configuration } from "../server/config.js";
import { buildApp } from "../server/app.js";
import {
  startWorker,
  claimRun,
  recallForRun,
  processRun,
} from "../server/worker.js";
import { createTask, executeCommand } from "../server/tasks.js";
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
// Seed one evidence-bound proposal through the same Worker protocol as a model call.
const lead = (
  await pool.query("SELECT * FROM cr_members WHERE email=$1", [
    "lead@e2e.invalid",
  ])
).rows[0];
const sourceTask = await createTask(
  pool,
  lead,
  {
    workType: "chat",
    agentId: "review",
    project: "기억 검토 검증",
    target: "합성 정책 원문",
    targetVersion: "policy-v1",
    goal: "로그인 정책을 기억 후보로 정리",
    visibility: "team",
  },
  randomUUID(),
);
const msg = (
  await pool.query(
    "INSERT INTO cr_messages(task_id,user_id,body,target_version) VALUES($1,$2,$3,$4) RETURNING id",
    [
      sourceTask.id,
      lead.id,
      "로그인정책합의: 세션 만료는 35분입니다.",
      "policy-v1",
    ],
  )
).rows[0];
await executeCommand(
  pool,
  lead,
  sourceTask.id,
  { action: "start", revision: sourceTask.revision },
  config,
);
const seedRun = await claimRun(pool, "proposal-e2e-seed", config);
await recallForRun(pool, seedRun, "proposal-e2e-seed", {
  action: "propose_memory",
  key: "message:" + msg.id,
  quote: "세션 만료는 35분입니다.",
  title: "합성 로그인 정책 제안",
  body: "세션 만료는 35분입니다.",
  kind: "decision",
  audience: "project",
});
await processRun(pool, seedRun, "proposal-e2e-seed", config);
const longTask = await createTask(
  pool,
  lead,
  {
    workType: "chat",
    agentId: `personal-${lead.id}`,
    skillId: "conversation",
    title: "긴 대화 회귀 전용",
    project: "history-fixture",
    target: "synthetic long conversation",
    targetVersion: "history-v1",
    goal: "긴 대화의 원문 조회와 화면 보존",
    visibility: "private",
  },
  randomUUID(),
);
await pool.query(
  "INSERT INTO cr_messages(task_id,user_id,body,target_version) SELECT $1,$2,CASE WHEN n=1 THEN 'ARCHIVE_NEEDLE_OLD 최초 합의 원문' ELSE '대화 기록 '||n END,'history-v1' FROM generate_series(1,1007)n",
  [longTask.id, lead.id],
);
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
