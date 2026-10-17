import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Broker, tarFiles, command } from "../runner/broker.mjs";
import { parseArchive, hash } from "../runner/archive.mjs";
const baseline = new Map([
  [
    "sum.js",
    { bytes: Buffer.from("exports.sum = (a,b) => a-b;\n"), mode: 0o644 },
  ],
  [
    "sum.test.js",
    {
      bytes: Buffer.from(
        "const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(require('./sum').sum(2,3),5));\n",
      ),
      mode: 0o644,
    },
  ],
]);
test("real Docker edit, final-state checks, fresh QA and idempotency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewroom-runner-test-"));
  const broker = await new Broker({
    stateDir: dir,
    namespace: "crewroom-test-" + Date.now(),
    checks: [
      { id: "test", label: "test", argv: ["node", "--test"], timeoutMs: 5000 },
    ],
  }).init();
  try {
    assert.equal(
      parseArchive(tarFiles(baseline), { gzip: true, stripRoot: true }).size,
      2,
    );
    const input = {
      runId: randomUUID(),
      generation: 1,
      baseSha: "a".repeat(40),
      mode: "edit",
      profileId: broker.profile.id,
      archive: tarFiles(baseline).toString("base64"),
    };
    const job = await broker.create(input);
    assert.deepEqual(await broker.create(input), job);
    const action = (sequence, action, extra = {}) =>
      broker.action(job.id, job.capability, { sequence, action, ...extra });
    assert.equal(
      (await action(1, "run_check", { checkId: "test" })).passed,
      false,
    );
    await action(2, "write_file", {
      path: "sum.js",
      content: "exports.sum = (a,b) => a+b;\n",
    });
    const passed = await action(3, "run_check", { checkId: "test" });
    assert.equal(passed.passed, true);
    assert.deepEqual(await action(3, "run_check", { checkId: "test" }), passed);
    await assert.rejects(
      action(3, "read_file", { path: "sum.js" }),
      /ACTION_CONFLICT/,
    );
    await action(4, "write_file", {
      path: "sum.js",
      content: "exports.sum = (a,b) => a+b;\n",
    });
    const result = await action(5, "finish");
    assert.equal(result.passed, false);
    const qa = await broker.create({
      ...input,
      runId: randomUUID(),
      mode: "verify",
      patch: result.patch,
    });
    await assert.rejects(
      broker.action(qa.id, qa.capability, {
        sequence: 1,
        action: "write_file",
        path: "sum.js",
        content: "bad",
      }),
      /READ_ONLY_QA/,
    );
    const checked = await broker.action(qa.id, qa.capability, {
      sequence: 1,
      action: "run_check",
      checkId: "test",
    });
    assert.equal(checked.passed, true);
    const verified = await broker.action(qa.id, qa.capability, {
      sequence: 2,
      action: "finish",
    });
    assert.equal(verified.patchHash, result.patchHash);
    assert.equal(verified.passed, true);
    await assert.rejects(broker.create(input), /JOB_NOT_REUSABLE/);
    assert.equal((await broker.stop(job.id, job.capability)).stopped, true);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("cancel running check confirms container gone and stale generation rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewroom-runner-stop-"));
  const namespace = "crewroom-stop-" + Date.now();
  const broker = await new Broker({
    stateDir: dir,
    namespace,
    checks: [
      {
        id: "wait",
        label: "wait",
        argv: ["node", "-e", "setTimeout(()=>{},60000)"],
        timeoutMs: 60000,
      },
    ],
  }).init();
  try {
    const input = {
      runId: randomUUID(),
      generation: 1,
      baseSha: "a".repeat(40),
      mode: "edit",
      profileId: broker.profile.id,
      archive: tarFiles(baseline).toString("base64"),
    };
    const job = await broker.create(input);
    const pending = broker
      .action(job.id, job.capability, {
        sequence: 1,
        action: "run_check",
        checkId: "wait",
      })
      .catch((e) => e);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await broker.stop(job.id, job.capability)).stopped, true);
    await pending;
    const { stdout } = await command("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=crewroom.runner=${namespace}`,
    ]);
    assert.equal(stdout.trim(), "");
    await broker.create({ ...input, generation: 2 });
    await assert.rejects(
      broker.create(input),
      /JOB_NOT_REUSABLE|STALE_GENERATION/,
    );
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty patch QA, ignored tracked files and latest failed recheck cannot reuse old success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewroom-runner-receipts-"));
  const broker = await new Broker({
    stateDir: dir,
    namespace: "crewroom-receipt-" + Date.now(),
    checks: [
      {
        id: "flaky",
        label: "flaky",
        argv: [
          "node",
          "-e",
          "const fs=require('fs');if(fs.existsSync('/tmp/once'))process.exit(1);fs.writeFileSync('/tmp/once','1');",
        ],
        timeoutMs: 5000,
      },
    ],
  }).init();
  try {
    const files = new Map([
        ...baseline,
        [".gitignore", { bytes: Buffer.from("sum.js\n"), mode: 420 }],
      ]),
      input = {
        runId: randomUUID(),
        generation: 1,
        baseSha: "b".repeat(40),
        mode: "edit",
        profileId: broker.profile.id,
        archive: tarFiles(files).toString("base64"),
      };
    const job = await broker.create(input);
    assert.equal(
      (
        await broker.action(job.id, job.capability, {
          sequence: 1,
          action: "run_check",
          checkId: "flaky",
        })
      ).passed,
      true,
    );
    assert.equal(
      (
        await broker.action(job.id, job.capability, {
          sequence: 2,
          action: "run_check",
          checkId: "flaky",
        })
      ).passed,
      false,
    );
    const result = await broker.action(job.id, job.capability, {
      sequence: 3,
      action: "finish",
    });
    assert.equal(result.patch, "");
    assert.equal(result.passed, false);
    const qa = await broker.create({
      ...input,
      runId: randomUUID(),
      mode: "verify",
      patch: "",
    });
    await broker.action(qa.id, qa.capability, {
      sequence: 1,
      action: "run_check",
      checkId: "flaky",
    });
    assert.equal(
      (
        await broker.action(qa.id, qa.capability, {
          sequence: 2,
          action: "finish",
        })
      ).passed,
      true,
    );
    const edit = await broker.create({ ...input, runId: randomUUID() });
    await broker.action(edit.id, edit.capability, {
      sequence: 1,
      action: "write_file",
      path: "sum.js",
      content: "exports.sum = (a,b) => a+b;\n",
    });
    const diff = await broker.action(edit.id, edit.capability, {
      sequence: 2,
      action: "finish",
    });
    assert.match(diff.patch, /a\+b/);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("broker restart kills orphan execution, preserves tombstone and never repeats prepared action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewroom-runner-restart-")),
    options = { stateDir: dir, namespace: "crewroom-restart-" + Date.now() };
  const first = await new Broker(options).init();
  let next;
  try {
    const input = {
        runId: randomUUID(),
        generation: 1,
        baseSha: "c".repeat(40),
        mode: "edit",
        profileId: first.profile.id,
        archive: tarFiles(baseline).toString("base64"),
      },
      job = await first.create(input);
    clearInterval(first.timer);
    const record = first.jobs.get(job.id);
    record.sequence = 1;
    record.actions[1] = {
      hash: hash(
        JSON.stringify({
          sequence: 1,
          action: "write_file",
          path: "sum.js",
          content: "lost",
        }),
      ),
      status: "prepared",
    };
    await first.save(record);
    next = await new Broker(options).init();
    assert.equal(next.jobs.get(job.id).status, "stopped");
    await assert.rejects(
      next.action(job.id, job.capability, {
        sequence: 1,
        action: "write_file",
        path: "sum.js",
        content: "lost",
      }),
      /ACTION_OUTCOME_UNKNOWN/,
    );
    await assert.rejects(next.create(input), /JOB_NOT_REUSABLE/);
    await next.create({ ...input, generation: 2 });
  } finally {
    if (next) await next.close();
    else await first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pinned execution image survives removal of its mutable deployment tag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewroom-image-pin-")),
    namespace = "crewroom-pin-" + Date.now(),
    temporary = namespace + "-build",
    sourceTag = namespace + ":source";
  let broker;
  try {
    await command("docker", [
      "create",
      "--pull=never",
      "--name",
      temporary,
      "crewroom-job:local",
    ]);
    await command("docker", [
      "commit",
      "--change",
      "ENV CREWROOM_PIN_TEST=" + namespace,
      temporary,
      sourceTag,
    ]);
    await command("docker", ["rm", temporary]);
    broker = await new Broker({
      stateDir: dir,
      namespace,
      image: sourceTag,
    }).init();
    await command("docker", ["image", "rm", sourceTag]);
    const { stdout } = await command("docker", [
      "image",
      "inspect",
      broker.profile.imageId,
      "--format",
      "{{.Id}}",
    ]);
    assert.equal(stdout.trim(), broker.profile.imageId);
    const job = await broker.create({
      runId: randomUUID(),
      generation: 1,
      baseSha: "d".repeat(40),
      mode: "edit",
      profileId: broker.profile.id,
      archive: tarFiles(baseline).toString("base64"),
    });
    assert.match(
      (
        await broker.action(job.id, job.capability, {
          sequence: 1,
          action: "read_file",
          path: "sum.js",
        })
      ).content,
      /a-b/,
    );
  } finally {
    if (broker) await broker.close();
    await command("docker", ["rm", "-f", temporary]).catch(() => {});
    await command("docker", ["image", "rm", sourceTag]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
