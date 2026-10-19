import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMemory,
  memoryQualityGate,
} from "../support/memory-evaluation.js";
test("Korean retrieval corpus covers old assistant evidence, policy validity, role/project sharing and denied sources", async (t) => {
  const result = await evaluateMemory(t);
  assert.equal(result.forbiddenMatches, 0);
  assert.ok(result.meanRecallAt5 >= 0.8, JSON.stringify(result));
  assert.ok(
    result.rows
      .filter((r) => r.category !== "semantic-paraphrase")
      .every((r) => r.allEvidence),
    JSON.stringify(result),
  );
  // Paraphrases are measured separately: this test makes no claim about an unconfigured embedding model.
  assert.equal(result.embeddingEndpointCalls, 0);
  assert.equal(memoryQualityGate(result).passed, true);
});

test("semantic evaluation refuses dimension drift rather than scoring a keyword fallback", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { configuration } = await import("../../server/config.js");
  let calls = 0;
  const endpoint = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    calls++;
    const { input } = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: input.map((text, index) => ({
          index,
          embedding: text.includes("\n") ? [1, 0] : [1, 0, 0],
        })),
      }),
    );
  });
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  t.after(() => new Promise((r) => endpoint.close(r)));
  const embeddingConfig = configuration({
    EMBEDDING_ENDPOINT_URL: `http://127.0.0.1:${endpoint.address().port}/embeddings`,
    EMBEDDING_MODEL: "protocol-fixture",
  });
  await assert.rejects(
    evaluateMemory(t, {
      embeddingConfig,
      embeddingBudget: { maxCalls: 80, calls: 0 },
    }),
    /Semantic retrieval not verified/,
  );
  assert.ok(calls > 1 && calls < 80);
});

test("embedding evaluation requires and obeys an explicit shared endpoint call budget", async (t) => {
  const { configuration } = await import("../../server/config.js");
  const embeddingConfig = configuration({
    EMBEDDING_ENDPOINT_URL: "http://127.0.0.1:1/embeddings",
    EMBEDDING_MODEL: "protocol-fixture",
  });
  let calls = 0;
  const embeddingFetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }),
    );
  };
  await assert.rejects(
    evaluateMemory(t, { embeddingConfig, embeddingFetch }),
    /explicit shared embedding call budget/,
  );
  assert.equal(calls, 0);
  const embeddingBudget = { maxCalls: 1, calls: 0 };
  await assert.rejects(
    evaluateMemory(t, { embeddingConfig, embeddingFetch, embeddingBudget }),
    /EMBEDDING_EVALUATION_BUDGET/,
  );
  assert.equal(calls, 1);
  assert.equal(embeddingBudget.calls, 1);
});
