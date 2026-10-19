// Uses the isolated E2E server; all conversations are synthetic.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = "docs/media/longevity";
await mkdir(directory, { recursive: true });
await mkdir(".capture/longevity", { recursive: true });
const browser = await chromium.launch(),
  context = await browser.newContext({
    baseURL: "http://127.0.0.1:4186",
    viewport: { width: 1440, height: 1080 },
    recordVideo: {
      dir: ".capture/longevity",
      size: { width: 1440, height: 1080 },
    },
  }),
  page = await context.newPage(),
  pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
try {
  await page.goto("http://127.0.0.1:4186");
  await page.getByLabel("이메일", { exact: true }).fill("lead@e2e.invalid");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("test-only-e2e-passphrase");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.locator(".cr-main")).toBeVisible();
  const archive = await (
    await page.request.get(
      "/api/tasks?q=" + encodeURIComponent("긴 대화 회귀 전용"),
    )
  ).json();
  await page.goto("http://127.0.0.1:4186/#/tasks/" + archive.tasks[0].id);
  await expect(page.locator(".cr-discussion .cr-message")).toHaveCount(40);
  await page.locator(".cr-discussion").scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: directory + "/recent-page.png" });
  await page
    .getByLabel("추가 조건 또는 업무 대화", { exact: true })
    .fill("읽던 위치와 함께 보존하는 작성 중 초안");
  await page
    .getByRole("button", { name: "이전 대화 더 보기", exact: true })
    .click();
  await expect(page.locator(".cr-discussion .cr-message")).toHaveCount(40);
  await page.waitForTimeout(900);
  await page
    .getByLabel("이 업무의 과거 대화 검색", { exact: true })
    .fill("ARCHIVE_NEEDLE_OLD");
  await page.getByRole("button", { name: "대화 검색", exact: true }).click();
  await expect(page.locator(".cr-discussion .cr-message")).toHaveCount(1);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: directory + "/old-source-search.png" });
  await page
    .getByLabel("대화 이력 이동", { exact: true })
    .getByRole("button", { name: "최근 기록으로", exact: true })
    .click();
  await expect(page.locator(".cr-discussion .cr-message")).toHaveCount(40);
  await page.waitForTimeout(900);
  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  const ffmpeg = spawn(
    process.env.FFMPEG_BIN || "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-filter_complex",
      "fps=6,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer",
      "-loop",
      "0",
      directory + "/history.gif",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let err = "";
  ffmpeg.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
  if ((await once(ffmpeg, "close"))[0] !== 0) throw Error(err);
  if (pageErrors.length) throw Error(pageErrors.join("\n"));
  const files = [];
  for (const name of (await readdir(directory))
    .filter((n) => /\.(png|gif)$/.test(n))
    .sort()) {
    const b = await readFile(directory + "/" + name);
    files.push({
      name,
      bytes: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
    });
  }
  await writeFile(
    directory + "/manifest.json",
    JSON.stringify(
      {
        release: "0.11.0",
        capturedAt: new Date().toISOString(),
        mode: "isolated PostgreSQL/App/Worker; 1007 synthetic messages; no real model",
        viewport: { width: 1440, height: 1080 },
        pageErrors,
        files,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
