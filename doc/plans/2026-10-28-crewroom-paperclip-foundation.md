# Crewroom Paperclip foundation — 2026-10-28

## Source, ownership, and rollback

The new product checkout is `crewroom-paperclip` on `codex/crewroom-paperclip`. It is a Git worktree of `team-agent-demo`, based on `9094868cdf0640797f9e1d72560c7143028dd94a`. The original checkout and main branch remain available. No original running service or production database/volume has been changed.

The full tracked Paperclip tree from `cff331f6ca0a652b5e41641c68dfa5fa584c22ae` is the application foundation, not an API wrapper or parallel orchestrator. `origin` remains `https://github.com/benny1020/crewroom-platform.git`; `upstream` identifies `https://github.com/paperclipai/paperclip.git`. Upstream Git metadata was not copied. The root MIT license is unchanged. Original Crewroom assets retain their scoped 0BSD notice. No push or deployment is implied by this checkout.

Astra owns architecture and review; GPT-6.1 Sol owns implementation. The local Astra design is the migration contract. Do not reuse the discarded implementation. `.agents/skills/impeccable` installation is owned by the orchestration chat.

## Existing capability map

| Crewroom need | Upstream owner / contract | Migration constraint |
| --- | --- | --- |
| Single-team home, roster, status | `ui/src`, companies/agents/issues APIs | Read real persisted data; departments are agent metadata, not ACLs |
| Personal assistant | per-user/company primary agent + Agent Chat task | Primary preference is not ownership or permission; enforce private conversations |
| Task delegation and replies | issue comments, normal wake queue, heartbeat | Do not use the BoardChat subprocess experiment |
| Governance and team roles | backend memberships, grants, approvals, audit | No client-only role toggle or invented authorization |
| Skills, memory, files and runs | upstream catalogs, documents, work products, task/run stores | Preserve upstream permission and provenance boundaries |
| Characters and animation | `crewroom/legacy-assets` generated atlases and reference primitives | Port presentation only; state must come from observed tasks/runs |
| Execution adapters | upstream adapters + runner | No separate bespoke execution engine |

## Installation record

`pnpm install --frozen-lockfile` passed in 38.6 seconds (Node 26.4.0, project-selected pnpm 9.15.4, 36 workspaces, 1342 packages). Lock resolution was skipped because the imported lockfile was current. Lifecycle review: root postinstall links the in-repo plugin SDK; runner/server Copilot installers detect an unbuilt source workspace and defer materialization. Dependency lifecycle scripts hydrate embedded PostgreSQL symlinks and install/build native dependencies. No model call was requested.

Warnings: bin links to unbuilt plugin SDK and runner `dist/` entry points were unavailable during installation. Copilot assets report `source-workspace-pending-build`. These are retained as incomplete build steps, not claimed runtime readiness. The first source extraction attempt failed because system Python lacks tarfile's modern `filter` parameter; a validated archive path check and compatible extraction completed the same import. The failed initial `pnpm install` had no package manifest and changed no dependencies.

## Isolated development contract

The upstream AGENTS quickstart mentions PGlite, but current code and `doc/DATABASE.md` use embedded PostgreSQL. Use a fresh data root, dedicated API and PostgreSQL ports, explicit config, disabled working-directory env loading, and unset external `DATABASE_URL`/`DATABASE_MIGRATION_URL`. Do not run default migrations against an existing instance.

`pnpm dev:once --data-dir ./tmp/crewroom-dev` is the supported isolated data-root option. Linked Git worktrees also require their own `.paperclip/.env`; create an empty file only for this fresh instance, never copy a base instance's environment or seed. Set every path in a generated config explicitly, because schema defaults may point at `~/.paperclip/instances/default`. Use loopback binding. Telemetry and announcement fetching should be disabled for isolated verification. The managed service registry must use the same isolated home; never use an unqualified dev-stop command on another instance.

Foundation inspection confirms the configuration mechanism; runtime health, credentials, real inference, container isolation and production deployment remain separate verification claims. Record actual commands and outcomes as they are run.

## Verification update

