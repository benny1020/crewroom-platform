import { test, expect } from "@playwright/test";

const snapshot = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("gyeot-prototype-v1")));
const nav = (page, view) =>
  page.locator(`[data-action="navigate"][data-view="${view}"]`).first().click();
const tab = (page, id) =>
  page.locator(`[data-action="admin-tab"][data-value="${id}"]`).first().click();
const submit = (page, form) =>
  page.locator(`${form} [data-action="submit-form"]`).click();
const errors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const messages = [];
  errors.set(page, messages);
  page.on("pageerror", (error) => messages.push(error.message));
  await page.goto("/");
  await page.locator('[data-action="office-play"]').click();
});
test.afterEach(async ({ page }) => expect(errors.get(page)).toEqual([]));

async function fillSignup(page) {
  await page.locator('[data-action="start-signup"]').click();
  await page.getByLabel("이름", { exact: true }).fill("서연");
  await page.getByLabel("이메일", { exact: true }).fill("seoyeon@example.com");
  await page.getByLabel("나의 비서 이름", { exact: true }).fill("보리");
  await page
    .getByLabel("소속 부서", { exact: true })
    .selectOption("development");
}

test("a member gets a personal workspace and cannot enter administration or public settings", async ({
  page,
}) => {
  await page.locator("#g-account-select").selectOption("minji");
  await expect(
    page.getByRole("heading", { name: "함께 일하는 오피스", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".g-main")).toContainText(
    "로그인 토큰 갱신 오류 수정",
  );
  await expect(page.locator('.g-nav-button[data-view="admin"]')).toHaveCount(0);
  await page.locator('.g-side-agent[data-id="dev"]').click();
  await expect(page.locator('[data-action="agent-settings"]')).toBeHidden();
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.dataset.action = "agent-settings";
    button.dataset.id = "dev";
    button.id = "forbidden-control";
    document.querySelector("#gyeot-frame").append(button);
  });
  await page.locator("#forbidden-control").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/?persona=minji&screen=admin");
  await expect(
    page.getByRole("heading", { name: "내 업무 공간", exact: true }),
  ).toBeVisible();
});

test("member signup creates a personal assistant in the existing shared team and survives reload", async ({
  page,
}) => {
  await fillSignup(page);
  await page
    .getByRole("button", { name: "팀원으로 시작하기", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "함께 일하는 오피스", exact: true }),
  ).toBeVisible();
  await nav(page, "home");
  await expect(page.locator(".g-my-assistant")).toContainText("보리");
  const state = await snapshot(page);
  expect(state.members[state.user].role).toBe("member");
  expect(state.team.name).toBe("제품개발팀");
  expect(state.tasks.some((t) => t.id === "T-108")).toBe(true);
  await page.reload();
  await expect(page.locator(".g-my-assistant")).toContainText("보리");
  await page
    .getByRole("button", { name: "비서에게 말 걸기", exact: true })
    .click();
  await page.locator("#g-chat").fill("내 회의 이름은 별빛 기억해줘");
  await submit(page, 'form[data-form="chat"]');
  expect(
    (await snapshot(page)).memories.find((m) => m.text.includes("별빛")).owner,
  ).toBe(state.user);
});

test("lead request retains inputs and requires an existing lead to grant the role", async ({
  page,
}) => {
  await fillSignup(page);
  await page.getByLabel("팀장 권한을 요청할게요", { exact: false }).check();
  await expect(page.getByLabel("이메일", { exact: true })).toHaveValue(
    "seoyeon@example.com",
  );
  await page
    .getByRole("button", { name: "참여하고 권한 요청", exact: true })
    .click();
  const requested = await snapshot(page);
  expect(requested.members[requested.user].role).toBe("member");
  expect(requested.members[requested.user].leadRequested).toBe(true);
  await expect(page.locator('.g-nav-button[data-view="admin"]')).toHaveCount(0);
  await page.locator("#g-account-select").selectOption("roopre");
  await nav(page, "admin");
  await tab(page, "members");
  await expect(page.locator(".g-member-table-row")).toHaveCount(3);
  await expect(page.locator(".g-main")).toContainText("민지");
  expect((await snapshot(page)).teams).toBeUndefined();
});

