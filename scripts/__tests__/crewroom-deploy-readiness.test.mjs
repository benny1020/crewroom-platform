import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

const compose = YAML.parse(readFileSync(new URL("../../deploy/crewroom/compose.yaml", import.meta.url), "utf8"));
const probe = compose.services.app.healthcheck.test;
assert.deepEqual(probe.slice(0, 3), ["CMD", "node", "-e"]);
test("authentication trusts only the configured public URL across a mapped container port", () => {
  const env = compose.services.app.environment;
  assert.equal(env.BETTER_AUTH_TRUSTED_ORIGINS, "${CREWROOM_PUBLIC_URL:-http://localhost:3118}");
  assert.equal(env.BETTER_AUTH_TRUSTED_ORIGINS, env.PAPERCLIP_PUBLIC_URL);
  assert.doesNotMatch(env.BETTER_AUTH_TRUSTED_ORIGINS, /\*/);
  assert.equal(env.BETTER_AUTH_DISABLE_ORIGIN_CHECK, undefined);
  assert.equal(env.BETTER_AUTH_DISABLE_CSRF_CHECK, undefined);
});
for (const [name, response, expected] of [
  ["anonymous ready without protected startupRecovery", { ok: true, body: { status: "ok" } }, 0],
  ["starting with a protected-looking ready field", { ok: true, body: { status: "starting", startupRecovery: { phase: "ready" } } }, 1],
  ["unhealthy", { ok: true, body: { status: "unhealthy" } }, 1],
  ["missing status", { ok: true, body: {} }, 1],
  ["invalid JSON", { ok: true, invalidJson: true }, 1],
  ["non-success HTTP even with ok body", { ok: false, body: { status: "ok" } }, 1],
  ["network failure", { networkFailure: true }, 1],
]) {
  test(`Compose anonymous readiness: ${name}`, () => {
    const program = `globalThis.fetch=async()=>{const x=${JSON.stringify(response)};if(x.networkFailure)throw Error('offline fixture');return{ok:x.ok,json:async()=>{if(x.invalidJson)throw Error('invalid fixture');return x.body}}};${probe[3]}`;
    const result = spawnSync(process.execPath, ["-e", program], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, expected, result.stderr);
  });
}

test("failure diagnostics run before cleanup and only their safe report is uploaded", () => {
  const workflow = YAML.parse(readFileSync(new URL("../../.github/workflows/crewroom-image.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs["image-and-persistence"].steps;
  const diagnostics = steps.findIndex(step => step.name === "Capture secret-safe failure diagnostics before cleanup");
  const cleanup = steps.findIndex(step => step.name === "Stop only the disposable verification projects");
  assert.ok(diagnostics >= 0 && diagnostics < cleanup);
  assert.equal(steps[diagnostics].if, "failure()");
  const upload = steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.match(upload.with.path, /deployment-diagnostics\.json/);
  assert.doesNotMatch(upload.with.path, /\.env|container-smoke|\.dockerbuild|runtime\.log/);
});
