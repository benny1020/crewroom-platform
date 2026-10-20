import { randomUUID } from "node:crypto";
import { database, migrate, transaction } from "../server/db.js";
import { seed } from "../server/seed.js";
import { bootstrap, createMember } from "../server/auth.js";
import { configuration } from "../server/config.js";
import { buildApp } from "../server/app.js";
import {
  actInWorkspace,
  startWorker,
  claimRun,
  recallForRun,
  processRun,
  completeRun,
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
await transaction(pool, (db) =>
  createMember(
    db,
    {
      email: "designer@e2e.invalid",
      name: "스킬 테스트",
      password,
      department: "development",
    },
    "lead",
  ),
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
// Persisted synthetic documents exercise the real service, never production data.
const documentTask = await createTask(
  pool,
  lead,
  {
    workType: "chat",
    agentId: "dev",
    skillId: "conversation",
    title: "작업공간 브라우저 검증",
    project: "workspace-fixture",
    target: "합성 문서 업무",
    targetVersion: "workspace-v1",
    goal: "계획과 진행 문서를 남기고 이어가기",
    visibility: "team",
  },
  randomUUID(),
);
await executeCommand(
  pool,
  lead,
  documentTask.id,
  { action: "start", revision: documentTask.revision },
  config,
);
const documentRun = await claimRun(pool, "workspace-e2e-seed", config);
const initialDocument = await actInWorkspace(
  pool,
  documentRun,
  "workspace-e2e-seed",
  {
    action: "write_workspace",
    path: 'notes/<input data-action="logout" value="문서 열기">.md',
    content: "첫 번째 계획 초안",
    expectedRevision: 0,
  },
);
await actInWorkspace(pool, documentRun, "workspace-e2e-seed", {
  action: "move_workspace",
  id: initialDocument.id,
  path: "notes/plan.md",
  expectedRevision: 1,
});
await actInWorkspace(pool, documentRun, "workspace-e2e-seed", {
  action: "write_workspace",
  path: "notes/plan.md",
  content:
    "# 이어서 할 일\n\n요청을 확인하고 작업 계획을 저장했습니다.\n\n## 완료한 일\n- 요청과 완료 기준 정리\n- 필요한 자료와 작업 범위 확인\n\n## 다음 작업\n- 변경할 코드와 문서 확인\n- 작은 단위로 구현하고 등록 검사 실행\n- 변경 내용과 남은 문제를 QA에 인계\n\n## 확인 상태\n검사: 미실행\n현재 문서는 계획 초안이며 완료된 결과가 아닙니다.\n\n## 원문 부록\n" +
    "작업 원문을 나눠 읽을 수 있습니다.\n".repeat(350),
  expectedRevision: 2,
});
await completeRun(
  pool,
  documentRun.id,
  "workspace-e2e-seed",
  documentRun.generation,
  {
    origin: "fixture",
    result: {
      summary: "작업 문서 표시 검증용 합성 결과",
      evidence: [],
      unknowns: ["실제 모델 호출 미실행"],
      nextActions: [],
    },
    receipt: {
      workspaceContinuation: true,
      workspaceUsage: {
        lists: 1,
        bodyReads: 0,
        charactersRead: 0,
        writes: 0,
        moves: 0,
        archives: 0,
      },
    },
  },
);
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
