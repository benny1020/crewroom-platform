import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { transaction } from "./db.js";
import { confirmStopped, checkpointJobs } from "./recovery.js";
import { register, id } from "./validation.js";
import { database, migrate } from "./db.js";
import { operationStats, maintain } from "./operations.js";
import { configuration } from "./config.js";
import { seed } from "./seed.js";
import { retryFailedEmbeddings } from "./memory-embedding.js";
import { bootstrap, createMember, resetPassword } from "./auth.js";
const pool = database();
try {
  if (process.argv[2] === "migrate") {
    await migrate(pool);
    await seed(pool);
    console.log("Schema and initial agents/skills ready.");
  } else if (process.argv[2] === "stats") {
    console.log(
      JSON.stringify(
        await operationStats(pool, configuration().dataDir),
        null,
        2,
      ),
    );
  } else if (process.argv[2] === "maintain") {
    console.log(
      JSON.stringify(
        await maintain(pool, { apply: process.argv.includes("--apply") }),
      ),
    );
  } else if (process.argv[2] === "retry-embeddings") {
    console.log(
      JSON.stringify(
        await retryFailedEmbeddings(pool, configuration(), {
          apply: process.argv.includes("--apply"),
        }),
      ),
    );
  } else if (process.argv[2] === "bootstrap") {
    const [email, name, passwordFile] = process.argv.slice(3);
    if (!email || !name || !passwordFile)
      throw new Error("Usage: bootstrap EMAIL NAME PASSWORD_FILE");
    const user = await bootstrap(pool, {
      email,
      name,
      password: (passwordFile === "-"
        ? readFileSync(0, "utf8")
        : await readFile(passwordFile, "utf8")
      ).trim(),
      department: "development",
    });
    console.log(`First lead created: ${user.email}`);
  } else if (process.argv[2] === "member") {
    const [email, name, department, passwordFile] = process.argv.slice(3);
    if (!passwordFile)
      throw new Error("Usage: member EMAIL NAME DEPARTMENT PASSWORD_FILE");
    const values = register.parse({
      email,
      name,
      department,
      password: (passwordFile === "-"
        ? readFileSync(0, "utf8")
        : await readFile(passwordFile, "utf8")
      ).trim(),
    });
    const user = await transaction(pool, (db) => createMember(db, values));
    console.log(`Member provisioned: ${user.email}`);
  } else if (process.argv[2] === "reset-password") {
    const [email, file] = process.argv.slice(3);
    if (!email || !file)
      throw new Error("Usage: reset-password EMAIL PASSWORD_FILE");
    const password = (
      file === "-" ? readFileSync(0, "utf8") : await readFile(file, "utf8")
    ).trim();
    console.log(JSON.stringify(await resetPassword(pool, email, password)));
  } else if (process.argv[2] === "checkpoint-jobs") {
    console.log(JSON.stringify(await checkpointJobs(pool)));
  } else if (process.argv[2] === "confirm-stopped") {
    const runId = id.parse(process.argv[3]),
      evidence = await readFile(process.argv[4], "utf8");
    console.log(JSON.stringify(await confirmStopped(pool, runId, evidence)));
  } else
    throw new Error(
      "Commands: migrate | stats | maintain [--apply] | retry-embeddings [--apply] | bootstrap EMAIL NAME PASSWORD_FILE | member EMAIL NAME DEPARTMENT PASSWORD_FILE | confirm-stopped RUN_ID EVIDENCE_FILE",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
