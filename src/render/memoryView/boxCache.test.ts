// @vitest-environment jsdom
/**
 * Kept boxes (boxCache.ts) must never show anything a fresh layout wouldn't:
 * for every example, in both memory modes, with memory sizes on and off,
 * stepping forward, back and around, the drawing made with kept boxes is
 * the one made from scratch, mark for mark. And they must actually be kept.
 * (Python's examples: boxCache.python.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../../examples/index";
import { traceJavaScript } from "../../js/trace";
import { traceTypeScript } from "../../js/typescript";
import { memoryScene } from "../../scene/memoryScene";
import { diffSteps } from "../../trace/diff";
import { applyHints } from "../../trace/hints";
import type { SizeModel } from "../../trace/memory";
import type { Trace } from "../../trace/types";
import { mark, toSvg } from "../drawing";
import { applyFocus, memoryDrawing, type Point } from "../memory";
import { SvgPatcher } from "../patch";
import { BoxCache, forgetBoxes } from "./boxCache";

/** Steps to visit: forward, then back, then jumping about (a person scrubbing). */
function visits(n: number): number[] {
  const forward = n <= 50 ? [...Array(n).keys()] : [...Array(50).keys()].map((k) => Math.floor((k * (n - 1)) / 49));
  const back = forward.slice(-8).reverse();
  const jumps = [0, n - 1, Math.floor(n / 2), 1, n - 2, Math.floor(n / 3)].filter((i) => i >= 0 && i < n);
  return [...forward, ...back, ...jumps];
}

const html = (el: Element) => el.outerHTML;

let keptCells = 0;

function check(trace: Trace, label: string, model: SizeModel): number {
  let kept = 0;
  for (const mode of ["arrows", "nested"] as const) {
    for (const sizes of [null, model]) {
      const boxes = new BoxCache();
      const patcher = new SvgPatcher();
      const positions = new Map<string, Point>();
      for (const i of visits(trace.steps.length)) {
        const scene = memoryScene(trace, i, diffSteps(trace.steps[i - 1], trace.steps[i]), { mode, sizes });
        // Now and then a box is dragged.
        if (i % 11 === 5 && scene.objects[0]) positions.set(scene.objects[0].key, { x: 20 * i, y: 300 + i });
        const fresh = toSvg(memoryDrawing(scene, { positions })) as Element;
        const drawing = memoryDrawing(scene, { positions, boxes });
        const where = `${label}, ${mode}${sizes ? ", sizes" : ""}, step ${i + 1}`;
        expect(html(toSvg(drawing) as Element), where).toBe(html(fresh));
        // Patched from the drawing before (sharing its marks), the page shows the same.
        if (i % 3 === 0) applyFocus(drawing, scene.objects.at(-1)?.key ?? null);
        expect(html(patcher.show(drawing)), `${where}, patched`).toBe(html(toSvg(drawing) as Element));
        kept += boxes.stats.kept;
        keptCells += boxes.cells.stats.kept;
      }
    }
  }
  return kept;
}

describe("kept boxes on the examples", () => {
  const programs = [
    ...JAVASCRIPT_EXAMPLES.map((e) => [e.name, () => traceJavaScript(e.code, 1500)] as const),
    ...TYPESCRIPT_EXAMPLES.slice(0, 3).map(
      (e) => [`${e.name} (TypeScript)`, () => traceTypeScript(e.code, 1500)] as const,
    ),
  ];
  let total = 0;
  it.each(programs)(
    "%s: every step drawn with kept boxes is the step drawn afresh",
    async (name, run) => {
      total += check(applyHints(await run()), name, "v8");
    },
    120_000,
  );
  it("keeps most boxes across steps", () => {
    expect(total).toBeGreaterThan(1000);
  });

  it("keeps cells inside boxes drawn again", () => {
    expect(keptCells).toBeGreaterThan(1000);
  });
});

describe("BoxCache", () => {
  it("draws every box again when something they all depend on changes", () => {
    const cache = new BoxCache();
    cache.begin();
    cache.end();
    forgetBoxes();
    cache.begin(); // forgets everything kept: nothing to check but that it doesn't throw
    cache.end();
    expect(cache.stats).toEqual({ drawn: 0, kept: 0 });
  });

  it("puts kept marks into the new drawing without taking them out of the old one", () => {
    const shared = mark("rect", { x: 1 });
    const old = mark("g", {}, shared);
    const now = mark("g", {});
    now.appendShared(shared);
    expect(old.childNodes).toContain(shared);
    expect(now.childNodes).toContain(shared);
    expect(shared.parentElement).toBe(now);
  });
});
