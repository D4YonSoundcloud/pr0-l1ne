import { describe, expect, it } from "vitest";
import {
  type Arrangement,
  BAR,
  columnsPreset,
  DIVIDER,
  describeTarget,
  dropTargetAt,
  legacyArrangement,
  mirror,
  moveWindow,
  order,
  parseArrangement,
  type Rect,
  samePlaces,
  solveTracks,
  stackedPreset,
  swapSides,
  swapWindows,
  trackCss,
  tracks,
  WINDOWS,
  type WindowName,
  windowRects,
} from "./arrangement";

const places = (a: Arrangement) => ({ dir: a.dir, items: a.items });

describe("presets", () => {
  it("stacks memory over loop history beside the code, or puts all three side by side", () => {
    expect(places(stackedPreset())).toEqual({
      dir: "row",
      items: ["editor", { dir: "column", a: "memory", b: "loop" }],
    });
    expect(order(columnsPreset())).toEqual(["editor", "memory", "loop"]);
    expect(order(columnsPreset(true))).toEqual(["memory", "loop", "editor"]);
    expect(order(stackedPreset(true))).toEqual(["memory", "loop", "editor"]);
  });

  it("mirrors the page, sizes and all", () => {
    const a = { ...columnsPreset(), weights: [50, 20, 30] };
    expect(mirror(a)).toMatchObject({ items: ["loop", "memory", "editor"], weights: [30, 20, 50] });
  });

  it("moves the code to the other side, the others keeping their order (⇄)", () => {
    expect(order(swapSides(columnsPreset()))).toEqual(["memory", "loop", "editor"]);
    expect(swapSides(swapSides(columnsPreset()))).toEqual(columnsPreset());
    const sized = { ...stackedPreset(), weights: [30, 70] };
    expect(swapSides(sized)).toMatchObject({ items: [sized.items[1], "editor"], weights: [70, 30] });
    // The code in the middle: the page is mirrored.
    expect(order(swapSides({ ...columnsPreset(), items: ["memory", "editor", "loop"] }))).toEqual([
      "loop",
      "editor",
      "memory",
    ]);
  });

  it("starts from how the layout was saved before windows could move", () => {
    const stacked = legacyArrangement({ columns: false, swapped: true, split: 30, canvasSplit: 70, columnSplit: null });
    expect(places(stacked)).toEqual(places(stackedPreset(true)));
    expect(stacked.weights).toEqual([70, 30]);
    expect(stacked.pairSplit).toBe(70);
    const columns = legacyArrangement({ columns: true, swapped: false, split: 40, canvasSplit: null, columnSplit: 25 });
    expect(columns.weights).toEqual([40, 15, 45]);
    // Nothing saved: the default.
    expect(
      places(legacyArrangement({ columns: false, swapped: false, split: null, canvasSplit: null, columnSplit: null })),
    ).toEqual(places(stackedPreset()));
  });
});

describe("parseArrangement", () => {
  it("reads back what it saved", () => {
    const a = moveWindow(stackedPreset(), "loop", { edge: "top" });
    expect(parseArrangement(JSON.stringify(a))).toEqual(a);
  });

  it("refuses anything that isn't all three windows, once each, in a shape it can draw", () => {
    const bad = [
      null,
      "nope",
      "{}",
      JSON.stringify({ dir: "row", items: ["editor", "memory"] }),
      JSON.stringify({ dir: "row", items: ["editor", "memory", "memory"] }),
      JSON.stringify({ dir: "row", items: ["editor", "memory", "loop", "editor"] }),
      JSON.stringify({ dir: "diagonal", items: ["editor", "memory", "loop"] }),
      // A pair must be split the other way from the line it's in.
      JSON.stringify({ dir: "row", items: ["editor", { dir: "row", a: "memory", b: "loop" }] }),
      JSON.stringify({
        dir: "row",
        items: [
          { dir: "column", a: "memory", b: "loop" },
          { dir: "column", a: "editor", b: "loop" },
        ],
      }),
    ];
    for (const json of bad) expect(parseArrangement(json), String(json)).toBeNull();
  });

  it("falls back to the usual sizes when they're missing or wrong", () => {
    const read = parseArrangement(
      JSON.stringify({ dir: "row", items: ["editor", "memory", "loop"], weights: [1, -2] }),
    );
    expect(read?.weights).toEqual(columnsPreset().weights);
    const clamped = parseArrangement(JSON.stringify({ ...stackedPreset(), pairSplit: 99 }));
    expect(clamped?.pairSplit).toBe(85);
  });
});

