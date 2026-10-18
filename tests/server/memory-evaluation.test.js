import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMemory } from "../support/memory-evaluation.js";
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
  assert.equal(result.realEmbeddingCalls, 0);
});
