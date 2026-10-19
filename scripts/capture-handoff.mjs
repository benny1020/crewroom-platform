// Isolated App/PostgreSQL/Worker fixture only; never a connected account.
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
const directory = "docs/media/handoff";
await mkdir(directory, { recursive: true });
await mkdir(".local/handoff-video", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1080 },
  recordVideo: {
    dir: ".local/handoff-video",
    size: { width: 1440, height: 1080 },
  },
});
const page = await context.newPage(),
  pageErrors = [],
  files = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const login = async (p, email) => {
  await p.goto("http://127.0.0.1:4186");
  await p.getByLabel("이메일", { exact: true }).fill(email);
  await p
    .getByLabel("비밀번호", { exact: true })
    .fill("test-only-e2e-passphrase");
  await p.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(p.locator(".cr-main")).toBeVisible();
};
const shot = async (name) => {
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: `${directory}/${name}`, fullPage: true });
  files.push(name);
};
try {
  await login(page, "lead@e2e.invalid");
  const workspace = await (
    await page.request.get("http://127.0.0.1:4186/api/workspace")
  ).json();
  if (!workspace.runtime.fixture || workspace.release !== "0.10.0")
    throw Error("Requires 0.10.0 isolated fixture");
  await page.getByRole("button", { name: /^노아 · 코드 리뷰/ }).click();
  await page
    .getByLabel("선택한 동료", { exact: true })
    .locator('[data-action="use-skill"]')
    .first()
    .click();
  await page
    .getByLabel("업무 대상 링크 또는 이름")
    .fill("로그인 재시도 변경 자료");
  await page.getByLabel("대상 커밋 또는 관측 버전").fill("login-review-v2");
  await page.getByLabel("프로젝트", { exact: true }).fill("서비스 품질");
  await page
    .getByLabel("요청할 내용")
    .fill("재시도 조건을 검토하고 확인 근거와 남은 QA 항목을 정리해주세요.");
  await shot("request.png");
  await page
    .getByRole("button", { name: "공개 내용 확인", exact: true })
    .click();
  await page
    .getByRole("button", { name: "업무 접수하기", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tasks\//);
  const taskUrl = page.url();
  await page.getByRole("button", { name: "실행 시작", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "이 결과 수용", exact: true }),
  ).toBeVisible();
  await shot("workroom.png");
  await page.getByText("담당자를 지정해 질문하기", { exact: true }).click();
  await page
    .getByLabel("확인할 질문", { exact: true })
    .fill("QA 확인 환경은 어디인가요?");
  await page
    .getByLabel("답할 사람", { exact: true })
    .selectOption({ label: "민지" });
  await page.getByRole("button", { name: "질문 보내기", exact: true }).click();
  await expect(
    page.getByLabel("현재 인계 요약", { exact: true }),
  ).toContainText("답변 1건");
  await shot("question.png");
  const memberContext = await browser.newContext(),
    member = await memberContext.newPage();
  member.on("pageerror", (e) => pageErrors.push(e.message));
  await login(member, "member@e2e.invalid");
  await member.getByRole("link", { name: "내가 할 일", exact: true }).click();
  await expect(
    member.getByRole("link", { name: /QA 확인 환경은 어디인가요/ }),
  ).toBeVisible();
  await member.screenshot({ path: `${directory}/inbox.png`, fullPage: true });
  files.push("inbox.png");
  await member.getByRole("link", { name: /QA 확인 환경은 어디인가요/ }).click();
  await member
    .getByLabel("답변", { exact: true })
    .fill("staging 환경에서 세션 만료와 재시도를 확인해주세요.");
  await member.getByRole("button", { name: "답변 저장", exact: true }).click();
  await expect(
    member.getByLabel("업무 질문", { exact: true }).locator("blockquote"),
  ).toContainText("staging");
  await memberContext.close();
  await page.goto(taskUrl);
  await expect(
    page.getByLabel("현재 인계 요약", { exact: true }),
  ).toContainText("새 답변이 아직");
  await page.getByRole("button", { name: "재작업 요청", exact: true }).click();
  await page
    .getByLabel("재작업 이유", { exact: true })
    .fill("답변한 staging 환경을 기준으로 검토 범위를 보완해주세요.");
  await page.getByRole("button", { name: "새 실행 준비", exact: true }).click();
  await page.getByRole("button", { name: "실행 시작", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "이 결과 수용", exact: true }),
  ).toBeVisible();
  await shot("rework.png");
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: 1080 });
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      throw Error(`Overflow at ${width}`);
  }
  const video = page.video();
  await context.close();
  const encoder = spawn(
    process.env.FFMPEG_BIN || "ffmpeg",
    [
      "-y",
      "-i",
      await video.path(),
      "-filter_complex",
      "fps=5,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer",
      "-loop",
      "0",
      `${directory}/workflow.gif`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  encoder.stderr.on("data", (c) => (errors = (errors + c).slice(-1500)));
  if ((await once(encoder, "close"))[0] !== 0) throw Error(errors);
  files.push("workflow.gif");
  if (pageErrors.length) throw Error("Browser errors");
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
        release: "0.10.0",
        capturedAt: new Date().toISOString(),
        mode: "isolated App/PostgreSQL/Worker, deterministic model fixture, no external inference",
        viewport: { width: 1440, height: 1080 },
        checkedDesktopWidths: [1440, 1280, 1024],
        pageErrors,
        files: receipts,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Handoff request, inbox, question, rework screenshots and GIF captured.",
  );
} finally {
  await browser.close();
}
