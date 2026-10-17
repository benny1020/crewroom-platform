import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git(["status", "--porcelain"]))
  throw new Error(
    "Commit or set aside tracked/untracked source changes before exporting; local ignored secrets remain excluded",
  );
const commit = git(["rev-parse", "HEAD"]),
  directory = resolve(process.argv[2] || ".local/exports");
await mkdir(directory, { recursive: true, mode: 0o700 });
const name = `crewroom-source-${commit.slice(0, 12)}.tar.gz`,
  path = join(directory, name);
execFileSync("git", [
  "archive",
  "--format=tar.gz",
  `--prefix=crewroom/`,
  `--output=${path}`,
  commit,
]);
const data = await readFile(path);
const receipt = {
  commit,
  file: name,
  bytes: data.length,
  sha256: createHash("sha256").update(data).digest("hex"),
  contents:
    "Tracked source at HEAD; no ignored .env/.local secrets, runtime volumes, node_modules or private upstream checkout",
};
await writeFile(
  join(directory, name + ".json"),
  JSON.stringify(receipt, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(receipt, null, 2));
