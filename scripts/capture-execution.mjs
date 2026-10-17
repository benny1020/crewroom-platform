import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
export async function captureExecution(origin, id) {
  const directory = "docs/media/execution";
  await mkdir(directory, { recursive: true });
  await mkdir(".capture/execution", { recursive: true });
  const browser = await chromium.launch(),
    context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
      recordVideo: {
        dir: ".capture/execution",
        size: { width: 1440, height: 1080 },
      },
    }),
    page = await context.newPage(),
    pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  try {
    await page.goto(origin);
    await page.getByLabel("이메일", { exact: true }).fill("lead@example.com");
    await page
      .getByLabel("비밀번호", { exact: true })
      .fill("test-only-passphrase-2026");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page.locator(".cr-main")).toBeVisible();
    await page.goto(origin + "/#/tasks/" + id);
    await expect(page.locator(".cr-code-result")).toHaveCount(2);
    await page.screenshot({ path: directory + "/workroom.png" });
    await page.locator(".cr-code-result").first().scrollIntoViewIfNeeded();
    await page.locator(".cr-check summary").first().click();
    await page
      .locator(".cr-code-result")
      .first()
      .screenshot({ path: directory + "/checks-and-diff.png" });
    await page.screenshot({ path: directory + "/qa-result.png" });
    await page
      .getByRole("link", { name: "스킬 라이브러리", exact: true })
      .click();
    await page
      .getByRole("button", { name: "새 스킬 만들기", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: directory + "/skill-editor.png" });
    await page.getByRole("button", { name: "취소", exact: true }).click();
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 1080 });
      await page.goto(origin + "/#/tasks/" + id);
      await expect(page.locator(".cr-code-result")).toHaveCount(2);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      if (overflow) throw new Error("Execution page overflow " + width);
    }
  } finally {
    const video = page.video();
    await context.close();
    const videoPath = await video.path();
    await browser.close();
    await writeFile(".capture/execution/path.txt", videoPath);
    const encoder = spawn(
      process.env.FFMPEG_BIN || "ffmpeg",
      [
        "-y",
        "-i",
        videoPath,
        "-filter_complex",
        "fps=5,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=80[p];[s1][p]paletteuse=dither=bayer",
        "-loop",
        "0",
        directory + "/execution.gif",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    encoder.stderr.on("data", (d) => (errors = (errors + d).slice(-2000)));
    const [code, signal] = await once(encoder, "close");
    if (code !== 0)
      throw new Error(`GIF encoder failed (${signal || code}): ${errors}`);
  }
  if (pageErrors.length) throw new Error(pageErrors.join("\n"));
  const files = [];
  for (const name of (await readdir(directory)).filter((n) =>
    /\.(png|gif)$/.test(n),
  )) {
    const bytes = await readFile(directory + "/" + name);
    files.push({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(
    directory + "/manifest.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        release: "0.6.0",
        pageErrors,
        proof:
          "Actual PostgreSQL + Docker execution; deterministic local Claude protocol fixture, not real model inference",
        files,
      },
      null,
      2,
    ) + "\n",
  );
}
