// Fetch immutable upstream text into the ignored local audit archive.
// This never installs, imports or executes the downloaded projects.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const base = new URL(
  "../docs/research/2026-10-16-code-audit/",
  import.meta.url,
);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", base), "utf8"),
);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const jobs = manifest.repositories.flatMap((repo) =>
  repo.fetched_files.map((file) => ({ repo, file })),
);
let done = 0;

async function worker() {
  while (jobs.length) {
    const { repo, file } = jobs.shift();
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repo.repo) ||
      !/^[a-f0-9]{40}$/.test(repo.sha) ||
      file.path.split("/").includes("..") ||
      file.path.startsWith("/")
    )
      throw new Error("Invalid source path");
    const target = new URL(`sources/${repo.slug}/${file.path}`, base);
    try {
      if (hash(await readFile(target)) === file.sha256) {
        done++;
        continue;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const response = await fetch(
      `https://raw.githubusercontent.com/${repo.repo}/${repo.sha}/${file.path}`,
    );
    if (!response.ok)
      throw new Error(`${response.status}: ${repo.slug}/${file.path}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (hash(data) !== file.sha256)
      throw new Error(`Source hash mismatch: ${repo.slug}/${file.path}`);
    await mkdir(dirname(target.pathname), { recursive: true });
    await writeFile(target, data);
    done++;
  }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));
console.log(
  `Verified ${done} pinned source files. No upstream code was executed.`,
);