describe("moveWindow", () => {
  const stacked = stackedPreset();

  it("puts a window beside another in the same direction: a line of three", () => {
    // Memory to the left of the code: memory | code | loop history.
    const a = moveWindow(stacked, "memory", { window: "editor", side: "left" });
    expect(places(a)).toEqual({ dir: "row", items: ["memory", "editor", "loop"] });
  });

  it("puts a window across another: the two become a pair", () => {
    // Loop history under the code: (code over loop history) | memory.
    const a = moveWindow(stacked, "loop", { window: "editor", side: "bottom" });
    expect(places(a)).toEqual({ dir: "row", items: [{ dir: "column", a: "editor", b: "loop" }, "memory"] });
  });

  it("puts a window along a whole edge of the page", () => {
    // The code across the bottom, memory beside loop history above it.
    const a = moveWindow(columnsPreset(), "editor", { edge: "bottom" });
    expect(places(a)).toEqual({ dir: "column", items: [{ dir: "row", a: "memory", b: "loop" }, "editor"] });
    // ...and back along the left: memory and loop history side by side again, the code before them.
    expect(order(moveWindow(a, "editor", { edge: "left" }))).toEqual(["editor", "memory", "loop"]);
    // The code on the right of a pair stacked the other way.
    const right = moveWindow(stacked, "editor", { edge: "right" });
    expect(places(right)).toEqual({ dir: "row", items: [{ dir: "column", a: "memory", b: "loop" }, "editor"] });
  });

  it("swaps two windows dropped in the middle, keeping every size", () => {
    const a = { ...stacked, weights: [25, 75], pairSplit: 70 };
    const swapped = moveWindow(a, "editor", { window: "loop", side: "center" });
    expect(places(swapped)).toEqual({ dir: "row", items: ["loop", { dir: "column", a: "memory", b: "editor" }] });
    expect(swapped.weights).toEqual([25, 75]);
    expect(swapped.pairSplit).toBe(70);
    expect(swapWindows(swapped, "editor", "loop")).toEqual(a);
  });

  it("takes a window out of a pair, its partner taking the pair's place", () => {
    // Memory above the code: memory goes to the left of everything else instead.
    const a = moveWindow(stacked, "memory", { edge: "left" });
    expect(places(a)).toEqual({ dir: "row", items: ["memory", "editor", "loop"] });
  });

  it("leaves things as they are for a drop on the window itself", () => {
    expect(moveWindow(stacked, "memory", { window: "memory", side: "left" })).toBe(stacked);
    expect(samePlaces(moveWindow(stacked, "editor", { edge: "left" }), stacked)).toBe(true);
  });

  it("can reach every arrangement of three windows", () => {
    // From the default, by moving windows: every line of three in both directions, and
    // every window beside every pair, on every side.
    const seen = new Set<string>();
    const queue = [stackedPreset()];
    const targets = (dragged: WindowName) => [
      ...(["left", "right", "top", "bottom"] as const).map((edge) => ({ edge })),
      ...WINDOWS.filter((w) => w !== dragged).flatMap((window) =>
        (["left", "right", "top", "bottom", "center"] as const).map((side) => ({ window, side })),
      ),
    ];
    while (queue.length) {
      const a = queue.pop()!;
      const key = JSON.stringify(places(a));
      if (seen.has(key)) continue;
      seen.add(key);
      for (const w of WINDOWS) for (const t of targets(w)) queue.push(moveWindow(a, w, t));
    }
    // A line: 6 orders × 2 directions. A window beside a pair: which window (3) ×
    // the direction (2) × before or after the pair (2) × the pair's order (2).
    expect(seen.size).toBe(12 + 24);
    for (const key of seen) expect(parseArrangement(JSON.stringify({ ...JSON.parse(key) }))).not.toBeNull();
  });
});

