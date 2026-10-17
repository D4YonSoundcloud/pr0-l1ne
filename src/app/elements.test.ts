// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findElements } from "./elements";

/**
 * The app finds the page's elements by id (elements.ts). A typo or a
 * renamed id gives null, and the app fails as it starts, which no other
 * unit test sees. This loads index.html and checks every one is found.
 */
describe("the page's elements", () => {
  it("has every element the app looks up", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    const els = findElements();
    const missing = Object.entries(els)
      .filter(([, el]) => !el)
      .map(([name]) => name);
    expect(Object.keys(els).length).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });

  it("main.ts doesn't look elements up itself", () => {
    const main = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");
    expect(main).not.toMatch(/getElementById|byId\(/);
  });
});
