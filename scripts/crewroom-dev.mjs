#!/usr/bin/env node
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const local = join(root, ".paperclip");
const home = join(local, "crewroom-home");
const instance = join(home, "instances", "crewroom-dev");
const configPath = join(instance, "config.json");
await mkdir(instance, { recursive: true });
const config = {
  $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
  crewroomIsolatedRoot: root,
  database: { mode: "embedded-postgres", embeddedPostgresDataDir: join(instance, "db"), embeddedPostgresPort: 55447,
    backup: { enabled: false, dir: join(instance, "backups") } },
  server: { deploymentMode: "local_trusted", exposure: "private", bind: "loopback", host: "127.0.0.1", port: 3117, serveUi: true },
  logging: { mode: "file", logDir: join(instance, "logs") },
  storage: { provider: "local_disk", localDisk: { baseDir: join(instance, "storage") } },
  secrets: { provider: "local_encrypted", localEncrypted: { keyFilePath: join(instance, "secrets", "master.key") } },
  telemetry: { enabled: false }, updates: { checkEnabled: false },
};
try {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  if (saved.crewroomIsolatedRoot !== root || saved.database?.embeddedPostgresDataDir !== config.database.embeddedPostgresDataDir
    || saved.database?.mode !== "embedded-postgres" || saved.telemetry?.enabled !== false) {
    throw new Error("Existing configuration is not this checkout's isolated Crewroom instance; no changes made.");
  }
}
// The upstream dev runner requires a worktree-local env file. Never copy one.
try { await (await open(join(local, ".env"), "wx", 0o600)).close(); }
catch (error) { if (error.code !== "EEXIST") throw error; }
console.log(`Crewroom local instance: http://127.0.0.1:3117\nConfiguration: ${configPath}\nTelemetry: disabled; model credentials: not provisioned`);
if (process.argv.includes("--prepare")) process.exit(0);
const env = { ...process.env, PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: configPath,
  PAPERCLIP_CONTEXT: join(home, "context.json"), PAPERCLIP_INSTANCE_ID: "crewroom-dev", PORT: "3117",
  PAPERCLIP_DISABLE_CWD_ENV_FILE: "true", PAPERCLIP_TELEMETRY_DISABLED: "1", PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
  PAPERCLIP_ISSUE_PRIVACY_MODE: "enforce", PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
  PAPERCLIP_MIGRATION_AUTO_APPLY: "true" };
delete env.DATABASE_URL;
delete env.DATABASE_MIGRATION_URL;
// The source API/UI can run without building unconfigured provider runners.
// Runtime qualification remains separate and is never implied by HTTP health.
const child = spawn("pnpm", ["dev:server"], { cwd: root, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
