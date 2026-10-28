#!/usr/bin/env node
import { randomUUID } from "node:crypto";

// Explicit, repeatable local setup. This never runs from an application GET.
const origin = new URL(process.env.CREWROOM_LOCAL_ORIGIN ?? "http://127.0.0.1:3117");
if (origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname)) {
  throw new Error("This bootstrap only supports an explicit loopback development instance.");
}
async function api(path, method = "GET", body) {
  const response = await fetch(new URL(`/api${path}`, origin), { method,
    headers: { "Content-Type": "application/json", Origin: origin.origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${result.error ?? "request failed"}`);
  return result;
}
const health = await api("/health");
if (health.deploymentMode !== "local_trusted") throw new Error("Local bootstrap cannot modify an authenticated/shared instance.");
const name = "크루룸 개발팀";
const companies = await api("/companies");
let company = companies.find(item => item.name === name);
if (!company) company = await api("/companies", "POST", { name, description: "격리된 로컬 개발용 팀 · 제공자 연결 전 상태", budgetMonthlyCents: 0 });
await api(`/companies/${company.id}`, "PATCH", { requireBoardApprovalForNewAgents: false });
await api("/instance/settings/experimental", "PATCH", { enableAgentChat: true });
const roster = [
  ["mimi", "미미", "내 기본 비서", "direct", "general"],
  ["dev-lead", "도담", "개발 리드", "development", "cto"],
  ["frontend", "모아", "프론트엔드 개발", "development", "engineer"],
  ["backend", "토리", "백엔드 개발", "development", "engineer"],
  ["ops-lead", "나루", "운영 리드", "operations", "general"],
  ["support", "하루", "업무 정리와 지원", "operations", "general"],
  ["qa-lead", "루미", "QA 리드", "qa", "general"],
  ["qa", "보리", "테스트와 검증", "qa", "engineer"],
];
const characterIds = { mimi: "mimi", "dev-lead": "rururu", frontend: "otter", backend: "fennec",
  "ops-lead": "capybara", support: "rabbit", "qa-lead": "penguin", qa: "hedgehog" };
const agents = await api(`/companies/${company.id}/agents`);
for (const [key, agentName, title, departmentId, role] of roster) {
  const existing = agents.find(agent => agent.metadata?.crewroomBootstrapKey === key);
  if (existing) {
    if (existing.metadata?.crewroom?.characterId === "default") {
      const updated = await api(`/agents/${existing.id}`, "PATCH", { metadata: { ...existing.metadata,
        crewroom: { ...existing.metadata.crewroom, characterId: characterIds[key] } } });
      Object.assign(existing, updated);
    }
    continue;
  }
  const agent = await api(`/companies/${company.id}/agents`, "POST", {
    setupId: randomUUID(), name: agentName, title, role, adapterType: "claude_local", runner: "auto",
    adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0 } },
    metadata: { crewroomBootstrapKey: key, crewroom: { schemaVersion: 1, departmentId,
      characterId: characterIds[key], displayOrder: roster.findIndex(row => row[0] === key) } },
    capabilities: `${title}. 제공자 연결과 실행 환경 설정이 필요합니다.`,
  });
  agents.push(agent);
}
const primary = await api(`/companies/${company.id}/primary-agent/me`);
if (!primary.primaryAgentId) await api(`/companies/${company.id}/primary-agent/me`, "PUT", {
  primaryAgentId: agents.find(agent => agent.metadata?.crewroomBootstrapKey === "mimi").id,
});
const skills = await api(`/companies/${company.id}/skills`);
const entries = Array.isArray(skills) ? skills : skills.items ?? [];
if (!entries.some(skill => skill.slug === "crewroom-meeting-summary")) {
  await api(`/companies/${company.id}/skills`, "POST", { idempotencyKey: "crewroom-local-meeting-summary-v1",
    name: "회의 내용 정리", slug: "crewroom-meeting-summary", description: "대화에서 결정과 다음 행동을 정리하는 작업 지침",
    sharingScope: "company", markdown: "---\nname: crewroom-meeting-summary\ndescription: 회의의 결정과 다음 행동을 정리한다.\n---\n\n제공된 회의 내용을 읽고 결정, 근거, 담당자, 다음 행동을 정리한다. 모호한 담당자나 날짜를 추측하지 말고 확인이 필요하다고 표시한다.\n" });
}
console.log(JSON.stringify({ companyId: company.id, issuePrefix: company.issuePrefix, agents: agents.length,
  url: new URL(`/${company.issuePrefix}/crewroom`, origin).href,
  execution: "not-configured", providerCredentials: "not-provisioned", agentSetup: "setup hold retained; no runs requested" }, null, 2));
