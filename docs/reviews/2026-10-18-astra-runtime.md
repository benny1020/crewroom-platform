# Crewroom 0.8 runtime correctness review

Reviewed baseline: Crewroom 0.8.0 memory and runtime implementation. Independent implementation inspection and isolated PostgreSQL reproductions. No production database, live deployment, real model endpoint, or real embedding provider was used. Fixture protocol success does not establish inference quality.

## P1 — Cross-task context locks deadlock two normal concurrent Runs

Locations: `server/worker.js:79-94`, `server/worker.js:394-399`, `server/memory.js:54-64`.

`lockedRun` obtains an exclusive lock on the executing task before `contextAllowed` acquires shared locks on referenced source tasks. Two distinct agents in two workrooms in one project can both recall messages from both workrooms. Each transaction holds its own task exclusively and then waits for the other task. Sorting the later source lock IDs cannot repair the already-held inverted task locks. Native recall, dispatch authorization, heartbeat, and completion all use this pattern; PostgreSQL aborts one transaction and an otherwise valid Run can fail or be aborted by its heartbeat.

Reproduction: `.local/astra-review-08/repro.test.mjs`, test `concurrent native recalls deadlock when task snapshots cross-reference`. Creates ordinary chat tasks with review and QA agents, distinct shared messages, starts and claims both, and calls actual `recallForRun` concurrently. A test-only barrier after both own-task locks forces a legal production interleaving. Results: one fulfilled, one rejected with `40P01: deadlock detected`.

Minimal safe repair: consistent locking before any task lock across worker and mutator transactions, or a narrow transaction-scoped context gate shared by these paths. Do not globally retry transactions containing model dispatch: `send()` executes before COMMIT, so retry could duplicate an external request. Regression must ensure both recalls complete and lock serialization does not span network-response waits.

## P2 — Deleting a successor permanently truncates the predecessor

Locations: `server/resources.js:346-358` and `server/resources.js:412-455`.

Creating B to replace A clips A.valid_to at B.valid_from. Deleting B only soft-deletes B; A retains the clipped end. After that time search returns neither policy. A new successor starting later is rejected by the interval check, so an ordinary deletion can strand the policy timeline without a correction endpoint for its dates.

Reproduction: same file, test `deleting successor leaves predecessor permanently expired`. A starts January 1, B supersedes it February 1. DELETE B returns 200, March 1 search has zero results, and another replacement starting March 1 returns 400 `MEMORY_INTERVAL`.

Minimal safe repair: reject successor deletion with actionable guidance, or implement explicit transactional successor cancellation that restores the predecessor's original end (which must first be persisted; blindly restoring NULL is incorrect when A originally had a finite end). Include deletion and replacement-chain cases.

## Corroborated provenance concern (owned by parallel review)

`server/migrations/006_memory_learning.sql` assigns all core memories `dependencies=[]`, while proposal acceptance stores only source_key and links source_task_id to the consumer task. Accepted copies consequently do not retain source revision/dependency invalidation. This was independently identified by static inspection and handed off early to the coordinating reviewer; no duplicate finding count is intended.

## Validation and limits

Command for both concrete reproductions:

```sh
TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test .local/astra-review-08/repro.test.mjs
```

Both tests passed by asserting the observed buggy behavior. Dedicated test database only; harness-created unique schemas removed on completion.

Existing targeted suite:

```sh
TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test --test-concurrency=1 tests/server/memory.test.js tests/server/memory-learning.test.js tests/server/generation.test.js
```

21 passed, 0 failed. Existing tests cover proposal quote checking, human acceptance, basic validity windows, source corrections, access scopes, provider protocol fixtures, embeddings, and stale-generation protection. They did not cover these deletion/lock interleavings. Dispatch and JSON tool-loop inspection found bounded recall/tool iterations and generation checks; no additional reproducible dispatch finding is claimed.

## Authorized remediation after review

The coordinator subsequently authorized tracked runtime edits. Added `lockContextMutation(db)` to `server/db.js`; acquired before `getTask(..., true)` and worker `lockedRun`, `claimRun`, and `expireRuns`. Gate identity includes current schema, so isolated test databases do not serialize each other. This intentionally serializes the short database critical sections that can acquire cross-task provenance locks. Model/embedding/Runner response waits remain outside the transaction/gate. No dispatch retry was added.

Audited raw-lock paths: API confirm-stopped already uses locked getTask; CLI recovery locks only its one task and associated run and never acquires cross-task source locks or the gate afterward. Member/agent update transactions do not subsequently acquire task locks. Source-less memory mutations need the same gate at transaction entry; coordinator owns those resource/proposal edits.

New `tests/server/memory-concurrency.test.js` regressions both pass: two cross-task recalls synchronize before gate acquisition and complete without deadlock; an unresolved external response does not retain the gate. A broader run across generation, concurrency, review-regressions, and workflow passed 17/18 while coordinator resource/provenance changes were incomplete; the one existing revocation test must be rerun after the new provenance migration lands. Starting-SHA review findings above remain immutable; remediation requires fresh integrated-SHA review.

## Integration inspection while remediation is in progress

After migration 007 landed, the previously failing existing dispatch-revocation regression passed independently. Source-ref creation/promotion acquires the context gate before source/memory/candidate locks, so no additional lock-order edge was found.

New, confirmed integration issue (not a starting-SHA finding): a new memory with both `sourceKey=memory:A` and `supersedesId=A` captures A's revision, then clips A.valid_to, invalidating that same revision before commit. POST returns 201 but neither policy is searchable after the transition. Reproduced in `.local/astra-review-08/integration.test.mjs` against the in-progress tree and reported to coordinator. Reject predecessor-dependent replacements (including transitive references), or design explicit independent correction semantics; silently refreshing the ref is insufficient because inherited effective bounds also conflict.

Additional integration concern reported: clearing source_refs for every non-delete PATCH detaches provenance on metadata-only edits such as pin/kind changes. This was identified from API implementation, not asserted as a baseline issue. Preserve provenance for metadata-only changes or require explicit correction intent.
