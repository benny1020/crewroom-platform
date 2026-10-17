// Capture the isolated server fixture from scripts/server-e2e.mjs, never a live account.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = "docs/media/server";
await mkdir(directory, { recursive: true });
await mkdir(".capture/server-video", { recursive: true });
const browser = await chromium.launch(),
  context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    recordVideo: {
      dir: ".capture/server-video",
      size: { width: 1440, height: 1080 },
    },
  }),
  page = await context.newPage(),
  pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto("http://127.0.0.1:4186");
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${directory}/login.png` });
await page.getByLabel("이메일", { exact: true }).fill("lead@e2e.invalid");
await page
  .getByLabel("비밀번호", { exact: true })
  .fill("test-only-e2e-passphrase");
await page.getByRole("button", { name: "로그인", exact: true }).click();
await expect(page.locator(".cr-main")).toBeVisible();
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${directory}/office.png` });
await page.getByRole("button", { name: "새 업무 시작", exact: true }).click();
await page.getByLabel("업무 대상 링크 또는 이름").fill("결제 상태 변경 검토");
await page.getByLabel("대상 커밋 또는 관측 버전").fill("demo-input-v1");
await page
  .getByLabel("요청할 내용")
  .fill("중복 요청과 세션 만료 조건을 검토하고 QA로 인계해주세요");
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${directory}/intake.png` });
await page.getByRole("button", { name: "공개 내용 확인", exact: true }).click();
await page.getByRole("button", { name: "업무 접수하기", exact: true }).click();
await page.getByRole("button", { name: "실행 시작", exact: true }).click();
await expect(
  page.getByRole("button", { name: "이 결과로 QA에 넘기기", exact: true }),
).toBeVisible();
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${directory}/workroom.png` });
await page
  .getByLabel("추가 조건 또는 업무 대화")
  .fill("QA는 만료된 세션의 재시도도 포함해주세요.");
await page.getByRole("button", { name: "맥락 남기기", exact: true }).click();
await page
  .getByRole("button", { name: "이 결과로 QA에 넘기기", exact: true })
  .click();
await page.getByRole("button", { name: "실행 시작", exact: true }).click();
await expect(
  page.getByRole("button", { name: "이 결과 수용", exact: true }),
).toBeVisible();
await page.getByRole("button", { name: "이 결과 수용", exact: true }).click();
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${directory}/accepted.png` });
await page.goto("http://127.0.0.1:4186/#/admin");
await expect(
  page.getByRole("heading", { name: "팀 관리", exact: true }),
).toBeVisible();
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${directory}/admin.png` });
const video = page.video();
await context.close();
const videoPath = await video.path();
await browser.close();
if (pageErrors.length) throw new Error(pageErrors.join("\n"));
await writeFile(".capture/server-video/path.txt", videoPath);
const encoder = spawn(
  process.env.FFMPEG_BIN || "ffmpeg",
  [
    "-y",
    "-i",
    videoPath,
    "-filter_complex",
    "fps=6,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer",
    "-loop",
    "0",
    `${directory}/workflow.gif`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let encoderErrors = "";
encoder.stderr.on(
  "data",
  (chunk) => (encoderErrors = (encoderErrors + chunk).slice(-2000)),
);
const [encoderStatus] = await once(encoder, "close");
if (encoderStatus !== 0)
  throw new Error(
    encoderErrors || "Set FFMPEG_BIN to a working ffmpeg executable",
  );
const files = [];
for (const name of (await readdir(directory))
  .filter((n) => /\.(png|gif)$/.test(n))
  .sort()) {
  const b = await readFile(`${directory}/${name}`);
  files.push({
    name,
    bytes: b.length,
    sha256: createHash("sha256").update(b).digest("hex"),
  });
}
await writeFile(
  `${directory}/manifest.json`,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      mode: "real server + isolated PostgreSQL + deterministic fixture; no external model calls",
      viewport: { width: 1440, height: 1080 },
      pageErrors,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log("Server fixture screenshots captured without browser errors.");
