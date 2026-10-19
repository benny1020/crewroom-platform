import test from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../scripts/doctor.mjs";

const release = "test-release";
const runtime = {
  release,
  schema: true,
  worker: true,
  maintenance: true,
  model: true,
  embeddingRequested: false,
  gitlab: false,
};
const app = { ready: true, release };
const fixture = (overrides = {}, runner = { ready: true }) => {
  const calls = [];
  return {
    calls,
    probe: async (service, script) => {
      calls.push({ service, script });
      if (script.includes("/v1/profile")) return runner;
      return service === "app" ? app : { ...runtime, ...overrides };
    },
  };
};

test("chat and skills require a healthy current Worker and model, without GitLab or Runner", async () => {
  const f = fixture();
  const report = await diagnose({ release, probe: f.probe });
  assert.equal(report.ready, true);
  assert.equal(f.calls.length, 2);
  assert.ok(!f.calls.some((c) => c.script.includes("/v1/profile")));
  assert.match(report.actualModelInference, /not checked/);
  assert.match(report.repositoryAccess, /not checked/);
  const code = await diagnose({ release, code: true, probe: f.probe });
  assert.equal(code.ready, false);
  assert.equal(code.checks.gitlabConfigured, false);
  assert.equal(code.checks.runner, true);
  assert.equal(
    (
      await diagnose({
        release,
        code: true,
        probe: fixture({ gitlab: true }).probe,
      })
    ).ready,
    true,
  );
});

test("stale/failed Workers, schema drift, release drift, invalid model and partial embeddings fail readiness", async () => {
  for (const override of [
    { worker: false },
    { schema: false },
    { release: "old" },
    { model: false },
    { embeddingRequested: true, embedding: false },
  ]) {
    assert.equal(
      (await diagnose({ release, probe: fixture(override).probe })).ready,
      false,
    );
  }
  const missingApp = await diagnose({
    release,
    probe: async (service) =>
      service === "app" ? { ready: true, release: "old" } : runtime,
  });
  assert.equal(missingApp.checks.app, false);
  assert.equal(
    (
      await diagnose({
        release,
        probe: fixture({ embeddingRequested: true, embedding: true }).probe,
      })
    ).ready,
    true,
  );
  const maintenance = await diagnose({
    release,
    probe: fixture({ maintenance: false }).probe,
  });
  assert.equal(maintenance.ready, true);
  assert.deepEqual(maintenance.warnings, ["MAINTENANCE_NOT_HEALTHY"]);
});

test("probe failure is sanitized without returning stderr, URLs or keys", async () => {
  const report = await diagnose({
    release,
    code: true,
    probe: async () => {
      throw Error("password=secret https://private.invalid");
    },
  });
  assert.equal(report.ready, false);
  assert.deepEqual(report.errors, [
    "RUNTIME_PROBE_FAILED",
    "APP_PROBE_FAILED",
    "RUNNER_PROBE_FAILED",
  ]);
  assert.ok(!JSON.stringify(report).includes("private.invalid"));
  assert.ok(!JSON.stringify(report).includes("password"));
});