test("duplicate signup shows a useful error and keeps the form", async ({
  page,
}) => {
  await fillSignup(page);
  await page.getByLabel("이메일", { exact: true }).fill("MINJI@example.com");
  await page
    .getByRole("button", { name: "팀원으로 시작하기", exact: true })
    .click();
  await expect(page.locator("[data-team-error]")).toContainText(
    "이미 가입한 이메일",
  );
  await expect(page.getByLabel("나의 비서 이름", { exact: true })).toHaveValue(
    "보리",
  );
  expect(Object.keys((await snapshot(page)).members)).toHaveLength(2);
});

test("a lead can promote another member then step down, while the last lead is protected", async ({
  page,
}) => {
  await nav(page, "admin");
  await tab(page, "members");
  const roopre = 'form[data-form="team-member"][data-id="roopre"]';
  await page.getByLabel("로프레의 역할").selectOption("member");
  await submit(page, roopre);
  await expect(page.locator(`${roopre} [data-team-error]`)).toContainText(
    "한 명 이상",
  );
  await page.getByLabel("민지의 역할").selectOption("lead");
  await submit(page, 'form[data-form="team-member"][data-id="minji"]');
  await page.getByLabel("로프레의 역할").selectOption("member");
  await submit(page, roopre);
  await expect(
    page.getByRole("heading", { name: "내 업무 공간", exact: true }),
  ).toBeVisible();
  await expect(page.locator('.g-nav-button[data-view="admin"]')).toHaveCount(0);
  await page.locator("#g-account-select").selectOption("minji");
  await nav(page, "admin");
  await expect(
    page.getByRole("heading", { name: "팀 관리", exact: true }),
  ).toBeVisible();
});

test("department edits reach the office and member department choices", async ({
  page,
}) => {
  await nav(page, "admin");
  await tab(page, "members");
  await page.getByLabel("QA 부서 이름", { exact: true }).fill("품질");
  await submit(page, 'form[data-form="department"][data-id="qa"]');
  await expect(page.getByLabel("민지의 부서")).toContainText("품질");
  await page.getByLabel("새 부서 이름").fill("디자인");
  await page.getByLabel("새 부서 설명").fill("사용자 경험 설계");
  await submit(page, 'form[data-form="department"]:not([data-id])');
  await nav(page, "office");
  await expect(page.locator(".g-office-room")).toHaveCount(5);
  await expect(page.locator(".g-office-room-head")).toContainText([
    "직속",
    "개발",
    "운영",
    "품질",
    "디자인",
  ]);
});

test("team skill policy enables member binding edits without granting agent settings", async ({
  page,
}) => {
  await nav(page, "admin");
  await tab(page, "settings");
  await page.getByLabel("팀원의 공용 스킬 편집 허용", { exact: false }).check();
  await submit(page, 'form[data-form="team-settings"]');
  await page.locator("#g-account-select").selectOption("minji");
  await nav(page, "skills");
  await page.locator("#g-skill-target").selectOption("qa");
  const attach = page.locator(
    '[data-action="attach-skill"][data-id="meeting"]',
  );
  await expect(attach).toBeEnabled();
  await attach.click();
  expect(
    (await snapshot(page)).agents.find((a) => a.id === "qa").skills,
  ).toContain("meeting");
  await page.locator('.g-side-agent[data-id="qa"]').click();
  await expect(page.locator('[data-action="agent-settings"]')).toBeHidden();
});

test("admin summaries and logs never include another member's private conversation or memory", async ({
  page,
}) => {
  await page.locator("#g-account-select").selectOption("minji");
  await nav(page, "assistant");
  await page.locator("#g-chat").fill("나의 비밀 프로젝트는 달무리 기억해줘");
  await submit(page, 'form[data-form="chat"]');
  await page.locator("#g-account-select").selectOption("roopre");
  await expect(page.locator(".g-main")).not.toContainText("달무리");
  await nav(page, "admin");
  await tab(page, "settings");
  await expect(page.locator(".g-main")).not.toContainText("달무리");
  await nav(page, "memory");
  await page.locator("#g-memory-agent").selectOption("roopre");
  await expect(page.locator(".g-main")).not.toContainText("달무리");
});

for (const width of [1280, 1024])
  test(`role screens stay within the desktop at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1080 });
    const within = async () => {
      const size = await page.locator("#gyeot-demo").evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
      }));
      expect(size.scroll).toBe(size.width);
    };
    await nav(page, "home");
    await within();
    await nav(page, "admin");
    for (const id of ["overview", "members", "agents", "settings"]) {
      await tab(page, id);
      await within();
    }
    await page.locator('[data-action="start-signup"]').click();
    await within();
  });
