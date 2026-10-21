import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { diaryIllustration } from "../src/work-diary.js";
import { motionAttributes, plushEffects } from "../src/plush-motion.js";
import { characterById } from "../src/data.js";

const character = ["rururu", "pom"].includes(process.env.PLUSH_CHARACTER)
    ? process.env.PLUSH_CHARACTER
    : "otter",
  characterName = characterById(character).name,
  directory =
    character === "otter" ? "docs/media/plush" : `docs/media/${character}`,
  origin = "http://127.0.0.1:4174",
  encoder = process.env.FFMPEG_BIN || "ffmpeg",
  errors = [];
await mkdir(directory, { recursive: true });
await mkdir(".capture/plush", { recursive: true });
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4174",
    "--strictPort",
  ],
  { stdio: "ignore" },
);
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null)
      throw Error("Plush preview could not start on 4174");
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  if (!ready) throw Error("Plush preview unavailable");
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    colorScheme: "light",
    deviceScaleFactor: 1,
    recordVideo: { dir: ".capture/plush", size: { width: 1440, height: 1080 } },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith("data:"))
      errors.push("Unexpected external request");
  });
  await page.goto(origin);
  await page.locator(".g-office-station").first().waitFor();
  if (character !== "otter") {
    await page
      .getByRole("button", { name: "카이 캐릭터 바꾸기", exact: true })
      .click();
    await page
      .getByRole("button", { name: `${characterName} 캐릭터`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "캐릭터 적용", exact: true })
      .click();
    await page
      .locator(
        `.g-office-station[data-id="dev"] [data-diary-character="${character}"]`,
      )
      .waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
  if (character !== "otter")
    await page.locator(".g-toast").waitFor({ state: "hidden" });
  await page.screenshot({
    path: `${directory}/office.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.waitForTimeout(2400);
  for (const id of ["review", "qa", "dev"]) {
    await page.locator(`.g-office-station[data-id="${id}"]`).click();
    await page.waitForTimeout(2000);
  }
  const styles = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((links) => links.map((link) => link.href));
  const video = page.video();
  await context.close();
  const scenes = [
    ["ready", "개발 모드 ON"],
    ["coding", "코딩 중"],
    ["investigating", "원인을 찾는 중"],
    ["testing", "검사 진행 중"],
    ["review", "리뷰 부탁해요"],
    ["celebrating", "함께 해냈어요"],
    ["question", "함께 확인해요"],
    ["writing", "기록을 남기는 중"],
    ["queued", "차례를 기다리는 중"],
    ["planning", "아이디어를 정리해요"],
    ["paused", "잠깐 멈춤"],
    ["blocked", "멈춘 지점을 확인해요"],
  ];
  const galleryContext = await browser.newContext({
    viewport: { width: 1200, height: 1740 },
    colorScheme: "light",
    recordVideo: { dir: ".capture/plush", size: { width: 1200, height: 1740 } },
  });
  const gallery = await galleryContext.newPage();
  gallery.on("pageerror", (e) => errors.push(e.message));
  const galleryHtml = `<!doctype html><html lang="ko"><meta charset="utf-8">${styles.map((href) => `<link rel="stylesheet" href="${href}">`).join("")}<style>body{margin:0;background:#faf9f7}#gyeot-demo{box-sizing:border-box;width:100%;min-width:0!important;margin:0!important;border:0!important;border-radius:0!important;padding:50px 64px;font-family:"Apple SD Gothic Neo","Malgun Gothic",sans-serif}#gyeot-demo .plush-title{text-align:center;margin-bottom:32px}#gyeot-demo .plush-title h1{font-size:44px;color:#18304e;margin:0 0 10px;letter-spacing:-2px}#gyeot-demo .plush-title p{font-size:15px;color:#687485}#gyeot-demo .plush-gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 38px}#gyeot-demo .plush-gallery article{text-align:center}#gyeot-demo .plush-gallery .g-diary-illustration{height:280px;max-width:280px;margin:auto;}#gyeot-demo .plush-motion-preview{width:280px;height:280px;margin:auto;}#gyeot-demo .plush-gallery h2{margin:10px 0 0;font-size:22px;color:#18304e}#gyeot-demo .plush-note{margin:36px 0 0;text-align:center;color:#687485;font-size:13px}</style><div id="gyeot-demo"><div class="plush-title"><h1>카이의 개발 일지</h1><p>${character === "otter" ? "" : characterName + " · "}작은 진척을 함께 쌓아가요.</p></div><div class="plush-gallery">${scenes.map(([phase, label]) => `<article><div class="plush-motion-preview g-diary-art" ${motionAttributes({ surface: "preview", agentId: "dev", character, phase })}>${diaryIllustration(phase, "", character)}${plushEffects()}</div><h2>${label}</h2></article>`).join("")}</div><p class="plush-note">장면 디자인 미리보기 · 실제 업무 상태는 서버 기록에 따라 표시됩니다.</p></div></html>`;
  await gallery.route(`${origin}/__plush-gallery`, (route) =>
    route.fulfill({ contentType: "text/html", body: galleryHtml }),
  );
  await gallery.goto(`${origin}/__plush-gallery`, { waitUntil: "networkidle" });
  await gallery.evaluate(() => document.fonts.ready);
  const galleryVideo = gallery.video();
  await gallery.waitForTimeout(6500);
  await gallery.screenshot({
    path: `${directory}/developer-diary.png`,
    fullPage: true,
    animations: "disabled",
  });
  await galleryContext.close();
  await browser.close();
  browser = null;
  for (const [source, target, width] of [
    [await video.path(), "office.gif", 1100],
    [await galleryVideo.path(), "developer-diary.gif", 780],
  ]) {
    const child = spawn(
      encoder,
      [
        "-y",
        "-i",
        source,
        "-vf",
        `fps=10,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
        "-loop",
        "0",
        `${directory}/${target}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    if ((await once(child, "close"))[0] !== 0) throw Error(stderr.slice(-1200));
  }
  if (errors.length) throw Error(errors.join("\n"));
  const files = await Promise.all(
    [
      "office.png",
      "developer-diary.png",
      "office.gif",
      "developer-diary.gif",
    ].map(async (name) => {
      const bytes = await readFile(`${directory}/${name}`);
      return {
        name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  await writeFile(
    `${directory}/manifest.json`,
    JSON.stringify(
      {
        release: JSON.parse(await readFile("package.json", "utf8")).version,
        capturedAt: new Date().toISOString(),
        mode: "Static interactive mock with synthetic tasks; diary sheet is a scene design preview; no model calls",
        character,
        pageErrors: errors,
        files,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Plush office and twelve-scene diary captured; page errors: 0");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
