import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";

// Rendering tools stay outside the app's dependencies. See docs/diagrams/README.md.
const directory = resolve("docs/diagrams"),
  distribution = resolve(
    process.env.MERMAID_DIST ||
      ".local/diagram-tools/node_modules/mermaid/dist",
  ),
  entries = JSON.parse(await readFile(directory + "/diagrams.json", "utf8")),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
await readFile(distribution + "/mermaid.esm.min.mjs");
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="ko"><meta charset="utf-8">
        <style>body{margin:0;background:#fff}#diagram{padding:32px;display:inline-block;width:max-content}svg{display:block;max-width:none!important}</style>
        <div id="diagram"></div><script type="module">
        import mermaid from '/mermaid.esm.min.mjs';
        window.mermaid=mermaid;
        </script></html>`);
      return;
    }
    const file = resolve(distribution, "." + decodeURIComponent(pathname));
    if (!file.startsWith(distribution + sep)) throw new Error("Invalid path");
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch(),
  page = await browser.newPage({
    viewport: { width: 1800, height: 1200 },
    deviceScaleFactor: 2,
  }),
  diagrams = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.mermaid);
  await page.evaluate(() => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      htmlLabels: false,
      fontFamily: '"Apple SD Gothic Neo", "Noto Sans KR", Arial, sans-serif',
      themeVariables: {
        fontSize: "18px",
        primaryColor: "#f0eefb",
        primaryTextColor: "#262537",
        primaryBorderColor: "#7770ba",
        secondaryColor: "#eaf5f0",
        secondaryTextColor: "#243a31",
        secondaryBorderColor: "#73a18b",
        tertiaryColor: "#f7f8fc",
        lineColor: "#777a8e",
        mainBkg: "#f0eefb",
        nodeBorder: "#7770ba",
        clusterBkg: "#f8f8fb",
        clusterBorder: "#d7d8e3",
        edgeLabelBackground: "#ffffff",
        actorBkg: "#f0eefb",
        actorBorder: "#7770ba",
        actorTextColor: "#262537",
        signalColor: "#55576e",
        signalTextColor: "#262537",
      },
      flowchart: {
        htmlLabels: false,
        useMaxWidth: false,
        nodeSpacing: 36,
        rankSpacing: 52,
        padding: 18,
      },
      sequence: {
        useMaxWidth: false,
        wrap: true,
        width: 170,
        actorMargin: 48,
        messageMargin: 34,
      },
      er: { useMaxWidth: false },
    });
  });
  for (const entry of entries) {
    const source = await readFile(directory + "/" + entry.source, "utf8");
    const rendered = await page.evaluate(
      async ({ id, title, source }) => {
        const host = document.getElementById("diagram");
        host.replaceChildren();
        const { svg } = await mermaid.render("d-" + id, source);
        host.innerHTML = svg;
        await document.fonts.ready;
        const element = host.querySelector("svg"),
          box = element.viewBox.baseVal,
          width = Math.ceil(box.width),
          height = Math.ceil(box.height);
        element.setAttribute("width", width);
        element.setAttribute("height", height);
        element.setAttribute("aria-label", title);
        element.style.maxWidth = "none";
        element.style.backgroundColor = "#ffffff";
        if (!width || !height || element.querySelector(".error-icon"))
          throw new Error("Invalid rendered diagram: " + id);
        return { svg: element.outerHTML, width, height };
      },
      { ...entry, source },
    );
    const svg = Buffer.from(rendered.svg + "\n"),
      png = await page.locator("#diagram").screenshot();
    await writeFile(directory + "/" + entry.id + ".svg", svg);
    await writeFile(directory + "/" + entry.id + ".png", png);
    diagrams.push({
      ...entry,
      width: rendered.width,
      height: rendered.height,
      sourceHash: hash(source),
      svg: { file: entry.id + ".svg", bytes: svg.length, sha256: hash(svg) },
      png: { file: entry.id + ".png", bytes: png.length, sha256: hash(png) },
    });
    console.log(`${entry.id}: ${rendered.width} × ${rendered.height}`);
  }
  await writeFile(
    directory + "/manifest.json",
    JSON.stringify(
      {
        renderer:
          "Mermaid 11.17.2 + Chromium; pre-rendered PNG and standalone SVG",
        diagrams,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
