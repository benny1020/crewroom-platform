import { test, expect } from "@playwright/test";
test("operator sees successful worker progress and bounded automatic cleanup", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("이메일", { exact: true }).fill("designer@e2e.invalid");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("test-only-e2e-passphrase");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.locator('.cr-nav[href="#/admin"]').click();
  await expect(
    page.getByRole("heading", { name: "서버와 실행 상태", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".cr-worker-row")).toContainText("마지막 처리");
  await expect(page.locator(".cr-worker-row")).toContainText("응답 중");
  await expect(page.getByText(/자동 정리 .*만료 세션/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
