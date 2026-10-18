import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configuration } from "../server/config.js";
import { evaluateMemory } from "../tests/support/memory-evaluation.js";
const cleanup = [],
  t = { after: (fn) => cleanup.push(fn) };
try {
  const embeddingConfig = process.argv.includes("--embeddings")
    ? configuration()
    : null;
  if (
    embeddingConfig &&
    (!embeddingConfig.embeddingUrl || !embeddingConfig.embeddingModel)
  )
    throw new Error(
      "Set EMBEDDING_ENDPOINT_URL and EMBEDDING_MODEL before --embeddings",
    );
  const current = await evaluateMemory(t, { embeddingConfig }),
    report = {
      date: new Date().toISOString(),
      current,
      limitations: [
        "Synthetic Korean retrieval corpus, not a public benchmark result",
        embeddingConfig
          ? "Real configured embedding retrieval only; generated-answer quality not measured"
          : "No real embeddings or generated-answer quality measurement",
        "Same five-document result cap; no latency or cost comparison claimed",
      ],
    };
  if (process.argv.includes("--baseline")) {
    let source = execFileSync("git", ["show", "8a71792:server/memory.js"], {
      encoding: "utf8",
    });
    for (const file of ["permissions.js", "errors.js"])
      source = source.replace(
        '"./' + file + '"',
        JSON.stringify(pathToFileURL(resolve("server/" + file)).href),
      );
    await mkdir(".local", { recursive: true });
    const file = resolve(".local/memory-baseline-0.7.mjs");
    await writeFile(file, source);
    report.baseline = await evaluateMemory(t, {
      search: (await import(pathToFileURL(file).href)).searchMemory,
      legacyView: true,
      embeddingConfig,
    });
  }
  await mkdir(".local", { recursive: true });
  await writeFile(
    ".local/memory-evaluation-0.8.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        current: { ...current, rows: undefined },
        baseline: report.baseline
          ? { ...report.baseline, rows: undefined }
          : undefined,
      },
      null,
      2,
    ),
  );
} finally {
  for (const fn of cleanup.reverse()) await fn();
}
