# Independent Astra memory research and code review

Date: 2026-10-18 (Asia/Seoul). Reviewed Crewroom 0.8.0 memory implementation, public origin https://github.com/benny1020/crewroom-platform.git. This report describes that baseline, before remediation. No tracked files changed by this reviewer. Three isolated PostgreSQL schema reproductions were executed and cleaned up; no public service was operated. Public upstream source was downloaded only for inspection, never installed or incorporated.

## Decision

The architecture fits a single team sharing role agents: PostgreSQL as authority, retained source passages and structured answer history, scoped retrieval, separate candidate review, and separately published skills are a sensible operational baseline. Replacing it wholesale with a graph or memory SaaS is not justified by the evidence. Three promotion correctness gaps should be fixed first. Real semantic usefulness and workload capacity remain unproven.

## Reproduced findings

### P1 — accepted memory stops following its evidence after promotion

Locations: `server/memory-learning.js:178-211`, `server/migrations/006_memory_learning.sql:29-33`, `server/memory.js:224-242`.

Acceptance checks source revision, quote and dependencies, but stores only `source_key` on the resulting memory. All core memories receive an empty dependency list from the recall view. The source revision remains in the candidate audit row but is not enforced by retrieval or the new memory's run references.

Reproduction: create a project core fact saying retention lasts thirty five days; propose and accept it; correct the original to sixty days. The accepted copy remains searchable as a current fact and has `dependencies: []`. This is an actual observed result, not an inferred model failure. The same missing link creates a revocation concern for source deletion or ACL changes, although those variants were not executed in this review.

Fix: keep immutable root source reference and transitive source references on promoted memories, incorporate them in fingerprints and existing run/retrieval validation. Changed, missing, or inaccessible evidence should suppress the derived fact until explicit re-review. Do not rewrite its text automatically. A deliberate human correction needs explicit detach/replacement semantics so a corrected fact is not permanently chained to invalid evidence. Preserve provenance audit history when detaching.

### P1 — expired facts can be promoted as timeless current facts

Locations: `server/memory-learning.js:16-36,178-211`, `server/memory-protocol.js:2-13`.

Neither proposal nor acceptance checks source effective interval. The promoted memory receives no `validFrom` or `validTo`. Direct historical reads are intentionally supported, but this path erases their temporal meaning.

Reproduction: create a core decision effective in 2020 and expired in 2021. A 2026 run can propose it by source key and quote; a reviewer accepts it; the new memory has both interval fields null. The stale source has become an unlimited current decision.

Minimal safe contract: allow current-effective core sources only for this simple promotion UI; recheck at proposal and acceptance; inherit their bounds into the promoted memory and display them at review. A source that expires while pending must not become current. Historical/future promotion can be added later with explicit preserved intervals and clear UI, rather than guessed dates. This restriction is for promotion, not historical retrieval. For raw messages lacking structured validity, quotation does not prove a claim remains current; retain human interpretation review and do not infer effective dates from prose without review.

### P2 — proposal bypasses role-audience eligibility used by reads

Locations: `server/memory-learning.js:17-24`; compare `server/worker.js:426-436` and `server/memory.js:139`.

A proposal calls `documentsByKeys` and `sourceAllowed`, checking user/scope visibility but not the current agent's eligibility for agent-only memories. Ordinary run reads do apply agent/audience filtering.

Reproduction: make a team-visible, QA-agent-only fact; run review agent. `read_memory` on its known key returns zero items, but `propose_memory` with that key and exact quote creates a pending project proposal. This requires a known key and correct quote and still requires human acceptance; it is not demonstrated private-data exfiltration. It is a concrete inconsistency with the agent-only retrieval contract.

Fix: share one source eligibility helper between run reads and proposals, including agent ownership and agent/project audience. Preserve explicit cross-project recall as documented; projects are retrieval boundaries, not an independent ACL.

### P2 — generic cosine threshold is unvalidated for arbitrary providers

Location: `server/memory.js:195`.

A fixed cosine cutoff of 0.35 is applied to all OpenAI-compatible embedding endpoints. Cosine score distributions are model-dependent. No configured real model supports this cutoff, so it can silently discard relevant candidates even if their relative rank is strong. This is a research/configuration gap, not a demonstrated production regression. Before claiming semantic quality, make the threshold part of the embedding profile or compare a bounded top-k approach against calibrated thresholds on held-out queries. RRF does not make a preceding arbitrary cutoff model-independent.

## Reproduction receipts

`.local/astra-review-08/repro.mjs` contains three regression demonstrations asserting the baseline bugs. Executed:

