// @vitest-environment jsdom
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { useOpenAgentChat } from "./useAgentChatNavigation";
const mocks = vi.hoisted(() => ({ ensure: vi.fn(), navigate: vi.fn() }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { ensure: mocks.ensure } }));
vi.mock("@/lib/router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
const agent = { id: "agent-a", companyId: "company-a", name: "Helper" } as Agent;
const chat = { id: "private-chat", updatedAt: "2026-10-28T00:00:00Z" } as Issue;
let client: QueryClient;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let open: ReturnType<typeof useOpenAgentChat>;
function Harness({ companyId, userId }: { companyId: string; userId: string }) {
  open = useOpenAgentChat(companyId, userId); return null;
}
function render(companyId = "company-a", userId = "viewer-a") {
  flushSync(() => root.render(<StrictMode><QueryClientProvider client={client}><Harness companyId={companyId} userId={userId} /></QueryClientProvider></StrictMode>));
}
beforeEach(() => {
  vi.clearAllMocks(); client = new QueryClient();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });
it("opens and caches a resolved chat after StrictMode effect replay", async () => {
  mocks.ensure.mockResolvedValue(chat); render(); await open(agent);
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(client.getQueryData(queryKeys.agentChats.detail("company-a", "viewer-a", "agent-a"))).toEqual(chat);
});
it.each(["actor", "company", "unmount", "abort"])("drops late private responses after %s changes", async change => {
  let resolve!: (value: Issue) => void;
  mocks.ensure.mockReturnValue(new Promise<Issue>(done => { resolve = done; }));
  render(); const abort = new AbortController(); const pending = open(agent, abort.signal);
  if (change === "actor") render("company-a", "viewer-b");
  else if (change === "company") render("company-b", "viewer-a");
  else if (change === "unmount") flushSync(() => root.render(null));
  else abort.abort();
  resolve(chat); await pending;
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(client.getQueryCache().findAll()).toHaveLength(0);
});
