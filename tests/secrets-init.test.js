import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
