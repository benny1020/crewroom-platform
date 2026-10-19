// Destructive only to the unique temporary Compose projects created by this script.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { backupKey, encryptFile, fileHash } from "./backup-crypto.mjs";
import assert from "node:assert/strict";
import { tarFiles } from "../runner/broker.mjs";
const suffix = randomBytes(5).toString("hex"),
  base = `crewroom-drill-${suffix}`,
  directory = resolve(`.local/restore-drill-${suffix}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const started = Date.now(),
  projects = [];
const environment = (project) => ({
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: resolve("compose.yaml"),
  COMPOSE_PROFILES: "",
  CREWROOM_SECRETS_DIR: join(directory, "secrets"),
  NODE_ENV: "test",
  RUNNER_JOB_IMAGE: "crewroom-job:local",
  PORT: "4287",
  PUBLIC_ORIGIN: "http://127.0.0.1:4287",
});
async function run(command, args, env, input) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }),
    out = [],
    err = [];
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => err.push(d));
  child.stdin.end(input);
  const [code] = await once(child, "close");
  if (code !== 0)
    throw new Error(
      `${command} ${args.slice(0, 3).join(" ")} failed (${code}): ${Buffer.concat(err).toString().slice(-1000)}`,
    );
  return Buffer.concat(out).toString();
}
const compose = (project, args, input) =>
  run("docker", ["compose", ...args], environment(project), input);
const sql = (project, text) =>
  compose(project, [
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "crewroom",
    "-d",
    "crewroom",
    "-Atc",
    text,
  ]);
const fixture = (project, action, data) =>
  compose(
    project,
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-v",
      resolve("scripts/restore-job-fixture.mjs") +
        ":/app/scripts/restore-job-fixture.mjs:ro",
      "worker",
      "node",
      "scripts/restore-job-fixture.mjs",
      action,
    ],
    JSON.stringify(data),
  );
const script = (project, name, args) =>
  run(process.execPath, [`scripts/${name}.mjs`, ...args], environment(project));
async function fresh(project) {
  projects.push(project);
  await compose(project, ["up", "-d", "--wait", "db"]);
  await compose(project, ["run", "--rm", "--no-deps", "init-secrets"]);
  await compose(project, ["run", "--rm", "--no-deps", "init-data"]);
}
const source = base + "-source",
  good = base + "-restored",
  bad = base + "-failed";
try {
  await run(
    process.execPath,
    ["scripts/init-secrets.mjs"],
    environment(source),
  );
  await fresh(source);
  await compose(source, ["run", "--rm", "--no-deps", "migrate"]);
  const password = randomBytes(24).toString("base64url");
  await compose(
    source,
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "app",
      "node",
      "server/cli.js",
      "bootstrap",
      "drill@example.invalid",
      "복원훈련",
      "-",
    ],
    password,
  );
  await compose(source, ["up", "-d", "--wait", "app", "runner"]);
  const origin = "http://127.0.0.1:4287";
  let cookie = "",
    csrf = "";
  async function api(path, body, extra = {}) {
    const response = await fetch(origin + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        origin,
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf,
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify({ path, code: data.code }));
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return data;
  }
  csrf = (
    await api("/auth/login", { email: "drill@example.invalid", password })
  ).csrfToken;
  const originalMemory = await api("/memories", {
    agentId: "dev",
    visibility: "private",
    pinned: true,
    kind: "decision",
    validFrom: "2026-01-01T00:00:00Z",
    title: "복원 고유 기억",
    body: "지속 저장 확인",
    source: "합성 운영 훈련",
  });
  await api("/memories", {
    agentId: "dev",
    visibility: "private",
    title: "Restored source-linked fact",
    body: "Durable evidence",
    source: "Synthetic drill",
    sourceKey: "memory:" + originalMemory.id,
  });
  await api(
    "/tasks",
    {
      workType: "pr-qa",
      target: "복원 훈련 대상",
      targetVersion: "drill-v1",
      project: "운영 훈련",
      goal: "가져온 결과 보존 확인",
      visibility: "team",
      imported: {
        body: "합성 결과입니다. 실제 모델 검증 아님.",
        source: "restore drill",
      },
    },
    { "idempotency-key": randomBytes(16).toString("hex") },
  );
  const queued = (
    await api(
      "/tasks",
      {
        workType: "code-qa",
        target: "https://gitlab.invalid/team/project",
        targetVersion: "a".repeat(40),
        project: "운영 훈련",
        goal: "미완료 실행 격리",
        visibility: "private",
      },
      { "idempotency-key": randomBytes(16).toString("hex") },
    )
  ).task;
  await sql(
    source,
    `INSERT INTO cr_questions(id,task_id,target_version,asked_by,assignee_id,prompt,status,answer,answered_by,answered_at)
 SELECT gen_random_uuid(),id,target_version,owner_id,owner_id,'Synthetic restored question','answered','Synthetic restored answer',owner_id,now() FROM cr_tasks WHERE id='${queued.id}';
 UPDATE cr_tasks SET question_revision=1,rework=jsonb_build_object('reason','Synthetic restored rework','targetVersion',target_version,'previous',NULL) WHERE id='${queued.id}'`,
  );
  await api(`/tasks/${queued.id}/commands`, {
    action: "start",
    revision: queued.revision,
  });
  // Failure injection: the worker has edited code but has not yet saved its checkpoint to DB.
  const runId = (await api("/tasks/" + queued.id)).task.current_run_id;
  await sql(
    source,
    "UPDATE cr_runs SET status='running',generation=1,lease_owner='drill-worker',lease_until=clock_timestamp()-interval '1 second' WHERE id='" +
      runId +
      "'; UPDATE cr_tasks SET status='running' WHERE id='" +
      queued.id +
      "'",
  );
  const sourceArchive = tarFiles(
    new Map([
      ["sample.js", { bytes: Buffer.from("module.exports = 1;\n"), mode: 420 }],
      [
        "sample.test.js",
        {
          bytes: Buffer.from(
            "const {test}=require('node:test');const assert=require('node:assert/strict');test('restored edit',()=>assert.equal(require('./sample'),2));\n",
          ),
          mode: 420,
        },
      ],
    ]),
  );
  await fixture(source, "stage", {
    runId,
    archive: sourceArchive.toString("base64"),
  });
  await sql(
    source,
    `INSERT INTO cr_memory_reads(run_id,generation,sequence,query,refs) SELECT '${runId}',1,1,'synthetic restore recall',jsonb_build_array(jsonb_build_object('key',key,'revision',revision)) FROM cr_recall_documents WHERE kind='decision' LIMIT 1`,
  );
  await sql(
    source,
    `INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,vectors,lease_until) SELECT key,revision,'restore-test-profile','ready','[{"text":"synthetic memory vector","vector":[1,0]}]'::jsonb,now() FROM cr_recall_documents WHERE kind='decision' LIMIT 1`,
  );
  await sql(
    source,
    `INSERT INTO cr_memory_candidates(id,run_id,generation,agent_id,owner_id,task_id,visibility,department,project,audience,title,body,kind,source_key,source_revision,source_quote)
 SELECT gen_random_uuid(),'${runId}',1,'dev',t.owner_id,t.id,t.visibility,t.department,t.project,'agent','Synthetic restore proposal',d.body,'fact',d.key,d.revision,d.body
 FROM cr_tasks t CROSS JOIN cr_recall_documents d WHERE t.id='${queued.id}' AND d.kind='decision' LIMIT 1`,
  );
  const comparison =
    "SELECT json_build_object('workInputs',(SELECT json_agg(json_build_object('id',id,'rework',rework,'questionRevision',question_revision) ORDER BY id) FROM cr_tasks),'questions',(SELECT json_agg(json_build_object('id',id,'task',task_id,'target',target_version,'prompt',prompt,'assignee',assignee_id,'status',status,'answer',answer,'revision',revision) ORDER BY id) FROM cr_questions),'tasks',(SELECT json_agg(id ORDER BY id) FROM cr_tasks),'artifacts',(SELECT json_agg(content_hash ORDER BY id) FROM cr_artifacts),'memories',(SELECT json_agg(json_build_object('body',body,'kind',kind,'pinned',pinned,'audience',audience,'valid_from',valid_from,'valid_to',valid_to,'supersedes_id',supersedes_id,'source_key',source_key,'source_refs',source_refs,'origin_task_id',origin_task_id,'source_corrected',source_corrected) ORDER BY id) FROM cr_memories),'proposals',(SELECT json_agg(json_build_object('id',id,'status',status,'source_key',source_key,'source_revision',source_revision,'source_quote',source_quote,'body',body,'valid_from',valid_from,'valid_to',valid_to) ORDER BY id) FROM cr_memory_candidates),'reads',(SELECT json_agg(refs ORDER BY run_id,generation,sequence) FROM cr_memory_reads),'vectors',(SELECT json_agg(json_build_object('key',source_key,'revision',source_revision,'profile',profile_id,'vectors',vectors) ORDER BY source_key) FROM cr_memory_embeddings),'documents',(SELECT json_agg(key||revision ORDER BY key) FROM cr_recall_documents))";
  const before = (await sql(source, comparison)).trim();
  const runtimePath = "/data/runs/restore-drill/input.json";
  await compose(source, [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "worker",
    "-e",
    `const fs=require('fs');fs.mkdirSync('/data/runs/restore-drill',{recursive:true,mode:0o700});fs.writeFileSync('${runtimePath}','synthetic immutable run input',{flag:'wx',mode:0o400});`,
  ]);
  const fileDigest = [
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "worker",
    "-e",
    `console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('${runtimePath}')).digest('hex'))`,
  ];
  const originalFileHash = (await compose(source, fileDigest)).trim();
  const backup = join(directory, "backup"),
    keyFile = join(directory, "secrets", "backup_key");
  await script(source, "backup", [backup, keyFile]);
  const checkpoint = (
    await sql(
      source,
      "SELECT checkpoint->>'patchHash' FROM cr_execution_jobs WHERE run_id='" +
        runId +
        "' AND status='stopped'",
    )
  ).trim();
  assert.match(checkpoint, /^[a-f0-9]{64}$/);
  assert.match(
    await sql(
      source,
      "SELECT checkpoint->>'patch' FROM cr_execution_jobs WHERE run_id='" +
        runId +
        "'",
    ),
    /module.exports = 2/,
  );
  await fresh(good);
  await script(good, "restore", [backup, keyFile, "--confirm-empty"]);
  assert.equal((await sql(good, comparison)).trim(), before);
  assert.equal(
    (
      await sql(
        good,
        "SELECT checkpoint->>'patchHash' FROM cr_execution_jobs WHERE run_id='" +
          runId +
          "' AND status='stopped'",
      )
    ).trim(),
    checkpoint,
  );
  assert.equal((await compose(good, fileDigest)).trim(), originalFileHash);
  assert.equal(
    (await sql(good, "SELECT count(*) FROM cr_sessions")).trim(),
    "0",
  );
  assert.equal(
    (
      await sql(
        good,
        "SELECT count(*) FROM cr_runs WHERE error_code='RESTORE_CONFIRMATION_REQUIRED' AND lease_owner='restored-unverified'",
      )
    ).trim(),
    "1",
  );
  assert.equal(
    (await sql(good, "SELECT restore_blocked FROM cr_runtime_control")).trim(),
    "f",
  );
  await compose(good, ["up", "-d", "--wait", "runner"]);
  await compose(
    good,
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "worker",
      "node",
      "server/cli.js",
      "confirm-stopped",
      runId,
      "/dev/stdin",
    ],
    "drill evidence: original execution and workspace stopped before backup",
  );
  const resumed = JSON.parse(
    (
      await fixture(good, "resume", {
        taskId: queued.id,
        oldRunId: runId,
        patchHash: checkpoint,
        archive: sourceArchive.toString("base64"),
      })
    ).trim(),
  );
  assert.equal(resumed.passed, true);
  assert.equal(resumed.fileRestored, true);
  const corrupt = join(directory, "bad-backup");
  await cp(backup, corrupt, { recursive: true });
  const invalid = join(directory, "invalid.tar");
  await writeFile(invalid, "deliberately invalid runtime archive", {
    mode: 0o600,
  });
  await rm(join(corrupt, "runtime.tgz.enc"));
  await encryptFile(
    invalid,
    join(corrupt, "runtime.tgz.enc"),
    await backupKey(keyFile),
  );
  await rm(invalid);
  const manifest = JSON.parse(
    await readFile(join(corrupt, "manifest.json"), "utf8"),
  );
  manifest.files.find((f) => f.name === "runtime.tgz.enc").sha256 =
    await fileHash(join(corrupt, "runtime.tgz.enc"));
  await writeFile(join(corrupt, "manifest.json"), JSON.stringify(manifest));
  await fresh(bad);
  await assert.rejects(() =>
    script(bad, "restore", [corrupt, keyFile, "--confirm-empty"]),
  );
  assert.equal(
    (await sql(bad, "SELECT restore_blocked FROM cr_runtime_control")).trim(),
    "t",
  );
  assert.equal(
    (await sql(bad, "SELECT count(*) FROM cr_sessions")).trim(),
    "0",
  );
  assert.equal(
    (
      await sql(
        bad,
        "SELECT count(*) FROM cr_runs WHERE error_code='RESTORE_CONFIRMATION_REQUIRED'",
      )
    ).trim(),
    "1",
  );
  await assert.rejects(() =>
    compose(bad, [
      "run",
      "--rm",
      "--no-deps",
      "app",
      "node",
      "server/index.js",
    ]),
  );
  await assert.rejects(() =>
    compose(bad, ["run", "--rm", "--no-deps", "worker"]),
  );
  const receipt = {
    date: new Date().toISOString(),
    release: "0.10.0",
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    checks: [
      "DB Task/Artifact hashes/Memory identical",
      "rework input, question ownership/answers/revisions and task question revision identical",
      "memory audience/effective periods, pending proposals, read ledger, vector cache and recall view fingerprints identical",
      "active Docker Job edit checkpointed to DB before backup and restored with identical patch hash",
      "operator CLI confirmation then new Run restores patch and passes actual test requiring the edited value",
      "immutable runtime input file SHA-256 identical",
      "old sessions revoked",
      "unfinished Run quarantined",
      "runtime extraction failure keeps restore blocked",
      "incomplete restore rejects App and Worker startup",
    ],
    actualExternalModelCalls: 0,
  };
  await writeFile(
    join(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const project of projects.reverse())
    await compose(project, ["down", "--volumes", "--remove-orphans"]).catch(
      () => {},
    );
}
