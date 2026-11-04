// @vitest-environment jsdom
/**
 * Drawings sent from the layout worker to the page as patches (wire.ts):
 * for every example, stepping forward, back and around, what the page
 * makes of each is the drawing laid out, mark for mark; the marks kept from
 * the step before are the page's own objects from the step before; and the
 * page's SVG patched with them is what the drawing would make.
 */
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { loopScene } from "../scene/loopScene";
import { memoryScene } from "../scene/memoryScene";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { Mark, mark, toSvg } from "./drawing";
import { buildAt, builtAt } from "./lod";
import { loopDrawing } from "./loopView";
import { RowCache } from "./loopView/rowCache";
import { applyFocus, memoryDrawing } from "./memory";
import { BoxCache } from "./memoryView/boxCache";
import { SvgPatcher } from "./patch";
import { MarkEncoder, MarkMirror, type WireDrawing, WireError } from "./wire";

/** Steps to visit: forward, then back, then jumping about. */
function visits(n: number): number[] {
  const forward = n <= 40 ? [...Array(n).keys()] : [...Array(40).keys()].map((k) => Math.floor((k * (n - 1)) / 39));
  return [...forward, ...forward.slice(-6).reverse(), 0, n - 1, Math.floor(n / 2)].filter((i) => i >= 0 && i < n);
}

/** Every mark in a drawing. */
function marksOf(root: Mark): Set<Mark> {
  const out = new Set<Mark>();
  const walk = (m: Mark) => {
    out.add(m);
    for (const c of m.childNodes) if (c instanceof Mark) walk(c);
  };
  walk(root);
  return out;
}

/** Sent through structured cloning, as postMessage does. */
const posted = (d: WireDrawing): WireDrawing => structuredClone(d);

interface Sent {
  laidOut: Mark;
  shown: Mark;
}

/** Each drawing laid out, sent and made again on the page, checked; how many marks went by number. */
function follow(drawings: Iterable<{ drawing: Mark; where: string; focus?: string | null }>): number {
  const encoder = new MarkEncoder();
  const mirror = new MarkMirror();
  const patcher = new SvgPatcher();
  let before: Sent | null = null;
  let kept = 0;
  for (const { drawing, where, focus } of drawings) {
    const shown = mirror.decode(posted(encoder.encode(drawing)));
    expect(shown.signature(), where).toBe(drawing.signature());
    // Marks the worker kept from the drawing before are the page's own from then.
    if (before) {
      const laidBefore = marksOf(before.laidOut);
      const shownBefore = marksOf(before.shown);
      const keptLaid = [...marksOf(drawing)].filter((m) => laidBefore.has(m)).length;
      const keptShown = [...marksOf(shown)].filter((m) => shownBefore.has(m)).length;
      expect(keptShown, `${where}: kept on the page`).toBe(keptLaid);
    }
    kept += encoder.lastSent.kept;
    // The page puts the focus on (hovering), as the renderers do, then patches its SVG.
    if (focus !== undefined) applyFocus(shown, focus);
    expect(patcher.show(shown).outerHTML, `${where}: patched`).toBe((toSvg(shown) as Element).outerHTML);
    before = { laidOut: drawing, shown };
  }
  return kept;
}

const traces = new Map<string, Trace>();
async function traceOf(name: string, code: string): Promise<Trace> {
  let t = traces.get(name);
  if (!t) {
    t = applyHints(await traceJavaScript(code));
    traces.set(name, t);
  }
  return t;
}

