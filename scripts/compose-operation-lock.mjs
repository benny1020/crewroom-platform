import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Shared across checkouts for this local user. A crashed owner leaves a lock
// for operator inspection; never guess that it is safe to resume services.
export async function acquireComposeOperationLock(
  project,
  operation,
  { directory = join(homedir(), ".crewroom", "compose-locks") } = {},
) {
  if (typeof project !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(project))
    throw Error("INVALID_COMPOSE_PROJECT");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(
      directory,
      createHash("sha256").update(project).digest("hex"),
    ),
    token = randomUUID();
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw Error(
        "COMPOSE_OPERATION_BUSY: inspect the project's lock before retrying",
      );
    throw error;
  }
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({
      project,
      operation,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return async () => {
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    if (owner.token !== token) throw Error("COMPOSE_OPERATION_LOCK_CHANGED");
    await rm(path, { recursive: true });
  };
}
