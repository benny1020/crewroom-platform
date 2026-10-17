import { readFile, stat, mkdir, symlink } from "node:fs/promises";
import { parseArchive, materialize, hash } from "../archive.mjs";
const setup = JSON.parse(await readFile("/tmp/setup.json", "utf8"));
const files = parseArchive(await readFile("/tmp/source.tgz"), {
  gzip: true,
  stripRoot: true,
});
await materialize(files, "/workspace");
if (setup.patch) {
  throw new Error("CHECKPOINT_MUST_BE_APPLIED_BEFORE_JOB_CREATION");
}
try {
  const packageJSON = JSON.parse(
    await readFile("/workspace/package.json", "utf8"),
  );
  const dependencies = Object.keys({
    ...packageJSON.dependencies,
    ...packageJSON.devDependencies,
    ...packageJSON.peerDependencies,
  });
  if (dependencies.length && !setup.preparedDependencies)
    throw new Error("DEPENDENCIES_NOT_PREPARED");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (setup.preparedDependencies) {
  const locks = setup.expectedLocks || {};
  if (!Object.keys(locks).length) throw new Error("DEPENDENCY_LOCKS_REQUIRED");
  for (const [name, expected] of Object.entries(locks)) {
    const actual = files.get(name);
    if (!actual || hash(actual.bytes) !== expected)
      throw new Error("DEPENDENCY_LOCK_MISMATCH");
  }
  if (!(await stat("/opt/crewroom-deps/node_modules")).isDirectory())
    throw new Error("DEPENDENCIES_NOT_PREPARED");
  await symlink("/opt/crewroom-deps/node_modules", "/workspace/node_modules");
}
await mkdir("/tmp/home", { recursive: true, mode: 0o700 });
console.log(JSON.stringify({ ready: true, files: files.size }));
