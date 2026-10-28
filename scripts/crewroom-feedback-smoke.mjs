#!/usr/bin/env node
/** Explicit local, paused-agent fixture only. Does not configure or call a model. */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
const origin = new URL(process.env.CREWROOM_LOCAL_ORIGIN ?? "http://127.0.0.1:3117");
const taskId = process.env.CREWROOM_FEEDBACK_TASK_ID;
if (!taskId || origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("Choose an explicit local verification task.");
async function api(path, method = "GET", body) {
  const response = await fetch(new URL(`/api${path}`, origin), { method,
    headers: { "Content-Type": "application/json", Origin: origin.origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}: ${result.error ?? "request failed"}`);
  return result;
}
if ((await api("/health")).deploymentMode !== "local_trusted") throw new Error("This smoke only mutates the isolated local fixture.");
const task = await api(`/issues/${taskId}`);
const agent = await api(`/agents/${task.assigneeAgentId}`);
if (task.title !== "검증용 업무 · 실제 모델 실행 아님" || task.status !== "done" || agent.status !== "paused") throw new Error("Refusing to modify a non-fixture or active task.");
const company = await api(`/companies/${task.companyId}`);
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const receipt = { source: "actual local browser and API; paused fixture agent; no model execution", taskId: task.id, identifier: task.identifier, checks: [] };
try {
  await page.goto(new URL(`/${company.issuePrefix}/issues/${task.identifier}`, origin).href, { waitUntil: "networkidle" });
  await page.screenshot({ path: resolve("doc/crewroom/media/task-before-feedback.png"), fullPage: true });
  const composer = page.locator('.paperclip-task-chat-composer');
  await composer.waitFor();
  const editor = composer.locator('[contenteditable="true"]').first();
  await editor.fill("고마워 · 로컬 검증용 의견입니다.");
  const responsePromise = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/issues/") && response.url().endsWith("/comments"));
  await composer.getByRole("button", { name: "보내기", exact: true }).click();
  const response = await responsePromise;
  const submitted = response.request().postDataJSON();
  if (!response.ok() || submitted.reopen !== false) throw new Error("Opinion did not explicitly submit reopen:false.");
  const afterOpinion = await api(`/issues/${task.id}`);
  if (afterOpinion.id !== task.id || afterOpinion.status !== "done") throw new Error("A plain opinion restarted the task.");
  receipt.checks.push({ action: "opinion", explicitReopen: submitted.reopen, status: afterOpinion.status, sameTask: true });
  await page.screenshot({ path: resolve("doc/crewroom/media/task-opinion.png"), fullPage: true });
  await editor.fill("검증용 수정 요청입니다. 실제 모델 실행 없이 같은 업무의 상태 전환만 확인합니다.");
  await composer.getByRole("checkbox").check();
  const revisionPromise = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/issues/") && response.url().endsWith("/comments"));
  await composer.getByRole("button", { name: "수정 요청 보내기", exact: true }).click();
  const revision = await revisionPromise;
  const revisionBody = revision.request().postDataJSON();
  const afterRevision = await api(`/issues/${task.id}`);
  if (!revision.ok() || revisionBody.reopen !== true || afterRevision.id !== task.id || afterRevision.status !== "todo") throw new Error("Revision did not reopen the same task.");
  receipt.checks.push({ action: "revision", explicitReopen: revisionBody.reopen, status: afterRevision.status, sameTask: true });
  receipt.wakeupEvidence = "Raw wakeup queue is not exposed by the public API. Wake counts are established in server route regressions, not this paused-agent browser smoke.";
  receipt.liveRuns = (await api(`/companies/${company.id}/live-runs?minCount=0`)).filter(run => run.issueId === task.id).length;
  await page.screenshot({ path: resolve("doc/crewroom/media/task-revision.png"), fullPage: true });
} finally {
  await context.close(); await browser.close();
  await api(`/issues/${task.id}`, "PATCH", { status: "done" });
  receipt.fixtureRestoredTo = "done; agent remains paused";
  await writeFile(resolve("doc/crewroom/media/feedback-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
console.log(JSON.stringify(receipt, null, 2));
