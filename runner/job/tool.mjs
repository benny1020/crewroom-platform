import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { spawn } from "node:child_process";
const root = "/workspace",
  protectedPaths = [".git", "node_modules"];
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 300000) throw new Error("REQUEST_TOO_LARGE");
}
const request = JSON.parse(input);
async function safe(value, { directory = false, create = false } = {}) {
  if (value === "." && directory) return root;
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((p) => !p || p === "." || p === ".." || protectedPaths.includes(p))
  )
    throw new Error("UNSAFE_PATH");
  const path = resolve(root, value);
  if (!path.startsWith(root + "/")) throw new Error("UNSAFE_PATH");
  let current = root;
  for (const part of value.split("/")) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
      )
        throw new Error("UNSUPPORTED_FILE");
    } catch (error) {
      if (error.code === "ENOENT" && create) break;
      throw error;
    }
  }
  return path;
}
async function perform() {
  if (request.action === "list_files") {
    const base = await safe(request.path || ".", { directory: true }),
      files = [];
    async function walk(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (protectedPaths.includes(entry.name)) continue;
        if (files.length >= 500) return;
        if (entry.isSymbolicLink()) throw new Error("UNSUPPORTED_FILE");
        const full = join(path, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) files.push(relative(root, full));
        else throw new Error("UNSUPPORTED_FILE");
      }
    }
    await walk(base);
    return { files, truncated: files.length >= 500 };
  }
  if (request.action === "read_file") {
    const path = await safe(request.path),
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024)
        throw new Error("FILE_TOO_LARGE_OR_UNSUPPORTED");
      const data = await file.readFile();
      if (data.includes(0)) throw new Error("BINARY_FILE");
      return { path: request.path, content: data.toString("utf8") };
    } finally {
      await file.close();
    }
  }
  if (request.action === "write_file") {
    if (request.mode !== "edit") throw new Error("READ_ONLY_QA");
    if (
      typeof request.content !== "string" ||
      Buffer.byteLength(request.content) > 128 * 1024 ||
      request.content.includes("\0")
    )
      throw new Error("FILE_TOO_LARGE_OR_BINARY");
    const path = await safe(request.path, { create: true });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await file.writeFile(request.content);
    } finally {
      await file.close();
    }
    return { path: request.path, bytes: Buffer.byteLength(request.content) };
  }
  if (request.action === "run_check") {
    if (!Array.isArray(request.argv) || !request.argv.length)
      throw new Error("INVALID_CHECK");
    const started = Date.now(),
      child = spawn(request.argv[0], request.argv.slice(1), {
        cwd: root,
        shell: false,
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: "/tmp/home",
          TMPDIR: "/tmp",
          CI: "1",
          NODE_ENV: "test",
          CREWROOM_BASE_SHA: request.baseSha || "",
          NODE_PATH: "/opt/crewroom-deps/node_modules",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    let stdout = "",
      stderr = "",
      truncated = false;
    const collect = (kind, data) => {
      if (kind === "out") {
        stdout += data;
        if (stdout.length > 60000) {
          stdout = stdout.slice(-60000);
          truncated = true;
        }
      } else {
        stderr += data;
        if (stderr.length > 60000) {
          stderr = stderr.slice(-60000);
          truncated = true;
        }
      }
    };
    child.stdout.on("data", (d) => collect("out", d));
    child.stderr.on("data", (d) => collect("err", d));
    return await new Promise((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, request.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          error: error.code || "CHECK_START_FAILED",
          stdout,
          stderr,
          truncated,
          durationMs: Date.now() - started,
        });
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        resolve({
          exitCode: code,
          signal,
          timedOut,
          stdout,
          stderr,
          truncated,
          durationMs: Date.now() - started,
        });
      });
    });
  }
  throw new Error("UNKNOWN_ACTION");
}
try {
  console.log(JSON.stringify({ ok: true, result: await perform() }));
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, error: error.code || error.message }),
  );
}
