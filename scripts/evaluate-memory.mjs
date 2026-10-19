import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configuration } from "../server/config.js";
import { embeddingProfile } from "../server/memory-embedding.js";
import {
  evaluateMemory,
  memoryQualityGate,
} from "../tests/support/memory-evaluation.js";
const cleanup = [],
  t = { after: (fn) => cleanup.push(fn) };
let phase = "OPTIONS";
try {
  const args = process.argv.slice(2);
  if (
    new Set(args.map((a) => a.split("=")[0])).size !== args.length ||
    args.some(
      (a) =>
        !["--baseline", "--embeddings", "--help"].includes(a) &&
        !/^--max-calls=\d+$/.test(a),
    )
  )
    throw Error();
  if (args.includes("--help")) {
    if (args.length !== 1) throw Error();
    console.log(
      "evaluate:memory [--baseline | --embeddings --max-calls=N]. Requires an isolated TEST_DATABASE_URL. Default: keyword only, no model requests. --baseline requires full Git history and is keyword only. Embedding calls share one explicit budget (1–240); no automatic retries. Reports: .local/memory-evaluation/.",
    );
  } else {
    const semantic = args.includes("--embeddings"),
      baseline = args.includes("--baseline"),
      maxCallsArg = args.find((a) => a.startsWith("--max-calls=")),
      maxCalls = Number(maxCallsArg?.split("=")[1]);
    if (
      (baseline && semantic) ||
      (!semantic && maxCallsArg) ||
      (semantic &&
        (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 240))
    )
      throw Error();
    let baselineSearch;
    // Resolve historical code before creating test data or making any endpoint call.
    if (baseline) {
      phase = "BASELINE_SOURCE_UNAVAILABLE";
      let source = execFileSync("git", ["show", "8a71792:server/memory.js"], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 200000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const file of ["permissions.js", "errors.js"])
        source = source.replace(
          '"./' + file + '"',
          JSON.stringify(new URL("../server/" + file, import.meta.url).href),
        );
      const directory = resolve(".local/memory-evaluation");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = resolve(directory, "baseline-0.7.mjs");
      await writeFile(file, source, { mode: 0o600 });
      baselineSearch = (await import(pathToFileURL(file).href)).searchMemory;
    }
    phase = "CONFIGURATION";
    const embeddingConfig = semantic ? configuration() : null;
    if (semantic && !embeddingProfile(embeddingConfig)) throw Error();
    phase = "EVALUATION_INCOMPLETE";
    const current = await evaluateMemory(t, {
        embeddingConfig,
        embeddingBudget: semantic ? { maxCalls, calls: 0 } : null,
      }),
      report = {
        version: 1,
        date: new Date().toISOString(),
        current,
        qualityGate: memoryQualityGate(current),
        limits: { maxEmbeddingCalls: semantic ? maxCalls : 0 },
        limitations: [
          "Synthetic Korean retrieval corpus; not a public benchmark or generated-answer quality approval",
          semantic
            ? "Configured endpoint only; endpoint identity and embedding quality require operator review"
            : "Keyword only; no embedding or answer model requests",
          "Same five-document result cap; semantic paraphrases are reported separately; no latency or cost comparison",
        ],
      };
    if (baselineSearch)
      report.baseline = await evaluateMemory(t, {
        search: baselineSearch,
        legacyView: true,
      });
    const directory = resolve(".local/memory-evaluation");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = resolve(
      directory,
      new Date().toISOString().replaceAll(/[:.]/g, "-") + ".json",
    );
    await writeFile(file, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify(
        {
          report: file,
          qualityGate: report.qualityGate,
          current: { ...current, rows: undefined },
          baseline: report.baseline
            ? { ...report.baseline, rows: undefined }
            : undefined,
        },
        null,
        2,
      ),
    );
    if (!report.qualityGate.passed) process.exitCode = 1;
  }
} catch {
  console.error(
    JSON.stringify({
      error: phase,
      note: "Evaluation refused or incomplete. Check --help, isolated TEST_DATABASE_URL, full Git history for --baseline, embedding configuration/coverage and explicit call budget. Endpoint URLs, secrets and provider error bodies are not printed.",
    }),
  );
  process.exitCode = 1;
} finally {
  for (const fn of cleanup.reverse()) await fn();
}
