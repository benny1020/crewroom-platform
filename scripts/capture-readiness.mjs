// Only the isolated synthetic server from scripts/server-e2e.mjs is supported.
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";

const directory = "docs/media/readiness";
await mkdir(directory, { recursive: true });
await mkdir(".local/readiness-video", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
  recordVideo: {
    dir: ".local/readiness-video",
    size: { width: 1440, height: 1080 },
  },
});
const page = await context.newPage();
const pageErrors = [],
  files = [],
  desktopWidths = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const capture = async (name) => {
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
    document.querySelector(".cr-main")?.scrollTo(0, 0);
  });
  await page.screenshot({ path: `${directory}/${name}`, fullPage: true });
  files.push(name);
};
try {
  await page.goto("http://127.0.0.1:4186");
  await page.getByLabel("이메일", { exact: true }).fill("lead@e2e.invalid");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("test-only-e2e-passphrase");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.locator(".cr-main")).toBeVisible();
  const workspace = await page.request.get(
    "http://127.0.0.1:4186/api/workspace",
  );
  if (!workspace.ok() || !(await workspace.json()).runtime?.fixture)
    throw new Error("Capture requires an isolated fixture workspace");
  await page.getByRole("button", { name: /^노아 · 코드 리뷰/ }).click();
  await capture("office.png");
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 1080 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    if (overflow) throw new Error(`Office overflows at ${width}px`);
    desktopWidths.push(width);
  }
  await capture("office-1024.png");
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page
    .getByLabel("선택한 동료", { exact: true })
    .locator('[data-action="use-skill"]')
    .first()
    .click();
  await page
    .getByLabel("맡길 일 또는 대화")
    .fill("재시도 조건을 검토하고, 확인한 근거와 남은 QA 항목을 정리해주세요.");
  await expect(page.locator(".cr-skill-guide")).toContainText(
    "이번 요청에 적용할 스킬 v",
  );
  await capture("skill-request.png");
  await page
    .getByRole("button", { name: "업무방 열고 시작", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tasks\//);
  await expect(
    page.getByRole("heading", { name: "결과 v1", exact: true }),
  ).toBeVisible();
  await capture("workroom.png");
  await page.getByRole("link", { name: "팀 관리", exact: true }).click();
  await expect(page.getByLabel("운영 현황", { exact: true })).toBeVisible();
  await capture("operations.png");
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 1080 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw new Error(`Operations overflows at ${width}px`);
  }
  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  const encoder = spawn(
    process.env.FFMPEG_BIN || "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-filter_complex",
      "fps=5,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer",
      "-loop",
      "0",
      `${directory}/workflow.gif`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let encoderErrors = "";
  encoder.stderr.on(
    "data",
    (chunk) => (encoderErrors = (encoderErrors + chunk).slice(-1500)),
  );
  if ((await once(encoder, "close"))[0] !== 0) throw new Error(encoderErrors);
  files.push("workflow.gif");
  if (pageErrors.length) throw new Error("Capture contains browser errors");
  const receipts = [];
  for (const name of files) {
    const data = await readFile(`${directory}/${name}`);
    receipts.push({
      name,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  await writeFile(
    `${directory}/manifest.json`,
    JSON.stringify(
      {
        release: "0.9.0",
        capturedAt: new Date().toISOString(),
        mode: "isolated PostgreSQL/App/Worker + deterministic model fixture; no external model calls",
        viewport: { width: 1440, height: 1080 },
        checkedDesktopWidths: [1440, ...desktopWidths],
        pageErrors,
        files: receipts,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Readiness screenshots and GIF captured; desktop overflow and browser errors checked.",
  );
} finally {
  await browser.close();
}
