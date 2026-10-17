import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Broker, equalToken } from "./broker.mjs";
import { pathToFileURL } from "node:url";
export function runnerServer(broker, token) {
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    try {
      if (req.method === "GET" && req.url === "/health")
        return res.end(JSON.stringify({ ok: true }));
      if (req.method === "GET" && req.url === "/v1/profile")
        return res.end(JSON.stringify(broker.profile));
      let size = 0,
        chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 30 * 1024 * 1024) throw new Error("REQUEST_TOO_LARGE");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      let result;
      if (req.method === "POST" && req.url === "/v1/jobs") {
        if (!equalToken(req.headers.authorization, "Bearer " + token)) {
          res.statusCode = 401;
          return res.end("{}");
        }
        result = await broker.create(input);
      } else {
        const match = /^\/v1\/jobs\/([a-f0-9-]+)\/(actions|stop)$/.exec(
          req.url,
        );
        if (req.method !== "POST" || !match) {
          res.statusCode = 404;
          return res.end("{}");
        }
        const capability = (req.headers.authorization || "").replace(
          /^Bearer /,
          "",
        );
        result =
          match[2] === "stop" &&
          equalToken(req.headers.authorization, "Bearer " + token)
            ? await broker.stopById(match[1])
            : match[2] === "stop"
              ? await broker.stop(match[1], capability)
              : await broker.action(match[1], capability, input);
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          error:
            error.message === "JOB_NOT_FOUND"
              ? "JOB_NOT_FOUND"
              : String(error.message).slice(0, 200),
        }),
      );
    }
  });
  server.requestTimeout = 360000;
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = process.env,
    token = (
      env.RUNNER_TOKEN_FILE
        ? await readFile(env.RUNNER_TOKEN_FILE, "utf8")
        : env.RUNNER_TOKEN || ""
    ).trim();
  if (token.length < 32) throw new Error("RUNNER_TOKEN_REQUIRED");
  const broker = await new Broker({
    stateDir: env.RUNNER_STATE_DIR || ".local/runner-state",
    namespace: env.RUNNER_NAMESPACE || "crewroom",
    image: env.RUNNER_JOB_IMAGE || "crewroom-job:local",
    ...(env.RUNNER_CHECKS_FILE
      ? JSON.parse(await readFile(env.RUNNER_CHECKS_FILE, "utf8"))
      : {}),
  }).init();
  const server = runnerServer(broker, token);
  server.listen(Number(env.PORT || 4191), env.HOST || "127.0.0.1");
  for (const sig of ["SIGTERM", "SIGINT"])
    process.on(sig, async () => {
      server.close();
      await broker.close();
      process.exit(0);
    });
}
