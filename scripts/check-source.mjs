import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const files = [
  "src/app.js",
  "src/live-app.js",
  "src/main.js",
  ...(await readdir("runner"))
    .filter((n) => n.endsWith(".mjs"))
    .map((n) => "runner/" + n),
  ...(await readdir("runner/job"))
    .filter((n) => n.endsWith(".mjs"))
    .map((n) => "runner/job/" + n),
  ...(await readdir("server"))
    .filter((n) => n.endsWith(".js"))
    .map((n) => "server/" + n),
  ...(await readdir("scripts"))
    .filter((n) => n.endsWith(".mjs"))
    .map((n) => "scripts/" + n),
];
for (const file of files) {
  const checked = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (checked.status !== 0) process.exit(checked.status || 1);
}
console.log(`${files.length} source entrypoints passed syntax checks.`);
