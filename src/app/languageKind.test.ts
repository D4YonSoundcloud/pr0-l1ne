// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { showLanguageKind } from "./languageKind";

describe("showLanguageKind", () => {
  it("names the windows for what they show, and marks the page for the styles", () => {
    document.body.innerHTML = `
      <h2 id="memory-title">Memory</h2><h2 id="loop-title">Loop history</h2>
      <button class="view-choice" data-view="memory">Memory</button>
      <button class="view-choice" data-view="loop">Loops</button>`;
    const text = (selector: string) => document.querySelector(selector)?.textContent;
    showLanguageKind("query");
    expect(document.documentElement.dataset.kind).toBe("query");
    expect([text("#memory-title"), text("#loop-title")]).toEqual(["Tables", "Query steps"]);
    expect(text('[data-view="loop"]')).toBe("Steps");
    showLanguageKind("program");
    expect(document.documentElement.dataset.kind).toBe("program");
    expect([text("#memory-title"), text("#loop-title")]).toEqual(["Memory", "Loop history"]);
    expect(text('[data-view="memory"]')).toBe("Memory");
  });
});
