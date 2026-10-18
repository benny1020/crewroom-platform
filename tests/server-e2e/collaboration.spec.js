import { test, expect } from "@playwright/test";
const password = "test-only-e2e-passphrase";
const messages = new WeakMap();
async function login(page, email = "lead@e2e.invalid") {
  const errors = [];
  messages.set(page, errors);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "함께 일하는 오피스", exact: true }),
  ).toBeVisible();
}
test.afterEach(async ({ page }) =>
  expect(messages.get(page) || []).toEqual([]),
);

test("two independent sessions share comments, transfer responsibility, hand off QA and accept one result", async ({
  page,
  browser,
}) => {
  await login(page);
  const other = await browser.newContext(),
    member = await other.newPage();
  await login(member, "member@e2e.invalid");
  await page.getByRole("button", { name: "새 업무 시작", exact: true }).click();
  await page.getByLabel("업무 대상 링크 또는 이름").fill("서버 공동 사용 검증");
  await page.getByLabel("대상 커밋 또는 관측 버전").fill("fixed-input-v1");
  await page
    .getByLabel("요청할 내용")
    .fill("같은 업무에서 검토와 QA 계획을 이어주세요");
  await page
    .getByRole("button", { name: "공개 내용 확인", exact: true })
    .click();
  await page
    .getByRole("button", { name: "업무 접수하기", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tasks\//);
  const url = page.url();
  await member.goto(url);
  await expect(
    member.getByRole("heading", {
      name: "같은 업무에서 검토와 QA 계획을 이어주세요",
      exact: true,
    }),
  ).toBeVisible();
  await member
    .getByLabel("추가 조건 또는 업무 대화")
    .fill("다중 탭의 세션 갱신 조건을 추가합니다");
  await member
    .getByRole("button", { name: "맥락 남기기", exact: true })
    .click();
  await expect(page.locator(".cr-discussion")).toContainText(
    "다중 탭의 세션 갱신 조건을 추가합니다",
  );
  await page.getByRole("button", { name: "실행 시작", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "이 결과로 QA에 넘기기", exact: true }),
  ).toBeVisible();
  await page.getByText("책임자 변경", { exact: false }).first().click();
  await page
    .getByLabel("현재 책임자", { exact: true })
    .selectOption({ label: "민지" });
  await page
    .getByRole("button", { name: "담당 변경 기록", exact: true })
    .click();
  await expect(
    member.getByRole("button", { name: "이 결과로 QA에 넘기기", exact: true }),
  ).toBeVisible();
  await member
    .getByRole("button", { name: "이 결과로 QA에 넘기기", exact: true })
    .click();
  await member.getByRole("button", { name: "실행 시작", exact: true }).click();
  await expect(
    member.getByRole("button", { name: "이 결과 수용", exact: true }),
  ).toBeVisible();
  await member
    .getByRole("button", { name: "이 결과 수용", exact: true })
    .click();
  await expect(page.locator(".g-page-head")).toContainText("수용 완료");
  await page.reload();
  await expect(page.locator(".cr-results")).toContainText(
    "좋은 결과를 다음 업무의 기준으로",
  );
  expect(messages.get(member)).toEqual([]);
  await other.close();
});
test("a personal assistant task stays private across reload, user sessions and direct links", async ({
  page,
  browser,
}) => {
  await login(page);
  await page.locator(".cr-personal").click();
  await page
    .getByLabel("맡길 일 또는 대화")
    .fill("나의 비공개 프로젝트 고유문장 누리별");
  await page
    .getByRole("button", { name: "업무방 열고 시작", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tasks\//);
  const url = page.url();
  await page.reload();
  await expect(page.locator(".cr-main")).toContainText("누리별");
  const context = await browser.newContext(),
    other = await context.newPage();
  await login(other, "member@e2e.invalid");
  await other.goto(url);
  await expect(other.locator(".cr-main")).not.toContainText("누리별");
  await expect(other.locator(".cr-main")).toContainText(
    "찾거나 열람할 수 없어요",
  );
  await context.close();
});
test("real memory correction and skill stewardship persist after browser reload", async ({
  page,
}) => {
  await login(page);
  await page.locator('.cr-nav[href="#/memory"]').click();
  await page.getByRole("button", { name: "기억 추가", exact: true }).click();
  await page.getByLabel("기억할 동료").selectOption("review");
  await page.getByLabel("공개 범위", { exact: true }).selectOption("team");
  await page.getByLabel("기억 제목").fill("실제 저장 규칙");
  await page
    .getByLabel("기억할 내용")
    .fill("모든 결과에 고정 대상 SHA를 남깁니다");
  await page.getByLabel("출처", { exact: true }).fill("운영 합의");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const card = page.locator(".cr-memory").filter({ hasText: "실제 저장 규칙" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "바로잡기", exact: true }).click();
  await page
    .getByLabel("기억할 내용")
    .fill("결과와 입력 산출물의 SHA를 함께 남깁니다");
  await page.getByLabel("정정 이유").fill("인계 기준 보완");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.reload();
  await expect(card).toContainText("입력 산출물");
  await expect(card).toContainText("v2");
  await page.locator('.cr-nav[href="#/admin"]').click();
  await page.getByLabel("코드 리뷰 관리 담당").selectOption({ label: "민지" });
  await page
    .locator('form[data-form="steward"][data-id="review"]')
    .getByRole("button", { name: "담당 저장" })
    .click();
  await page.reload();
  await expect(page.getByLabel("코드 리뷰 관리 담당")).not.toHaveValue("");
});
for (const width of [1440, 1280, 1024])
  test(`server workspace fits desktop ${width} and supports keyboard dialogs`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1080 });
    await login(page);
    for (const view of [
      "office",
      "work",
      "memory",
      "skills",
      "admin",
      "intake",
    ]) {
      await page.goto(`/#/${view}`);
      await expect(page.locator(".cr-main")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.goto("/#/memory");
    await page.getByRole("button", { name: "기억 추가", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("#gyeot-frame")).not.toHaveAttribute("inert");
  });
for (const status of [200, 401])
  test(`late previous-session ${status} response cannot overwrite or sign out the next account`, async ({
    page,
  }) => {
    await login(page);
    let release, entered;
    const gate = new Promise((r) => (release = r)),
      arrived = new Promise((r) => (entered = r));
    let held = false;
    await page.route("**/api/workspace", async (route) => {
      if (held) {
        await route.continue();
        return;
      }
      held = true;
      const old = await route.fetch();
      entered();
      await gate;
      try {
        await route.fulfill(
          status === 200
            ? { response: old }
            : { status: 401, json: { message: "old session expired" } },
        );
      } catch {}
    });
    await page.evaluate(() => (location.hash = "#/work"));
    await arrived;
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await page.getByLabel("이메일", { exact: true }).fill("member@e2e.invalid");
    await page.getByLabel("비밀번호", { exact: true }).fill(password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page.locator(".cr-top-actions")).toContainText("민지 / 팀원");
    release();
    await expect
      .poll(async () => page.locator(".cr-top-actions").textContent())
      .toContain("민지 / 팀원");
    await page.goto("/#/admin");
    await expect(page.locator(".cr-main")).toContainText(
      "팀장 권한이 필요해요",
    );
    await expect(page.locator(".cr-top-actions")).toContainText("민지 / 팀원");
  });
test("member lead request is explicit and grants no admin permission", async ({
  page,
}) => {
  await login(page, "member@e2e.invalid");
  await page.locator(".cr-personal").click();
  const request = page.getByRole("button", {
    name: "팀장 권한 요청",
    exact: true,
  });
  await request.click();
  await expect(
    page.getByRole("button", { name: "팀장 권한 요청됨", exact: true }),
  ).toBeDisabled();
  await page.goto("/#/admin");
  await expect(page.locator(".cr-main")).toContainText("팀장 권한이 필요해요");
});

test("a new personal skill can be created, bound and selected to trigger an agent workroom", async ({
  page,
}) => {
  await login(page);
  await page.locator('.cr-nav[href="#/skills"]').click();
  await page
    .getByRole("button", { name: "새 스킬 만들기", exact: true })
    .click();
  const name = "주간 업무 정리 · 브라우저";
  await page.getByLabel("스킬 이름", { exact: true }).fill(name);
  await page
    .getByLabel("반복 업무 지침", { exact: true })
    .fill("성과, 장애, 다음 계획 세 항목으로 정리한다.");
  await page
    .getByLabel("완료 기준", { exact: true })
    .fill("세 항목을 모두 제공한다.");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const card = page.locator(".cr-skill").filter({ hasText: name });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "동료에 적용", exact: true }).click();
  await page
    .getByLabel("적용할 동료", { exact: true })
    .selectOption({ label: "나의 비서" });
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(card).toContainText("나의 비서");
  const href = await page
    .locator('.cr-sidebar a[href^="#/agents/personal-"]')
    .getAttribute("href");
  await page.goto("/" + href);
  await page
    .getByLabel("사용할 스킬", { exact: true })
    .selectOption({ label: name });
  await page
    .getByLabel("맡길 일 또는 대화", { exact: true })
    .fill("이번 주 업무를 정리해주세요");
  await page
    .getByRole("button", { name: "업무방 열고 시작", exact: true })
    .click();
  await expect(page.locator(".cr-run")).toContainText(name);
  await expect(
    page.getByRole("button", { name: "이 결과 수용", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".cr-run")).toContainText(name);
  await page
    .getByLabel("추가 조건 또는 업무 대화", { exact: true })
    .fill("이전 답변의 다음 계획을 더 자세히 알려주세요.");
  await page
    .getByRole("button", { name: "보내고 답변받기", exact: true })
    .click();
  await expect(page.locator(".cr-run")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "이 결과 수용", exact: true }),
  ).toBeVisible();
});
test("password change revokes the browser session and new password can log in", async ({
  page,
}) => {
  await login(page, "member@e2e.invalid");
  await page
    .getByRole("button", { name: "비밀번호 변경", exact: true })
    .click();
  await page.getByLabel("현재 비밀번호", { exact: true }).fill(password);
  await page
    .getByLabel("새 비밀번호 (12자 이상)", { exact: true })
    .fill("changed-e2e-passphrase");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "우리 팀으로 들어가기", exact: true }),
  ).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill("member@e2e.invalid");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("changed-e2e-passphrase");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.locator(".cr-main")).toBeVisible();
  await page
    .getByRole("button", { name: "비밀번호 변경", exact: true })
    .click();
  await page
    .getByLabel("현재 비밀번호", { exact: true })
    .fill("changed-e2e-passphrase");
  await page
    .getByLabel("새 비밀번호 (12자 이상)", { exact: true })
    .fill(password);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "우리 팀으로 들어가기", exact: true }),
  ).toBeVisible();
});

