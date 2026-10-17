import { execFileSync } from "node:child_process";
const script = `const cfg={provider:process.env.MODEL_PROVIDER,model:!!process.env.MODEL_NAME,endpoint:!!(process.env.MODEL_ENDPOINT_URL||process.env.MODEL_BASE_URL),gitlab:!!process.env.GITLAB_BASE_URL,projects:(process.env.GITLAB_PROJECTS||'').split(',').filter(Boolean).length};console.log(JSON.stringify(cfg))`;
const runtime = JSON.parse(
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "worker", "node", "-e", script],
    { encoding: "utf8" },
  ),
);
const ready = JSON.parse(
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "app",
      "node",
      "-e",
      "fetch('http://127.0.0.1:4180/api/ready').then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))})",
    ],
    { encoding: "utf8" },
  ),
);
const runner = JSON.parse(
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "worker",
      "node",
      "-e",
      "fetch(process.env.RUNNER_URL+'/v1/profile').then(async r=>{if(!r.ok)process.exit(1);const p=await r.json();console.log(JSON.stringify({id:p.id,image:p.imageId,checks:p.checks.map(c=>c.id)}))})",
    ],
    { encoding: "utf8" },
  ),
);
console.log(
  JSON.stringify(
    {
      app: ready.ok,
      runner,
      modelConfigured: runtime.model && runtime.endpoint,
      gitlabConfigured: runtime.gitlab && runtime.projects > 0,
      actualModelInference:
        "not checked; run a small real task with the configured endpoint",
    },
    null,
    2,
  ),
);
if (!runtime.model || !runtime.endpoint || !runtime.gitlab || !runtime.projects)
  process.exitCode = 1;