- Baseline: `pnpm exec vitest run src/__tests__/agent-conversations.test.ts` from `server/` passed 40/40 before the patch. The initial root-cwd invocation found no tests; it was a command/cwd error, not a passing check.
- Privacy: the same focused command passed 41/41 after the patch, on disposable embedded PostgreSQL. A first changed expectation incorrectly assumed every denied mutation uses HTTP 404; existing owner-only mutation routes deliberately use 403, and those assertions were corrected. Private detail reads use canonical 404. New private conversations bind the authenticated responsible user, normal privacy root/personal project, and assignment grants. Historical open conversations return 409 at chat ensure/send/upload, are omitted from personal discovery, and remain ordinary historical public issues until an explicit visibility change. The service's identity lock also rejects an open task when a private creator races. A tested explicit privacy change allows ensure to reopen the same task; historical public content is not retroactively undisclosed. The upstream visibility update sets root/grants and does not itself create a personal project; no automatic migration is claimed.
- Focused Claude probe fixtures: `pnpm exec vitest run src/server/probe-env.test.ts src/server/test.probe.test.ts` from `packages/adapters/claude-local/` passed 27/27. Real endpoint credentials were not configured or tested.
- Isolated startup: `node scripts/crewroom-dev.mjs --prepare` created explicit configuration. The initial managed dev-runner migrated all 393 migrations on only the new embedded PostgreSQL port 55447, then failed building optional Copilot assets. The provider directory had a partial binary/distribution but no closure manifest. It was preserved under ignored `.paperclip/copilot-partial-materialization-20261028/`, and the unmodified official runner installer then returned `installed (darwin-arm64)`. The original interruption cause remains unproven. Server installer reported source-workspace-pending-build until its own build.
- Source API/UI startup: the wrapper runs upstream `pnpm dev:server` with explicit isolated config and Vite middleware. Health returned HTTP 200/status ok/recovery ready, companies returned `[]`, and UI returned HTTP 200 at `http://127.0.0.1:3117`; PostgreSQL is only the checkout-local instance at 55447. Agent JWT is unconfigured and no model execution is claimed. The working tree remains uncommitted, so health's Git commit is the old base SHA and must not be mistaken for a new source receipt.
- Root orchestrator separately owns whole-repository typecheck/test/build results and the final UI design check. These focused results do not replace them.

## Final backend verification update

The final focused server run passed 7 files / 248 tests with one worker in 35.41 seconds (exit 0). It includes `agent-conversations` (43 tests), `crewroom-capabilities` (6 tests), `chat-completion-delivery`, `chat-project-tools`, `issue-comment-reopen-routes`, `issue-feedback-routes` and `heartbeat-run-privacy-routes`. The changed conversation and capability suites exercise disposable embedded PostgreSQL. The related suites combine real DB integration and controlled route/service fixtures; they are not live provider inference or an exhaustive security audit.

Native and direct HTTP handoff from a private conversation into a public project preserved private visibility, privacy root/source edge, responsible user and origin run. A non-owner received 404. Retrying the same handoff left one task, one plan revision and one completion-handoff record. The fixtures create backlog tasks, so this proves persistence/privacy/idempotency rather than automatic provider execution.

The conversation directive now distinguishes ordinary questions and ideas from clear Standard-mode requests for substantial execution. It sends new work through ordinary assigned tasks, carries actual source-comment scope, requires revision/interaction approval evidence only where explicitly requested, and uses existing task comment/reopen behavior for later corrections. Acknowledgments and completion notifications do not authorize re-execution, and human pauses and denials remain binding. Korean intent quality with a real model remains unverified.

The pinned Impeccable installer also passed a fresh temporary installation and a second verification-only invocation. Python deployment tools compile, Compose configuration validation passes without printing expanded secrets, and map structural validation passes. Temporary test runners and their PostgreSQL children exited after the run.

The first resumed production Docker build completed Rust runner and UI stages but was killed in server TypeScript compilation with exit 137 / ResourceExhausted inside an 8 GiB Docker VM at a 3072 MiB Node heap. No cache, persistent volume or unrelated service was removed. A memory-limited final retry is recorded separately when complete; this failed build is not deployment proof.

The single final 2048 MiB Docker retry also ended with server TypeScript exit 137 / ResourceExhausted. No further local build was attempted. The production-image workflow now builds on a native Ubuntu CI host with a 4096 MiB heap while retaining full TypeScript checks, then exercises authenticated local invitation/privacy, file checksums, restart and fresh-project full snapshot restore. Workflow YAML, smoke and embedded CI Python syntax, quiet Compose configuration, and diff whitespace checks pass locally. CI execution and image acceptance remain pending the actual run; writing the workflow is not a passing container result.

Subsequent dependency inspection identified TypeScript 7.0.2 as a native Go compiler: the installed `lib/tsc.js` launcher calls `process.execve` on the platform executable. The two different Node heap settings did not constrain that compiler. The Docker application-build stage now separately sets `GOMAXPROCS=2` and the soft Go runtime GC memory target `GOMEMLIMIT=3GiB` through explicit build arguments. Full checking and declaration emission remain enabled; these are not hard process memory caps and do not affect the production app environment. A targeted new-cause verification and CI result remain separate from the earlier failures.

## Final terminal-feedback contract and verification

Explicit `reopen:false` now saves a comment on Done/Cancelled work without implicit reopening or rebuilding a closed workspace, through both comment POST and comment-bearing PATCH. Explicit reopen/resume/status actions retain their existing gates, and omitted flags retain legacy fallback behavior. The UI preserves false through both request paths; the shared MCP schemas already support the flag. Native generic `call_api` forwards the same JSON body, while current-task agent `report_progress` remains an inert progress comment.

