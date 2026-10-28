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
