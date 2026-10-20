import { secret, modelAuthentication } from "./config.js";
import { digest, transaction, assertRuntimeReady } from "./db.js";
import { HttpError } from "./errors.js";
import {
  validReferences,
  EXACT_VECTOR_DOCUMENT_LIMIT,
  EXACT_VECTOR_VALUE_LIMIT,
  EXACT_VECTOR_BYTE_LIMIT,
} from "./memory.js";
import { limitedText } from "./inputs.js";
import { randomUUID } from "node:crypto";

export async function pruneStaleEmbeddings(
  db,
  { apply = false, batch = 100 } = {},
) {
  const stale = (
    await db.query(
      `SELECT e.source_key FROM cr_memory_embeddings e
     WHERE NOT EXISTS(SELECT 1 FROM cr_recall_documents d WHERE d.key=e.source_key AND d.revision=e.source_revision)
     ORDER BY e.source_key LIMIT $1`,
      [batch],
    )
  ).rows;
  const removed =
    apply && stale.length
      ? (
          await db.query(
            `DELETE FROM cr_memory_embeddings e WHERE e.source_key=ANY($1::text[])
     AND NOT EXISTS(SELECT 1 FROM cr_recall_documents d WHERE d.key=e.source_key AND d.revision=e.source_revision)`,
            [stale.map((r) => r.source_key)],
          )
        ).rowCount
      : 0;
  return { candidates: stale.length, removed, hasMore: stale.length === batch };
}

export async function retryFailedEmbeddings(
  db,
  config,
  { apply = false } = {},
) {
  const profile = embeddingProfile(config);
  if (!profile) throw Error("EMBEDDING_NOT_CONFIGURED");
  const rows = (
    await db.query(
      "SELECT source_key FROM cr_memory_embeddings WHERE profile_id=$1 AND status IN ('failed','indexing') AND lease_until<clock_timestamp() ORDER BY updated_at,source_key LIMIT 100",
      [profile.id],
    )
  ).rows;
  const requeued =
    apply && rows.length
      ? (
          await db.query(
            `UPDATE cr_memory_embeddings SET status='failed',vectors=NULL,attempts=0,lease_until=clock_timestamp()-interval '1 second',lease_token=NULL,error_code=NULL
     WHERE source_key=ANY($1::text[]) AND profile_id=$2 AND status IN ('failed','indexing') AND lease_until<clock_timestamp()`,
            [rows.map((r) => r.source_key), profile.id],
          )
        ).rowCount
      : 0;
  return {
    mode: apply ? "apply" : "dry-run",
    candidates: rows.length,
    requeued,
    hasMore: rows.length === 100,
    batch: 100,
  };
}

