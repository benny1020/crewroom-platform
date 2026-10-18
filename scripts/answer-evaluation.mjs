import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  configuration,
  modelEndpoint,
  modelProfile,
} from "../server/config.js";
import { runModel } from "../server/provider.js";

export function evaluationPlan(corpus, { ids = [], repeat = 1 } = {}) {
  if (
    corpus.version !== 1 ||
    !Array.isArray(corpus.cases) ||
    !Number.isInteger(repeat) ||
    repeat < 1 ||
    repeat > 3
  )
    throw new Error("Invalid corpus or repeat (1–3)");
  const unique = new Set(corpus.cases.map((c) => c.id));
  if (unique.size !== corpus.cases.length || ids.some((id) => !unique.has(id)))
    throw new Error("Unknown or duplicate case ID");
  const cases = corpus.cases.filter((c) => !ids.length || ids.includes(c.id));
  if (!cases.length) throw new Error("No cases selected");
  for (const c of cases) {
    if (
      !c.id ||
      typeof c.goal !== "string" ||
      !Array.isArray(c.context) ||
      !Array.isArray(c.expected) ||
      !Array.isArray(c.forbidden) ||
      c.forbidden.some((v) => typeof v !== "string" || !v) ||
      c.expected.some(
        (v) =>
          !Array.isArray(v) ||
          !v.length ||
          v.some((w) => typeof w !== "string" || !w),
      ) ||
      c.context.some(
        (v) => typeof v.key !== "string" || typeof v.body !== "string",
      ) ||
      JSON.stringify(c.context).length > 16000
    )
      throw new Error("Invalid evaluation case: " + c.id);
  }
  return {
    corpusHash: createHash("sha256")
      .update(JSON.stringify(corpus))
      .digest("hex"),
    ids: cases.map((c) => c.id),
    repeat,
    plannedCalls: cases.length * repeat,
    cases,
  };
}
const normalized = (v) =>
  String(v).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
