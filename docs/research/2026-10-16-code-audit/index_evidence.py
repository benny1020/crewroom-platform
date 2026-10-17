"""Rebuild the source evidence index from existing, pinned local files only.

No upstream code is imported or executed. No network access is used.
"""

import hashlib
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent
MANIFEST = BASE / "manifest.json"
REPORT = BASE.parents[1] / "OPEN_SOURCE_CODE_RESEARCH.md"
MARKER = "<!-- PINNED_SOURCE_REFERENCES -->"

# IDs used by the report. A range denotes the selected evidence around a symbol,
# not a claim that the whole enclosing file or every caller was audited.
ROWS = [
    ("P-agent", "paperclip", "packages/db/src/schema/agents.ts", [(17, 58)], "agents", "Persistent identity, reporting, appearance, runtime binding and budgets", "schema"),
    ("P-issue", "paperclip", "packages/db/src/schema/issues.ts", [(26, 110), (149, 156)], "issues", "Task, conversation identity, visibility and execution ownership are separate fields", "schema"),
    ("P-run", "paperclip", "packages/db/src/schema/heartbeat_runs.ts", [(23, 112)], "heartbeatRuns", "Run identity, owner, native session, usage and event sequence", "schema"),
    ("P-session", "paperclip", "packages/db/src/schema/agent_task_sessions.ts", [(16, 56), (61, 90)], "agentTaskSessions", "Unique company/agent/adapter/task scope and action request identity", "schema"),
    ("P-checkout", "paperclip", "server/src/services/issues.ts", [(11650, 11835)], "checkout", "Conditional UPDATE checks status, assignee and execution ownership atomically", "implementation"),
    ("P-queue", "paperclip", "server/src/services/heartbeat/queue.ts", [(4148, 4230)], "run coalescing and wakeup receipt", "Scope-aware coalescing preserves receipt and run identity under conditions", "implementation"),
    ("P-skill-contract", "paperclip", "packages/shared/src/validators/adapter-skills.ts", [(1, 72)], "adapterSkillSnapshotSchema", "Desired/effective entries, version pins, sync modes and status states", "contract"),
    ("P-skill-db", "paperclip", "packages/db/src/schema/company_skills.ts", [(19, 114), (213, 240)], "companySkills, versions and tests", "Library trust, source/hash/version and test snapshots", "schema"),
    ("P-skill-ui", "paperclip", "ui/src/pages/agent-skills/AgentSkillsTab.tsx", [(120, 200)], "draft hydration and autosave", "Changing agent resets draft; stale hydration does not overwrite pending version selection", "implementation"),
    ("P-events", "paperclip", "packages/db/src/schema/heartbeat_run_events.ts", [(1, 50)], "heartbeatRunEvents", "Unique run sequence and source event/sequence constraints", "schema"),
    ("P-live", "paperclip", "server/src/services/live-events.ts", [(1, 66)], "publishLiveEvent", "Process-local EventEmitter live notifications", "implementation"),
    ("P-reconnect", "paperclip", "ui/src/context/LiveUpdatesProvider.tsx", [(1974, 2045)], "connect / onopen / scheduleReconnect", "Reconnect invalidates queries because notifications are not replayed", "implementation"),
    ("P-hermes-session", "paperclip", "packages/adapters/hermes/src/server/execute.ts", [(347, 382), (443, 505), (636, 648)], "execute", "Native session resume and returned session params; managed skill reconciliation", "implementation"),
    ("P-hermes-env", "paperclip", "packages/adapters/hermes/src/server/execute.ts", [(487, 525)], "CLI args and child env", "Always appends --yolo; inherits process.env; resets Paperclip API identity", "implementation"),
    ("P-hermes-home", "paperclip", "packages/adapters/hermes/src/server/skills.ts", [(25, 46)], "resolveHermesHome", "HERMES_HOME or configured/default user home, no automatic agent ID in this resolver", "implementation"),
    ("P-hermes-sync", "paperclip", "packages/adapters/hermes/src/server/skills.ts", [(220, 271)], "reconcileHermesPaperclipSkills", "Materializes selected skills and removes deselected managed symlinks", "implementation"),
    ("P-adapter", "paperclip", "packages/adapter-utils/src/types.ts", [(1, 155)], "AdapterRuntime and execution result", "Recovery evidence and per-run versus cumulative usage have explicit contracts", "contract"),
    ("P-registry", "paperclip", "server/src/adapters/registry.ts", [(825, 846)], "Hermes adapters", "Existing local/gateway Hermes adapters are registered", "implementation"),
    ("L-agent", "lobehub", "packages/database/src/schemas/agent.ts", [(29, 120)], "agents", "Workspace/user ownership and profile, model and visibility fields", "schema"),
    ("L-group", "lobehub", "packages/database/src/schemas/chatGroup.ts", [(1, 120)], "chatGroupsAgents", "Multi-agent group membership is distinct from human department membership", "schema"),
    ("L-share", "lobehub", "packages/database/src/schemas/agentShare.ts", [(1, 105)], "AgentShareConfig", "Session visibility, memory read, skill grants and tool grants are separate; billing enforcement note is Cloud-specific", "contract"),
    ("L-coordinator", "lobehub", "apps/server/src/modules/AgentRuntime/AgentRuntimeCoordinator.ts", [(74, 125)], "AgentRuntimeCoordinator", "State and stream managers composed with runtime scope", "implementation"),
    ("L-state", "lobehub", "apps/server/src/modules/AgentRuntime/AgentStateManager.ts", [(14, 63), (104, 175)], "AgentStateManager", "Owner-checked Redis locks, state TTL and DB-backed message rehydration", "implementation"),
    ("L-stream", "lobehub", "apps/server/src/modules/AgentRuntime/StreamEventManager.ts", [(158, 175), (196, 263), (323, 373)], "StreamEventManager", "Redis Stream cursor reads with approximate length and two-hour retention", "implementation"),
    ("L-human", "lobehub", "apps/server/src/services/agentRuntime/HumanInterventionHandler.ts", [(25, 58), (68, 117)], "HumanInterventionHandler", "Persist human intervention and retain waiting state when more tools need input", "implementation"),
    ("H-memory", "hermes", "tools/memory_tool_store.py", [(175, 298)], "MemoryStore", "Bounded curated memory, frozen prompt snapshot and separate lock file", "implementation"),
    ("H-search", "hermes", "tools/session_search_tool.py", [(354, 400)], "_discover", "FTS5 search, temporal filtering and session lineage deduplication", "implementation"),
    ("H-skill-list", "hermes", "tools/skills_tool.py", [(269, 296)], "skills_list", "Metadata-first skill listing", "implementation"),
    ("H-skill-view", "hermes", "tools/skills_tool.py", [(571, 640)], "skill_view", "Separate skill body/reference loading, readiness and preprocessing", "implementation"),
    ("T-move", "letta", "README.md", [(1, 39)], "current repository pointer", "Current implementation points to letta-code, retired V1 separate", "documentation"),
    ("T-scope", "letta-code", "src/agent/memory-filesystem.ts", [(46, 132)], "resolveScopedMemoryDir", "Per-agent memory paths and runtime-first scope resolution", "implementation"),
    ("T-tree", "letta-code", "src/agent/memory-filesystem.ts", [(312, 450)], "memory directory rendering", "Directory representation has line/character/child budgets", "implementation"),
    ("T-worktree", "letta-code", "src/agent/memory-worktree.ts", [(125, 191)], "memory worktree creation", "Separate reflection branch and worktree", "implementation"),
    ("T-merge", "letta-code", "src/agent/memory-worktree.ts", [(659, 745)], "memory worker integration", "Merge, discard and conflict outcomes; abort and retain conflicting branch", "implementation"),
    ("T-skills", "letta-code", "src/agent/skills.ts", [(148, 206)], "isModelInvocableSkill / isUserInvocableSkill", "User/model invocation flags and skill roots are distinct", "implementation"),
    ("T-cloud", "letta-code", "src/agent/shared-memory-skills.ts", [(87, 195)], "shared memory skills discovery", "Local agent and Cloud detection constrain shared repository discovery", "implementation"),
    ("O-event", "openhands-sdk", "openhands-sdk/openhands/sdk/conversation/event_store.py", [(34, 42), (188, 245)], "EventLog.append", "Locked append synchronizes disk, validates uniqueness and parent then writes", "implementation"),
    ("O-lease", "openhands-sdk", "openhands-agent-server/openhands/agent_server/conversation_lease.py", [(101, 216)], "ConversationLease", "Owner/generation/expiry claims and guarded writes", "implementation"),
    ("M-fence", "mastra", "packages/core/src/agent/durable/execution-fence.ts", [(1, 150)], "ExecutionFence", "Storage generation fencing, pubsub lease and no-op modes differ", "implementation_and_comments"),
    ("M-recovery", "mastra", "packages/core/src/agent/durable/run-recovery.md", [(1, 105)], "Durable run recovery", "Snapshot prerequisites, replayed calls, limitations and known gaps documented", "documentation"),
    ("M-observe", "mastra", "packages/memory/src/processors/observational-memory/observational-memory.ts", [(388, 455), (596, 636), (690, 757)], "ObservationalMemory", "Observer/Reflector, token budgets, resource/thread scope and buffering conditions", "implementation_and_comments"),
    ("M-memory-design", "mastra", "packages/memory/src/processors/observational-memory/ARCHITECTURE.md", [(1, 110)], "Observational Memory architecture", "Record generations, cursors and buffered observations are explicit design concerns", "documentation"),
    ("G-checkpoint", "langgraph", "libs/checkpoint/langgraph/checkpoint/base/__init__.py", [(199, 230)], "BaseCheckpointSaver", "Thread-keyed execution persistence", "contract"),
    ("G-store", "langgraph", "libs/checkpoint/langgraph/store/base/__init__.py", [(708, 745)], "BaseStore", "Cross-thread namespaces; semantic indexing depends on configuration/backend", "contract"),
    ("G-interrupt", "langgraph", "libs/langgraph/langgraph/types.py", [(903, 932)], "interrupt", "Resumed node reexecutes from the beginning", "contract"),
    ("D-scope", "dify", "api/core/app/apps/agent_app/session_store.py", [(1, 112)], "AgentAppSessionScope / _load_caller", "Tenant/app/conversation scope and caller-bound workspace loading", "implementation"),
    ("D-history", "dify", "api/core/memory/token_buffer_memory.py", [(1, 165)], "PreparedHistory", "Prompt messages trimmed to token budget; distinct from long-term memory", "implementation"),
    ("D-pause", "dify", "api/services/workflow_event_snapshot_service.py", [(1, 125)], "WorkflowEventSnapshotService", "Paused run and resumption context used to build event snapshot", "implementation"),
    ("C-security", "openclaw", "SECURITY.md", [(1, 13)], "Trust model", "Trusted operator gateway is not a shared multi-tenant security boundary", "documentation"),
    ("C-hybrid", "openclaw", "extensions/memory-core/src/memory/hybrid.ts", [(1, 160)], "mergeHybridResults", "Vector and keyword result merging with path/line provenance and diversity/time options", "implementation"),
    ("R-recall", "hindsight", "hindsight-api-slim/hindsight_api/engine/memories/pg/recall.py", [(1, 265)], "retrieve_semantic_bm25_combined_sql", "Dense/BM25 combination and bank/time scoped retrieval paths", "targeted_implementation_search"),
    ("R-budget", "hindsight", "hindsight-api-slim/hindsight_api/engine/retain/memory_budget.py", [(1, 165)], "MemoryBudget", "Ingest RAM backpressure, not an unlimited prompt/storage guarantee", "implementation"),
    ("R-tenant", "hindsight", "hindsight-api-slim/hindsight_api/extensions/builtin/tenant.py", [(1, 90)], "DefaultTenantExtension / ApiKeyTenantExtension", "Unauthenticated single-schema default; built-in API key also maps to one schema", "implementation"),
    ("V-scope", "mem0", "mem0/memory/main.py", [(314, 403)], "_build_filters_and_metadata", "Identity scope validated and identity keys removed from arbitrary metadata", "implementation"),
    ("V-extract", "mem0", "mem0/memory/main.py", [(881, 990)], "_add_to_vector_store", "Current V3 additive extraction uses recent messages and retrieved memories", "implementation"),
]

