import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { memoryQualityGate } from "./support/memory-evaluation.js";

const cli = resolve("scripts/evaluate-memory.mjs");
const run = (args, extra = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_DATABASE_URL: "invalid-private-url",
      EMBEDDING_ENDPOINT_URL: "http://private.invalid/key",
      EMBEDDING_MODEL: "protocol-only",
    },
    ...extra,
  });

test("memory evaluation rejects invalid/baseline embedding plans before DB or endpoint access", async () => {
  for (const args of [
    ["--unknown"],
    ["--baseline", "--embeddings", "--max-calls=80"],
    ["--embeddings"],
    ["--max-calls=80"],
    ["--embeddings", "--max-calls=241"],
    ["--baseline", "--baseline"],
  ]) {
    const r = run(args);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stderr).error, "OPTIONS");
    assert.ok(!r.stderr.includes("private.invalid"));
  }
  const directory = await mkdtemp(join(tmpdir(), "crewroom-no-history-"));
  try {
    const r = run(["--baseline"], { cwd: directory });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stderr).error, "BASELINE_SOURCE_UNAVAILABLE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /no model requests/);
});

test("retrieval quality gate fails denied evidence, recall regressions, missing required facts and semantic fallback", () => {
  const good = {
    queries: 1,
    mode: "keyword",
    forbiddenMatches: 0,
    meanRecallAt5: 0.94,
    rows: [{ category: "shared-project", allEvidence: true }],
  };
  assert.equal(memoryQualityGate(good).passed, true);
  for (const change of [
    { forbiddenMatches: 1 },
    { meanRecallAt5: 0.7 },
    { rows: [{ category: "shared-project", allEvidence: false }] },
    { mode: "configured-embeddings" },
  ]) {
    assert.equal(memoryQualityGate({ ...good, ...change }).passed, false);
  }
});
