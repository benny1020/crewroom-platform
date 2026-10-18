import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { configuration } from "../server/config.js";
import {
  evaluationPlan,
  evaluateAnswers,
  checkBaseline,
} from "./answer-evaluation.mjs";

try {
  const args = process.argv.slice(2);
  if (
    args.some(
      (a) =>
        a !== "--live" && !/^--(?:case|repeat|max-calls|compare)=.+$/.test(a),
    )
  )
    throw new Error(
      "Options: --live --case=id,id --repeat=1 --max-calls=20 --compare=report.json",
    );
  if (new Set(args.map((a) => a.split("=")[0])).size !== args.length)
    throw new Error("Duplicate options");
  const option = (name) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const corpus = JSON.parse(
    await readFile(
      new URL("../evaluation/answer-cases.ko.json", import.meta.url),
      "utf8",
    ),
  );
  const ids = option("case")?.split(",") || [],
    repeat = Number(option("repeat") || 1);
  const plan = evaluationPlan(corpus, { ids, repeat }),
    config = configuration();
  const baseline = option("compare")
    ? JSON.parse(await readFile(resolve(option("compare")), "utf8"))
    : null;
  if (baseline) checkBaseline(baseline, plan);
  if (!args.includes("--live")) {
    console.log(
      JSON.stringify(
        {
          mode: "plan-only",
          networkCalls: 0,
          cases: plan.ids,
          repeat,
          plannedCalls: plan.plannedCalls,
          note: "No requests sent. Configure endpoint/secret, then use --live and an explicit --max-calls budget.",
        },
        null,
        2,
      ),
    );
  } else {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const report = await evaluateAnswers({
      corpus,
      config,
      ids,
      repeat,
      maxCalls: Number(option("max-calls")),
      baseline,
      signal: controller.signal,
    });
    const directory = resolve(".local/answer-evaluation");
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
          mode: report.mode,
          report: file,
          summary: report.summary,
          note: "Review individual answers manually; heuristic success is not a quality approval.",
        },
        null,
        2,
      ),
    );
    if (
      report.aborted ||
      report.summary.failedCalls ||
      report.summary.forbiddenMatches ||
      report.summary.heuristicPassed !== report.summary.attemptedCalls
    )
      process.exitCode = 1;
  }
} catch {
  // Do not echo endpoint addresses, key paths or provider error bodies.
  console.error(
    "Evaluation refused or could not finish. Check case IDs, comparison corpus, endpoint/model configuration, secret files and --max-calls budget. No automatic retry.",
  );
  process.exitCode = 1;
}
