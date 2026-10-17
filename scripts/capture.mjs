import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

const media = new URL("../docs/media/", import.meta.url);
const recordings = new URL("../.capture/", import.meta.url);
await mkdir(media, { recursive: true });
await mkdir(recordings, { recursive: true });

const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4174",
    "--strictPort",
  ],
  { stdio: "ignore" },
);
const url = "http://127.0.0.1:4174/";
const errors = [];
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
let browser;

async function command(binary, args) {
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code, signal] = await once(child, "exit");
  if (code !== 0 || signal)
    throw new Error(
      `${binary} exited ${code ?? signal}: ${stderr.slice(-2000)}`,
    );
}
const nav = (page, view) =>
  page.locator(`.g-nav-button[data-view="${view}"]`).click();
const agent = (page, id) =>
  page
    .locator(`.g-dept-children [data-action="agent"][data-id="${id}"]`)
    .click();
async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".g-toast").waitFor({ state: "hidden", timeout: 12000 });
  await page.screenshot({
    path: new URL(name, media).pathname,
    fullPage: true,
    animations: "disabled",
  });
  console.log(`Screenshot: ${name}`);
}
function observe(page) {
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith(url) && !request.url().startsWith("data:"))
      errors.push("Unexpected external request: " + request.url());
  });
}