```sh
TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test .local/astra-review-08/repro.mjs
```

Observed: 3 tests, 3 passed (bug assertions), zero failures. Harness creates uniquely named schemas, uses fixture configuration, and drops schemas on completion. These demonstrations should be converted to desired-behavior tests when implementing fixes. They do not call external models.

## Promotion provenance and scope contract

Keep proposal context and source origin distinct. Candidate `task_id` is the run's workroom and governs who reviews and where the event belongs. `source_key` identifies actual evidence, which can originate in a different task/project after explicit cross-project retrieval. Currently acceptance sets `sourceTaskId: c.task_id`; the resulting field is proposal context, not necessarily source origin. Add a separate origin field or clearly name/document both; do not blindly change destination project/visibility to the source task's fields. Never widen visibility beyond source and destination permissions.

Persist source revision and transitive references at promotion, rather than resolving the latest source later. Revalidate all references before use, including further derived answers and cached embeddings. A core-memory expiration may occur with no revision change, so revision checks alone are insufficient: inherited intervals or effective-time checks remain necessary. Supersession must preserve historical records while excluding them from current facts. Human correction and new effective decisions remain different actions.

Memory is supporting material, not execution authority. The current prompt and episode disclaimer explicitly separate memory from current checks/acceptance; preserve this. A learned procedure must not carry a prior passing test, approval, target SHA or access grant into a new execution. Accepted-work skill drafts are appropriate, but acceptance is not evidence of universal procedure quality.

## Fresh first-party product review

All sources below were opened afresh on 2026-10-18.

