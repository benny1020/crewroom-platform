import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
export async function secret(name, env = process.env) {
  if (env[`${name}_FILE`])
    return (await readFile(env[`${name}_FILE`], "utf8")).trim();
  return env[name] || "";
}
export function configuration(env = process.env) {
  const origin = env.PUBLIC_ORIGIN || "http://localhost:4180";
  if (new URL(origin).origin !== origin)
    throw new Error(
      "PUBLIC_ORIGIN must be a canonical origin without a trailing slash",
    );
  const production = env.NODE_ENV === "production";
  if (production && !origin.startsWith("https://"))
    throw new Error("Production PUBLIC_ORIGIN must use HTTPS");
  return {
    origin,
    production,
    secureCookies: origin.startsWith("https://"),
    port: Number(env.PORT || 4180),
    host: env.HOST || "127.0.0.1",
    dataDir: resolve(env.DATA_DIR || ".local/server-data"),
    allowedEmails: (env.ALLOWED_EMAILS || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    provider: env.MODEL_PROVIDER || "openai-compatible",
    model: env.MODEL_NAME || "",
    modelBase: env.MODEL_BASE_URL || "",
    modelEndpoint: env.MODEL_ENDPOINT_URL || "",
    modelAuthHeader: env.MODEL_AUTH_HEADER || "",
    modelAuthScheme: env.MODEL_AUTH_SCHEME || "auto",
    modelApiVersion: env.MODEL_API_VERSION || "2023-06-01",
    githubEnabled: env.GITHUB_ENABLED !== "0",
    gitlabBase: env.GITLAB_BASE_URL || "",
    gitlabProjects: (env.GITLAB_PROJECTS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    gitlabSharedProjects: (env.GITLAB_SHARED_PROJECTS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    runnerUrl: env.RUNNER_URL || "",
    modelTimeoutMs: Number(env.MODEL_TIMEOUT_MS || 120000),
    maxOutputTokens: Number(env.MODEL_MAX_OUTPUT_TOKENS || 4096),
    workerLeaseSeconds: 60,
    workerHeartbeatMs: 15000,
    release: "0.13.0",
    embeddingUrl: env.EMBEDDING_ENDPOINT_URL || "",
    embeddingModel: env.EMBEDDING_MODEL || "",
    embeddingAuthHeader: env.EMBEDDING_AUTH_HEADER || "",
    embeddingAuthScheme: env.EMBEDDING_AUTH_SCHEME || "auto",
    allowFixture: env.CREWROOM_TEST_FIXTURE === "1" && !production,
    serveDist: env.SERVE_DIST !== "0",
  };
}

export function modelEndpoint(config) {
  const route =
    config.provider === "anthropic" ? "/messages" : "/chat/completions";
  let endpoint =
    config.modelEndpoint ||
    (config.modelBase ? config.modelBase.replace(/\/$/, "") + route : "");
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new Error("Invalid model endpoint");
    endpoint = url.href.replace(/\/$/, "");
  }
  return endpoint;
}
export function modelAuthentication(config) {
  const header =
    config.modelAuthHeader ||
    (config.provider === "anthropic" ? "x-api-key" : "authorization");
  const scheme = config.modelAuthScheme || "auto";
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) ||
    ["host", "content-length", "content-type", "connection"].includes(
      header.toLowerCase(),
    ) ||
    !["auto", "bearer", "raw"].includes(scheme)
  )
    throw new Error("Invalid model authentication configuration");
  return {
    header: header.toLowerCase(),
    prefix:
      scheme === "bearer" ||
      (scheme === "auto" && config.provider !== "anthropic")
        ? "Bearer "
        : "",
  };
}
export function modelProfile(config) {
  const value = {
    provider: config.provider,
    endpoint: modelEndpoint(config),
    model: config.model,
    authentication: modelAuthentication(config),
    apiVersion:
      config.provider === "anthropic"
        ? config.modelApiVersion || "2023-06-01"
        : null,
    revision: 2,
  };
  return {
    ...value,
    id: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}

export function sourceProfile(config) {
  let gitlabBase = config.gitlabBase || "";
  if (gitlabBase) {
    const url = new URL(gitlabBase);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new Error("Invalid GitLab API root");
    gitlabBase = url.href.replace(/\/$/, "");
  }
  const value = {
    gitlabBase,
    projects: [...(config.gitlabProjects || [])].sort(),
    sharedProjects: [...(config.gitlabSharedProjects || [])].sort(),
    githubEnabled: config.githubEnabled !== false,
    revision: 1,
  };
  return {
    ...value,
    id: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}
