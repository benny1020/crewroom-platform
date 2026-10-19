import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { writeEvent } from "../server/event-hub.js";
import { acquireComposeOperationLock } from "../scripts/compose-operation-lock.mjs";

test("backpressured or closed event streams never accumulate subsequent refresh frames", () => {
  const slow = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {},
  });
  assert.equal(writeEvent(slow, "event: refresh\ndata: {}\n\n"), false);
  assert.equal(slow.destroyed, true);
  const bytes = slow.writableLength;
  for (let i = 0; i < 1000; i++)
    assert.equal(writeEvent(slow, "event: refresh\ndata: {}\n\n"), false);
  assert.equal(slow.writableLength, bytes);
  let output = "";
  const normal = new Writable({
    write(chunk, _encoding, cb) {
      output += chunk;
      cb();
    },
  });
  assert.equal(writeEvent(normal, ": heartbeat\n\n"), true);
  assert.equal(output, ": heartbeat\n\n");
  normal.end();
  assert.equal(writeEvent(normal, ": heartbeat\n\n"), false);
});

test("project operation lock excludes another backup or restore across callers and releases for reuse", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewroom-lock-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await acquireComposeOperationLock("one-team", "backup", {
    directory,
  });
  for (const operation of ["backup", "restore"])
    await assert.rejects(
      acquireComposeOperationLock("one-team", operation, { directory }),
      /COMPOSE_OPERATION_BUSY/,
    );
  const other = await acquireComposeOperationLock("another-team", "backup", {
    directory,
  });
  await other();
  const path = join(directory, (await readdir(directory))[0], "owner.json"),
    owner = JSON.parse(await readFile(path, "utf8"));
  assert.equal(owner.operation, "backup");
  assert.equal(owner.pid, process.pid);
  await release();
  const next = await acquireComposeOperationLock("one-team", "restore", {
    directory,
  });
  await next();
  assert.deepEqual(await readdir(directory), []);
});

test("a stale or replaced operation lock needs inspection and cannot be removed by the previous owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewroom-abandoned-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await acquireComposeOperationLock("one-team", "backup", {
    directory,
  });
  const path = join(directory, (await readdir(directory))[0], "owner.json");
  await writeFile(
    path,
    JSON.stringify({
      pid: 999999,
      startedAt: "2000-01-01",
      token: "replacement",
    }),
  );
  await assert.rejects(
    acquireComposeOperationLock("one-team", "restore", { directory }),
    /COMPOSE_OPERATION_BUSY/,
  );
  await assert.rejects(release(), /COMPOSE_OPERATION_LOCK_CHANGED/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).token, "replacement");
});