export function embeddingProfile(config) {
  if (!config.embeddingUrl) return null;
  const url = new URL(config.embeddingUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !config.embeddingModel
  )
    throw new Error("Invalid embedding endpoint/model");
  const authentication = modelAuthentication({
    provider: "openai-compatible",
    modelAuthHeader: config.embeddingAuthHeader,
    modelAuthScheme: config.embeddingAuthScheme,
  });
  const profile = {
    endpoint: url.href,
    model: config.embeddingModel,
    authentication,
    revision: 1,
  };
  return { ...profile, id: digest(profile) };
}
export function documentChunks(text, size = 2400) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size - 200)
    chunks.push(text.slice(i, i + size));
  if (chunks.length > 16)
    throw new HttpError(
      413,
      "EMBEDDING_INPUT_LIMIT",
      "의미 검색 입력이 너무 커요.",
    );
  return chunks;
}
export async function embedTexts(
  texts,
  config,
  { signal, fetchImpl = fetch, dispatch = (send) => send(), apiKey } = {},
) {
  const profile = embeddingProfile(config);
  if (!profile) return null;
  const key = apiKey ?? (await secret("EMBEDDING_API_KEY"));
  const headers = { "content-type": "application/json" };
  if (key)
    headers[profile.authentication.header] =
      profile.authentication.prefix + key;
  const response = await dispatch(() =>
    fetchImpl(profile.endpoint, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.any([
        signal || new AbortController().signal,
        AbortSignal.timeout(15000),
      ]),
      body: JSON.stringify({
        model: profile.model,
        input: texts,
        encoding_format: "float",
      }),
    }),
  );
  if (!response.ok)
    throw new HttpError(
      503,
      "EMBEDDING_REJECTED",
      "의미 검색 연결에 실패했어요.",
    );
  const data = JSON.parse(await limitedText(response, 2000000));
  const rows = data.data;
  if (!Array.isArray(rows) || rows.length !== texts.length)
    throw new HttpError(
      503,
      "EMBEDDING_RESPONSE",
      "의미 검색 응답 형식을 확인해주세요.",
    );
  const sorted = [...rows].sort((a, b) => a.index - b.index),
    dimension = sorted[0]?.embedding?.length;
  if (
    !dimension ||
    dimension > 4096 ||
    sorted.some(
      (r, i) =>
        r.index !== i ||
        !Array.isArray(r.embedding) ||
        r.embedding.length !== dimension ||
        !r.embedding.every(
          (n) =>
            typeof n === "number" &&
            Number.isFinite(n) &&
            Math.abs(n) <= 1000000,
        ) ||
        !r.embedding.some((n) => n !== 0),
    )
  )
    throw new HttpError(
      503,
      "EMBEDDING_RESPONSE",
      "의미 검색 벡터 형식을 확인해주세요.",
    );
  return sorted.map((r) => r.embedding);
}
export async function indexNextMemoryDocument(pool, config, options = {}) {
  await assertRuntimeReady(pool);
  await pruneStaleEmbeddings(pool, { apply: true });
  const profile = embeddingProfile(config);
  if (!profile) return false;
  const capacity = (
    await pool.query(
      `SELECT count(*)::int AS documents,coalesce(sum(vector_values),0)::text AS values,coalesce(sum(vector_bytes),0)::text AS bytes FROM (SELECT vector_values,vector_bytes FROM cr_memory_embeddings WHERE status='ready' AND profile_id=$1 LIMIT $2)c`,
      [profile.id, EXACT_VECTOR_DOCUMENT_LIMIT + 1],
    )
  ).rows[0];
  if (
    capacity.documents > EXACT_VECTOR_DOCUMENT_LIMIT ||
    Number(capacity.values) > EXACT_VECTOR_VALUE_LIMIT ||
    Number(capacity.bytes) > EXACT_VECTOR_BYTE_LIMIT
  )
    return false;
  const doc = await transaction(pool, async (db) => {
    await assertRuntimeReady(db);
    const acquired = (
      await db.query(
        "SELECT pg_try_advisory_xact_lock(hashtext(current_schema()),hashtext('crewroom-memory-index')) AS acquired",
      )
    ).rows[0].acquired;
    if (!acquired) return null;
    const row = (
      await db.query(
        `SELECT d.* FROM cr_recall_documents d LEFT JOIN cr_memory_embeddings e ON e.source_key=d.key
      WHERE d.kind<>'workspace' AND (e.source_key IS NULL OR e.source_revision<>d.revision OR e.profile_id<>$1
       OR (e.status<>'ready' AND e.attempts<3 AND e.lease_until<clock_timestamp()))
      ORDER BY d.created_at,d.key LIMIT 1`,
        [profile.id],
      )
    ).rows[0];
    if (!row) return null;
    const token = randomUUID();
    await db.query(
      `INSERT INTO cr_memory_embeddings(source_key,source_revision,profile_id,status,lease_until,lease_token) VALUES($1,$2,$3,'indexing',clock_timestamp()+interval '1 minute',$4)
      ON CONFLICT(source_key) DO UPDATE SET source_revision=$2,profile_id=$3,status='indexing',vectors=NULL,
      attempts=CASE WHEN cr_memory_embeddings.source_revision=$2 AND cr_memory_embeddings.profile_id=$3 THEN cr_memory_embeddings.attempts+1 ELSE 1 END,
      error_code=NULL,lease_until=clock_timestamp()+interval '1 minute',lease_token=$4,updated_at=now()`,
      [row.key, row.revision, profile.id, token],
    );
    return { ...row, leaseToken: token };
  });
  if (!doc) return false;
  try {
    const owner = (
      await pool.query("SELECT * FROM cr_members WHERE id=$1", [doc.owner_id])
    ).rows[0];
    if (!(await validReferences(pool, owner, doc, doc.dependencies || [])))
      throw new HttpError(
        409,
        "EMBEDDING_SOURCE_REVOKED",
        "기억 원본이 변경됐어요.",
      );
    const chunks = documentChunks(doc.title + "\n" + doc.body),
      vectors = await embedTexts(chunks, config, options);
    await pool.query(
      `UPDATE cr_memory_embeddings SET status='ready',vectors=$4,error_code=NULL,updated_at=now()
      WHERE source_key=$1 AND source_revision=$2 AND profile_id=$3 AND lease_token=$5 AND status='indexing' AND lease_until>clock_timestamp()
      AND EXISTS(SELECT 1 FROM cr_recall_documents d WHERE d.key=$1 AND d.revision=$2)`,
      [
        doc.key,
        doc.revision,
        profile.id,
        JSON.stringify(
          vectors.map((vector, i) => ({ text: chunks[i], vector })),
        ),
        doc.leaseToken,
      ],
    );
  } catch (error) {
    await pool.query(
      "UPDATE cr_memory_embeddings SET status='failed',error_code=$4,lease_until=clock_timestamp()+interval '1 minute',updated_at=now() WHERE source_key=$1 AND source_revision=$2 AND profile_id=$3 AND lease_token=$5 AND status='indexing' AND lease_until>clock_timestamp()",
      [
        doc.key,
        doc.revision,
        profile.id,
        error.code?.startsWith("EMBEDDING_")
          ? error.code
          : "EMBEDDING_UNAVAILABLE",
        doc.leaseToken,
      ],
    );
  }
  await pruneStaleEmbeddings(pool, { apply: true });
  return true;
}
