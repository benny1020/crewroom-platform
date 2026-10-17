import { database, assertRuntimeReady } from "./db.js";
import { configuration } from "./config.js";
import { buildApp } from "./app.js";
const config = configuration(),
  pool = database();
try {
  // Startup checks the schema; a dedicated migration job owns schema changes.
  await assertRuntimeReady(pool);
  const app = buildApp(pool, config);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    });
  await app.listen({ port: config.port, host: config.host });
  console.log(`Crewroom ${config.release} listening at ${config.origin}`);
} catch (error) {
  console.error("Server startup failed:", error.code || error.name);
  await pool.end();
  process.exitCode = 1;
}
