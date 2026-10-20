import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
test("agent home and task share real documents, paged body and escaped version paths", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("이메일", { exact: true }).fill("member@e2e.invalid");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("test-only-e2e-passphrase");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "함께 일하는 오피스", exact: true }),
  ).toBeVisible();
  await page.goto("/#/agents/dev");
  const files = page.getByLabel("에이전트 작업공간", { exact: true });
  await expect(files).toContainText("notes/plan.md");
  if (process.env.CAPTURE_WORKSPACE) {
    await mkdir("docs/media/workspace", { recursive: true });
    await page.screenshot({ path: "docs/media/workspace/agent-home.png" });
  }
  await files.getByRole("button", { name: /notes\/plan.md/ }).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toContainText("초안 v3");
  await expect(modal.locator("pre")).toContainText("검사: 미실행");
  if (process.env.CAPTURE_WORKSPACE)
    await page.screenshot({ path: "docs/media/workspace/document.png" });
  await modal.getByText("문서 버전 이력", { exact: true }).click();
  await expect(
    modal.getByRole("button", { name: /v1 · notes\/.*input/ }),
  ).toBeVisible();
  await expect(modal.locator('input[data-action="logout"]')).toHaveCount(0);
  await modal
    .getByRole("button", { name: "본문 더 읽기", exact: true })
    .click();
  await expect(modal.locator("pre")).toContainText(
    "작업 원문을 나눠 읽을 수 있습니다.",
  );
  await expect(
    modal.getByRole("button", { name: "본문 더 읽기", exact: true }),
  ).toHaveCount(0);
  await modal.getByText("문서 버전 이력", { exact: true }).click();
  await modal.getByRole("button", { name: /v1 · notes\/.*input/ }).click();
  await expect(modal.locator("pre")).toHaveText("첫 번째 계획 초안");
  await modal
    .getByRole("link", { name: "원래 업무방 열기", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tasks\//);
  await expect(
    page.getByRole("heading", { name: "작업공간 브라우저 검증", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("에이전트 작업공간", { exact: true }),
  ).toContainText("notes/plan.md");
  if (process.env.CAPTURE_WORKSPACE)
    await page.screenshot({ path: "docs/media/workspace/workroom.png" });
  await page.setViewportSize({ width: 1024, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
