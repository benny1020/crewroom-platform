import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { encryptFile, decryptFile } from "../scripts/backup-crypto.mjs";
test("backup authenticates content and removes partial plaintext when the key is wrong", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "crewroom-backup-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32),
    source = join(dir, "source"),
    encrypted = join(dir, "encrypted"),
    restored = join(dir, "restored");
  await writeFile(source, "비공개 업무와 원문");
  await encryptFile(source, encrypted, key);
  assert.ok(!(await readFile(encrypted)).includes(Buffer.from("비공개")));
  await decryptFile(encrypted, restored, key);
  assert.equal(await readFile(restored, "utf8"), "비공개 업무와 원문");
  await assert.rejects(() =>
    decryptFile(encrypted, join(dir, "wrong"), randomBytes(32)),
  );
  await assert.rejects(() => stat(join(dir, "wrong")), { code: "ENOENT" });
});
