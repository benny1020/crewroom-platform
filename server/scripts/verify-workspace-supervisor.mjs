// Linux process-lifecycle verification. This does not qualify bwrap filesystem confinement.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("This verification requires Linux subreaper semantics");
const helper = fileURLToPath(new URL("../src/services/scripts/workspace-command-supervisor.py", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "workspace-supervisor-proof-"));
const active = new Map();
const observedDescendants = new Set();
const observedHelpers = new Set();
function track(child) {
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  active.set(child, closed);
  closed.then(() => active.delete(child), () => active.delete(child));
  return closed;
}
const fixture = join(root, "detach.py");
await writeFile(fixture, `import os, sys, time
if os.fork() == 0:
    os.setsid()
    for fd in (0, 1, 2):
        os.close(fd)
    with open("descendant.pid", "w") as out:
        out.write(str(os.getpid()))
    for tick in range(1000):
        with open("ticks.txt", "w") as out:
            out.write(str(tick))
        time.sleep(0.005)
    os._exit(0)
while not os.path.exists("ticks.txt"):
    time.sleep(0.005)
if sys.argv[1] == "completion":
    while not os.path.exists("completion.release"):
        time.sleep(0.005)
else:
    time.sleep(20)
`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read().catch(() => false);
    if (value) return value;
    await pause(10);
  }
  throw new Error(message);
}
async function processState(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], birth: fields[19] };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function descendant() {
  const pid = await waitFor(async () => {
    const pid = Number(await readFile(join(root, "descendant.pid"), "utf8"));
    return pid > 1 && await processState(pid) ? pid : false;
  }, "Fixture descendant did not start");
  observedDescendants.add(pid);
  return pid;
}
async function reset() {
  await rm(join(root, "descendant.pid"), { force: true });
  await rm(join(root, "ticks.txt"), { force: true });
  await rm(join(root, "completion.release"), { force: true });
}
try {
  for (const mode of ["completion", "timeout", "revocation"]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await reset();
      const child = spawn("/usr/bin/python3", [helper, "/usr/bin/python3", fixture, mode], {
        cwd: root, stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      let status = "", diagnostics = "";
      child.stdio[3].on("data", bytes => { status += bytes; });
      child.stdout.resume(); child.stderr.on("data", bytes => { diagnostics += bytes; });
      const closed = track(child);
      const pid = await descendant();
      if (mode === "completion") await writeFile(join(root, "completion.release"), "release");
      else {
        if (mode === "timeout") await pause(50);
        child.stdin.end();
      }
      assert.deepEqual(await closed, { code: 0, signal: null }, diagnostics);
      const receipt = JSON.parse(status);
      assert.equal(receipt.settled, true);
      assert.equal(receipt.error, undefined);
      assert.equal(await processState(pid), null, "Acknowledgment preceded descendant reaping");
      await writeFile(join(root, "ticks.txt"), "successor");
      await pause(150);
      assert.equal(await readFile(join(root, "ticks.txt"), "utf8"), "successor");
    }
  }
  await reset();
  const controllerScript = `import {spawn} from "node:child_process";
const child=spawn("/usr/bin/python3",${JSON.stringify([helper, "/usr/bin/python3", fixture, "parent-death"])},{cwd:${JSON.stringify(root)},stdio:["pipe","ignore","ignore","pipe"]});
console.log(JSON.stringify({helperPid:child.pid})); child.stdio[3].resume();`;
  const controller = spawn(process.execPath, ["--input-type=module", "-e", controllerScript], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = track(controller);
  let announcement = "";
  controller.stdout.on("data", bytes => { announcement += bytes; });
  const helperPid = await waitFor(async () => {
    try { return JSON.parse(announcement).helperPid || false; } catch { return false; }
  }, "Fixture controller did not announce its owned helper");
  observedHelpers.add(helperPid);
  const pid = await descendant();
  controller.kill("SIGKILL"); // This exact test-owned Node process; helper observes control EOF.
  await closed;
  await waitFor(async () => await processState(pid) === null, "Controller death left its descendant alive");
  await writeFile(join(root, "ticks.txt"), "successor-after-parent-death");
  await pause(150);
  assert.equal(await readFile(join(root, "ticks.txt"), "utf8"), "successor-after-parent-death");
  console.log("PASS: Linux subreaper completion/timeout/revocation (3 each), same-file successor safety, and controller-death cleanup");
} finally {
  for (const [child, closed] of active) {
    // Cooperative EOF for owned helpers; stopping an owned Node controller
    // also closes its helper's control pipe. Never kill the reaper first.
    if (child.stdin) child.stdin.end();
    else child.kill("SIGTERM");
    await closed;
  }
  for (const pid of observedDescendants) {
    await waitFor(async () => await processState(pid) === null, "Fixture descendant cleanup remains unresolved");
  }
  for (const pid of observedHelpers) {
    await waitFor(async () => { const state = await processState(pid); return state === null || state.state === "Z"; }, "Owned helper cleanup remains active");
  }
  await rm(root, { recursive: true, force: true });
}
