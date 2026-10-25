// @vitest-environment jsdom
/**
 * The Layout panel's spacing (spacing.ts): read safely from settings, used
 * by the layout as soon as it's set, and safe across each setting's whole
 * range: with everything at its minimum, or its maximum, every JavaScript
 * example still draws with no overlapping boxes, no arrow through a box,
 * and no NaN anywhere.
 */
import { afterEach, describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { loopScene } from "../scene/loopScene";
import { type MemoryMode, memoryScene } from "../scene/memoryScene";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { renderLoopHistory } from "./loopView";
import { renderMemory } from "./memory";
import { crosses, overlaps, type Point, type Rect } from "./route";
import {
  changedFromDefault,
  clampSpacing,
  DEFAULT_SPACING,
  defaultSpacing,
  parseSpacing,
  SPACING_FIELDS,
  SPACING_GROUPS,
  type Spacing,
  sameSpacing,
  setSpacing,
  spacing,
} from "./spacing";

afterEach(() => setSpacing(defaultSpacing()));

describe("spacing settings", () => {
  it("lists every setting once, each default inside its own range and on its step", () => {
    expect(SPACING_FIELDS.map((f) => f.key).sort()).toEqual(Object.keys(DEFAULT_SPACING).sort());
    for (const f of SPACING_FIELDS) {
      const value = DEFAULT_SPACING[f.key];
      expect(value, f.key).toBeGreaterThanOrEqual(f.min);
      expect(value, f.key).toBeLessThanOrEqual(f.max);
      expect(clampSpacing(f.key, value), f.key).toBe(value);
      expect(SPACING_GROUPS.some((g) => g.key === f.group)).toBe(true);
    }
  });

  it("reads saved JSON, keeping what's valid and defaulting the rest", () => {
    expect(parseSpacing(null)).toEqual(defaultSpacing());
    expect(parseSpacing("not json")).toEqual(defaultSpacing());
    expect(parseSpacing("[1,2]")).toEqual(defaultSpacing());
    const read = parseSpacing(JSON.stringify({ lane: 12, rowGap: "wide", columnGap: 9999, stackGap: -5, unknown: 3 }));
    expect(read.lane).toBe(12);
    expect(read.rowGap).toBe(DEFAULT_SPACING.rowGap);
    expect(read.columnGap).toBe(200); // the maximum
    expect(read.stackGap).toBe(4); // the minimum
    expect("unknown" in read).toBe(false);
  });

  it("snaps to each setting's step", () => {
    expect(clampSpacing("behindCost", 333)).toBe(350);
    expect(clampSpacing("columnGap", 65)).toBe(66);
    expect(clampSpacing("lane", Number.NaN)).toBe(DEFAULT_SPACING.lane);
  });

  it("stores only what differs from the defaults", () => {
    expect(changedFromDefault(defaultSpacing())).toEqual({});
    expect(changedFromDefault({ ...defaultSpacing(), lane: 9 })).toEqual({ lane: 9 });
    expect(sameSpacing(parseSpacing(JSON.stringify({ lane: 9 })), { ...defaultSpacing(), lane: 9 })).toBe(true);
  });

  it("setSpacing clamps, and fills in the defaults for anything left out", () => {
    setSpacing({ lane: 100 });
    expect(spacing.lane).toBe(20);
    expect(spacing.rowGap).toBe(DEFAULT_SPACING.rowGap);
  });
});

const listCode = `const nums = [5, 2, 8];
const pairs = { a: nums, b: [1, 2] };
for (let i = 0; i < nums.length; i++) {
  nums[i] = nums[i] * 2;
}
`;

describe("the layout follows the spacing", () => {
  it("wider column gaps make the memory view wider", async () => {
    const t = applyHints(await traceJavaScript(listCode, 3000));
    const last = t.steps.length - 1;
    const width = () =>
      Number(
        renderMemory(
          memoryScene(t, last, diffSteps(t.steps[last - 1], t.steps[last]), { mode: "arrows" }),
        ).getAttribute("width"),
      );
    const before = width();
    setSpacing({ columnGap: 160, busyColumnGap: 160 });
    expect(width()).toBeGreaterThan(before + 60);
    setSpacing(defaultSpacing());
    expect(width()).toBe(before);
  });

  it("more row spacing makes the loop history taller", async () => {
    const t = applyHints(await traceJavaScript(listCode, 3000));
    const last = t.steps.length - 1;
    const history = buildLoopHistory(t, last, null)!;
    const height = () => Number(renderLoopHistory(loopScene(t, history, { hideQuiet: false })).getAttribute("height"));
    const before = height();
    setSpacing({ rowGap: 90 });
    expect(height()).toBeGreaterThan(before + 2 * (90 - DEFAULT_SPACING.rowGap) - 1);
  });
});

/** Every setting at its minimum, or its maximum. */
const extreme = (end: "min" | "max"): Spacing => {
  const out = defaultSpacing();
  for (const f of SPACING_FIELDS) out[f.key] = f[end];
  return out;
};

function boxesAndArrows(svg: SVGSVGElement) {
  const boxes = new Map<string, Rect>();
  for (const g of svg.querySelectorAll<SVGGElement>(".node")) {
    const hit = g.querySelector(".node-hit")!;
    boxes.set(g.dataset.nodeKey!, {
      x: Number(g.dataset.x),
      y: Number(g.dataset.y),
      w: Number(hit.getAttribute("width")) - 4,
      h: Number(hit.getAttribute("height")) - 4,
    });
  }
  const arrows = [...svg.querySelectorAll<SVGPathElement>(".ref-arrow")].map((path) => {
    const d = path.getAttribute("d")!;
    const start = d.match(/^M([\d.-]+),([\d.-]+)/)!;
    const points: Point[] = [{ x: Number(start[1]), y: Number(start[2]) }];
    for (const m of d.matchAll(/Q([\d.-]+),([\d.-]+)/g)) points.push({ x: Number(m[1]), y: Number(m[2]) });
    const end = d.match(/L([\d.-]+),([\d.-]+)$/)!;
    points.push({ x: Number(end[1]), y: Number(end[2]) });
    return { from: path.dataset.from!, to: path.dataset.to!, points, behind: path.classList.contains("is-behind") };
  });
  return { boxes, arrows };
}

/** No NaN, no overlapping boxes, and no arrow through a box (except those sent behind on purpose). */
function expectClean(svg: SVGSVGElement, where: string): void {
  expect(svg.outerHTML, `${where}: NaN in the memory view`).not.toContain("NaN");
  const { boxes, arrows } = boxesAndArrows(svg);
  const list = [...boxes];
  for (let a = 0; a < list.length; a++)
    for (let b = a + 1; b < list.length; b++)
      if (overlaps(list[a][1], list[b][1])) throw new Error(`${where}: ${list[a][0]} overlaps ${list[b][0]}`);
  for (const arrow of arrows) {
    if (arrow.behind) continue; // sent behind boxes on purpose (see layout.test.ts)
    for (let k = 1; k < arrow.points.length; k++) {
      const [p, q] = [arrow.points[k - 1], arrow.points[k]];
      for (const [key, rect] of boxes) {
        if (key === arrow.from && k === 1) continue;
        if (crosses(p, q, rect)) throw new Error(`${where}: arrow ${arrow.from} -> ${arrow.to} crosses ${key}`);
      }
    }
  }
}

/** Each example traced once, for all the cases below. */
const traces = new Map<string, Promise<Trace>>();
const traced = (code: string) => {
  if (!traces.has(code)) traces.set(code, traceJavaScript(code, 3000).then(applyHints));
  return traces.get(code)!;
};

/** Every step of a short trace; `most` spread over a long one. */
const sample = (n: number, most: number) =>
  n <= most ? [...Array(n).keys()] : [...Array(most).keys()].map((k) => Math.floor((k * (n - 1)) / (most - 1)));

describe.each(["min", "max"] as const)("every setting at its %s", (end) => {
  it.each(JAVASCRIPT_EXAMPLES.map((e) => [e.name, e.code] as const))(
    "%s: still draws cleanly",
    async (_name, code) => {
      const t = await traced(code);
      setSpacing(extreme(end));
      for (const i of sample(t.steps.length, 60)) {
        for (const mode of ["arrows", "nested"] as MemoryMode[]) {
          const svg = renderMemory(memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { mode }));
          expectClean(svg, `step ${i + 1} (${mode})`);
        }
        const history = buildNestedHistory(t, i) ?? buildLoopHistory(t, i, null);
        if (history?.rows.length) {
          for (const vertical of [false, true]) {
            const svg = renderLoopHistory(loopScene(t, history, { hideQuiet: false }), { vertical });
            expect(svg.outerHTML, `step ${i + 1}: NaN in the loop view`).not.toContain("NaN");
          }
        }
      }
    },
    120_000,
  );
});

// One setting at an end, the rest at their defaults: settings that are only
// safe together (a narrow gap, wide lanes) are caught here.
describe("each memory setting alone at either end", () => {
  const cases = SPACING_FIELDS.filter((f) => f.group !== "loop").flatMap((f) =>
    (["min", "max"] as const).map((end) => [`${f.key} at its ${end}`, f.key, f[end]] as const),
  );
  it.each(cases)(
    "%s: every JavaScript example draws cleanly",
    async (_name, key, value) => {
      setSpacing({ [key]: value });
      for (const example of JAVASCRIPT_EXAMPLES) {
        const t = await traced(example.code);
        for (const i of sample(t.steps.length, 10)) {
          const svg = renderMemory(memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { mode: "arrows" }));
          expectClean(svg, `${example.name}, step ${i + 1}`);
        }
      }
    },
    120_000,
  );
});
