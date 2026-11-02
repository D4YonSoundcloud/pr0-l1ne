// @vitest-environment jsdom
/**
 * Text measured once (pixiScene.ts textMeasures): the real PixiJS's
 * measurement table is ours, so PixiJS and drawText share one, bigger than
 * the 1,000 strings PixiJS keeps. If an upgrade of PixiJS moves or renames
 * its table, this fails, rather than text quietly being measured twice.
 */
import { CanvasTextMetrics, TextStyle } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { forgetFonts, TextMeasures, textMeasures } from "./pixiScene";

describe("text measured once", () => {
  it("stands in for PixiJS's own table", () => {
    expect((CanvasTextMetrics as unknown as { _measurementCache: unknown })._measurementCache).toBe(textMeasures);
  });

  it("measures each string in a style once, past PixiJS's 1,000, until the fonts change", () => {
    forgetFonts();
    // Node has no canvas: measure with a stand-in that counts.
    const measure = vi
      .spyOn(CanvasTextMetrics as unknown as { _measureText: (t: string) => number }, "_measureText")
      .mockImplementation((t: string) => t.length * 7);
    vi.spyOn(CanvasTextMetrics, "measureFont").mockReturnValue({ ascent: 10, descent: 3, fontSize: 13 });
    const style = new TextStyle({ fontFamily: "monospace", fontSize: 13 });
    const context = { font: "", letterSpacing: "0px", textBaseline: "alphabetic", measureText: () => ({ width: 0 }) };
    // jsdom has no 2D canvas either.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    const measureText = (s: string) => CanvasTextMetrics.measureText(s, style);
    const strings = Array.from({ length: 3000 }, (_, i) => `value ${i}`);
    try {
      for (const s of strings) measureText(s);
      const first = measure.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      for (const s of strings) measureText(s);
      expect(measure.mock.calls.length).toBe(first);
      forgetFonts();
      measureText(strings[0]);
      expect(measure.mock.calls.length).toBeGreaterThan(first);
    } finally {
      vi.restoreAllMocks();
      forgetFonts();
    }
  });

  it("starts again past its size", () => {
    const table = new TextMeasures<number>(3);
    for (const k of ["a", "b", "c"]) table.set(k, 1);
    table.set("a", 2);
    expect(table.size).toBe(3);
    table.set("d", 1);
    expect(table.size).toBe(1);
    expect(table.get("d")).toBe(1);
  });
});
