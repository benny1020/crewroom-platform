import { test, expect } from "@playwright/test";

const nav = (page, view) =>
  page.locator(`.g-nav-button[data-view="${view}"]`).click();
const agent = (page, id) =>
  page
    .locator(`.g-dept-children [data-action="agent"][data-id="${id}"]`)
    .click();
const submit = (page, kind) =>
  page.locator(`form[data-form="${kind}"] [data-action="submit-form"]`).click();
const snapshot = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("gyeot-prototype-v1")));

const pageErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".g-office-station")).toHaveCount(8);
  await page.locator('[data-action="office-play"]').click();
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test("four departments, meaningful activity and no page errors", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".g-office-room")).toHaveCount(4);
  await expect(page.locator(".g-workspace-summary")).toContainText(
    "내 답변 대기",
  );
  await page.locator('[data-action="office-motion"]').click();
  const motion = await page
    .locator(".g-office-paw")
    .first()
    .evaluate((el) => getComputedStyle(el).animationPlayState);
  expect(motion).toBe("paused");
  await page.locator('[data-action="view-results"]').click();
  await expect(page.locator(".g-task-list")).toContainText(
    "이번 주 제품팀 업무 정리",
  );
  expect(errors).toEqual([]);
});

test("developer diary follows the selected task and respects both motion controls", async ({
  page,
}) => {
  const diary = page.getByRole("region", {
    name: "카이의 개발 일지",
    exact: true,
  });
  await expect(diary).toHaveAttribute("data-phase", "paused");
  await expect(diary).toContainText("샘플 상태");
  await expect(diary).toContainText("잠깐 멈춰 있어요");
  await page.locator('[data-action="office-play"]').click();
  await expect(diary).toHaveAttribute("data-phase", "coding");
  await page.locator('[data-action="office-motion"]').click();
  const scene = diary.locator(".g-diary-illustration");
  expect(
    await scene.evaluate((el) => getComputedStyle(el).animationPlayState),
  ).toBe("paused");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await scene.evaluate((el) => getComputedStyle(el).animationName)).toBe(
    "none",
  );
  await page.locator('.g-office-station[data-id="qa"]').click();
  await expect(
    page.getByRole("region", { name: "린의 업무 일지", exact: true }),
  ).toBeVisible();
  await expect(diary).toHaveCount(0);
  await page.locator('.g-office-station[data-id="dev"]').click();
  await page
    .getByRole("button", { name: "카이 캐릭터 바꾸기", exact: true })
    .click();
  await page.getByRole("button", { name: "토끼 캐릭터", exact: true }).click();
  await page.getByRole("button", { name: "캐릭터 적용", exact: true }).click();
  await expect(diary.locator('[data-character="rabbit"]')).toBeVisible();
  await expect(diary.locator(".g-diary-illustration")).toHaveCount(0);
  await expect(
    page.locator('.g-office-station[data-id="dev"] [data-character="rabbit"]'),
  ).toBeVisible();
  await page.reload();
  await expect(diary.locator('[data-character="rabbit"]')).toBeVisible();
  await page
    .getByRole("button", { name: "카이 캐릭터 바꾸기", exact: true })
    .click();
  await page.getByRole("button", { name: "수달 캐릭터", exact: true }).click();
  await page.getByRole("button", { name: "캐릭터 적용", exact: true }).click();
  await expect(diary.locator(".g-diary-illustration")).toBeVisible();
  await expect(
    page.locator('.g-office-station[data-id="dev"] .g-diary-illustration'),
  ).toBeVisible();
});

test("private conversations and their memories remain private after user switching", async ({
  page,
}) => {
  await agent(page, "dev");
  await page.getByRole("button", { name: "새 대화", exact: true }).click();
  await page.getByLabel("대화 제목", { exact: true }).fill("오로라 개인 초안");
  await page.getByRole("button", { name: "대화 만들기", exact: true }).click();
  await page.locator("#g-chat").fill("내 프로젝트명은 오로라 기억해줘");
  await submit(page, "chat");
  await expect(page.locator(".g-messages")).toContainText("기억에 남겼어요");
  const memory = (await snapshot(page)).memories.find((m) =>
    m.text.includes("오로라"),
  );
  expect(memory.scope).toBe("personal");
  await page.locator("#g-account-select").selectOption("minji");
  await agent(page, "dev");
  await expect(page.locator("#g-conversation-select")).not.toContainText(
    "오로라",
  );
  await page.getByRole("tab", { name: /기억/ }).click();
  await expect(page.locator(".g-main")).not.toContainText("오로라");
  await nav(page, "conversations");
  await expect(page.locator(".g-main")).not.toContainText("오로라");
});

