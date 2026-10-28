import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const authRequire = createRequire(serverRequire.resolve("better-auth"));
const drizzleRequire = createRequire(authRequire.resolve("drizzle-kit/api"));
const loaderEntry = drizzleRequire.resolve("@esbuild-kit/esm-loader");
const loaderRequire = createRequire(loaderEntry);
const coreEntry = loaderRequire.resolve("@esbuild-kit/core-utils");
const coreRequire = createRequire(coreEntry);
const core = loaderRequire("@esbuild-kit/core-utils");

test("legacy Drizzle transform adapter uses the reviewed patched esbuild", () => {
  assert.equal(coreRequire("esbuild").version, "0.25.0");
});

test("legacy adapter retains synchronous and asynchronous TypeScript transforms", async () => {
  const source = "export const value: number = 42;";
  for (const transformed of [core.transformSync(source, "compatibility.cts", { format: "cjs" }), await core.transform(source, "compatibility.cts", { format: "cjs" })]) {
    const module = { exports: {} };
    new Function("module", transformed.code)(module);
    assert.equal(module.exports.value, 42);
    assert.ok(transformed.map);
  }
});

test("legacy ESM loader still imports a typed module using the patched transformer", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crewroom-dependency-runtime-"));
  try {
    writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
    writeFileSync(path.join(directory, "value.ts"), "export const value: number = 42;\n");
    const entry = path.join(directory, "main.ts");
    writeFileSync(entry, 'import { value } from "./value.ts"; console.log(value);\n');
    const output = execFileSync(process.execPath, ["--no-experimental-strip-types", "--loader", pathToFileURL(loaderEntry).href, entry], {
      encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(output.trim(), "42");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
