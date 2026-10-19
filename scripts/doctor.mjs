import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const runtimeScript = `
const {configuration,modelProfile}=await import('./server/config.js');
const {embeddingProfile}=await import('./server/memory-embedding.js');
const {database,digest,assertRuntimeReady}=await import('./server/db.js');
const {readdir,readFile}=await import('node:fs/promises');
const cfg=configuration(),pool=database();
try {
  await assertRuntimeReady(pool);
  const migrations=(await pool.query('SELECT name,hash FROM cr_migrations')).rows;
  const files=(await readdir('server/migrations')).filter(n=>n.endsWith('.sql'));
  let schema=migrations.length===files.length;
  for(const name of files) {
    const hash=digest(await readFile('server/migrations/'+name,'utf8'));
    schema &&= migrations.some(m=>m.name===name&&m.hash===hash);
  }
  const workers=(await pool.query("SELECT count(*)::int AS healthy,coalesce(bool_or(maintenance_at>clock_timestamp()-interval '3 minutes' AND maintenance_error_code IS NULL),false) AS maintenance FROM cr_workers WHERE version=$1 AND state='ready' AND last_error_code IS NULL AND heartbeat_at>clock_timestamp()-interval '60 seconds' AND last_tick_at>clock_timestamp()-interval '60 seconds'",[cfg.release])).rows[0];
  let model=false,embedding=false;
  try {model=!!(cfg.model&&modelProfile(cfg).endpoint&&['openai-compatible','anthropic'].includes(cfg.provider)&&!cfg.allowFixture)}catch{}
  try {embedding=!!embeddingProfile(cfg)}catch{}
  console.log(JSON.stringify({release:cfg.release,schema,worker:workers.healthy>0,maintenance:workers.maintenance,model,embedding,embeddingRequested:!!(cfg.embeddingUrl||cfg.embeddingModel),gitlab:!!(cfg.gitlabBase&&cfg.gitlabProjects.length)}));
} finally {await pool.end()}`;
const appScript = `
const get=async path=>{const r=await fetch('http://127.0.0.1:4180/api/'+path,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error();return r.json()};
const health=await get('health'),ready=await get('ready');
console.log(JSON.stringify({ready:ready.ok===true,release:health.release}));`;
const runnerScript = `
const r=await fetch(process.env.RUNNER_URL+'/v1/profile',{signal:AbortSignal.timeout(3000)});
if(!r.ok)throw Error();const p=await r.json();
console.log(JSON.stringify({ready:!!(p.id&&p.imageId&&Array.isArray(p.checks)&&p.checks.length)}));`;

export function composeProbe(service, script) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        service,
        "node",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}

export async function diagnose({
  code = false,
  probe = composeProbe,
  release,
} = {}) {
  release ||= JSON.parse(
    await readFile(new URL("../package.json", import.meta.url)),
  ).version;
  const errors = [],
    checks = {};
  const read = async (name, service, script) => {
    try {
      return await probe(service, script);
    } catch {
      errors.push(name + "_PROBE_FAILED");
      return {};
    }
  };
  const runtime = await read("RUNTIME", "worker", runtimeScript),
    app = await read("APP", "app", appScript);
  checks.app = app.ready === true && app.release === release;
  checks.schema = runtime.schema === true;
  checks.worker = runtime.worker === true && runtime.release === release;
  checks.modelConfigured = runtime.model === true;
  checks.embeddingConfiguration =
    !runtime.embeddingRequested || runtime.embedding === true;
  if (code) {
    const runner = await read("RUNNER", "worker", runnerScript);
    checks.runner = runner.ready === true;
    checks.gitlabConfigured = runtime.gitlab === true;
  }
  return {
    mode: code ? "code" : "chat-and-skills",
    release,
    ready: errors.length === 0 && Object.values(checks).every(Boolean),
    checks,
    errors,
    warnings: runtime.maintenance === true ? [] : ["MAINTENANCE_NOT_HEALTHY"],
    memorySearch: errors.includes("RUNTIME_PROBE_FAILED")
      ? "unverified"
      : runtime.embedding === true
        ? "configured-embeddings; quality not checked"
        : "keyword; embeddings disabled",
    actualModelInference:
      "not checked; use evaluate:answers and review a small real task",
    repositoryAccess:
      "not checked; code mode checks configuration and Runner profile only",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some((a) => !["--code", "--help"].includes(a)))
      throw Error();
    if (args.includes("--help")) {
      console.log(
        "doctor [--code]: read-only app/schema/Worker/model configuration checks. --code also requires Runner and GitLab. No inference or repository requests. Each process is bounded to 20 seconds; output excludes endpoint URLs and secrets.",
      );
    } else {
      const report = await diagnose({ code: args.includes("--code") });
      console.log(JSON.stringify(report, null, 2));
      if (!report.ready) process.exitCode = 1;
    }
  } catch {
    console.error(
      "Diagnostic refused. Use doctor [--code]; confirm Docker Compose and the current release are available. No credentials or provider error bodies are printed.",
    );
    process.exitCode = 1;
  }
}
