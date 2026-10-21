import { test, expect } from "@playwright/test";
async function login(page) {
  await page.goto("/");
  await page.getByLabel("이메일", { exact: true }).fill("designer@e2e.invalid");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("test-only-e2e-passphrase");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "함께 일하는 오피스", exact: true }),
  ).toBeVisible();
}
test("a short request becomes a persisted skill through dialogue, direct edits, an example and one save/apply action", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await page.locator('.cr-nav[href="#/skills"]').click();
  await page
    .getByRole("button", { name: "AI와 스킬 만들기", exact: true })
    .click();
  await page
    .getByLabel("만들고 싶은 업무", { exact: true })
    .fill("매주 업무를 세 줄 요약으로 정리하는 스킬을 만들어줘");
  await page.getByRole("button", { name: "초안 만들기", exact: true }).click();
  await expect(page.locator(".cr-studio-document")).toBeVisible();
  await expect(page.locator(".cr-studio-thread")).toContainText(
    "반복 업무의 초안",
  );
  await page
    .getByRole("button", {
      name: "완료 기준을 더 구체적으로 써줘",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "수정 요청", exact: true }).click();
  await expect(page.locator(".cr-studio-thread .cr-studio-reply")).toHaveCount(
    3,
  );
  await page.locator(".cr-studio-manual summary").click();
  const name = "대화로 만든 주간 정리";
  await page.getByLabel("스킬 이름", { exact: true }).fill(name);
  await page
    .getByLabel("스킬 지침", { exact: true })
    .fill(
      "입력한 업무를 성과·장애·다음 계획으로 세 줄 이내에 정리한다. 없으면 질문한다.",
    );
  await page.getByRole("button", { name: "초안에 반영", exact: true }).click();
  await expect(page.locator(".cr-studio-document h2")).toHaveText(name);
  await page.locator(".cr-studio-sample summary").click();
  await page
    .getByLabel("예시 입력", { exact: true })
    .fill("로그인 수정 완료, 배포 지연, QA 예정");
  await page
    .getByRole("button", { name: "예시 결과 만들기", exact: true })
    .click();
  await expect(page.locator(".cr-studio-sample-output")).toContainText(
    "테스트 fixture 예시",
  );
  await page.reload();
  await expect(page.locator(".cr-studio-document h2")).toHaveText(name);
  await expect(page.locator(".cr-studio-sample-output")).toBeVisible();
  await expect(page.getByLabel("예시 입력", { exact: true })).toHaveValue(
    "로그인 수정 완료, 배포 지연, QA 예정",
  );
  const workshop = page.url();
  await page.getByLabel("스킬 공개 대상", { exact: true }).selectOption("team");
  await page
    .getByLabel("저장 후 적용할 동료", { exact: true })
    .selectOption("dev");
  await page
    .getByLabel("추가로 바꾸고 싶은 점", { exact: true })
    .fill("실시간 갱신 중에도 보존할 수정 요청");
  const csrf = (await (await page.request.get("/api/auth/session")).json())
    .csrfToken;
  const id = workshop.split("/").at(-1);
  await page.request.post(`/api/tasks/${id}/messages`, {
    headers: { origin: "http://127.0.0.1:4186", "x-csrf-token": csrf },
    data: { body: "실시간 초안 보존 확인" },
  });
  await expect(page.locator(".cr-studio-thread")).toContainText(
    "실시간 초안 보존 확인",
  );
  await expect(
    page.getByLabel("저장 후 적용할 동료", { exact: true }),
  ).toHaveValue("dev");
  await expect(
    page.getByLabel("추가로 바꾸고 싶은 점", { exact: true }),
  ).toHaveValue("실시간 갱신 중에도 보존할 수정 요청");
  await expect(
    page.getByLabel("추가로 바꾸고 싶은 점", { exact: true }),
  ).toBeFocused();
  await page
    .getByLabel("스킬 공개 대상", { exact: true })
    .selectOption("private");
  await page
    .getByLabel("저장 후 적용할 동료", { exact: true })
    .selectOption({ label: "나의 비서 · 내 비서" });
  await page.getByRole("button", { name: "스킬 저장", exact: true }).click();
  await expect(page.locator(".cr-studio-saved")).toContainText(
    "저장 완료 · v1",
  );
  await page.locator('.cr-nav[href="#/skills"]').click();
  await page.getByLabel("스킬 검색", { exact: true }).fill(name);
  await page.getByRole("button", { name: "찾기", exact: true }).click();
  const card = page.locator(".cr-skill").filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(card).toContainText("나의 비서");
  await page.goto(workshop);
  await page
    .getByRole("button", { name: "이 스킬로 업무 시작", exact: true })
    .click();
  await expect(page.getByLabel("사용할 스킬", { exact: true })).toHaveValue(
    /custom-/,
  );
  expect(errors).toEqual([]);
});
test("an unconfigured AI offers direct writing and does not produce simulated AI results", async ({
  page,
}) => {
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.runtime.modelConfigured = false;
    body.runtime.fixture = false;
    await route.fulfill({ response, json: body });
  });
  await login(page);
  await page.goto("/#/skill-studio/new");
  await expect(page.locator(".cr-studio-alert")).toContainText(
    "AI 모델 연결이 필요해요",
  );
  await expect(
    page.getByRole("button", { name: "초안 만들기", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "직접 작성하기", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByLabel("반복 업무 지침", { exact: true }),
  ).toBeEditable();
});
for (const width of [1440, 1280, 1024])
  test(`the desktop skill studio fits ${width}px and supports keyboard input`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.goto("/#/skill-studio/new");
    await expect(page.locator(".cr-studio")).toBeVisible();
    await page
      .getByLabel("만들고 싶은 업무", { exact: true })
      .fill("누락 자료를 질문하는 QA 스킬");
    await page.getByLabel("만들고 싶은 업무", { exact: true }).press("Tab");
    await expect(
      page.getByRole("button", { name: "초안 만들기", exact: true }),
    ).toBeFocused();
    // A live refresh must also preserve the unnamed submit button after Tab.
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/workspace") && r.ok()),
      page.evaluate(() =>
        window.dispatchEvent(new HashChangeEvent("hashchange")),
      ),
    ]);
    await expect(
      page.getByRole("button", { name: "초안 만들기", exact: true }),
    ).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
