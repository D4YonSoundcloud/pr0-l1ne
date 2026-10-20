// @vitest-environment jsdom
/**
 * Patching SVG (patch.ts) must leave exactly the SVG a fresh toSvg() makes,
 * whatever came before: checked for every step of the examples, memory and
 * loop views, and for the awkward cases on their own.
 */
import { describe, expect, it } from "vitest";
import { liveRows } from "../app/loopController";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { loopScene } from "../scene/loopScene";
import { memoryScene } from "../scene/memoryScene";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { mark as m, toSvg } from "./drawing";
import { loopDrawing } from "./loopView";
import { applyFocus, memoryDrawing, type Point } from "./memory";
import { SvgPatcher } from "./patch";

const html = (el: Element) => el.outerHTML;

/** Some steps of a trace: all of a short one, 60 spread over a long one. */
const stepsOf = (trace: Trace) => {
  const n = trace.steps.length;
  return n <= 60 ? [...Array(n).keys()] : [...Array(60).keys()].map((k) => Math.floor((k * (n - 1)) / 59));
};

describe("SvgPatcher on the examples", () => {
  const programs = [
    ...JAVASCRIPT_EXAMPLES.map((e) => [e.name, () => traceJavaScript(e.code, 2000)] as const),
    ...TYPESCRIPT_EXAMPLES.slice(0, 3).map(
      (e) => [`${e.name} (TypeScript)`, () => traceTypeScript(e.code, 2000)] as const,
    ),
  ];

  it.each(programs)(
    "%s: every step's SVG is what a fresh drawing makes",
    async (_name, run) => {
      const trace = applyHints(await run());
      const memory = new SvgPatcher();
      const loop = new SvgPatcher();
      const stacked = new SvgPatcher();
      const positions = new Map<string, Point>();
      let kept = 0;
      for (const i of stepsOf(trace)) {
        const scene = memoryScene(trace, i, diffSteps(trace.steps[i - 1], trace.steps[i]));
        // Now and then a box is dragged, or hovered.
        if (i % 9 === 4 && scene.objects[0]) positions.set(scene.objects[0].key, { x: 30 * i, y: 400 + i });
        const drawing = memoryDrawing(scene, { positions });
        if (i % 4 === 1) applyFocus(drawing, scene.objects.at(-1)?.key ?? null);
        expect(html(memory.show(drawing)), `memory, step ${i + 1}`).toBe(html(toSvg(drawing)));
        kept += memory.stats.kept;

        const history = buildNestedHistory(trace, i) ?? buildLoopHistory(trace, i, null);
        if (!history?.rows.length) continue;
        const rows = loopDrawing(loopScene(trace, history, { hideQuiet: i % 2 === 0 }), { vertical: i % 3 === 0 });
        expect(html(loop.show(rows)), `loop, step ${i + 1}`).toBe(html(toSvg(rows)));
        const live = loopDrawing(loopScene(trace, history, { hideQuiet: false, live: liveRows(trace, i, history) }));
        expect(html(stacked.show(live)), `live loop, step ${i + 1}`).toBe(html(toSvg(live)));
      }
      expect(kept).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe("SvgPatcher", () => {
  const show = (p: SvgPatcher, drawing: ReturnType<typeof m>) => {
    const el = p.show(drawing);
    expect(html(el)).toBe(html(toSvg(drawing)));
    return el;
  };

  it("keeps the same elements, changing only attribute values and text", () => {
    const p = new SvgPatcher();
    const svg = show(p, m("svg", {}, m("rect", { x: 1, y: 2, class: "a" }), m("text", { x: 0 }, "hi")));
    const [rect, text] = [...svg.children];
    expect(show(p, m("svg", {}, m("rect", { x: 5, y: 2, class: "a" }), m("text", { x: 0 }, "ho")))).toBe(svg);
    expect(svg.children[0]).toBe(rect);
    expect(svg.children[1]).toBe(text);
    expect(p.stats).toEqual({ created: 0, updated: 2, kept: 2 });
  });

  it("puts attributes in toSvg's order when the set of them changes", () => {
    const p = new SvgPatcher();
    show(p, m("svg", {}, m("rect", { x: 1, y: 2 })));
    show(p, m("svg", {}, m("rect", { width: 3, x: 1, y: 2 })));
    show(p, m("svg", {}, m("rect", { y: 2 })));
    // Inline styles too, set as toSvg sets them.
    const styled = m("rect", { x: 1 });
    styled.style.setProperty("--a", "1");
    show(p, m("svg", {}, styled));
    const restyled = m("rect", { x: 1 });
    restyled.style.setProperty("--b", "2");
    restyled.style.setProperty("--a", "1");
    show(p, m("svg", {}, restyled));
  });

  it("matches keyed children wherever they move, and adds and drops the rest", () => {
    const p = new SvgPatcher();
    const box = (key: string, x: number) =>
      m("g", { class: "node", "data-node-key": key, "data-x": x }, m("rect", { x }));
    const svg = show(p, m("svg", {}, box("a", 0), box("b", 10), box("c", 20)));
    const [a, b, c] = [...svg.children];
    show(p, m("svg", {}, box("c", 25), box("d", 30), box("a", 0)));
    expect(svg.children[0]).toBe(c);
    expect(svg.children[2]).toBe(a);
    expect([...svg.children]).not.toContain(b);
    // Unkeyed children: by position among their own tag.
    show(p, m("svg", {}, m("path", { d: "M0,0" }), "text", m("path", { d: "M1,1" })));
    show(p, m("svg", {}, "other", m("path", { d: "M1,1" })));
    show(p, m("svg", {}));
  });

  it("makes a changed cell and the output card afresh, so their CSS animation plays again", () => {
    const p = new SvgPatcher();
    const cell = () => m("g", { class: "cell is-changed", "data-cell": "a|0" }, m("rect", { width: 5 }));
    const svg = show(p, m("svg", {}, cell(), m("g", { class: "cell", "data-cell": "a|1" })));
    const [changed, plain] = [...svg.children];
    show(p, m("svg", {}, cell(), m("g", { class: "cell", "data-cell": "a|1" })));
    expect(svg.children[0]).not.toBe(changed);
    expect(svg.children[1]).toBe(plain);
    const card = () => m("g", { class: "node is-output", "data-node-key": "out" });
    const first = show(p, m("svg", {}, card())).children[0];
    expect(show(p, m("svg", {}, card())).children[0]).not.toBe(first);
  });

  it("swaps an element for one of another tag, and text for an element", () => {
    const p = new SvgPatcher();
    show(p, m("svg", {}, m("g", {}, "a", m("rect"))));
    show(p, m("svg", {}, m("g", {}, m("rect"), "a")));
    show(p, m("svg", {}, m("text", {}, "a")));
    p.reset();
    expect(p.current).toBeNull();
    show(p, m("svg", {}, m("circle")));
    expect(p.stats.created).toBe(2);
  });
});