test("sharing one personal conversation gives the other user a read-only view", async ({
  page,
}) => {
  await page.locator('[data-view="assistant"]').click();
  await page.getByRole("button", { name: "새 대화", exact: true }).click();
  await page
    .getByLabel("대화 제목", { exact: true })
    .fill("팀에 공유할 화면 메모");
  await page.getByRole("button", { name: "대화 만들기", exact: true }).click();
  await page.locator("#g-chat").fill("오늘은 화면 흐름을 정리해줘");
  await submit(page, "chat");
  await page.locator('[data-action="conversation-access"]').click();
  await page.getByLabel("이 대화 열람", { exact: true }).selectOption("team");
  await page
    .getByRole("button", { name: "공개 범위 저장", exact: true })
    .click();
  await page.locator("#g-account-select").selectOption("minji");
  await nav(page, "conversations");
  await page
    .locator(".g-shared-thread")
    .filter({ hasText: "팀에 공유할 화면 메모" })
    .click();
  await expect(page.locator(".g-readonly-note")).toContainText(
    "개인 기억과 다른 대화는 포함되지 않아요",
  );
  await expect(page.locator(".g-messages")).toContainText(
    "오늘은 화면 흐름을 정리해줘",
  );
  await expect(page.locator("#g-chat")).toHaveCount(0);
});