describe("tracks", () => {
  it("lays out the default: the code beside memory over loop history", () => {
    const t = tracks(stackedPreset(), []);
    expect(trackCss(t.columns)).toBe(`minmax(0, 40fr) ${DIVIDER}px minmax(0, 60fr)`);
    expect(trackCss(t.rows)).toBe(`minmax(0, 55fr) ${DIVIDER}px minmax(0, 45fr)`);
    expect(t.windows.editor).toEqual({ column: [1, 2], row: [1, 4] });
    expect(t.windows.memory).toEqual({ column: [3, 4], row: [1, 2] });
    expect(t.windows.loop).toEqual({ column: [3, 4], row: [3, 4] });
    expect(t.dividers.map((d) => [d.axis, d.between])).toEqual([
      ["x", { root: 0 }],
      ["y", "pair"],
    ]);
    expect(t.upright).toEqual({ editor: true, memory: false, loop: false });
  });

  it("turns everything for a column", () => {
    const a = moveWindow(columnsPreset(), "editor", { edge: "top" });
    const t = tracks(a, []);
    expect(t.windows.editor).toEqual({ column: [1, 4], row: [1, 2] });
    expect(t.windows.memory).toEqual({ column: [1, 2], row: [3, 4] });
    expect(t.dividers[0].axis).toBe("y");
    expect(t.dividers[1].axis).toBe("x");
    expect(t.upright.editor).toBe(false);
  });

  it("gives a folded window a bar, and its room to the others", () => {
    const code = tracks(stackedPreset(), ["editor"]);
    expect(trackCss(code.columns)).toBe(`${BAR}px 0px minmax(0, 60fr)`);
    expect(code.dividers[0].active).toBe(false);
    const loop = tracks(stackedPreset(), ["loop"]);
    expect(trackCss(loop.rows)).toBe(`minmax(0, 55fr) 0px ${BAR}px`);
    expect(loop.dividers[1].active).toBe(false);
    // Both of a pair folded: a strip of two bars, standing upright.
    const both = tracks(stackedPreset(), ["memory", "loop"]);
    expect(trackCss(both.columns)).toBe(`minmax(0, 40fr) 0px ${BAR}px`);
    expect(both.upright).toMatchObject({ memory: true, loop: true });
    // Side by side, folded bars stand upright.
    expect(tracks(columnsPreset(), ["memory"]).upright.memory).toBe(true);
  });
});

describe("windowRects", () => {
  const area: Rect = { x: 0, y: 100, width: 1006, height: 806 };
  it("matches what the grid gives", () => {
    const r = windowRects({ ...stackedPreset(), weights: [40, 60], pairSplit: 50 }, [], area);
    expect(r.editor).toEqual({ x: 0, y: 100, width: 400, height: 806 });
    expect(r.memory).toEqual({ x: 406, y: 100, width: 600, height: 400 });
    expect(r.loop).toEqual({ x: 406, y: 506, width: 600, height: 400 });
  });

  it("shares the room left after fixed tracks by weight", () => {
    expect(solveTracks([{ px: 32 }, { fr: 1 }, { fr: 3 }], 432)).toEqual([32, 100, 300]);
  });
});

describe("dropTargetAt", () => {
  const area: Rect = { x: 0, y: 0, width: 1000, height: 800 };
  const rects = windowRects({ ...stackedPreset(), weights: [40, 60], pairSplit: 50 }, [], area);

  it("goes along an edge of the page near the edge", () => {
    expect(dropTargetAt({ x: 10, y: 400 }, rects, area, "memory")).toEqual({ edge: "left" });
    expect(dropTargetAt({ x: 500, y: 790 }, rects, area, "memory")).toEqual({ edge: "bottom" });
  });

  it("goes beside the window under the pointer, on its nearest side, or in its place from its middle", () => {
    expect(dropTargetAt({ x: 60, y: 400 }, rects, area, "memory")).toEqual({ window: "editor", side: "left" });
    expect(dropTargetAt({ x: 200, y: 700 }, rects, area, "memory")).toEqual({ window: "editor", side: "bottom" });
    expect(dropTargetAt({ x: 200, y: 400 }, rects, area, "memory")).toEqual({ window: "editor", side: "center" });
  });

  it("has nowhere to go over the dragged window itself", () => {
    expect(dropTargetAt({ x: 700, y: 200 }, rects, area, "memory")).toBeNull();
  });

  it("says where in words", () => {
    const names = { editor: "Code", memory: "Memory", loop: "Loop history" };
    expect(describeTarget({ edge: "left" }, names)).toBe("along the left edge");
    expect(describeTarget({ window: "loop", side: "top" }, names)).toBe("above Loop history");
    expect(describeTarget({ window: "editor", side: "center" }, names)).toBe("in place of Code");
  });
});
