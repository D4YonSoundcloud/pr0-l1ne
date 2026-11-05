// @vitest-environment jsdom
/**
 * Kept loop rows and rows left out of view (rowCache.ts) must never show
 * anything a fresh drawing wouldn't: for every example, every step, in each
 * mode, a drawing that keeps rows is the fresh one mark for mark, and one
 * drawn for a part of the view is the fresh one without the rows outside
 * it. And rows must actually be kept, and the cells of rows drawn again
 * (rowCache.ts cells), stacked and animated.
 */
import { describe, expect, it } from "vitest";
import { liveRows } from "../../app/loopController";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../../examples/index";
import { traceJavaScript } from "../../js/trace";
import { traceTypeScript } from "../../js/typescript";
import { loopScene } from "../../scene/loopScene";
import { applyHints } from "../../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../../trace/loopHistory";
import type { Trace } from "../../trace/types";
import { type Mark, toSvg } from "../drawing";
import { SvgPatcher } from "../patch";
import { loopDrawing } from "./layout";
import { RowCache, RowsInView } from "./rowCache";

/** Steps to visit: forward, then back, then about. */
function visits(n: number): number[] {
  const forward = n <= 60 ? [...Array(n).keys()] : [...Array(60).keys()].map((k) => Math.floor((k * (n - 1)) / 59));
  return [...forward, ...forward.slice(-6).reverse(), 0, n - 1, Math.floor(n / 2)].filter((i) => i >= 0 && i < n);
}

const rowsOf = (drawing: Mark) => drawing.querySelectorAll(".loop-row");

/** Cells kept in rows drawn again: stacked, and in animated mode's live rows. */
const cellsKept = { stacked: 0, live: 0 };

function check(trace: Trace, label: string): number {
  let kept = 0;
  for (const hideQuiet of [true, false])
    for (const vertical of [false, true]) {
      const rows = new RowCache();
      const liveCache = new RowCache();
      const livePatcher = new SvgPatcher();
      const patcher = new SvgPatcher();
      // Scrolling as it steps: a window that moves each step, with rows kept, patched onto one SVG.
      const scrolled = new RowCache();
      const scrolling = new SvgPatcher();
      for (const i of visits(trace.steps.length)) {
        const history = buildNestedHistory(trace, i) ?? buildLoopHistory(trace, i, null);
        if (!history?.rows.length) continue;
        const where = `${label}, ${hideQuiet ? "quiet hidden" : "all"}${vertical ? ", vertical" : ""}, step ${i + 1}`;
        const scene = loopScene(trace, history, { hideQuiet });
        const fresh = loopDrawing(scene, { vertical });
        const drawing = loopDrawing(scene, { vertical, rows });
        expect(drawing.signature() === fresh.signature(), where).toBe(true);
        expect(patcher.show(drawing).outerHTML, `${where}, patched`).toBe((toSvg(drawing) as Element).outerHTML);
        kept += rows.stats.kept;
        cellsKept.stacked += rows.cells.stats.kept;

        // Only part of it in view: the fresh drawing's rows that reach it, as they are.
        const height = Number(fresh.getAttribute("height"));
        const visible = { top: height * 0.3, bottom: height * 0.6 };
        const part = loopDrawing(scene, { vertical, visible });
        expect(part.getAttribute("height"), where).toBe(fresh.getAttribute("height"));
        const freshRows = rowsOf(fresh);
        const partRows = rowsOf(part);
        const reaches = (r: Mark) =>
          r.classList.contains("is-current") ||
          (Number(r.getAttribute("data-bottom")) >= visible.top &&
            Number(r.getAttribute("data-top")) <= visible.bottom);
        expect(
          partRows.map((r) => r.signature()),
          `${where}, in view`,
        ).toEqual(freshRows.filter(reaches).map((r) => r.signature()));

        const window = height / 3;
        const top = ((i * 7) % 5) * (height / 5) - window;
        const moving = loopDrawing(scene, { vertical, rows: scrolled, visible: { top, bottom: top + 3 * window } });
        expect(scrolling.show(moving).outerHTML, `${where}, scrolling`).toBe((toSvg(moving) as Element).outerHTML);

        // Animated mode: rows never kept (one live row), its cells are; the same as fresh.
        const live = loopScene(trace, history, { hideQuiet: false, live: liveRows(trace, i, history) });
        const liveDrawing = loopDrawing(live, { vertical, rows: liveCache });
        cellsKept.live += liveCache.cells.stats.kept;
        expect(liveDrawing.signature() === loopDrawing(live, { vertical }).signature(), `${where}, animated`).toBe(
          true,
        );
        expect(livePatcher.show(liveDrawing).outerHTML, `${where}, animated, patched`).toBe(
          (toSvg(liveDrawing) as Element).outerHTML,
        );
      }
    }
  return kept;
}

describe("kept loop rows on the examples", () => {
  const programs = [
    ...JAVASCRIPT_EXAMPLES.map((e) => [e.name, () => traceJavaScript(e.code, 1500)] as const),
    ...TYPESCRIPT_EXAMPLES.slice(0, 3).map(
      (e) => [`${e.name} (TypeScript)`, () => traceTypeScript(e.code, 1500)] as const,
    ),
  ];
  let total = 0;
  it.each(programs)(
    "%s: every step drawn with kept rows, or only the rows in view, matches the step drawn afresh",
    async (name, run) => {
      total += check(applyHints(await run()), name);
    },
    120_000,
  );
  it("keeps rows across steps, and the cells of rows drawn again", () => {
    expect(total).toBeGreaterThan(500);
    expect(cellsKept.stacked).toBeGreaterThan(500);
    expect(cellsKept.live).toBeGreaterThan(500);
  });
});

describe("RowsInView", () => {
  const at = (top: number, bottom: number, autoFit = false) => ({
    autoFit,
    span: (m: number) => ({ top: top - m * (bottom - top), bottom: bottom + m * (bottom - top) }),
  });

  it("draws a window's height more above and below the view, and is stale once the view leaves that", () => {
    const rows = new RowsInView();
    expect(rows.next(at(1000, 1500))).toEqual({ top: 500, bottom: 2000 });
    expect(rows.stale(at(600, 1900))).toBe(false);
    expect(rows.stale(at(400, 900))).toBe(true);
    expect(rows.stale(at(1800, 2100))).toBe(true);
  });

  it("with Auto-fit on, draws every row; once Auto-fit is off, draws again for the view", () => {
    const rows = new RowsInView();
    expect(rows.next(at(0, 10, true))).toBeUndefined();
    expect(rows.stale(at(-1e6, 1e6, true))).toBe(false);
    expect(rows.stale(at(0, 10))).toBe(true);
    expect(rows.next(at(0, 10))).toEqual({ top: -10, bottom: 20 });
    expect(rows.stale(at(0, 10))).toBe(false);
  });
});
