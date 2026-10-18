import pg from "pg";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export function database(
  url = process.env.DATABASE_URL_FILE
    ? readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim()
    : process.env.DATABASE_URL,
) {
  if (!url) throw new Error("DATABASE_URL is required");
  return new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
}
// Cross-task provenance checks must not invert an already-held task lock.
// Acquire this transaction-scoped gate before any context-related row lock.
// Only short database critical sections serialize; external response waits do not.
export async function lockContextMutation(db) {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('crewroom-context-mutation'))",
  );
}
export async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(pool) {
  await transaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('crewroom-migrations'))",
    );
    await db.query(
      "CREATE TABLE IF NOT EXISTS cr_migrations (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (
      await readdir(new URL("./migrations/", import.meta.url))
    )
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
        hash = digest(sql);
      const previous = (
        await db.query("SELECT hash FROM cr_migrations WHERE name=$1", [name])
      ).rows[0];
      if (previous && previous.hash !== hash)
        throw new Error(`Applied migration changed: ${name}`);
      if (!previous) {
        await db.query(sql);
        await db.query("INSERT INTO cr_migrations(name,hash) VALUES($1,$2)", [
          name,
          hash,
        ]);
      }
    }
  });
}
export async function event(db, taskId, actor, type, data = {}) {
  return (
    await db.query(
      "INSERT INTO cr_events(task_id,actor_type,actor_id,type,data) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [taskId, actor.type, actor.id, type, data],
    )
  ).rows[0];
}

export async function assertRuntimeReady(db) {
  const row = (
    await db.query("SELECT restore_blocked FROM cr_runtime_control WHERE id=1")
  ).rows[0];
  if (!row || row.restore_blocked) {
    const error = new Error("Restore has not completed");
    error.code = "RESTORE_INCOMPLETE";
    error.statusCode = 503;
    throw error;
  }
}
