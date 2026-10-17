// Copy host-owned 0600 inputs into per-service, container-owned volumes.
// Compose file-backed secrets do not remap uid/gid on Linux.
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  chown,
} from "node:fs/promises";
const groups = [
  ["app", 1000, ["db_url"]],
  ["worker", 1000, ["db_url", "model_api_key", "gitlab_token", "runner_token"]],
  ["runner", 0, ["runner_token"]],
];
for (const [name, uid, files] of groups) {
  const directory = "/out/" + name;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const file of files) {
    const target = directory + "/" + file,
      temporary = target + ".next";
    await writeFile(temporary, await readFile("/run/secrets/" + file), {
      mode: 0o400,
    });
    await chmod(temporary, 0o400);
    await chown(temporary, uid, uid);
    await rename(temporary, target);
  }
  await chown(directory, uid, uid);
  await chmod(directory, 0o500);
}
console.log("Per-service secret volumes staged. Values omitted.");
