// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("./crewroom/CrewroomSidebar", () => ({
  CrewroomSidebar: () => <nav data-testid="crewroom-sidebar">Crewroom navigation</nav>,
}));

it.each([false, true])("renders the Crewroom entry and preserves optional contextual children (%s)", withChildren => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<Sidebar>{withChildren ? <aside data-testid="contextual-child">Contextual navigation</aside> : undefined}</Sidebar>));
    expect(container.querySelectorAll('[data-testid="crewroom-sidebar"]')).toHaveLength(1);
    expect(container.firstElementChild?.getAttribute("data-testid")).toBe("crewroom-sidebar");
    expect(container.querySelector('[data-testid="contextual-child"]')?.textContent ?? null)
      .toBe(withChildren ? "Contextual navigation" : null);
    expect(container.children).toHaveLength(withChildren ? 2 : 1);
  } finally { flushSync(() => root.unmount()); }
});
