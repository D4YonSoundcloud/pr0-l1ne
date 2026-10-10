// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  COLOR_FIELDS, DEFAULT_APPEARANCE, PRESETS, applyAppearance, clone, gridImage, isEasing, parseAppearance,
} from "./appearance";
import { bezierPoints } from "./stylePanel";

describe("parseAppearance", () => {
  it("gives the default look when nothing is saved", () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("not json")).toEqual(DEFAULT_APPEARANCE);
  });

  it("round-trips saved settings", () => {
    const night = clone(PRESETS.find((p) => p.theme === "Night")!);
    night.memory.easing = "cubic-bezier(0.1, 0.9, 0.2, 1.3)";
    night.loop.grid = "dots";
    expect(parseAppearance(JSON.stringify(night))).toEqual(night);
  });

  it("replaces anything invalid with the default, field by field", () => {
    const parsed = parseAppearance(JSON.stringify({
      memory: { background: "red", grid: "plaid", gridSize: 900, easing: "bouncy", duration: -5 },
      colors: { ink: "#123456", cell: "url(evil)" },
      arrowWidth: "thick",
      font: "Comic Sans",
    }));
    expect(parsed.memory).toMatchObject({
      background: DEFAULT_APPEARANCE.memory.background, grid: "lines", gridSize: 64,
      easing: DEFAULT_APPEARANCE.memory.easing, duration: 0,
    });
    expect(parsed.colors.ink).toBe("#123456");
    expect(parsed.colors.cell).toBe(DEFAULT_APPEARANCE.colors.cell);
    expect(parsed.arrowWidth).toBe(1);
    expect(parsed.font).toBe(DEFAULT_APPEARANCE.font);
  });

  it("has every color in every preset", () => {
    for (const preset of PRESETS) {
      for (const field of COLOR_FIELDS) expect(preset.colors[field.key], `${preset.theme}: ${field.key}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("easing", () => {
  it("accepts CSS keywords and cubic-beziers with x in 0..1", () => {
    expect(isEasing("linear")).toBe(true);
    expect(isEasing("ease-in-out")).toBe(true);
    expect(isEasing("cubic-bezier(0.34, 1.56, 0.64, 1)")).toBe(true);
    expect(isEasing("cubic-bezier(1.5, 0, 0, 1)")).toBe(false); // x out of range
    expect(isEasing("cubic-bezier(0, 0, 1)")).toBe(false);
    expect(isEasing("springy")).toBe(false);
  });

  it("finds the curve's control points for the preview", () => {
    expect(bezierPoints("cubic-bezier(0.2, 0.7, 0.2, 1)")).toEqual([0.2, 0.7, 0.2, 1]);
    expect(bezierPoints("linear")).toEqual([0, 0, 1, 1]);
  });
});

describe("applyAppearance", () => {
  it("sets diagram variables on the canvas and backgrounds on each window", () => {
    const canvas = document.createElement("div");
    const memory = document.createElement("section");
    const loop = document.createElement("section");
    const sizes: [string, number][] = [];
    const a = clone(DEFAULT_APPEARANCE);
    a.memory.background = "#101010";
    a.loop.grid = "none";
    a.loop.gridSize = 40;
    a.colors.highlight = "#ff00ff";
    a.arrowWidth = 2;
    applyAppearance(a, { canvas, memory, loop }, (pane, size) => sizes.push([pane, size]));
    expect(canvas.style.getPropertyValue("--highlight")).toBe("#ff00ff");
    expect(canvas.style.getPropertyValue("--arrow-width")).toBe("2");
    expect(memory.style.getPropertyValue("--paper")).toBe("#101010");
    expect(loop.style.getPropertyValue("--grid-image")).toBe("none");
    expect(sizes).toEqual([["memory", 24], ["loop", 40]]);
  });

  it("draws lines, dots or nothing", () => {
    expect(gridImage("lines")).toContain("linear-gradient");
    expect(gridImage("dots")).toContain("radial-gradient");
    expect(gridImage("none")).toBe("none");
  });
});

describe("printed output motion", () => {
  it("defaults to fading and sliding in, and reads saved choices", () => {
    expect(parseAppearance(null).output).toEqual({ fade: true, slide: true, dimFade: true, duration: 240 });
    const saved = parseAppearance(JSON.stringify({ output: { fade: false, slide: false, dimFade: "yes", duration: 5000 } }));
    expect(saved.output).toEqual({ fade: false, slide: false, dimFade: true, duration: 1000 });
  });

  it("copies are independent of the preset they came from", () => {
    const copy = clone(PRESETS[0]);
    copy.output.fade = false;
    expect(PRESETS[0].output.fade).toBe(true);
  });
});
