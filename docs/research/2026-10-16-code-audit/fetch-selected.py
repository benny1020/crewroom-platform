import concurrent.futures
import json
from collect import ROOT, fetch_source

SELECTED = {
    "paperclip": [
        "README.md", "LICENSE", "SECURITY.md",
        "packages/db/src/schema/agents.ts", "packages/db/src/schema/issues.ts",
        "packages/db/src/schema/agent_runtime_state.ts", "packages/db/src/schema/agent_task_sessions.ts",
        "packages/db/src/schema/heartbeat_runs.ts", "packages/db/src/schema/heartbeat_run_events.ts",
        "packages/db/src/schema/company_skills.ts", "packages/db/src/schema/routines.ts",
        "server/src/services/heartbeat.ts", "server/src/services/issues.ts",
        "server/src/services/company-skills.ts", "server/src/services/agent-conversations.ts",
        "server/src/services/live-events.ts", "server/src/adapters/registry.ts",
        "packages/adapter-utils/src/types.ts", "ui/src/context/LiveUpdatesProvider.tsx",
    ],
    "lobehub": [
        "README.md", "LICENSE",
        "packages/database/src/schemas/agent.ts", "packages/database/src/schemas/agentShare.ts",
        "packages/database/src/schemas/agentSkill.ts", "packages/database/src/schemas/agentOperations.ts",
        "packages/database/src/schemas/userMemories/index.ts",
        "apps/server/src/modules/AgentRuntime/AgentRuntimeCoordinator.ts",
        "apps/server/src/modules/AgentRuntime/AgentStateManager.ts",
        "apps/server/src/modules/AgentRuntime/StreamEventManager.ts",
        "apps/server/src/services/agentRuntime/HumanInterventionHandler.ts",
        "apps/server/src/services/memory/userMemory/extract.ts",
        "apps/server/src/services/agentGroup/index.ts",
        "src/store/agentGroup/slices/member.ts",
    ],
    "openclaw": [
        "README.md", "LICENSE", "SECURITY.md", "docs/concepts/multi-agent.md",
        "src/agents/agent-scope.ts", "src/routing/resolve-route.ts",
        "extensions/memory-core/src/memory/hybrid.ts",
        "extensions/memory-core/src/memory/manager-search.ts",
        "docs/concepts/memory-provenance.md",
    ],
    "hermes": [
        "README.md", "LICENSE", "agent/memory_manager.py", "agent/memory_provider.py",
        "tools/memory_tool.py", "tools/memory_tool_store.py", "tools/skills_tool.py",
        "tools/session_search_tool.py", "gateway/session_admission.py",
        "website/docs/user-guide/features/memory.md",
    ],
    "letta": ["README.md", "LICENSE", "SECURITY.md"],
    "mastra": [
        "README.md", "LICENSE.md", "packages/core/src/agent/durable/create-durable-agent.ts",
        "packages/core/src/agent/durable/execution-fence.ts", "packages/core/src/agent/durable/run-recovery.md",
        "packages/core/src/storage/run-fencing.ts",
        "packages/memory/src/processors/observational-memory/observational-memory.ts",
        "packages/memory/src/processors/observational-memory/ARCHITECTURE.md",
    ],
    "langgraph": [
        "README.md", "LICENSE", "libs/langgraph/langgraph/pregel/_loop.py",
        "libs/langgraph/langgraph/pregel/_runner.py", "libs/langgraph/langgraph/types.py",
        "libs/checkpoint/langgraph/checkpoint/base/__init__.py",
        "libs/checkpoint/langgraph/store/base/__init__.py",
    ],
    "dify": [
        "README.md", "LICENSE", "api/core/app/apps/agent_app/session_store.py",
        "api/core/memory/token_buffer_memory.py", "api/core/workflow/human_input_adapter.py",
        "api/core/workflow/nodes/human_input/session_binding.py",
        "api/services/workflow_event_snapshot_service.py",
    ],
    "openhands": [
        "README.md", "LICENSE", "src/api/conversation-service/agent-server-conversation-service.api.ts",
        "src/api/conversation-service/agent-server-conversation-service.types.ts",
        "src/stores/conversation-state-store.ts", "src/stores/event-message-store.ts",
        "src/hooks/use-handle-ws-events.ts",
    ],
}

manifest = json.loads((ROOT / "manifest.json").read_text())
records = {x["slug"]: x for x in manifest["repositories"]}
jobs = [(records[slug], path) for slug, paths in SELECTED.items() for path in paths]

def work(job):
    record, path = job
    try:
        return record["slug"], fetch_source(record, path)
    except Exception as exc:
        return record["slug"], {"path": path, "error": str(exc)}

with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    results = list(pool.map(work, jobs))
for slug, record in records.items():
    record.pop("read_files", None)
    record["fetched_files"] = [data for key, data in results if key == slug]
    record["inspected_files"] = []
    print(slug, len(record["fetched_files"]), [x for x in record["fetched_files"] if "error" in x], flush=True)
(ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