LICENSE_PATHS = {
    "paperclip": "LICENSE", "hermes": "LICENSE", "openclaw": "LICENSE",
    "openhands-sdk": "LICENSE", "langgraph": "LICENSE", "hindsight": "LICENSE",
    "letta-code": "LICENSE", "mem0": "LICENSE", "mastra": "LICENSE.md",
    "lobehub": "LICENSE", "dify": "LICENSE",
}
LICENSE_ALIASES = {"openhands-sdk": "openhands", "letta-code": "letta"}
for slug, path in LICENSE_PATHS.items():
    ROWS.append((f"X-{LICENSE_ALIASES.get(slug, slug)}", slug, path,
                 [], "Repository license", "Recorded text and additional conditions; not legal approval", "license"))


def main():
    manifest = json.loads(MANIFEST.read_text())
    repositories = {r["slug"]: r for r in manifest["repositories"]}
    evidence = []
    refs = []
    used_paths = set()
    for key, slug, path, ranges, symbol, observation, kind in ROWS:
        repo = repositories[slug]
        local = BASE / "sources" / slug / path
        raw = local.read_bytes()
        line_count = len(raw.splitlines())
        for first, last in ranges:
            if not 1 <= first <= last <= line_count:
                raise ValueError(f"Invalid source range: {key}: {first}-{last}/{line_count}")
        url = f"https://github.com/{repo['repo']}/blob/{repo['sha']}/{path}"
        if ranges:
            # A link highlights the first selected region. JSON retains all regions.
            first, last = ranges[0]
            url += f"#L{first}-L{last}"
        evidence.append({
            "id": key, "repository": repo["repo"], "slug": slug, "sha": repo["sha"],
            "path": path, "ranges": ranges, "symbol": symbol, "observation": observation,
            "evidence_kind": kind, "classification": "source_observed",
            "source_url": url, "local_path": f"sources/{slug}/{path}",
            "source_sha256": hashlib.sha256(raw).hexdigest(),
            "runtime_tested": False,
        })
        refs.append(f"[{key}]: {url}")
        used_paths.add((slug, path))

    for repo in repositories.values():
        inspected = {}
        for item in evidence:
            if item["slug"] != repo["slug"]:
                continue
            entry = inspected.setdefault(item["path"], {"path": item["path"], "evidence_ids": [], "ranges": []})
            entry["evidence_ids"].append(item["id"])
            entry["ranges"].extend(r for r in item["ranges"] if r not in entry["ranges"])
        repo["inspected_files"] = list(inspected.values())
        for source in repo["fetched_files"]:
            source["sha256"] = hashlib.sha256((BASE / "sources" / repo["slug"] / source["path"]).read_bytes()).hexdigest()

    original = REPORT.read_text()
    body = original.split(MARKER)[0].rstrip()
    used_ids = set(re.findall(r"\]\[([A-Z][A-Za-z0-9-]+)\]", body))
    known_ids = {x["id"] for x in evidence}
    if missing := used_ids - known_ids:
        raise ValueError(f"Unknown source references: {missing}")
    rendered = body + "\n\n" + MARKER + "\n\n" + "\n".join(refs) + "\n"
    REPORT.write_text(rendered)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    result = {
        "research_date_kst": "2026-10-16", "method": manifest["method"],
        "scope": "Selected static source paths, schemas and repository design documents. No upstream execution.",
        "repository_count": len(repositories), "project_count": 11,
        "fetched_file_count": sum(len(r["fetched_files"]) for r in repositories.values()),
        "evidence_file_count": len(used_paths), "evidence_entry_count": len(evidence),
        "entries": evidence,
        "limits": ["Not a full-file or whole-repository audit", "Default-branch snapshots may differ from releases", "No functional, security, performance or recovery experiment was run"],
    }
    (BASE / "evidence.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k.endswith("count")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
