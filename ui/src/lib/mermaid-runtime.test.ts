// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import mermaid from "mermaid";

// jsdom has no SVG layout engine. Supply measurements only; rendering,
// parsing, sanitization and KaTeX still run through the installed packages.
beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value() { return { x: 0, y: 0, width: 120, height: 24 }; },
  });
});
afterEach(() => { document.body.replaceChildren(); });

describe("installed Mermaid runtime", () => {
  it("renders a strict diagram with Korean task labels", async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true });
    const { svg } = await mermaid.render("security-flowchart", "flowchart LR\n  request[요청] --> complete[완료]");
    const rendered = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(rendered.querySelector("parsererror")).toBeNull();
    expect(rendered.querySelector("svg")).not.toBeNull();
    expect(rendered.documentElement.textContent).toContain("요청");
    expect(rendered.documentElement.textContent).toContain("완료");
    expect(rendered.querySelector("script")).toBeNull();
  });

  it("renders mathematical labels through the patched KaTeX dependency", async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true });
    const { svg } = await mermaid.render("security-math", 'flowchart LR\n  equation["$$x^2$$"] --> result[완료]');
    expect(svg).toContain("katex");
    expect(svg).toContain("완료");
  });
});
