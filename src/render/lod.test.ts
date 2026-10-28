import { describe, expect, it } from "vitest";
import { s } from "./draw";
import { descendants } from "./drawing";
import { atLevel, landmarksIn, lodAt, lodFor } from "./lod";

describe("levels of detail", () => {
  it("go by zoom: full, reduced, blocks, outline, overview", () => {
    expect([1, 0.6, 0.5, 0.35, 0.2, 0.12, 0.05, 0.03, 0.01].map(lodAt)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4]);
  });

  it("change only once the zoom is well past a threshold, so zooming slowly across one doesn't flicker", () => {
    // At reduced (35% to 60%): back to full only at 66%, on to blocks only below 31.5%.
    expect(lodFor(0.62, 1)).toBe(1);
    expect(lodFor(0.67, 1)).toBe(0);
    expect(lodFor(0.33, 1)).toBe(1);
    expect(lodFor(0.3, 1)).toBe(2);
    // A jump goes straight to its level.
    expect(lodFor(0.01, 0)).toBe(4);
    expect(lodFor(1, 4)).toBe(0);
    expect(lodFor(0.2)).toBe(2);
  });

  it("leave out what each level hides, from a copy: the drawing itself is untouched", () => {
    const drawing = s(
      "svg",
      { class: "memory-svg" },
      s(
        "g",
        { class: "node", "data-node-key": "obj:o1" },
        s("rect", { class: "node-hit" }),
        s("rect", { class: "node-outline" }),
        s("text", { class: "index" }, "0"),
        s("g", { class: "cell" }, s("rect", {}), s("text", { class: "value" }, "7")),
        s("g", { class: "pointer" }, s("path", {}), s("text", {}, "i")),
      ),
      s("g", { class: "arrows arrow-tops" }, s("path", { class: "arrow-head" })),
    );
    const count = (d: ReturnType<typeof s>, selector: string) =>
      descendants(d).filter((m) => m.matches(selector)).length;
    expect(atLevel(drawing, 0)).toBe(drawing);
    const reduced = atLevel(drawing, 1);
    expect(count(reduced, ".index")).toBe(0);
    // The pointer's name is gone too: the value is the only text left.
    expect(count(reduced, "text")).toBe(1);
    expect(count(reduced, ".value")).toBe(1);
    const blocks = atLevel(drawing, 2);
    expect(count(blocks, "text")).toBe(0);
    expect(count(blocks, ".cell")).toBe(1);
    expect(count(blocks, "rect")).toBe(3); // the box's two, and the cell's
    expect(count(atLevel(drawing, 3), ".arrow-tops")).toBe(0);
    const overview = atLevel(drawing, 4);
    expect(
      descendants(overview)
        .filter((m) => m.parentElement?.matches(".node"))
        .map((m) => m.getAttribute("class")),
    ).toEqual(["node-hit", "node-outline"]);
    expect(count(drawing, "text")).toBe(3);
  });

  it("read a drawing's landmarks", () => {
    const drawing = s("svg", { "data-landmarks": JSON.stringify([{ x: 1, y: 2, text: "Global", kind: "frame" }]) });
    expect(landmarksIn(drawing)).toEqual([{ x: 1, y: 2, text: "Global", kind: "frame" }]);
    expect(landmarksIn(s("svg", {}))).toEqual([]);
    expect(landmarksIn(s("svg", { "data-landmarks": "{oops" }))).toEqual([]);
  });
});