test("archive search opens an old conversation source and preserves core-memory settings", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "새 업무 시작", exact: true }).click();
  await page
    .getByLabel("업무 대상 링크 또는 이름")
    .fill("회상 검색 브라우저 검증");
  await page.getByLabel("대상 커밋 또는 관측 버전").fill("memory-browser-v1");
  await page.getByLabel("요청할 내용").fill("장기기억 브라우저 인계");
  await page
    .getByRole("button", { name: "공개 내용 확인", exact: true })
    .click();
  await page
    .getByRole("button", { name: "업무 접수하기", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/tasks\//);
  const taskUrl = page.url();
  await page
    .getByLabel("추가 조건 또는 업무 대화")
    .fill("결정: 보라별회상키의 담당자는 다연입니다.");
  await page.getByRole("button", { name: "맥락 남기기", exact: true }).click();
  await page.locator('.cr-nav[href="#/memory"]').click();
  await page.getByLabel("기억 검색", { exact: true }).fill("보라별회상키");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "과거 대화·업무에서 찾은 기록",
      exact: true,
    }),
  ).toBeVisible();
  const section = page
    .locator(".cw-paper")
    .filter({
      has: page.getByRole("heading", {
        name: "과거 대화·업무에서 찾은 기록",
        exact: true,
      }),
    })
    .first();
  await expect(section).toContainText("다연");
  await section
    .getByRole("button", { name: "출처 원문", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText("보라별회상키");
  await expect(page.getByRole("dialog")).toContainText("memory-browser-v1");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "기억 추가", exact: true }).click();
  await page.getByLabel("기억할 동료").selectOption("review");
  await page.getByLabel("공개 범위", { exact: true }).selectOption("team");
  await page.getByLabel("기억 종류").selectOption("decision");
  await page.getByLabel("기본 문맥에 우선 포함").selectOption("true");
  await page.getByLabel("기억 제목").fill("고정 결정 · 브라우저");
  await page.getByLabel("기억할 내용").fill("회상 검색에는 출처를 표시합니다.");
  await page.getByLabel("출처", { exact: true }).fill("검증 기록");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.reload();
  const card = page
    .locator(".cr-memory")
    .filter({ hasText: "고정 결정 · 브라우저" });
  await expect(card).toContainText("핵심 기억");
  await card.getByRole("button", { name: "바로잡기", exact: true }).click();
  await expect(page.getByLabel("기억 종류")).toHaveValue("decision");
  await expect(page.getByLabel("기본 문맥에 우선 포함")).toHaveValue("true");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.goto(taskUrl);
  await page.getByRole("button", { name: "실행 시작", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "이 결과로 QA에 넘기기", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "참고한 기억", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "회상 검색에는 출처를 표시합니다.",
  );
});