export function scoreAnswer(c, result) {
  const answer = normalized([result.summary, ...result.evidence].join("\n")),
    all = normalized(JSON.stringify(result)),
    factsPresent = c.expected.every((alternatives) =>
      alternatives.some((v) => answer.includes(normalized(v))),
    ),
    forbiddenMatches = c.forbidden.filter((v) =>
      all.includes(normalized(v)),
    ).length,
    sourceCited =
      !c.expected.length ||
      (c.expectedSources || c.context.map((s) => s.key)).every((key) =>
        result.evidence.some((v) => v.includes(key)),
      ),
    uncertaintyPresent = !c.unknown || result.unknowns.some((v) => v.trim());
  return {
    heuristicPassed:
      factsPresent &&
      !forbiddenMatches &&
      sourceCited &&
      Boolean(uncertaintyPresent),
    factsPresent,
    forbiddenMatches,
    sourceCited,
    uncertaintyPresent: Boolean(uncertaintyPresent),
  };
}
export function checkBaseline(baseline, plan) {
  if (
    baseline.aborted !== false ||
    baseline.version !== 1 ||
    baseline.mode !== "configured-endpoint" ||
    baseline.corpusHash !== plan.corpusHash ||
    JSON.stringify(baseline.ids) !== JSON.stringify(plan.ids) ||
    baseline.repeat !== plan.repeat ||
    baseline.rows?.length !== plan.plannedCalls
  )
    throw new Error(
      "Comparison requires the same corpus, ordered cases, repeats and a complete baseline",
    );
}
export async function evaluateAnswers({
  corpus,
  config,
  ids,
  repeat = 1,
  maxCalls,
  baseline,
  signal,
  call = runModel,
  mode = "configured-endpoint",
}) {
  const plan = evaluationPlan(corpus, { ids, repeat });
  if (
    !Number.isInteger(maxCalls) ||
    maxCalls < plan.plannedCalls ||
    maxCalls > 60
  )
    throw new Error(
      "Set an explicit max-calls budget covering the plan (maximum 60)",
    );
  if (
    !["openai-compatible", "anthropic"].includes(config.provider) ||
    !config.model ||
    !modelEndpoint(config) ||
    config.allowFixture
  )
    throw new Error("Configure a real endpoint/model; fixture mode is refused");
  if (baseline) {
    checkBaseline(baseline, plan);
    if (baseline.maxOutputTokens !== config.maxOutputTokens)
      throw new Error("Comparison output budget must match");
  }
  const { cases, ...metadata } = plan,
    rows = [];
  const profile = modelProfile(config);
  for (const c of cases) {
    for (let iteration = 1; iteration <= repeat; iteration++) {
      if (signal?.aborted) break;
      const started = performance.now();
      try {
        const value = await call(
          {
            agent: {
              name: "근거 평가 동료",
              instructions:
                "제공된 원문에만 근거해 답하세요. 근거에는 출처 key를 적고, 알 수 없는 내용은 unknowns에 남기세요.",
              runtime: "readonly",
            },
            skill: {
              version: 1,
              instructions: "원문 밖의 사실이나 실행 결과를 만들지 마세요.",
              done: "출처를 인용하고 모르는 부분을 구분한다.",
            },
            providerProfile: profile,
            model: config.model,
            goal: c.goal,
            target: "한국어 합성 답변 평가",
            targetVersion: "corpus-v1",
            memoryContext: { items: c.context },
            memories: [],
            messages: [],
          },
          config,
          { signal },
        );
        rows.push({
          id: c.id,
          category: c.category,
          iteration,
          durationMs: Math.round(performance.now() - started),
          result: value.result,
          usage: value.receipt.usage ?? null,
          ...scoreAnswer(c, value.result),
          humanReview: { accepted: null, notes: "" },
        });
      } catch (e) {
        rows.push({
          id: c.id,
          category: c.category,
          iteration,
          durationMs: Math.round(performance.now() - started),
          errorCode:
            typeof e.code === "string" && /^[A-Z_]+$/.test(e.code)
              ? e.code
              : "MODEL_CALL_FAILED",
          heuristicPassed: false,
          usage: null,
          humanReview: { accepted: null, notes: "" },
        });
      }
    }
  }
  const usages = rows
    .map((r) => r.usage)
    .filter(
      (u) =>
        u &&
        Number.isSafeInteger(u.promptTokens) &&
        u.promptTokens >= 0 &&
        Number.isSafeInteger(u.completionTokens) &&
        u.completionTokens >= 0,
    );
  const summary = {
    attemptedCalls: rows.length,
    completedCalls: rows.filter((r) => r.result).length,
    failedCalls: rows.filter((r) => r.errorCode).length,
    heuristicPassed: rows.filter((r) => r.heuristicPassed).length,
    forbiddenMatches: rows.reduce((n, r) => n + (r.forbiddenMatches || 0), 0),
    meanDurationMs: rows.length
      ? Math.round(rows.reduce((n, r) => n + r.durationMs, 0) / rows.length)
      : null,
    usageReported: usages.length,
    usageMissing: rows.length - usages.length,
    inputTokens: usages.length
      ? usages.reduce((n, u) => n + u.promptTokens, 0)
      : null,
    outputTokens: usages.length
      ? usages.reduce((n, u) => n + u.completionTokens, 0)
      : null,
    cost: null,
  };
  return {
    version: 1,
    date: new Date().toISOString(),
    mode,
    ...metadata,
    provider: config.provider,
    model: config.model,
    profileId: profile.id,
    maxOutputTokens: config.maxOutputTokens,
    aborted: Boolean(signal?.aborted),
    summary,
    rows,
    comparison:
      baseline && !signal?.aborted && rows.length === plan.plannedCalls
        ? {
            baselineProfileId: baseline.profileId,
            heuristicPassedDelta:
              summary.heuristicPassed - baseline.summary.heuristicPassed,
            meanDurationMsDelta:
              summary.meanDurationMs - baseline.summary.meanDurationMs,
          }
        : null,
    limitations: [
      "Hand-authored synthetic answer cases; supplied context, not retrieval/ACL/Worker/Docker verification",
      "Phrase/source checks are heuristics, not semantic correctness; human review required",
      "Endpoint calls do not independently establish that the remote service performed model inference",
      "No general benchmark accuracy, production effectiveness or monetary cost claim",
    ],
  };
}