test("a skill update is pending while the existing run keeps its original version", async ({
  page,
}) => {
  await agent(page, "qa");
  await page.getByRole("tab", { name: /스킬/ }).click();
  await page.locator('[data-action="run-skill"][data-id="release"]').click();
  await page
    .getByRole("button", { name: "샘플 업무 실행", exact: true })
    .click();
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  const before = await snapshot(page),
    task = before.tasks.find((t) => t.id === "T-109"),
    run = before.runs.find((r) => r.id === task.runId);
  await agent(page, "qa");
  await page.getByRole("tab", { name: /스킬/ }).click();
  await page.locator('[data-action="skill-detail"][data-id="release"]').click();
  await page
    .getByRole("button", { name: "다음 버전 만들기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "샘플 버전 게시", exact: true })
    .click();
  await expect(page.locator('[data-skill-id="release"]')).toContainText(
    "다음 실행부터 적용",
  );
  const after = await snapshot(page);
  expect(after.runs.find((r) => r.id === run.id).skillVersion).toBe(
    run.skillVersion,
  );
  expect(after.agents.find((a) => a.id === "qa").skillPins.release).not.toBe(
    run.skillVersion,
  );
  await nav(page, "work");
  await page.locator('[data-action="select-task"][data-id="T-109"]').click();
  await page
    .locator('[data-action="task-tab"][data-value="execution"]')
    .click();
  await expect(page.locator(".g-run-facts")).toContainText(run.id);
  await expect(page.locator(".g-run-facts")).toContainText(
    "v" + run.skillVersion,
  );
});

test("reload restores a paused run and resumes the same snapshot", async ({
  page,
}) => {
  await page.locator('[data-view="assistant"]').click();
  await page.locator('[data-action="run-skill"][data-id="meeting"]').click();
  await page
    .getByRole("button", { name: "샘플 업무 실행", exact: true })
    .click();
  const before = await snapshot(page),
    id = before.tasks.find((t) => t.id === "T-109").runId;
  await page.reload();
  await expect(
    page.getByRole("button", { name: "저장된 단계부터 재개", exact: true }),
  ).toBeVisible();
  expect((await snapshot(page)).runs.find((r) => r.id === id).status).toBe(
    "paused",
  );
  await page
    .getByRole("button", { name: "저장된 단계부터 재개", exact: true })
    .click();
  const resumed = (await snapshot(page)).runs.find((r) => r.id === id);
  expect(resumed.generation).toBe(2);
  expect(resumed.status).toBe("running");
});

test("profile support is visible and blocks incompatible skill execution", async ({
  page,
}) => {
  await page.locator('[data-view="assistant"]').click();
  await page.locator('[data-action="settings"]').click();
  await page.locator('select[name="runtime"]').selectOption("openhands");
  await page
    .getByRole("button", { name: "비서 설정 저장", exact: true })
    .click();
  await page.getByRole("tab", { name: /스킬/ }).click();
  const row = page.locator('[data-skill-id="meeting"]');
  await expect(row).toContainText("이 프로필에서 미지원");
  await expect(row.locator('[data-action="run-skill"]')).toBeDisabled();
});

test("approval resumes work and sequence-bearing execution evidence is visible", async ({
  page,
}) => {
  await page.locator("#g-account-select").selectOption("minji");
  await nav(page, "inbox");
  await page
    .getByRole("radio", { name: "전체 회귀 · 주요 사용자 흐름", exact: true })
    .check();
  await submit(page, "resume");
  await expect(page.locator(".g-main")).toContainText("모두 답변했어요");
  const data = await snapshot(page),
    t = data.tasks.find((t) => t.id === "T-108"),
    run = data.runs.find((r) => r.id === t.runId);
  expect(t.status).toBe("running");
  expect(run.events.at(-1).sequence).toBeGreaterThan(1);
});

test("keyboard search and modal focus recover without a pointer", async ({
  page,
}) => {
  await page.keyboard.press("Control+k");
  await expect(page.locator("#g-command-query")).toBeFocused();
  await page.locator("#g-command-query").fill("제이");
  await page.keyboard.press("Enter");
  await expect(page.locator(".g-main h1")).toContainText("제이");
  await page.locator('[data-action="new-conversation"]').click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#gyeot-frame")).not.toHaveAttribute("inert");
});

test("the selected coworker retains access to a completed handoff result", async ({
  page,
}) => {
  await page.locator("#g-account-select").selectOption("minji");
  await page.locator('.g-office-station[data-id="qa"]').click();
  await page.locator(".g-office-answer select").selectOption({ index: 1 });
  await page
    .getByRole("button", { name: "답변하고 재개", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "결과 확인", exact: true }),
  ).toBeVisible({ timeout: 8000 });
  await page.getByRole("button", { name: "결과 확인", exact: true }).click();
  await expect(page.locator(".g-task-detail h2")).toContainText(
    "로그인 토큰 갱신 오류 수정",
  );
});

test("memory correction keeps history and deletion can be undone", async ({
  page,
}) => {
  await nav(page, "memory");
  await page.locator('.g-memory-entry-title[data-id="m-qa"]').click();
  await page
    .getByRole("button", { name: "내용 바로잡기", exact: true })
    .click();
  await page
    .getByLabel("기억할 내용", { exact: true })
    .fill(
      "세션 갱신은 여러 탭과 실패 후 재로그인까지 확인한다. 정정된 검증 범위.",
    );
  await submit(page, "memory");
  await expect(
    page.locator(".g-memory-entry").filter({ hasText: "정정된 검증 범위" }),
  ).toContainText("v3");
  await page.locator('.g-memory-entry-title[data-id="m-qa"]').click();
  await expect(page.getByRole("dialog")).toContainText("이전 버전 2개");
  await page.getByRole("button", { name: "기억 지우기", exact: true }).click();
  await expect(
    page.locator('.g-memory-entry-title[data-id="m-qa"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(
    page.locator('.g-memory-entry-title[data-id="m-qa"]'),
  ).toBeVisible();
  expect(
    (await snapshot(page)).memories.find((m) => m.id === "m-qa").version,
  ).toBe(3);
});

test("reduced-motion stops decorative character animations", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const duration = await page
    .locator(".g-office-paw")
    .first()
    .evaluate((el) => getComputedStyle(el).animationDuration);
  expect(duration).toBe("0s");
});

for (const width of [1280, 1024])
  test(`desktop layout has no horizontal overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const size = await page
      .locator("#gyeot-demo")
      .evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(size.scroll).toBe(size.client);
    await expect(page.locator(".g-office-room")).toHaveCount(4);
  });
