#!/usr/bin/env node
/** One browser/context, real loopback API data. No provider calls or mocked activity. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { chromium } from "@playwright/test";

const origin = new URL(process.env.CREWROOM_LOCAL_ORIGIN ?? "http://127.0.0.1:3117");
if (origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname)) {
  throw new Error("Capture is limited to an explicit local development instance.");
}
const output = resolve("doc/crewroom/media");
await mkdir(output, { recursive: true });
const api = async path => {
  const response = await fetch(new URL(`/api${path}`, origin));
  if (!response.ok) throw new Error(`Read failed: ${path} (${response.status})`);
  return response.json();
};
const health = await api("/health");
const companies = await api("/companies");
const company = companies.find(item => item.name === "크루룸 개발팀");
if (!company) throw new Error("Run the explicit local Crewroom bootstrap first.");
const agents = await api(`/companies/${company.id}/agents`);
const base = `/${company.issuePrefix}/crewroom`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
let frames;
page.on("pageerror", error => errors.push(error.message));
const receipt = { capturedAt: new Date().toISOString(), origin: origin.origin,
  source: "real local API; paused sample colleagues; no provider credentials or model execution",
  healthCommit: health.commit ?? health.serverInfo?.git?.fullSha ?? null,
  sourceHasLocalChanges: health.serverInfo?.git?.localChanges?.hasLocalChanges ?? null, companyId: company.id, captures: [] };
async function capture(name, path = base, expectedText) {
  await page.goto(new URL(path, origin).href, { waitUntil: "networkidle" });
  await page.locator("#crewroom-title").waitFor();
  if (expectedText) await page.getByText(expectedText, { exact: false }).first().waitFor();
  await page.screenshot({ path: resolve(output, name), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  receipt.captures.push({ file: name, viewport: page.viewportSize(), path, horizontalOverflow: overflow });
  if (overflow) throw new Error(`Horizontal page overflow: ${name}`);
}
try {
  for (const width of [1440, 1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await capture(`team-${width}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await capture("team-1440x900.png");
  receipt.rosterWithin900Viewport = await page.locator(".crewroom-roster .crewroom-agent").evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().bottom <= innerHeight));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture("development.png", `${base}?department=development`);
  const selected = agents.find(agent => agent.metadata?.crewroomBootstrapKey === "frontend");
  if (selected) await capture("workroom.png", `${base}?agent=${selected.id}`);
  await capture("personal.png", `${base}?view=personal`);
  await capture("skills.png", `${base}?view=skills`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await capture("team-reduced-motion.png");
  const moving = await page.locator(".crewroom-character").evaluateAll(nodes => nodes.flatMap(node => node.getAnimations({ subtree: true })).filter(animation => animation.playState === "running").length);
  receipt.reducedMotionRunningAnimations = moving;
  if (moving) throw new Error("Reduced motion still has running character animations.");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".crewroom-motion-preview summary").click();
  await page.locator(".crewroom-scene-gallery").screenshot({ path: resolve(output, "mimi-scenes-preview.png") });
  receipt.sampleGallery = "Explicit 12-scene sample; no execution or successful result implied";
  if (process.env.CREWROOM_CAPTURE_GIF === "1") {
    frames = await mkdtemp(join(tmpdir(), "crewroom-motion-"));
    const gallery = page.locator(".crewroom-motion-preview");
    for (let index = 0; index < 24; index++) {
      await gallery.screenshot({ path: join(frames, `frame-${String(index).padStart(3, "0")}.png`), animations: "allow" });
      await page.waitForTimeout(100);
    }
  }
  await page.goto(new URL(base, origin).href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "동작 멈추기", exact: true }).click();
  await page.reload({ waitUntil: "networkidle" });
  receipt.motionPreferenceSurvivesReload = await page.locator(".crewroom-page").getAttribute("data-motion") === "off";
  if (!receipt.motionPreferenceSurvivesReload) throw new Error("Motion preference was not restored.");
  await page.getByRole("button", { name: "동작 켜기", exact: true }).click();
  await page.getByRole("button", { name: "대화로 요청하기", exact: true }).click();
  await page.waitForURL(/\/chats\//);
  await page.locator('.paperclip-task-chat-composer, [data-testid="thread-root"]').first().waitFor();
  receipt.primaryCtaUsesExistingChat = true;
  await page.screenshot({ path: resolve(output, "private-chat.png"), fullPage: true });
  if (process.env.CREWROOM_CAPTURE_STATES === "1") {
    receipt.browserFixtures = [];
    const rosterPattern = `**/api/companies/${company.id}/agents**`;
    await page.route(rosterPattern, route => route.fulfill({ contentType: "application/json", body: "[]" }));
    await capture("empty.fixture.png", base, "아직 등록된 동료가 없어요");
    receipt.browserFixtures.push({ file: "empty.fixture.png", source: "browser response replacement: empty agent list" });
    await page.unroute(rosterPattern);
    await page.route(rosterPattern, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "UI verification fixture" }) }));
    await capture("error.fixture.png", base, "에이전트 명부를 불러오지 못했어요");
    receipt.browserFixtures.push({ file: "error.fixture.png", source: "browser response replacement: agent API 503" });
    await page.unroute(rosterPattern);
    const capabilityPattern = `**/api/companies/${company.id}/crewroom/capabilities**`;
    await page.route(capabilityPattern, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ companyId: company.id, canAssignTasks: false, canCreateUnassignedTask: false, canConfigureAgents: false, canCreateAgents: false }) }));
    await capture("read-only.fixture.png");
    if (!await page.getByRole("button", { name: "새 업무", exact: true }).isDisabled()) throw new Error("Read-only fixture enabled task creation.");
    receipt.browserFixtures.push({ file: "read-only.fixture.png", source: "browser response replacement: denied creation capabilities; server authorization tested separately" });
    await page.unroute(capabilityPattern);
  }
  receipt.pageErrors = errors;
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
} finally {
  await writeFile(resolve(output, "capture-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await context.close();
  await browser.close();
}
if (frames) {
  try {
    if (process.env.CREWROOM_GIF_PYTHON) {
      await promisify(execFile)(process.env.CREWROOM_GIF_PYTHON, ["-c",
        "from PIL import Image; import glob,sys; frames=[Image.open(p).convert('RGB') for p in sorted(glob.glob(sys.argv[1]+'/*.png'))]; frames[0].save(sys.argv[2],save_all=True,append_images=frames[1:],duration=125,loop=0,optimize=True)",
        frames, resolve(output, "mimi-motion-preview.gif")]);
    } else {
      await promisify(execFile)("ffmpeg", ["-y", "-framerate", "8", "-i", join(frames, "frame-%03d.png"),
        "-filter_complex", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", "-loop", "0",
        resolve(output, "mimi-motion-preview.gif")]);
    }
  } finally { await rm(frames, { recursive: true, force: true }); }
}
console.log(JSON.stringify(receipt, null, 2));
