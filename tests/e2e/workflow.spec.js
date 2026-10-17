import { test, expect } from "@playwright/test";
const snapshot = (p) =>
  p.evaluate(() => JSON.parse(localStorage.getItem("gyeot-prototype-v1")));
const action = (p, a) => p.locator(`[data-action="${a}"]`).last();
const submit = (p, f) =>
  p.locator(`form[data-form="${f}"] [data-action="submit-form"]`).click();
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const e = [];
  errors.set(page, e);
  page.on("pageerror", (x) => e.push(x.message));
  await page.goto("/");
  await action(page, "office-play").click();
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));
async function intake(p, mode = "flow-intake", scope = "team") {
  await action(p, mode).click();
  await p
    .getByLabel("업무 대상 링크 또는 이름")
    .fill("https://github.com/example/product/pull/55");
  await p.getByLabel("대상 커밋 또는 관측 버전").fill("feed123");
  await p.getByLabel("공개 범위", { exact: true }).selectOption(scope);
  await p.getByLabel("요청할 내용").fill("세션 변경 검토와 QA 계획");
}
async function create(p, importing = false) {
  await p
    .getByRole("button", {
      name: importing ? "공유할 내용 확인" : "요청 확인",
      exact: true,
    })
    .click();
  await action(p, "flow-create").click();
}

test("target intake, brief correction, pinned QA handoff, acceptance and reuse work end to end", async ({
  page,
}) => {
  await intake(page);
  await create(page);
  await expect(page).toHaveURL(/#\/tasks\/W-202$/);
  await action(page, "start-task").click();
  await expect(action(page, "flow-handoff")).toBeVisible();
  await action(page, "flow-brief").click();
  await page.getByLabel("현재 업무 요약").fill("갱신 실패와 다중 탭을 확인");
  await page.getByLabel("정정 이유").fill("검토 범위 명확화");
  await submit(page, "flow-brief");
  const before = await snapshot(page),
    t = before.tasks.find((t) => t.id === "W-202"),
    first = t.artifactIds[0];
  await action(page, "flow-handoff").click();
  await action(page, "start-task").click();
  await expect(action(page, "flow-accept")).toBeVisible();
  await action(page, "flow-accept").click();
  const after = await snapshot(page),
    done = after.tasks.find((t) => t.id === "W-202");
  expect(done.status).toBe("done");
  expect(done.steps[1].inputArtifactId).toBe(first);
  expect(done.brief.history).toHaveLength(1);
  await page.reload();
  await expect(page.locator(".g-task-detail")).toContainText(
    "좋은 결과를 다음 업무의 기준으로",
  );
  await action(page, "flow-reuse").click();
  await expect(page.getByLabel("업무 대상 링크 또는 이름")).toHaveValue("");
  await expect(page.getByLabel("대상 커밋 또는 관측 버전")).toHaveValue("");
});
test("shared viewer requests ownership, owner assigns and a changed SHA clears the brief", async ({
  page,
}) => {
  await page.goto("/#/tasks/W-201");
  await page.locator("#g-account-select").selectOption("minji");
  await page.goto("/#/tasks/W-201");
  await expect(action(page, "flow-handoff")).toHaveCount(0);
  await action(page, "flow-claim").click();
  await page.locator("#g-account-select").selectOption("roopre");
  await page.goto("/#/tasks/W-201");
  await page.locator(".cw-owner summary").click();
  await page
    .locator('form[data-form="flow-assign"] select')
    .selectOption("minji");
  await page.locator('form[data-form="flow-assign"] button').click();
  await page.locator("#g-account-select").selectOption("minji");
  await page.goto("/#/tasks/W-201");
  await action(page, "flow-rework").click();
  await page.getByLabel("재작업 이유").fill("새 커밋 확인");
  await page.getByLabel("대상 커밋 또는 관측 버전").fill("new-sha");
  await submit(page, "flow-rework");
  const t = (await snapshot(page)).tasks.find((t) => t.id === "W-201");
  expect(t.targetVersion).toBe("new-sha");
  expect(t.brief.source).toBe("request");
  expect(t.brief.targetVersion).toBe("new-sha");
  expect(t.artifactIds).toHaveLength(1);
});
test("selected external text is escaped, unverified, runless and inaccessible outside its private scope", async ({
  page,
}) => {
  await intake(page, "flow-import", "private");
  await page
    .getByLabel("공유할 결과 내용")
    .fill('<img src=x onerror="window.injected=1">개인 검토');
  await page.getByLabel("결과 출처").fill("개인 review.md");
  await create(page, true);
  await action(page, "task-tab").count();
  const s = await snapshot(page),
    a = s.artifacts.at(-1);
  expect(a.runId).toBeNull();
  expect(a.origin).toBe("external");
  expect(a.importedByUserId).toBe("roopre");
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.locator("#g-account-select").selectOption("minji");
  await page.goto("/#/tasks/W-202");
  await expect(page.locator(".g-main")).not.toContainText("개인 검토");
  await expect(page.locator(".g-task-detail")).toHaveCount(0);
});
for (const width of [1440, 1280, 1024])
  test(`new screens fit desktop ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 });
    for (const route of ["/#/tasks/W-201", "/#/intake"]) {
      await page.goto(route);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page
      .locator('[data-action="navigate"][data-view="admin"]')
      .first()
      .click();
    await page
      .locator('[data-action="admin-tab"][data-value="stewardship"]')
      .first()
      .click();
    await expect(page.locator(".cw-steward-row")).toHaveCount(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test("a delegated skill publisher cannot silently change an agent binding", async ({
  page,
}) => {
  await page.locator("#g-account-select").selectOption("minji");
  await page.locator('.g-side-agent[data-id="qa"]').click();
  await page.getByRole("tab", { name: /스킬/ }).click();
  await page
    .locator('[data-action="skill-detail"][data-id="regression"]')
    .click();
  await page
    .getByRole("button", { name: "다음 버전 만들기", exact: true })
    .click();
  const before = await snapshot(page);
  await page
    .getByRole("button", { name: "샘플 버전 게시", exact: true })
    .click();
  const after = await snapshot(page);
  expect(after.skillOverrides.regression.version).toBeDefined();
  expect(after.agents.find((a) => a.id === "qa").skillPins).toEqual(
    before.agents.find((a) => a.id === "qa").skillPins,
  );
  expect(after.agents.find((a) => a.id === "qa").configVersion).toBe(
    before.agents.find((a) => a.id === "qa").configVersion,
  );
});

test("agent conversation selection and shared entry use one workroom and scope", async ({
  page,
}) => {
  const s = await snapshot(page),
    t = s.tasks.find((t) => t.id === "W-201");
  await page.locator('.g-side-agent[data-id="review"]').click();
  await page.locator("#g-conversation-select").selectOption(t.conversationId);
  await expect(page).toHaveURL(/#\/tasks\/W-201$/);
  await expect(page.locator('[data-action="conversation-access"]')).toHaveCount(
    0,
  );
  await page.locator("#g-comment").fill("다중 탭 세션도 확인해주세요");
  await submit(page, "task-comment");
  await page.locator("#g-account-select").selectOption("minji");
  await page
    .locator('[data-action="navigate"][data-view="conversations"]')
    .first()
    .click();
  await page
    .locator(`[data-action="open-conversation"][data-id="${t.conversationId}"]`)
    .click();
  await expect(page.locator(".g-task-detail")).toContainText(
    "다중 탭 세션도 확인해주세요",
  );
  const after = await snapshot(page);
  expect(after.messages[t.conversationId]).toEqual([]);
  expect(after.tasks.find((x) => x.id === t.id).visibility).toBe("team");
});