describe("drawings sent to the page", () => {
  it("text, numbers, styles and the level built at arrive as they were", () => {
    const encoder = new MarkEncoder();
    const mirror = new MarkMirror();
    const drawing = buildAt(2, () => {
      const g = mark("g", { class: "node", "data-x": 12.5, "data-title": "a <b>" });
      g.style.setProperty("--fill", "red");
      g.append(mark("text", { x: 3 }, "hello"), "loose text");
      return mark("svg", { width: 100 }, g);
    });
    const shown = mirror.decode(posted(encoder.encode(drawing)));
    expect(shown.querySelector(".node")!.numberAttribute("data-x")).toBe(12.5); // still a number
    expect(shown.signature()).toBe(drawing.signature());
    expect(shown.querySelector(".node")!.styleProperties).toEqual([["--fill", "red"]]);
    expect(builtAt(shown)).toBe(2);
  });

  it("a mark kept from the drawing before goes by number, and is the page's own mark", () => {
    const encoder = new MarkEncoder();
    const mirror = new MarkMirror();
    const kept = mark("g", { class: "row" }, mark("rect", { x: 1 }));
    const first = mark("svg", {}, kept);
    const one = mirror.decode(posted(encoder.encode(first)));
    expect(encoder.lastSent).toEqual({ full: 3, kept: 0 });
    const second = mark("svg", {});
    second.appendShared(kept);
    const two = mirror.decode(posted(encoder.encode(second)));
    expect(encoder.lastSent).toEqual({ full: 1, kept: 1 });
    expect(two.childNodes[0]).toBe(one.childNodes[0]);
    expect((two.childNodes[0] as Mark).isShared).toBe(true);
    // A mark from two drawings back may be gone from the page: sent in full again.
    const third = mark("svg", {});
    mirror.decode(posted(encoder.encode(third)));
    const fourth = mark("svg", {});
    fourth.appendShared(kept);
    mirror.decode(posted(encoder.encode(fourth)));
    expect(encoder.lastSent).toEqual({ full: 3, kept: 0 });
  });

  it("a kept mark inside one kept whole the step before still goes by number", () => {
    const encoder = new MarkEncoder();
    const mirror = new MarkMirror();
    const cell = mark("g", { class: "cell" }, "7");
    const body = mark("g", { class: "node-body" }, cell);
    const one = mirror.decode(posted(encoder.encode(mark("svg", {}, body))));
    // The body kept whole.
    const two = mark("svg", {});
    two.appendShared(body);
    mirror.decode(posted(encoder.encode(two)));
    // Then the body changes (a new one), with the cell kept inside it.
    const fresh = mark("g", { class: "node-body changed" });
    fresh.appendShared(cell);
    const three = mirror.decode(posted(encoder.encode(mark("svg", {}, fresh))));
    expect(encoder.lastSent).toEqual({ full: 2, kept: 1 });
    expect((three.childNodes[0] as Mark).childNodes[0]).toBe((one.childNodes[0] as Mark).childNodes[0]);
  });

  it("a number the page hasn't got is an error, not a wrong picture", () => {
    expect(() => new MarkMirror().decode({ root: ["svg", [], 0, [41]], builtLod: 0 })).toThrow(WireError);
  });

  for (const example of JAVASCRIPT_EXAMPLES) {
    it(`${example.name}: the memory window, stepping about, with kept boxes and cells`, async () => {
      const trace = await traceOf(example.name, example.code);
      function* drawings() {
        for (const mode of ["arrows", "nested"] as const) {
          const boxes = new BoxCache();
          for (const i of visits(trace.steps.length)) {
            const scene = memoryScene(trace, i, diffSteps(trace.steps[i - 1], trace.steps[i]), { mode });
            yield {
              drawing: memoryDrawing(scene, { positions: new Map(), boxes }),
              where: `${example.name}, ${mode}, step ${i + 1}`,
              focus: i % 3 === 0 ? (scene.objects.at(-1)?.key ?? null) : undefined,
            };
          }
        }
      }
      const kept = follow(drawings());
      if (trace.steps.length > 5) expect(kept).toBeGreaterThan(0);
    });

    it(`${example.name}: the loop history, stepping about, with kept rows`, async () => {
      const trace = await traceOf(example.name, example.code);
      function* drawings() {
        for (const vertical of [false, true]) {
          const rows = new RowCache();
          for (const i of visits(trace.steps.length)) {
            const history = buildNestedHistory(trace, i) ?? buildLoopHistory(trace, i, null);
            if (!history?.rows.length) continue;
            const scene = loopScene(trace, history, { hideQuiet: true });
            yield { drawing: loopDrawing(scene, { vertical, rows }), where: `${example.name}, step ${i + 1}` };
          }
        }
      }
      follow(drawings());
    });
  }
});
