import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
test("upgrading secret files adds the optional GitLab token without replacing existing database/model secrets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewroom-secret-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const existing = {
    db_password: "test-only-existing-db-secret",
    db_url: "test-only-existing-db-url",
    model_api_key: "test-only-existing-model-key",
    backup_key: "test-only-existing-backup-key",
  };
  for (const [name, value] of Object.entries(existing))
    await writeFile(join(directory, name), value, { mode: 0o600 });
  execFileSync(process.execPath, ["scripts/init-secrets.mjs"], {
    env: { ...process.env, CREWROOM_SECRETS_DIR: directory },
    stdio: "pipe",
  });
  for (const [name, value] of Object.entries(existing))
    assert.equal(await readFile(join(directory, name), "utf8"), value);
  assert.equal(await readFile(join(directory, "gitlab_token"), "utf8"), "");
  assert.equal(
    await readFile(join(directory, "embedding_api_key"), "utf8"),
    "",
  );
});

test("secret ownership verification uses the configured app image across releases", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewroom-secret-image-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "docker"),
    log = join(directory, "commands.jsonl");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');if(args[0]==='compose'){console.log(JSON.stringify({services:{app:{image:'custom/crewroom:future-release'}}}));}else if(args[0]==='run'&&args.includes('1000')&&args.some(a=>a.includes("readFileSync('/source/db_url')"))){console.error('EACCES');process.exitCode=1;}
`,
  );
  await chmod(executable, 0o755);
  const output = execFileSync(
    process.execPath,
    ["scripts/verify-secret-ownership.mjs"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: directory + delimiter + process.env.PATH },
    },
  );
  assert.equal(JSON.parse(output).image, "custom/crewroom:future-release");
  const commands = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  const runs = commands.filter((a) => a[0] === "run");
  assert.equal(runs.length, 7);
  for (const args of runs) {
    assert.ok(args.includes("custom/crewroom:future-release"));
    assert.ok(args.includes("--pull=never"));
  }
});