test("evidence proposal promotion, a future policy replacement and accepted-work skill drafts are explicit", async ({
  page,
}) => {
  await login(page);
  await page.locator('.cr-nav[href="#/memory"]').click();
  const candidate = page
    .locator(".cr-proposal")
    .filter({ hasText: "합성 로그인 정책 제안" });
  await expect(candidate).toContainText("세션 만료는 35분입니다.");
  await candidate
    .getByRole("button", { name: "출처 원문", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("로그인정책합의");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .first()
    .click();
  await candidate
    .getByRole("button", { name: "확인하고 기억에 저장", exact: true })
    .click();
  await expect(candidate).toHaveCount(0);
  const old = page
    .locator(".cr-memory")
    .filter({ hasText: "합성 로그인 정책 제안" });
  await expect(old).toContainText("프로젝트 공통");
  await old
    .getByRole("button", { name: "새 결정으로 대체", exact: true })
    .click();
  await page.getByLabel("기억 제목").fill("로그인 신규 정책");
  await page.getByLabel("기억할 내용").fill("세션 만료는 50분입니다.");
  await page.getByLabel("적용 시작 (비우면 상시)").fill("2026-11-01T09:00");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("기억 검색", { exact: true }).fill("세션 만료");
  await page.getByLabel("적용 기준일 (비우면 현재)").fill("2026-10-18");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".cr-memory-grid").first()).toContainText("35분");
  await expect(page.locator(".cr-memory-grid").first()).not.toContainText(
    "50분",
  );
  await page.getByLabel("적용 기준일 (비우면 현재)").fill("2026-11-02");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".cr-memory-grid").first()).toContainText("50분");
  await expect(page.locator(".cr-memory-grid").first()).not.toContainText(
    "35분",
  );
  // The shared task accepted earlier is a real API fixture result, and remains available as a reviewed example.
  await page.locator('.cr-nav[href="#/work"]').click();
  await page
    .getByRole("link", { name: /같은 업무에서 검토와 QA 계획을 이어주세요/ })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "반복 업무 스킬 초안", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "반복 업무 스킬 초안", exact: true })
    .click();
  await expect(page.getByLabel("반복 업무 지침")).toContainText(
    "새 대상과 버전",
  );
  await expect(page.getByLabel("반복 업무 지침")).toHaveValue(
    /과거 결과의 검사·수용을 새 업무의 승인으로 사용하지 마세요./,
  );
});