try {
  await command(ffmpeg, ["-version"]);
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null)
      throw new Error("Preview server exited; port 4174 may be occupied.");
    try {
      if ((await fetch(url)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  if (!ready) throw new Error("Preview server not ready");
  browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    recordVideo: {
      dir: recordings.pathname,
      size: { width: 1440, height: 1080 },
    },
  });
  const page = await context.newPage();
  observe(page);
  await page.goto(url);
  await page.locator(".g-office-station").first().waitFor();
  await shot(page, "office.png");
  await page.waitForTimeout(1800);
  await page.locator('[data-action="office-play"]').click();
  await page.locator('[data-action="flow-intake"]').click();
  await shot(page, "intake.png");
  await page
    .getByLabel("업무 대상 링크 또는 이름")
    .fill("https://github.com/example/product/pull/55");
  await page.getByLabel("대상 커밋 또는 관측 버전").fill("feed123");
  await page
    .getByLabel("요청할 내용")
    .fill("로그인 변경 검토와 QA 계획을 이어주세요.");
  await page.getByRole("button", { name: "요청 확인", exact: true }).click();
  await page.waitForTimeout(1400);
  await page.locator('[data-action="flow-create"]').click();
  await page.locator('[data-action="start-task"]').click();
  await page.locator('[data-action="flow-handoff"]').waitFor();
  await shot(page, "work-brief.png");
  await page.waitForTimeout(2000);
  await page.locator('[data-action="flow-handoff"]').click();
  await page.locator('[data-action="start-task"]').click();
  await page.locator('[data-action="flow-accept"]').waitFor();
  await page.locator('[data-action="task-tab"][data-value="result"]').click();
  await shot(page, "artifacts.png");
  await page.waitForTimeout(1800);
  await page.locator('[data-action="flow-accept"]').click();
  await page.waitForTimeout(1600);
  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  const gifFilter =
    "fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3";
  await command(ffmpeg, [
    "-y",
    "-i",
    videoPath,
    "-vf",
    gifFilter,
    "-loop",
    "0",
    new URL("workflow.gif", media).pathname,
  ]);
  await command(ffmpeg, [
    "-y",
    "-t",
    "6",
    "-i",
    videoPath,
    "-vf",
    gifFilter,
    "-loop",
    "0",
    new URL("office.gif", media).pathname,
  ]);
  console.log("GIFs: office.gif, workflow.gif");

  const gallery = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const screen = await gallery.newPage();
  observe(screen);
  await screen.goto(url);
  await screen.locator('[data-action="office-play"]').click();
  await agent(screen, "dev");
  await shot(screen, "conversations.png");
  await screen.locator('[data-action="conversation-access"]').click();
  await shot(screen, "sharing.png");
  await screen.getByRole("button", { name: "닫기", exact: true }).click();

  await agent(screen, "qa");
  await screen.getByRole("tab", { name: /스킬/ }).click();
  await screen.locator('[data-action="run-skill"][data-id="release"]').click();
  await screen
    .getByRole("button", { name: "샘플 업무 실행", exact: true })
    .click();
  await screen.getByRole("button", { name: "일시정지", exact: true }).click();
  await agent(screen, "qa");
  await screen.getByRole("tab", { name: /스킬/ }).click();
  await screen
    .locator('[data-action="skill-detail"][data-id="release"]')
    .click();
  await screen
    .getByRole("button", { name: "다음 버전 만들기", exact: true })
    .click();
  await screen
    .getByRole("button", { name: "샘플 버전 게시", exact: true })
    .click();
  await screen.waitForTimeout(4000);
  await shot(screen, "skills.png");
  await nav(screen, "work");
  await screen.locator('[data-action="select-task"][data-id="T-109"]').click();
  await screen
    .locator('[data-action="task-tab"][data-value="execution"]')
    .click();
  await shot(screen, "execution.png");
  await nav(screen, "memory");
  await shot(screen, "memory.png");
  await screen.locator('[data-view="assistant"]').click();
  await screen.locator('[data-action="settings"]').click();
  await shot(screen, "personal-assistant.png");
  await screen.getByRole("button", { name: "닫기", exact: true }).click();
  await nav(screen, "office");
  await screen.locator('[data-action="flow-import"]').click();
  await screen
    .getByLabel("업무 대상 링크 또는 이름")
    .fill("https://github.com/example/product/pull/78");
  await screen.getByLabel("대상 커밋 또는 관측 버전").fill("a01bc34");
  await screen
    .getByLabel("공유할 결과 내용")
    .fill(
      "개인 검토에서 정리한 후속 확인 항목\n1. 만료된 세션 복구\n2. 다중 탭에서 재로그인\n실제 테스트 실행 결과는 별도 확인이 필요합니다.",
    );
  await screen.getByLabel("결과 출처").fill("개인 review.md · 2026-10-17");
  await screen
    .getByRole("button", { name: "공유할 내용 확인", exact: true })
    .click();
  await shot(screen, "import-result.png");
  await gallery.close();

  const roles = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    recordVideo: {
      dir: recordings.pathname,
      size: { width: 1440, height: 1080 },
    },
  });
  const roleScreen = await roles.newPage();
  observe(roleScreen);
  await roleScreen.goto(url);
  await roleScreen.locator('[data-action="office-play"]').click();
  await roleScreen.locator('[data-action="start-signup"]').click();
  await roleScreen.waitForTimeout(1000);
  await shot(roleScreen, "signup.png");
  await roleScreen
    .getByLabel("이름", { exact: true })
    .pressSequentially("서연", { delay: 100 });
  await roleScreen
    .getByLabel("이메일", { exact: true })
    .pressSequentially("seoyeon@example.com", { delay: 35 });
  await roleScreen
    .getByLabel("나의 비서 이름", { exact: true })
    .pressSequentially("보리", { delay: 100 });
  await roleScreen
    .getByLabel("소속 부서", { exact: true })
    .selectOption("development");
  await roleScreen.waitForTimeout(700);
  await roleScreen
    .getByLabel("팀장 권한을 요청할게요", { exact: false })
    .check();
  await roleScreen.waitForTimeout(1200);
  await roleScreen
    .getByRole("button", { name: "참여하고 권한 요청", exact: true })
    .click();
  await roleScreen.waitForTimeout(4200);
  await roleScreen.locator("#g-account-select").selectOption("roopre");
  await nav(roleScreen, "admin");
  await shot(roleScreen, "team-admin.png");
  await roleScreen.locator("#g-admin-tab-members").click();
  await roleScreen.waitForTimeout(1400);
  await shot(roleScreen, "team-members.png");
  await roleScreen
    .locator('[data-action="admin-tab"][data-value="stewardship"]')
    .first()
    .click();
  await roleScreen.waitForTimeout(1200);
  await shot(roleScreen, "skill-stewards.png");
  await roleScreen.locator("#g-account-select").selectOption("minji");
  await roleScreen.waitForTimeout(4200);
  await nav(roleScreen, "home");
  await shot(roleScreen, "member-workspace.png");
  await roleScreen
    .getByRole("button", { name: "비서에게 말 걸기", exact: true })
    .click();
  await roleScreen.waitForTimeout(1400);
  const roleVideo = roleScreen.video();
  await roles.close();
  await command(ffmpeg, [
    "-y",
    "-i",
    await roleVideo.path(),
    "-vf",
    gifFilter,
    "-loop",
    "0",
    new URL("roles.gif", media).pathname,
  ]);
  console.log("GIF: roles.gif");

  if (errors.length) throw new Error(JSON.stringify(errors));
  const files = [];
  for (const name of [
    "office.png",
    "intake.png",
    "work-brief.png",
    "artifacts.png",
    "import-result.png",
    "skill-stewards.png",
    "conversations.png",
    "sharing.png",
    "skills.png",
    "execution.png",
    "memory.png",
    "personal-assistant.png",
    "office.gif",
    "workflow.gif",
    "signup.png",
    "member-workspace.png",
    "team-admin.png",
    "team-members.png",
    "roles.gif",
  ]) {
    const buffer = await readFile(new URL(name, media));
    files.push({
      name,
      bytes: (await stat(new URL(name, media))).size,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    });
  }
  await writeFile(
    new URL("manifest.json", media),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source: "Production Vite build rendered in Chromium; real UI actions",
        viewport: { width: 1440, height: 1080 },
        gif: { width: 1200, fps: 12 },
        scenario: [
          "Office activity",
          "Target-first intake with pinned SHA",
          "Review artifact and hand off to QA in one task",
          "Inspect result",
          "Accept a specific simulation artifact version",
          "Request lead role, then switch to existing lead for administration",
          "Inspect team administration and member departments",
          "Switch to a member workspace and personal assistant",
        ],
        pageErrors: errors,
        files,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Capture complete. No page errors or external requests.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
