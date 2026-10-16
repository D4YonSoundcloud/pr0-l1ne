import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * main.ts finds the page's elements by id (byId("speed")). A typo or a
 * renamed id gives null, and the app fails as it starts, which no unit test
 * sees. This checks every id main.ts asks for exists in index.html.
 */
describe("the page's elements", () => {
  it("has every element main.ts looks up", () => {
    const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const wanted = [...main.matchAll(/byId(?:<[^>]+>)?\("([^"]+)"\)/g)].map((m) => m[1]);
    const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    expect(wanted.length).toBeGreaterThan(40);
    expect(wanted.filter((id) => !present.has(id))).toEqual([]);
  });
});
