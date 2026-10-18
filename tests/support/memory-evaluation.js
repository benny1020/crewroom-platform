import { readFile } from "node:fs/promises";
import { harness, newTask, values } from "../server/helpers.js";
import { insertArtifact } from "../../server/tasks.js";
import { searchMemory } from "../../server/memory.js";
import {
  indexNextMemoryDocument,
  embedTexts,
  embeddingProfile,
} from "../../server/memory-embedding.js";
export async function evaluateMemory(
  t,
  { search = searchMemory, legacyView = false, embeddingConfig = null } = {},
) {
  const data = JSON.parse(
      await readFile(
        new URL("../fixtures/memory-retrieval.ko.json", import.meta.url),
      ),
    ),
    h = await harness(t),
    lead = await h.client("lead@example.com"),
    member = await h.client("member@example.com", true),
    keys = new Map();
  for (const note of data.notes) {
    const { id, ...v } = note;
    const r = await lead.request("POST", "/api/memories", {
      agentId: "review",
      visibility: "team",
      audience: "project",
      project: "검증 프로젝트",
      source: "합성 평가 자료",
      ...v,
    });
    if (r.statusCode !== 201) throw new Error(r.body);
    keys.set(id, "memory:" + r.json().id);
  }
  for (const a of data.answers) {
    const task = await newTask(
      lead,
      values({
        workType: "chat",
        agentId: a.agentId,
        project: "검증 프로젝트",
        goal: "검색 평가용 합성 업무",
      }),
    );
    for (let i = 0; i < a.versions.length; i++) {
      const artifact = await insertArtifact(h.pool, task, 0, {
        origin: "external",
        result: { unknowns: [], nextActions: [], ...a.versions[i] },
      });
      await h.pool.query("UPDATE cr_artifacts SET created_at=$2 WHERE id=$1", [
        artifact.id,
        `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      ]);
      for (const section of ["summary", "evidence"]) {
        const n = section === "summary" ? 1 : a.versions[i].evidence.length;
        for (let j = 1; j <= n; j++)
          keys.set(
            `${a.id}:${i + 1}:${section}:${j}`,
            `artifact:${artifact.id}:${section}:${j}`,
          );
      }
    }
  }
  if (legacyView) {
    const sql = await readFile(
      new URL(
        "../../server/migrations/005_long_term_memory.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await h.pool.query("DROP VIEW cr_recall_documents");
    await h.pool.query(
      sql.slice(sql.indexOf("CREATE VIEW cr_recall_documents")),
    );
  }
  let embeddingCalls = 0;
  const fetchImpl = async (...args) => {
    embeddingCalls++;
    return fetch(...args);
  };
  if (embeddingConfig) {
    for (let i = 0; i < 100; i++)
      if (
        !(await indexNextMemoryDocument(h.pool, embeddingConfig, { fetchImpl }))
      )
        break;
    const failed = Number(
      (
        await h.pool.query(
          "SELECT count(*) FROM cr_memory_embeddings WHERE status<>'ready'",
        )
      ).rows[0].count,
    );
    if (failed)
      throw new Error("Embedding index incomplete; quality evaluation refused");
  }
  const rows = [];
  for (const q of data.queries) {
    const semantic = embeddingConfig
      ? {
          vector: (await embedTexts([q.q], embeddingConfig, { fetchImpl }))[0],
          profileId: embeddingProfile(embeddingConfig).id,
        }
      : {};
    const docs = await search(
      h.pool,
      { ...member.user, active: true },
      { visibility: "team", department: member.user.department },
      {
        query: q.q,
        agentId: q.agentId || "qa",
        project: q.project || "검증 프로젝트",
        asOf: q.asOf || "2026-10-18T00:00:00Z",
        limit: 5,
        ...semantic,
      },
    );
    const expected = q.expected.map((k) => keys.get(k));
    const hit = expected.filter((k) => docs.some((d) => d.key === k)).length;
    const found = docs.map((d) => d.key);
    rows.push({
      id: q.id,
      category: q.category,
      expected: expected.length,
      hits: hit,
      recallAt5: expected.length ? hit / expected.length : null,
      allEvidence: expected.length
        ? hit === expected.length
        : docs.length === 0,
      forbiddenMatches: (q.forbidden || []).filter((v) =>
        docs.some((d) => d.body.includes(v)),
      ).length,
      returned: docs.length,
    });
  }
  const positive = rows.filter((r) => r.expected),
    semantic = rows.filter((r) => r.category === "semantic-paraphrase");
  return {
    corpus: "hand-authored Korean synthetic retrieval regression",
    queries: rows.length,
    positiveQueries: positive.length,
    meanRecallAt5:
      positive.reduce((a, r) => a + r.recallAt5, 0) / positive.length,
    allEvidenceQueries: rows.filter((r) => r.allEvidence).length,
    forbiddenMatches: rows.reduce((a, r) => a + r.forbiddenMatches, 0),
    semanticParaphraseHits: semantic.reduce((a, r) => a + r.hits, 0),
    realEmbeddingCalls: embeddingCalls,
    realAnswerModelCalls: 0,
    rows,
  };
}
