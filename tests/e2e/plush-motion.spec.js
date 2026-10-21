import { test, expect } from "@playwright/test";

test("real office refresh retains animation identity, progress and motion controls", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const picture = page.locator(
    '.g-work-diary [data-plush-phase="coding"] > .g-diary-illustration',
  );
  await expect(picture).toBeVisible();
  expect(
    await picture.evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("plush-typing");
  await picture.evaluate((el) => {
    window.motionPicture = el;
    el.getAnimations()[0].currentTime = 900;
  });
  await page.locator('[data-action="office-motion"]').click();
  expect(await picture.evaluate((el) => el === window.motionPicture)).toBe(
    true,
  );
  expect(
    await picture.evaluate((el) => el.getAnimations()[0].currentTime),
  ).toBeGreaterThanOrEqual(900);
  expect(
    await picture.evaluate((el) => getComputedStyle(el).animationPlayState),
  ).toBe("paused");
  const stopped = await picture.evaluate(
    (el) => el.getAnimations()[0].currentTime,
  );
  await page.waitForTimeout(120);
  expect(
    await picture.evaluate((el) => el.getAnimations()[0].currentTime),
  ).toBeCloseTo(stopped, 0);
  await page.locator('[data-action="office-motion"]').click();
  expect(await picture.evaluate((el) => el === window.motionPicture)).toBe(
    true,
  );
  expect(
    await picture.evaluate((el) => getComputedStyle(el).animationPlayState),
  ).toBe("running");
  // Exercise the visibility policy deterministically without freezing the test browser.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(
    await picture.evaluate((el) => getComputedStyle(el).animationPlayState),
  ).toBe("paused");
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(
    await picture.evaluate((el) => getComputedStyle(el).animationPlayState),
  ).toBe("running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await picture.evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  expect(
    await page
      .locator(".g-work-diary .g-plush-effects")
      .evaluate((el) => getComputedStyle(el).display),
  ).toBe("none");
  expect(errors).toEqual([]);
});

test("a finished celebration stays finished across rendering and cannot cross a queued task", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".g-office-station").first().waitFor();
  const result = await page.evaluate(async () => {
    const { workDiary } = await import("/src/work-diary.js"),
      { rememberPlushMotion } = await import("/src/plush-motion.js"),
      host = document.createElement("div"),
      input = {
        agent: { id: "dev", name: "카이", character: "otter" },
        task: { id: "motion-fixture", status: "done", title: "합성 동작 검사" },
        sample: true,
      };
    document.getElementById("gyeot-demo").append(host);
    host.innerHTML = workDiary(input);
    const original = host.querySelector(".g-diary-illustration");
    for (const animation of host.getAnimations({ subtree: true }))
      animation.finish();
    const restore = rememberPlushMotion(host);
    host.innerHTML = workDiary(input);
    restore();
    const current = host.querySelector(".g-diary-illustration"),
      completed = {
        sameNode: original === current,
        name: getComputedStyle(current).animationName,
        repeat: getComputedStyle(current).animationIterationCount,
        state: current.getAnimations()[0].playState,
      };
    const next = rememberPlushMotion(host);
    host.innerHTML = workDiary({
      ...input,
      task: { ...input.task, id: "next-task", status: "queued" },
    });
    next();
    const queued = host.querySelector(".g-diary-illustration");
    return {
      completed,
      queued: {
        sameNode: original === queued,
        name: getComputedStyle(queued).animationName,
        text: host.textContent,
        sparkle: getComputedStyle(host.querySelector(".g-plush-effects i"))
          .animationName,
      },
    };
  });
  expect(result.completed).toEqual({
    sameNode: true,
    name: "plush-celebrate",
    repeat: "1",
    state: "finished",
  });
  expect(result.queued.sameNode).toBe(false);
  expect(result.queued.name).toBe("plush-breathing");
  expect(result.queued.sparkle).toBe("none");
  expect(result.queued.text).toContain("아직 실행 전");
});
