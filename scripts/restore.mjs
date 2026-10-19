import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { backupKey, decryptFile, fileHash } from "./backup-crypto.mjs";
const [source, keyFile, confirmation] = process.argv.slice(2);
if (!source || !keyFile || confirmation !== "--confirm-empty")
  throw new Error(
    "Usage: node scripts/restore.mjs BACKUP_DIR KEY_FILE --confirm-empty; target a fresh isolated Compose project",
  );
const directory = resolve(source),
  key = await backupKey(keyFile),
  manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
if (
  manifest.format !== 1 ||
  ![
    "0.6.0",
    "0.7.0",
    "0.8.0",
    "0.8.1",
    "0.9.0",
    "0.10.0",
    "0.11.0",
    "0.11.1",
    "0.12.0",
  ].includes(manifest.release) ||
  manifest.files?.length !== 2
)
  throw new Error("Unsupported backup manifest");
for (const name of ["database.dump.enc", "runtime.tgz.enc"]) {
  const item = manifest.files.find((x) => x.name === name);
  if (!item || (await fileHash(join(directory, name))) !== item.sha256)
    throw new Error("Backup checksum mismatch");
}
const temp = await mkdtemp(join(tmpdir(), "crewroom-restore-"));
async function command(args, input = null, target = null) {
  const child = spawn("docker", ["compose", ...args], {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    }),
    output = [];
  let error = "";
  child.stderr.on("data", (d) => (error = (error + d).slice(-2000)));
  const read = target
    ? pipeline(
        child.stdout,
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
      )
    : (async () => {
        for await (const chunk of child.stdout) output.push(chunk);
      })();
  const write = input
    ? pipeline(createReadStream(input), child.stdin)
    : Promise.resolve();
  const [[code]] = await Promise.all([once(child, "close"), read, write]);
  if (code !== 0)
    throw new Error(`Compose operation failed (${code}): ${error}`);
  return Buffer.concat(output).toString("utf8");
}
try {
  await decryptFile(
    join(directory, "database.dump.enc"),
    join(temp, "database.dump"),
    key,
  );
  await decryptFile(
    join(directory, "runtime.tgz.enc"),
    join(temp, "runtime.tgz"),
    key,
  );
  const running = (await command(["ps", "--services", "--status", "running"]))
    .trim()
    .split("\n");
  if (running.some((x) => ["app", "worker", "runner"].includes(x)))
    throw new Error("Stop app, worker and runner before restoring");
  const count = (
    await command([
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "crewroom",
      "-d",
      "crewroom",
      "-Atc",
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')",
    ])
  ).trim();
  if (count !== "0") throw new Error("Restore target database is not empty");
  await command(
    [
      "exec",
      "-T",
      "db",
      "pg_restore",
      "--no-owner",
      "--no-privileges",
      "--file=-",
    ],
    join(temp, "database.dump"),
    join(temp, "restore.sql"),
  );
  await appendFile(
    join(temp, "restore.sql"),
    `
SET search_path TO public;
DELETE FROM cr_sessions;
UPDATE cr_runtime_control SET restore_blocked=true WHERE id=1;
UPDATE cr_runs SET status='failed',generation=generation+1,lease_owner='restored-unverified',lease_until=clock_timestamp()-interval '1 second',error_code='RESTORE_CONFIRMATION_REQUIRED',error_message='복원 전 실행의 종료를 운영자가 확인해야 해요.' WHERE status IN ('queued','running','paused');
UPDATE cr_tasks t SET status='failed',revision=revision+1 FROM cr_runs r WHERE t.current_run_id=r.id AND r.error_code='RESTORE_CONFIRMATION_REQUIRED';
`,
  );
  // Imported records, session revocation and quarantine become visible atomically.
  await command(
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "crewroom",
      "-d",
      "crewroom",
      "-v",
      "ON_ERROR_STOP=1",
      "--single-transaction",
    ],
    join(temp, "restore.sql"),
  );
  await command(
    [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "tar",
      "worker",
      "-xzf",
      "-",
      "-C",
      "/data",
      "--no-same-owner",
    ],
    join(temp, "runtime.tgz"),
  );
  await command([
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "crewroom",
    "-d",
    "crewroom",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "UPDATE cr_runtime_control SET restore_blocked=false WHERE id=1",
  ]);
  console.log(
    "Restore complete. Sessions revoked; unfinished runs require operator confirmation. External model credentials are restored separately.",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
