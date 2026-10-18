import test from "node:test";
import assert from "node:assert/strict";
import {
  queryTerms,
  excerpt,
  cosine,
  contextFromDocuments,
  sourceAllowed,
  reciprocalRankFusion,
} from "../server/memory.js";
import {
  embeddingProfile,
  embedTexts,
  documentChunks,
} from "../server/memory-embedding.js";
import { configuration } from "../server/config.js";
import { runMemoryAgent } from "../server/memory-agent.js";
import { modelMessages } from "../server/provider.js";
const config = configuration({
  MODEL_PROVIDER: "anthropic",
  MODEL_ENDPOINT_URL: "http://127.0.0.1:18888/messages",
  MODEL_NAME: "test-only-model",
  EMBEDDING_ENDPOINT_URL: "http://127.0.0.1:18888/embeddings",
  EMBEDDING_MODEL: "test-only-embedding",
});

test("Korean spacing/inflections have reusable anchors, while SQL wildcard syntax stays data", () => {
  assert.ok(queryTerms("만료기간을 알려줘").includes("만료"));
  assert.ok(queryTerms("만료기간을 알려줘").includes("만료기"));
  assert.ok(!queryTerms("%_' OR 1=1 --").includes("%"));
  assert.equal(
    new Set(queryTerms("세션 세션")).size,
    queryTerms("세션 세션").length,
  );
});
test("an old matching passage, rather than only the start of a long note, enters context", () => {
  const body =
      "앞부분 ".repeat(1200) + "세션 만료는 35분입니다." + " 끝".repeat(1200),
    found = excerpt(body, ["35분"], 700);
  assert.ok(found.includes("35분"));
  assert.ok(found.length < 704);
  const context = contextFromDocuments([
    {
      key: "memory:a",
      revision: "v1",
      title: "정책",
      body,
      excerpt: found,
      dependencies: [],
    },
  ]);
  assert.match(context.items[0].body, /35분/);
});
test("context size is budgeted, with deduplicated source versions", () => {
  const docs = Array.from({ length: 100 }, (_, i) => ({
    key: "message:" + i,
    revision: "1",
    title: "원문",
    body: "본문".repeat(200),
    dependencies: [{ key: "memory:base", revision: "2" }],
  }));
  const context = contextFromDocuments(docs, 2000);
  assert.ok(context.characters <= 2000);
  assert.ok(context.items.length < 100);
  assert.equal(context.refs.filter((r) => r.key === "memory:base").length, 1);
  const payload = JSON.parse(
    modelMessages({
      agent: {},
      skill: {},
      memories: [{ body: "legacy duplicate" }],
      memoryContext: context,
    })[1].content,
  );
  assert.deepEqual(payload.memories, []);
  assert.equal(payload.memoryContext.length, context.items.length);
});
test("a shared workroom cannot inherit private context even when the requester owns it", () => {
  const user = { id: "a", active: true, department: "qa" },
    source = { owner_id: "a", visibility: "private", department: "qa" };
  assert.equal(sourceAllowed(user, { visibility: "team" }, source), false);
  assert.equal(sourceAllowed(user, { visibility: "private" }, source), true);
  assert.equal(
    sourceAllowed(
      user,
      { visibility: "private" },
      { ...source, agent_owner_id: "b" },
    ),
    false,
  );
});
test("cosine similarity rejects incompatible dimensions and zero vectors", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1], [1, 0]), -1);
  assert.equal(cosine([0, 0], [0, 0]), -1);
  assert.equal(cosine([Infinity], [1]), -1);
  assert.equal(cosine([1e300], [1e300]), -1);
});
test("rank fusion combines independent rankings without mixing incompatible raw score scales", () => {
  const a = { key: "a", score: 99999 },
    b = { key: "b", score: 0.3 },
    c = { key: "c", score: 0.9 };
  const fused = reciprocalRankFusion([
    [a, b],
    [c, b],
  ]);
  assert.ok(fused.get("b") > fused.get("a"));
  assert.ok(fused.get("b") > fused.get("c"));
  assert.equal(reciprocalRankFusion([[a, a]]).get("a"), 1 / 61);
});
test("identical passages do not consume the context budget repeatedly", () => {
  const docs = ["a", "b", "c"].map((key) => ({
    key,
    title: key,
    revision: "v1",
    body: "같은 원문입니다.",
    dependencies: [],
  }));
  assert.equal(contextFromDocuments(docs).items.length, 1);
});
test("embedding calls use a separate explicit endpoint/auth and reorder indexed results", async () => {
  let request;
  const result = await embedTexts(["첫째", "둘째"], config, {
    apiKey: "synthetic-embedding-key",
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
      );
    },
  });
  assert.deepEqual(result, [
    [1, 0],
    [0, 1],
  ]);
  assert.equal(request.url, config.embeddingUrl);
  assert.equal(request.headers.authorization, "Bearer synthetic-embedding-key");
  assert.deepEqual(JSON.parse(request.body).input, ["첫째", "둘째"]);
  assert.equal(request.redirect, "error");
  assert.equal(embeddingProfile({ ...config, embeddingUrl: "" }), null);
  assert.notEqual(
    embeddingProfile(config).id,
    embeddingProfile({ ...config, embeddingModel: "changed" }).id,
  );
});
test("invalid embedding results never become usable vectors", async () => {
  for (const data of [
    { data: [] },
    { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 1, embedding: [1, 0] }] },
  ])
    await assert.rejects(
      embedTexts(["x"], config, {
        apiKey: "",
        fetchImpl: async () => new Response(JSON.stringify(data)),
      }),
      (e) => e.code === "EMBEDDING_RESPONSE",
    );
  const parts = documentChunks("가".repeat(10000));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 2400));
  assert.throws(
    () => documentChunks("x".repeat(50000)),
    (e) => e.code === "EMBEDDING_INPUT_LIMIT",
  );
});
test("analysis can look up an older source and then produce a normal structured answer", async () => {
  const snapshot = {
    agent: { name: "리뷰", instructions: "검토" },
    skill: { instructions: "출처 확인", done: "근거" },
    goal: "지난 결정",
    memories: [],
    providerProfile: (await import("../server/config.js")).modelProfile(config),
  };
  const bodies = [],
    lookups = [];
  let n = 0;
  const result = await runMemoryAgent(snapshot, config, {
    memoryTools: async (a) => {
      lookups.push(a);
      return { items: [{ body: "지난달 합의는 35분입니다." }] };
    },
    fetchImpl: async (_, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify(
                n++
                  ? {
                      summary: "35분입니다.",
                      evidence: ["지난달 결정"],
                      unknowns: [],
                      nextActions: [],
                    }
                  : { action: "search_memory", query: "지난달 만료 합의" },
              ),
            },
          ],
          stop_reason: "end_turn",
        }),
      );
    },
  });
  assert.equal(lookups.length, 1);
  assert.match(JSON.stringify(bodies[1]), /35분/);
  assert.equal(result.result.summary, "35분입니다.");
  assert.equal(result.receipt.memoryLookups, 1);
});
