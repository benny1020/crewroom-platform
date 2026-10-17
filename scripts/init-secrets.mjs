import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
const directory = resolve(process.env.CREWROOM_SECRETS_DIR || ".local/secrets");
await mkdir(directory, { recursive: true, mode: 0o700 });
let password;
try {
  password = (await readFile(join(directory, "db_password"), "utf8")).trim();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  password = randomBytes(32).toString("hex");
}
for (const [name, value] of [
  ["db_password", password],
  ["db_url", `postgresql://crewroom:${password}@db:5432/crewroom`],
  ["model_api_key", ""],
  ["embedding_api_key", ""],
  ["gitlab_token", ""],
  ["runner_token", randomBytes(32).toString("hex")],
  ["backup_key", randomBytes(32).toString("hex")],
]) {
  try {
    await writeFile(join(directory, name), value, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
console.log(
  `Secret files prepared in ${directory}; existing files preserved. No values printed.`,
);
