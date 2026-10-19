import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  opendir,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  parseArchive,
  materialize,
  treeHash,
  hash,
  LIMITS,
  safePath,
} from "./archive.mjs";
export async function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdout = [],
      stderr = [];
    let size = 0,
      problem = null;
    const timer = setTimeout(() => {
      problem = new Error("COMMAND_TIMEOUT");
      child.kill("SIGKILL");
    }, options.timeout || 120000);
    const collect = (list, data) => {
      size += data.length;
      if (size > 72 * 1024 * 1024) {
        problem = new Error("COMMAND_OUTPUT_TOO_LARGE");
        child.kill("SIGKILL");
      } else list.push(data);
    };
    child.stdout.on("data", (d) => collect(stdout, d));
    child.stderr.on("data", (d) => collect(stderr, d));
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout),
        err = Buffer.concat(stderr);
      if (problem || code !== 0) {
        const error = problem || new Error("COMMAND_FAILED");
        error.stdout = out.toString().slice(-60000);
        error.stderr = err.toString().slice(-60000);
        error.code = code;
        reject(error);
      } else
        resolve({
          stdout: options.encoding === "buffer" ? out : out.toString(),
          stderr: err.toString(),
        });
    });
    child.stdin.end(options.input || "");
  });
}
export function tarFiles(files) {
  const chunks = [];
  const append = (name, bytes, mode, type = "0") => {
    const header = Buffer.alloc(512);
    header.write(name);
    const oct = (n, start, length) =>
      header.write(
        n.toString(8).padStart(length - 1, "0") + "\0",
        start,
        length,
        "ascii",
      );
    oct(mode, 100, 8);
    oct(1000, 108, 8);
    oct(1000, 116, 8);
    oct(bytes.length, 124, 12);
    oct(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const value of header) sum += value;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  };
  let index = 0;
  for (const [path, file] of files) {
    const name = "source/" + safePath(path);
    if (Buffer.byteLength(name) > 100) {
      const field = "path=" + name + "\n";
      let size = Buffer.byteLength(field) + 3;
      while (Buffer.byteLength(String(size) + " " + field) !== size)
        size = Buffer.byteLength(String(size) + " " + field);
      append("pax-" + index, Buffer.from(String(size) + " " + field), 420, "x");
      append("entry-" + index++, file.bytes, file.mode);
    } else append(name, file.bytes, file.mode);
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
export function equalToken(a, b) {
  const aa = Buffer.from(a || ""),
    bb = Buffer.from(b || "");
  return !!aa.length && aa.length === bb.length && timingSafeEqual(aa, bb);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class Broker {
  constructor({
    stateDir,
    namespace = "crewroom",
    image = "crewroom-job:local",
    checks = [
      {
        id: "test",
        label: "Node tests",
        argv: ["node", "--test"],
        timeoutMs: 60000,
      },
    ],
    preparedDependencies = false,
    expectedLocks = {},
    ignore = ["node_modules", "coverage", ".cache"],
    ttlMs = 1800000,
    maxJobs = 2,
    memory = "512m",
    cpus = "1",
    workspaceMb = 256,
  } = {}) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(namespace))
      throw new Error("INVALID_NAMESPACE");
    for (const c of checks)
      if (
        !/^[a-z0-9-]{1,40}$/.test(c.id) ||
        !Array.isArray(c.argv) ||
        !c.argv.length ||
        c.argv.some((v) => typeof v !== "string" || !v || v.length > 500) ||
        !Number.isInteger(c.timeoutMs) ||
        c.timeoutMs < 100 ||
        c.timeoutMs > 300000
      )
        throw new Error("INVALID_CHECK_PROFILE");
    if (
      !checks.length ||
      new Set(checks.map((c) => c.id)).size !== checks.length
    )
      throw new Error("INVALID_CHECK_PROFILE");
    for (const path of [...ignore, ...Object.keys(expectedLocks)])
      safePath(path);
    this.options = {
      namespace,
      image,
      checks,
      preparedDependencies,
      expectedLocks,
      ignore,
      ttlMs,
      maxJobs,
      memory,
      cpus,
      workspaceMb,
    };
    this.stateDir = stateDir;
    this.jobs = new Map();
    this.locks = new Map();
    this.runLocks = new Map();
    this.writeLocks = new Map();
    this.snapshotLocks = new Map();
    this.stopLocks = new Map();
  }
  async init() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.stateDir, "terminal"), {
      recursive: true,
      mode: 0o700,
    });
    const { stdout } = await command("docker", [
      "image",
      "inspect",
      this.options.image,
      "--format",
      "{{.Id}}",
    ]);
    const imageId = stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw new Error("JOB_IMAGE_NOT_READY");
    const value = { ...this.options, imageId, revision: 2 };
    delete value.ttlMs;
    delete value.maxJobs;
    delete value.namespace;
    this.profile = { ...value, id: hash(JSON.stringify(value)) };
    this.pinnedTag =
      this.options.namespace + "-job-pin:" + this.profile.id.slice(0, 24);
    await command("docker", ["image", "tag", imageId, this.pinnedTag]);
    const orphaned = (
      await command("docker", [
        "ps",
        "-aq",
        "--filter",
        "label=crewroom.runner=" + this.options.namespace,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const id of orphaned) await command("docker", ["rm", "-f", id]);
    for await (const entry of await opendir(this.stateDir)) {
      const name = entry.name;
      if (!/^job-[a-f0-9-]+\.json$/.test(name)) continue;
      const job = JSON.parse(await readFile(join(this.stateDir, name), "utf8"));
      await this.recordGeneration(job.runId, job.generation);
      if (!["stopped", "failed"].includes(job.status)) {
        this.jobs.set(job.id, job);
        job.status = "unknown";
        await this.save(job);
        await this.kill(job);
        job.status = "stopped";
        await this.save(job);
      }
      await this.compact(job);
    }
    const { stdout: containers } = await command("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=crewroom.runner=${this.options.namespace}`,
    ]);
    for (const id of containers.trim().split(/\s+/).filter(Boolean))
      await command("docker", ["rm", "-f", id]);
    this.timer = setInterval(() => this.sweep().catch(() => {}), 10000);
    this.timer.unref();
    return this;
  }
  async readJob(id) {
    if (!/^([a-f0-9-]{36})-([1-9][0-9]*)$/.test(id))
      throw new Error("INVALID_JOB");
    for (const directory of [this.stateDir, join(this.stateDir, "terminal")]) {
      try {
        return JSON.parse(
          await readFile(join(directory, `job-${id}.json`), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return null;
  }
  async generation(runId) {
    try {
      return JSON.parse(
        await readFile(join(this.stateDir, `run-${runId}.json`), "utf8"),
      ).generation;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }
  async recordGeneration(runId, generation) {
    const previous = await this.generation(runId);
    if (previous >= generation) return;
    const path = join(this.stateDir, `run-${runId}.json`);
    await writeFile(path + ".tmp", JSON.stringify({ runId, generation }), {
      mode: 0o600,
    });
    await rename(path + ".tmp", path);
  }
  async compact(job) {
    // Preserve the complete durable action ledger/checkpoint for late retries.
    // Only a confirmed terminal job without in-flight operations loses its base.
    if (
      !["stopped", "failed"].includes(job.status) ||
      this.locks.has(job.id) ||
      this.stopLocks.has(job.id) ||
      this.snapshotLocks.has(job.id) ||
      this.runLocks.has(job.runId)
    )
      return false;
    for (const suffix of [".base.tgz", ".source.tgz", ".setup.json"])
      await rm(join(this.stateDir, job.id + suffix), { force: true });
    // Cold ledgers are outside the startup scan. Existing root ledgers migrate
    // here once; restart cost then follows active/unfinished jobs, not all runs.
    try {
      await rename(
        join(this.stateDir, `job-${job.id}.json`),
        join(this.stateDir, "terminal", `job-${job.id}.json`),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.jobs.delete(job.id);
    return true;
  }
  async save(job) {
    return this.serialized(
      job.id,
      async () => {
        const path = join(this.stateDir, `job-${job.id}.json`);
        await writeFile(path + ".tmp", JSON.stringify(job), { mode: 0o600 });
        await rename(path + ".tmp", path);
      },
      this.writeLocks,
    );
  }
  async serialized(key, fn, map = this.locks) {
    const previous = map.get(key) || Promise.resolve();
    let release;
    const current = new Promise((r) => (release = r));
    map.set(key, current);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (map.get(key) === current) map.delete(key);
    }
  }
  async create(input) {
    if (this.closing) throw new Error("RUNNER_STOPPING");
    if (
      !uuid.test(input.runId) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      !["edit", "verify"].includes(input.mode) ||
      !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseSha) ||
      (input.mode === "verify" && typeof input.patch !== "string") ||
      input.profileId !== this.profile.id
    )
      throw new Error("INVALID_JOB_REQUEST");
    return this.serialized(
      input.runId,
      async () => {
        if (this.closing) throw new Error("RUNNER_STOPPING");
        const id = `${input.runId}-${input.generation}`,
          existing = this.jobs.get(id) || (await this.readJob(id)),
          inputHash = hash(JSON.stringify(input));
        if (existing) {
          if (existing.inputHash !== inputHash)
            throw new Error("JOB_INPUT_CONFLICT");
          if (existing.status !== "ready") throw new Error("JOB_NOT_REUSABLE");
          return this.publicJob(existing);
        }
        if ((await this.generation(input.runId)) >= input.generation)
          throw new Error("STALE_GENERATION");
        for (const old of this.jobs.values())
          if (
            old.runId === input.runId &&
            !["stopped", "failed"].includes(old.status)
          )
            throw new Error("PREVIOUS_JOB_NOT_STOPPED");
        if (
          [...this.jobs.values()].filter(
            (j) => !["stopped", "failed"].includes(j.status),
          ).length >= this.options.maxJobs
        )
          throw new Error("RUNNER_BUSY");
        if (
          typeof input.archive !== "string" ||
          input.archive.length > 28 * 1024 * 1024
        )
          throw new Error("ARCHIVE_TOO_LARGE");
        const archive = Buffer.from(input.archive, "base64"),
          files = parseArchive(archive, {
            gzip: true,
            stripRoot: true,
            ignore: this.options.ignore,
          });
        const job = {
          id,
          runId: input.runId,
          generation: input.generation,
          inputHash,
          mode: input.mode,
          baseSha: input.baseSha,
          status: "creating",
          capability: randomBytes(32).toString("hex"),
          container: `${this.options.namespace}-${id}`,
          volume: `${this.options.namespace}-${id}-workspace`,
          createdAt: Date.now(),
          touchedAt: Date.now(),
          sequence: 0,
          actions: {},
          checks: [],
          profileId: this.profile.id,
        };
        await this.recordGeneration(input.runId, input.generation);
        this.jobs.set(id, job);
        await this.save(job);
        try {
          await writeFile(
            join(this.stateDir, id + ".base.tgz"),
            tarFiles(files),
            { mode: 0o600 },
          );
          let source = files;
          if (typeof input.patch === "string") {
            source = await this.applyPatch(files, input.patch);
            job.requiredPatchHash = hash(input.patch);
          }
          await this.checkLocks(source);
          const sourcePath = join(this.stateDir, id + ".source.tgz"),
            setupPath = join(this.stateDir, id + ".setup.json");
          await writeFile(sourcePath, tarFiles(source), { mode: 0o644 });
          await writeFile(
            setupPath,
            JSON.stringify({
              preparedDependencies: this.options.preparedDependencies,
              expectedLocks: this.options.expectedLocks,
            }),
            { mode: 0o644 },
          );
          await command("docker", [
            "volume",
            "create",
            "--label",
            `crewroom.runner=${this.options.namespace}`,
            "--driver",
            "local",
            "--opt",
            "type=tmpfs",
            "--opt",
            "device=tmpfs",
            "--opt",
            `o=size=${this.options.workspaceMb}m,uid=1000,gid=1000,mode=0700`,
            job.volume,
          ]);
          await command("docker", [
            "create",
            "--pull=never",
            "--name",
            job.container,
            "--label",
            `crewroom.runner=${this.options.namespace}`,
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "1000:1000",
            "--pids-limit",
            "128",
            "--memory",
            this.options.memory,
            "--cpus",
            this.options.cpus,
            "--mount",
            `type=volume,source=${job.volume},target=/workspace`,
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=96m,uid=1000,gid=1000,mode=0700",
            this.profile.imageId,
          ]);
          await command("docker", ["start", job.container]);
          for (const [from, to] of [
            [sourcePath, "/tmp/source.tgz"],
            [setupPath, "/tmp/setup.json"],
          ])
            await command(
              "docker",
              [
                "exec",
                "-i",
                job.container,
                "node",
                "-e",
                "const fs=require('node:fs');const parts=[];process.stdin.on('data',d=>parts.push(d));process.stdin.on('end',()=>fs.writeFileSync(process.argv[1],Buffer.concat(parts)));",
                to,
              ],
              { input: await readFile(from) },
            );
          await command("docker", [
            "exec",
            job.container,
            "node",
            "/opt/crewroom/job/bootstrap.mjs",
          ]);
          job.status = "ready";
          job.stateHash = treeHash(source);
          await this.save(job);
          return this.publicJob(job);
        } catch (error) {
          job.status = "failed";
          job.error = error.stderr?.includes("DEPENDENCIES_NOT_PREPARED")
            ? "DEPENDENCIES_NOT_PREPARED"
            : error.message;
          try {
            await this.kill(job);
          } catch (stopError) {
            job.status = "unknown";
            await this.save(job);
            throw stopError;
          }
          await this.save(job);
          throw Object.assign(new Error(job.error), { detail: error.stderr });
        } finally {
          await rm(join(this.stateDir, id + ".source.tgz"), { force: true });
          await rm(join(this.stateDir, id + ".setup.json"), { force: true });
        }
      },
      this.runLocks,
    );
  }
  publicJob(job) {
    return {
      id: job.id,
      capability: job.capability,
      status: job.status,
      stateHash: job.stateHash,
      profileId: job.profileId,
      sequence: job.sequence,
    };
  }
  async get(id, token) {
    const job = this.jobs.get(id) || (await this.readJob(id));
    if (!job || !equalToken(token, job.capability))
      throw new Error("JOB_NOT_FOUND");
    return job;
  }
  async git(files, fn) {
    const dir = await mkdtemp(join(tmpdir(), "crewroom-diff-"));
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      LANG: "C",
    };
    const git = async (args) =>
      (
        await command(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.autocrlf=false",
            ...args,
          ],
          { cwd: dir, env },
        )
      ).stdout;
    try {
      await materialize(files, dir);
      await git(["init", "-q"]);
      await git(["add", "--all", "--force"]);
      await git([
        "-c",
        "user.name=Crewroom",
        "-c",
        "user.email=runner@localhost",
        "commit",
        "-qm",
        "baseline",
      ]);
      return await fn(dir, git);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async applyPatch(files, patch) {
    if (patch === "") return files;
    if (
      typeof patch !== "string" ||
      Buffer.byteLength(patch) > LIMITS.patch ||
      /GIT binary patch|^Binary files |^new mode 120000|^new file mode 120000|^.*mode 160000/m.test(
        patch,
      )
    )
      throw new Error("UNSUPPORTED_PATCH");
    return this.git(files, async (dir, git) => {
      const patchPath = join(
        this.stateDir,
        randomBytes(12).toString("hex") + ".patch",
      );
      try {
        await writeFile(patchPath, patch, { mode: 0o600 });
        await git(["apply", "--check", patchPath]);
        await git(["apply", patchPath]);
        const { stdout } = await command(
          "tar",
          ["--exclude=.git", "-cf", "-", "."],
          {
            cwd: dir,
            encoding: "buffer",
            env: { PATH: process.env.PATH, COPYFILE_DISABLE: "1" },
          },
        );
        return parseArchive(stdout, { ignore: this.options.ignore });
      } finally {
        await rm(patchPath, { force: true });
      }
    });
  }
  async checkLocks(files) {
    {
      for (const [path, expected] of Object.entries(this.options.expectedLocks))
        if (!files.get(path) || hash(files.get(path).bytes) !== expected)
          throw new Error("DEPENDENCY_LOCK_MISMATCH");
    }
  }
  async snapshot(job, options = {}) {
    return this.serialized(
      job.id,
      () => this.capture(job, options),
      this.snapshotLocks,
    );
  }
  async capture(job, { leavePaused = false } = {}) {
    await command("docker", ["pause", job.container]);
    try {
      const { stdout } = await command(
        "docker",
        [
          "run",
          "--pull=never",
          "--rm",
          "--label",
          `crewroom.runner=${this.options.namespace}`,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "1000:1000",
          "--memory",
          "256m",
          "--pids-limit",
          "32",
          "--mount",
          `type=volume,source=${job.volume},target=/workspace,readonly`,
          this.profile.imageId,
          "tar",
          "-c",
          "-C",
          "/workspace",
          ".",
        ],
        { encoding: "buffer" },
      );
      const files = parseArchive(stdout, {
        ignore: this.options.ignore,
        dependencyLink: this.options.preparedDependencies,
      });
      return files;
    } finally {
      if (!leavePaused)
        await command("docker", ["unpause", job.container]).catch(() => {});
    }
  }
  async checkpoint(job, files) {
    const baseline = parseArchive(
      await readFile(join(this.stateDir, job.id + ".base.tgz")),
      { gzip: true, stripRoot: true },
    );
    const patch = await this.git(baseline, async (dir, git) => {
      for (const name of await readdir(dir))
        if (name !== ".git")
          await rm(join(dir, name), { recursive: true, force: true });
      await materialize(files, dir);
      await git(["add", "--intent-to-add", "--all", "--force"]);
      return git([
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
        ".",
      ]);
    });
    if (
      Buffer.byteLength(patch) > LIMITS.patch ||
      /GIT binary patch|^Binary files /m.test(patch)
    )
      throw new Error("UNSUPPORTED_OR_LARGE_PATCH");
    if (treeHash(await this.applyPatch(baseline, patch)) !== treeHash(files))
      throw new Error("PATCH_STATE_MISMATCH");
    return {
      patch,
      patchHash: hash(patch),
      stateHash: treeHash(files),
      baselineSha: job.baseSha,
      profileId: job.profileId,
      checks: [
        ...new Map(job.checks.map((c) => [c.checkId, c])).values(),
      ].filter(
        (c) =>
          c.stateHash === treeHash(files) &&
          (c.editRevision || 0) === (job.editRevision || 0),
      ),
      mode: job.mode,
    };
  }
  async action(id, token, input) {
    const job = await this.get(id, token);
    return this.serialized(id, async () => {
      const bodyHash = hash(JSON.stringify(input)),
        old = job.actions[input.sequence];
      if (old) {
        if (old.hash !== bodyHash) throw new Error("ACTION_CONFLICT");
        if (old.status !== "completed")
          throw new Error("ACTION_OUTCOME_UNKNOWN");
        return old.result;
      }
      if (
        job.status !== "ready" ||
        !Number.isSafeInteger(input.sequence) ||
        input.sequence !== job.sequence + 1
      )
        throw new Error("JOB_NOT_READY_OR_SEQUENCE");
      if (
        ![
          "list_files",
          "read_file",
          "write_file",
          "run_check",
          "finish",
        ].includes(input.action)
      )
        throw new Error("UNKNOWN_ACTION");
      if (input.action === "write_file" && job.mode !== "edit")
        throw new Error("READ_ONLY_QA");
      const check =
        input.action === "run_check"
          ? this.options.checks.find((c) => c.id === input.checkId)
          : null;
      if (input.action === "run_check" && !check)
        throw new Error("UNKNOWN_CHECK");
      job.sequence = input.sequence;
      if (input.action === "write_file")
        job.editRevision = (job.editRevision || 0) + 1;
      job.touchedAt = Date.now();
      job.actions[input.sequence] = { hash: bodyHash, status: "prepared" };
      await this.save(job);
      let result;
      try {
        if (input.action === "finish") {
          const files = await this.snapshot(job, { leavePaused: true });
          result = await this.checkpoint(job, files);
          if (
            job.mode === "verify" &&
            result.patchHash !== job.requiredPatchHash
          )
            throw new Error("QA_PATCH_CHANGED");
          result.passed = this.options.checks.every((c) =>
            result.checks.some((r) => r.checkId === c.id && r.passed),
          );
          await this.kill(job);
          job.status = "stopped";
          job.checkpoint = result;
        } else {
          let before;
          if (check) {
            before = await this.snapshot(job);
            await this.checkLocks(before);
          }
          const request = check
            ? {
                action: "run_check",
                argv: check.argv,
                timeoutMs: check.timeoutMs,
                baseSha: job.baseSha,
              }
            : {
                action: input.action,
                path: input.path,
                content: input.content,
                mode: job.mode,
              };
          const { stdout } = await command(
            "docker",
            ["exec", "-i", job.container, "node", "/opt/crewroom/job/tool.mjs"],
            {
              input: JSON.stringify(request),
              timeout: check ? check.timeoutMs + 15000 : 30000,
            },
          );
          const payload = JSON.parse(stdout);
          if (!payload.ok) throw new Error(payload.error);
          result = payload.result;
          if (check || input.action === "write_file") {
            const files = await this.snapshot(job);
            job.stateHash = treeHash(files);
            if (check) {
              result = {
                ...result,
                checkId: check.id,
                editRevision: job.editRevision || 0,
                label: check.label,
                stateHash: job.stateHash,
                sourceUnchanged: treeHash(before) === job.stateHash,
                passed:
                  result.exitCode === 0 &&
                  !result.timedOut &&
                  treeHash(before) === job.stateHash,
                checkedAt: new Date().toISOString(),
              };
              job.checks.push(result);
            }
            job.checkpoint = await this.checkpoint(job, files);
          }
        }
        if (job.status === "stopping") throw new Error("JOB_STOPPED");
        job.actions[input.sequence] = {
          hash: bodyHash,
          status: "completed",
          result,
        };
        await this.save(job);
        return result;
      } catch (error) {
        job.actions[input.sequence] = {
          hash: bodyHash,
          status: "failed",
          error: error.message,
        };
        job.error = error.message;
        await this.save(job);
        throw error;
      }
    });
  }
  async kill(job) {
    try {
      await command("docker", ["rm", "-f", job.container]);
    } catch (error) {
      const { stdout } = await command("docker", [
        "ps",
        "-aq",
        "--filter",
        `name=^/${job.container}$`,
      ]);
      if (stdout.trim()) throw new Error("JOB_STOP_UNCONFIRMED");
    }
    if (job.volume)
      await command("docker", ["volume", "rm", job.volume]).catch(async () => {
        const { stdout } = await command("docker", [
          "volume",
          "ls",
          "-q",
          "--filter",
          `name=^${job.volume}$`,
        ]);
        if (stdout.trim()) throw new Error("WORKSPACE_STOP_UNCONFIRMED");
      });
  }
  async stop(id, token) {
    return this.serialized(id, () => this.terminate(id, token), this.stopLocks);
  }
  async terminate(id, token) {
    const job = await this.get(id, token);
    if (job.status === "stopped")
      return { stopped: true, checkpoint: job.checkpoint || null };
    job.status = "stopping";
    await this.save(job);
    let checkpoint = job.checkpoint || null;
    try {
      const files = await this.snapshot(job, { leavePaused: true });
      checkpoint = await this.checkpoint(job, files);
    } catch {}
    await this.kill(job);
    job.status = "stopped";
    job.checkpoint = checkpoint;
    await this.save(job);
    return { stopped: true, checkpoint };
  }
  async stopById(id) {
    const match = /^([a-f0-9-]{36})-([1-9][0-9]*)$/.exec(id);
    if (!match || !uuid.test(match[1])) throw new Error("INVALID_JOB");
    return this.serialized(
      match[1],
      async () => {
        const existing = this.jobs.get(id) || (await this.readJob(id));
        if (existing) return this.stop(id, existing.capability);
        const job = {
          id,
          runId: match[1],
          generation: Number(match[2]),
          inputHash: null,
          status: "stopped",
          actions: {},
          createdAt: Date.now(),
          touchedAt: Date.now(),
          capability: randomBytes(32).toString("hex"),
        };
        await this.recordGeneration(job.runId, job.generation);
        await this.save(job);
        return { stopped: true, checkpoint: null };
      },
      this.runLocks,
    );
  }
  async sweep() {
    for (const job of this.jobs.values())
      if (
        !["stopped", "failed"].includes(job.status) &&
        Date.now() - job.touchedAt > this.options.ttlMs
      )
        await this.stop(job.id, job.capability);
    for (const job of this.jobs.values()) await this.compact(job);
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const job of this.jobs.values())
      if (!["stopped", "failed"].includes(job.status))
        await this.stopById(job.id);
    if (this.pinnedTag)
      await command("docker", ["image", "rm", this.pinnedTag]).catch(() => {});
  }
}
