import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { backupKey, encryptFile, fileHash } from "./backup-crypto.mjs";
const [destination, keyFile] = process.argv.slice(2);
if (!destination || !keyFile)
  throw new Error(
    "Usage: node scripts/backup.mjs DESTINATION KEY_FILE; run from the checkout for the intended Compose project",
  );
const directory = resolve(destination),
  key = await backupKey(keyFile);
await mkdir(directory, { recursive: false, mode: 0o700 });
async function command(args, target = null, raw = false) {
  const child = spawn("docker", raw ? args : ["compose", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
    chunks = [];
  let error = "";
  child.stderr.on("data", (d) => (error = (error + d).slice(-2000)));
  const copy = target
    ? pipeline(
        child.stdout,
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
      )
    : (async () => {
        for await (const data of child.stdout) chunks.push(data);
      })();
  const [[code]] = await Promise.all([once(child, "close"), copy]);
  if (code !== 0)
    throw new Error(`Compose operation failed (${code}): ${error}`);
  return Buffer.concat(chunks).toString("utf8");
}
const running = (await command(["ps", "--services", "--status", "running"]))
  .trim()
  .split("\n")
  .filter((x) => ["app", "worker", "runner"].includes(x));
const rawDb = join(directory, "database.dump"),
  rawFiles = join(directory, "runtime.tgz");
try {
  const front = running.filter((s) => s !== "runner");
  if (front.length) await command(["stop", "--timeout", "150", ...front]);
  await command([
    "run",
    "--rm",
    "--no-deps",
    "worker",
    "node",
    "server/cli.js",
    "checkpoint-jobs",
  ]);
  if (running.includes("runner"))
    await command(["stop", "--timeout", "90", "runner"]);
  const settings = JSON.parse(await command(["config", "--format", "json"]));
  const namespace = settings.services.runner.environment.RUNNER_NAMESPACE;
  if (
    (
      await command(
        ["ps", "-q", "--filter", "label=crewroom.runner=" + namespace],
        null,
        true,
      )
    ).trim()
  )
    throw new Error("Execution Jobs still running; backup refused");
  if (
    (
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
        "SELECT restore_blocked FROM cr_runtime_control WHERE id=1",
      ])
    ).trim() !== "f"
  )
    throw new Error("Cannot back up an incomplete restore");
  const migrations = JSON.parse(
    (
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
        "SELECT coalesce(json_agg(m),'[]') FROM (SELECT name,hash FROM cr_migrations ORDER BY name)m",
      ])
    ).trim(),
  );
  await command(
    [
      "exec",
      "-T",
      "db",
      "pg_dump",
      "-U",
      "crewroom",
      "-d",
      "crewroom",
      "--format=custom",
    ],
    rawDb,
  );
  await command(
    [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "tar",
      "worker",
      "-czf",
      "-",
      "-C",
      "/data",
      ".",
    ],
    rawFiles,
  );
  const files = [];
  for (const [source, name] of [
    [rawDb, "database.dump.enc"],
    [rawFiles, "runtime.tgz.enc"],
  ]) {
    const target = join(directory, name);
    await encryptFile(source, target, key);
    await unlink(source);
    files.push({ name, sha256: await fileHash(target) });
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        format: 1,
        release: "0.12.0",
        createdAt: new Date().toISOString(),
        migrations,
        nativeSessions:
          "Native loop; ephemeral jobs stopped. DB/runtime retain checkpoints. Runner state is not restored.",
        files,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(`Encrypted database and runtime snapshot created: ${directory}`);
} finally {
  await unlink(rawDb).catch(() => {});
  await unlink(rawFiles).catch(() => {});
  if (running.includes("runner"))
    await command([
      "up",
      "-d",
      "--wait",
      "--no-deps",
      "--no-recreate",
      "runner",
    ]);
  const front = running.filter((s) => s !== "runner");
  if (front.length) await command(["start", ...front]);
}
