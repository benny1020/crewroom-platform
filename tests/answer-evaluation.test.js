import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { configuration } from "../server/config.js";
import {
  evaluationPlan,
  evaluateAnswers,
  scoreAnswer,
} from "../scripts/answer-evaluation.mjs";
const corpus = JSON.parse(
  await readFile(
    new URL("../evaluation/answer-cases.ko.json", import.meta.url),
  ),
);
const config = () => ({
  ...configuration({
    MODEL_NAME: "protocol-only",
    MODEL_ENDPOINT_URL: "http://127.0.0.1:1/v1/chat/completions",
  }),
});
const good = {
  summary: "요청 제한시간은 30초입니다.",
  evidence: ["policy:timeout"],
  unknowns: [],
  nextActions: [],
};

test("answer plan is bounded and dry CLI makes no inference claims", () => {
  const plan = evaluationPlan(corpus);
  assert.equal(plan.plannedCalls, 20);
  assert.throws(() => evaluationPlan(corpus, { ids: ["missing"] }));
  assert.throws(() => evaluationPlan(corpus, { repeat: 4 }));
  const cli = spawnSync(process.execPath, ["scripts/evaluate-answers.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MODEL_NAME: "",
      MODEL_ENDPOINT_URL: "",
      MODEL_BASE_URL: "",
    },
  });
  assert.equal(cli.status, 0);
  assert.equal(JSON.parse(cli.stdout).networkCalls, 0);
  assert.equal(JSON.parse(cli.stdout).mode, "plan-only");
});
test("budgets, fixture configuration and mismatched baseline fail before dispatch", async () => {
  let calls = 0;
  const run = (extra) =>
    evaluateAnswers({
      corpus,
      config: config(),
      maxCalls: 20,
      call: async () => {
        calls++;
      },
      ...extra,
    });
  await assert.rejects(run({ maxCalls: undefined }));
  await assert.rejects(run({ maxCalls: 19 }));
  await assert.rejects(run({ config: { ...config(), allowFixture: true } }));
  await assert.rejects(run({ baseline: { corpusHash: "wrong" } }));
  assert.equal(calls, 0);
});
test("heuristics require sources/unknowns and reject obsolete facts without claiming semantic correctness", () => {
  const c = corpus.cases[0];
  assert.equal(scoreAnswer(c, good).heuristicPassed, true);
  assert.equal(
    scoreAnswer(c, { ...good, evidence: [] }).heuristicPassed,
    false,
  );
  assert.equal(
    scoreAnswer(corpus.cases[12], { ...good, unknowns: [] }).heuristicPassed,
    false,
  );
  assert.equal(
    scoreAnswer(corpus.cases[16], {
      ...good,
      summary: "60분, 이전 35분",
      evidence: ["policy:session-current"],
    }).forbiddenMatches,
    1,
  );
});
test("partial failures are retained once, missing usage is null, and incomplete comparisons are refused", async () => {
  let calls = 0;
  const report = await evaluateAnswers({
    corpus,
    config: config(),
    ids: ["timeout-1", "timeout-2"],
    maxCalls: 2,
    mode: "protocol-fixture",
    call: async () => {
      if (++calls === 2)
        throw Object.assign(
          new Error("Do not store a provider secret or URL here"),
          { code: "INVALID_MODEL_RESULT" },
        );
      return { result: good, receipt: { usage: null } };
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.summary.failedCalls, 1);
  assert.equal(report.rows.length, 2);
  assert.equal(report.summary.inputTokens, null);
  assert.equal(report.rows[0].humanReview.accepted, null);
  assert.ok(!JSON.stringify(report).includes("provider secret"));
  await assert.rejects(
    evaluateAnswers({
      corpus,
      config: config(),
      maxCalls: 20,
      baseline: report,
    }),
  );
});
test("configured endpoint uses production Claude/OpenAI adapters and rejects partial provider usage", async (t) => {
  const requests = [],
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      requests.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/messages"
            ? {
                content: [{ type: "text", text: JSON.stringify(good) }],
                stop_reason: "end_turn",
                usage: { input_tokens: 12, output_tokens: 7 },
              }
            : {
                choices: [{ message: { content: JSON.stringify(good) } }],
                usage: { prompt_tokens: 12 },
              },
        ),
      );
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const provider of ["openai-compatible", "anthropic"]) {
    const r = await evaluateAnswers({
      corpus,
      ids: ["timeout-1"],
      maxCalls: 1,
      mode: "protocol-fixture",
      config: {
        ...config(),
        provider,
        modelEndpoint:
          origin +
          (provider === "anthropic" ? "/messages" : "/chat/completions"),
      },
    });
    assert.equal(r.summary.completedCalls, 1);
    assert.equal(r.summary.heuristicPassed, 1);
    assert.equal(r.summary.inputTokens, provider === "anthropic" ? 12 : null);
  }
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests).includes("policy:timeout"));
});

test("a cancelled last request is never a complete comparison baseline or current comparison", async () => {
  const run = (extra) =>
    evaluateAnswers({
      corpus,
      config: config(),
      ids: ["timeout-1"],
      maxCalls: 1,
      call: async () => ({ result: good, receipt: { usage: null } }),
      ...extra,
    });
  const complete = await run({});
  assert.ok((await run({ baseline: complete })).comparison);
  const controller = new AbortController();
  const aborted = await run({
    baseline: complete,
    signal: controller.signal,
    call: async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.rows.length, 1);
  assert.equal(aborted.comparison, null);
  let dispatched = false;
  await assert.rejects(
    run({
      baseline: aborted,
      call: async () => {
        dispatched = true;
      },
    }),
  );
  assert.equal(dispatched, false);
});