- [Grok Team Bots](https://docs.x.ai/grok-bot/team-bots), page marked updated 2026-10-15: shared bot setup and team memory coexist with personal notes and private individual conversations. Account-based plugins use the caller's identity; key/token plugins can use the bot's common credential. Therefore “Grok always executes under separate personal OAuth” would overstate the contract. Crewroom's shared workrooms are a defensible different product contract, provided the UI makes sharing clear. The page does not disclose memory ranking or extraction internals.
- [Muse product design](https://introducing.muse.ai/), September 2026: describes persistent conversation context, side chats, directly editable memory files and visible activity. This supports inspectability, not a specific memory retrieval algorithm.
- [Meta Muse safety architecture](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse): states durable application state lives in separate Postgres, and Sentinel controls connector actions/egress outside the runtime cell. These are published architecture claims, not an audited proprietary implementation. Crewroom should not claim Sentinel, eBPF taint tracking or per-user VMs merely because it separates DB/Worker/Runner.

## Paper review and limits

- [LongMemEval v2](https://arxiv.org/html/2410.10813v2): its 500-question design covers extraction, multi-session reasoning, temporal reasoning, updates and abstention. Assistant-origin evidence and full source retention are justified. Crucially, retrieval and answer reading are distinct: even oracle retrieval does not guarantee correct answers. Crewroom's source-key Recall@5 is not this benchmark's end-to-end accuracy.
- [EverMemBench v3](https://arxiv.org/html/2602.01313v3): collaborative multi-party, multi-group temporal attribution is directly relevant. Its generated long-horizon corpus and model-based evaluation are useful diagnostic evidence, not proof of real-team behavior or ACL security. Import task families (conflicting owners, changing policies, cross-group references), not vendor scores.
- [Zep v1](https://arxiv.org/html/2501.13956v1): valid time and record/knowledge time are useful separate concepts. Current valid intervals plus run cutoff form a limited practical contract, not complete bitemporal history. Do not infer that a graph DB is required to preserve these distinctions.
- [Hindsight v1](https://arxiv.org/html/2512.12818v1): separates retained evidence, experience and synthesized interpretation, with several recall signals. Crewroom adopts only a small subset; two-way RRF is not reproduction of its full method or reported quality.
- [Mem0 v1 abstract](https://arxiv.org/abs/2504.19413): extraction/consolidation and optional graph memory are evaluated by the system authors on LOCOMO. Reported latency, cost and judge improvements are configuration-specific, not independent evidence that Crewroom should adopt Mem0.
- [Redis June 2026 study](https://redis.github.io/redis-ai-research-public/longmemeval-agent-memory/): raw excerpts plus extracted facts outperform its extraction-only condition. The publisher itself labels third-party charts as broad context mixing measured and published values rather than controlled head-to-head rankings. Supports retaining raw source access; does not transfer its score to Crewroom.
- [AMemGym abstract](https://arxiv.org/abs/2603.01966): interactive/on-policy evaluation is a relevant future step beyond frozen retrieval queries. Local scripted tool loops establish protocol correctness, not autonomous long-term learning quality.
- [AgeMem current abstract v3](https://arxiv.org/abs/2601.01885): progressive reinforcement learning jointly trains short/long-term memory operations. This is a model-training approach, not merely a memory database replacement. Existing decision cites v1; current abstract is v3 (2026-07-23), so versions should be distinguished if updating the report.
- [Beyond Memory Leaderboards v1](https://arxiv.org/html/2607.16848v1): scientific-document QA shows how retrieved character budget and dense/lexical modality change rankings. Useful methodology, with a domain mismatch to shared workrooms. Equal number of returned results alone does not equalize retrieved characters, latency or answer model budget.

## Independently fetched pinned core source

Downloads and SHA-256 receipts: `.local/astra-review-08/research/manifest.json`. All four fresh downloads matched the earlier manifest's digest, but conclusions below came from inspecting code, not trusting that manifest.

| Upstream and exact SHA | Inspected path | Observation and practical fit |
|---|---|---|
| Graphiti `417c3a125ae3ac53c19b8e53fffaccf3e665a88e` | `graphiti_core/edges.py:263-289` | Distinct `expired_at`, `valid_at`, `invalid_at`, `reference_time`; comments distinguish soft deadlines from invalidation. Avoid converting every future date into a fact's effective start. |
| Hindsight `5331da2f4db369528bb122075341a7de9c3df6df` | `hindsight-api-slim/hindsight_api/engine/search/fusion.py:29-108` | RRF k=60 with source-rank/raw-score bookkeeping and four named arms. Crewroom's rank fusion principle is consistent; its two paths and absent learned reranker are materially simpler. |
| Letta Code `7be3c81f9cfce481994fe4484d59a5bf17cdb48a` | `src/agent/subagents/memory-worker.ts:68-96,179-205` | Lease and private worktree isolate background memory updates; cancel drops edits, conflict is surfaced. The transferable requirement is atomic, reviewable lifecycle, not adopting Git for relational memory. |
| EverOS/EverMemOS `736b82103557cc7d5886ae86c4fd0161e69983cd` | `src/everos/memory/strategies/extract_agent_skill.py:40-63` | Explicitly documents missing retirement semantics: lowered confidence alone leaves skills available. Crewroom should keep deterministic skill publication/retirement separate from inferred confidence. |

Selected source inspection does not constitute whole-repository auditing. No upstream algorithms were copied into Crewroom.

## Ranked implementation and evaluation plan

1. Fix the three reproduced lifecycle/boundary defects together with focused PostgreSQL tests: correction/deletion/ACL revocation after promotion, transitive sources, expired and future sources, expiration while pending, agent-only mismatch, and explicit corrected-memory detachment. Preserve compatibility fingerprints or explicitly quarantine incompatible pending runs.
2. Keep current storage and retrieval shape. Add an evidence-aware review display with source origin, effective period and historical-answer labeling where absent. Any source-derived memory should remain reviewable after its source becomes unavailable without exposing revoked content.
3. Before enabling semantic quality claims, run one configured multilingual embedding provider and answer model on a held-out, consented or independently authored team corpus. Include paraphrase, negation, contradiction, speaker attribution, expired/future decisions, absent answers, private/department/team boundaries and contaminated historical execution claims. Compare lexical-only, dense-only, RRF and no-memory under equal character/token budgets. Measure source precision/recall, answer faithfulness, abstention, stale-fact usage, unauthorized matches (must be zero), p50/p95 latency and cost separately.
4. Load-test projected document/chunk counts before replacing JSONB exact scan. Exact search is acceptable at small scale but transfers and scans all eligible vectors. Switch to pgvector only when measured memory/latency requires it; verify ACL-filtered recall under the chosen ANN strategy. No measured team-size capacity claim is presently warranted.

Defer graph DBs, automated consolidation/contradiction overwrites, reinforcement-learned memory management, background self-editing skills, and a new memory SaaS. These introduce cost and authority paths before the simpler correctness gaps and real-model baseline are resolved.

Existing 144-check, Docker and restore claims are inherited evidence, not rerun in this review. Inspected `docs/evidence/0.8/memory-evaluation.json` records 20 hand-authored queries, 15 positive queries, mean Recall@5 0.9333, 19 all-evidence queries, zero forbidden matches, zero real embedding/answer calls. Five negative queries contribute to the 19 total; present positive retrieval and forbidden-result tests separately. No universal optimum, real semantic quality, or production-user success is established by these results.