The final server run passed 8 files / 278 tests in 37.21 seconds with one worker (exit 0). Twelve real PostgreSQL/API cases cover Done/Cancelled, POST/PATCH, and false/true/omitted flags: an acknowledgment mentioning the assignee stays terminal with one comment and zero dispatches; authorized revision requests reuse the same task, move it to Todo, and dispatch once. Four controlled closed-workspace cases also verify no rebuild for comment-only feedback. Dispatch is observed at the heartbeat factory boundary so these tests never invoke a provider.

The first expanded run had 270 passes and 8 failed positive dispatch assertions because the test fixture passed a spy as route file storage instead of replacing the owning heartbeat factory. It also lacked corresponding auth-user rows. This fixture was corrected without changing production behavior; the capability suite then passed 18/18 alone, followed by the complete 278-test passing run. This failure is retained rather than presented as a product regression or hidden by the retry.

The separate MCP transport suite passed 16/16 in 715 ms (exit 0), including both AddComment and UpdateIssue preserving false. Its first run had 15 passes / 1 failure in an existing create-task expectation that omitted the current shared schema defaults `visibility:open` and `allowDuplicate:false`; those exact expectations were synchronized and omission of status remains explicitly asserted. The two new feedback transport checks passed on both runs.

UI browser receipts independently show actual local API feedback using the same task ID: false preserves Done, true moves it to Todo, with no live model runs. They do not establish wake counts on the paused fixture agent. The image smoke optionally checks `EXPECTED_COMMIT` against public health, and CI supplies its exact GitHub source SHA. A remote image build is already running, so an additional local Go-limited build was not started solely to duplicate it. Image/EC2 acceptance remains tied to the resulting evidence.

## Linux lifecycle and portability follow-up

The first public full regression exposed a real workspace-command settlement gap: bwrap's initial command/outer process could exit before detached descendants stopped writing. The command owner now uses a Linux Python child-subreaper, requests cleanup through control EOF (also on Node death), reaps only its own children until ECHILD, and sends a private acknowledgment. Node requires a valid acknowledgment and normal helper close before returning. A missing/error acknowledgment or an unresolved cleanup deadline quarantines queued and later tools for that workspace in the current controller process; cleanup continues and the reaper is not killed first. This quarantine is not claimed to persist across server restart. Full durable runtime recovery remains with the existing owner.

A bounded Linux container (1.5 GiB, one CPU, no network during verification, no host mounts or elevated sandbox permissions) passed a fresh real fork/setsid writer test for completion, timeout and revocation three times each, ECHILD-before-ack/PID disappearance, same-file successor preservation, and Node-controller-death cleanup. The verification script's startup handshake prevents observing an already-reaped writer, and its failure cleanup drains owned controllers before removing fixture files. The container was stopped and removed; the two unrelated running services were preserved.

The local Docker policy blocks unprivileged user namespaces, so it cannot qualify actual bwrap namespace/filesystem confinement. The existing Linux bwrap regression retains completion/timeout/revocation tests and now queues a successor command that overwrites the same marker. Two controlled fault cases cover missing acknowledgments and late authorization rejection. Those eight Linux-dependent cases are not represented as passing on macOS; a GitHub Linux run must supply that proof.

The strict Git non-repository classifier now recognizes both the ordinary C-locale diagnostic and Git's exact two-line filesystem-boundary diagnostic. Exit 128, no signal, Git environment checks, metadata ancestry checks and the separate declared-plain-task provenance gate remain with their original callers. Unrelated, incomplete and appended diagnostics remain errors. Crewroom capability discovery also has its mounted-route manifest, concrete assignee query, response fields and board-only OpenAPI contract.

The follow-up local focused run passed five server files with 241 tests and eight platform skips in 13.63 seconds. A separate CLI telemetry fixture run passed four tests while the parent environment explicitly opted out: tests install mock fetch before clearing fixture opt-outs, use a .invalid endpoint, verify both explicit opt-outs cause no client/state/request, and restore environment and temporary roots. Production telemetry behavior and CI's global opt-out were not changed.

Final follow-up type verification: full server `tsc --noEmit` passed with Go build parallelism 2 and soft memory target 3 GiB. Its first attempt found only the intentionally partial ChildProcess test double cast; the cast boundary was made explicit and the full server check then returned exit 0. The final Linux verification script, including completion release handshake and tracked controller/helper failure cleanup, was rerun successfully. Its disposable container used init, no network, one CPU and a 1.5 GiB cap, then stopped and was removed. No local test/compiler/container processes remained; unrelated services stayed running. Actual bwrap namespace regression acceptance remains with the next GitHub Linux result.
