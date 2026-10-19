// @vitest-environment jsdom
/**
 * Keeping paint and PixiJS objects between steps (paint.ts PaintCache,
 * pixiScene.ts SceneCache) must never change the picture: stepping through
 * real programs with both caches draws exactly what building every step
 * from nothing draws, wherever kept objects were moved to.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { JAVASCRIPT_EXAMPLES } from "../../examples/index";
import { traceJavaScript } from "../../js/trace";
import { loopScene } from "../../scene/loopScene";
import { memoryScene } from "../../scene/memoryScene";
import { fakeStyles } from "../../testing/canvasStyles";
import { type Container, Graphics, Text } from "../../testing/fakePixi";
import { diffSteps } from "../../trace/diff";
import { applyHints } from "../../trace/hints";
import { buildLoopHistory } from "../../trace/loopHistory";
import type { Mark } from "../drawing";
import { loopDrawing } from "../loopView";
import { applyFocus, memoryDrawing, type Point } from "../memory";
import { PaintCache, paintDrawing } from "./paint";
import { buildScene, SceneCache } from "./pixiScene";
import type { ComputedPaint } from "./styles";

vi.mock("pixi.js", () => import("../../testing/fakePixi"));

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

/** Styles by class: changed cells, focus and dimming all look different. */
function rule(el: Element): Partial<ComputedPaint> {
  const cls = ` ${el.getAttribute("class") ?? ""} `;
  const parent = ` ${el.parentElement?.getAttribute("class") ?? ""} `;
  const text = el.localName === "text" || el.localName === "tspan";
  const out: Partial<ComputedPaint> = text
    ? { fill: cls.includes(" is-changed ") ? "rgb(200, 0, 0)" : "rgb(0, 0, 0)" }
    : { fill: parent.includes(" is-changed ") ? "rgb(255, 230, 0)" : "rgb(255, 255, 255)", stroke: "rgb(0, 0, 0)" };
  if (cls.includes(" is-focus ") || cls.includes(" is-related ")) out.strokeWidth = 3;
  if (cls.includes(" current-band ")) out.fill = "rgb(240, 240, 255)";
  return out;
}

const r2 = (v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : JSON.stringify(v));

/** Coordinates a Graphics call takes, as [x, y] argument pairs. */
const POINTS: Record<string, number> = {
  rect: 1,
  roundRect: 1,
  circle: 1,
  moveTo: 1,
  lineTo: 1,
  quadraticCurveTo: 2,
  bezierCurveTo: 3,
};

/** What a scene draws, in order, in diagram units: every call and text, wherever its container is. */
function picture(c: Container, ox = 0, oy = 0, alpha = 1, out: string[] = []): string[] {
  const x = ox + c.x;
  const y = oy + c.y;
  const a = alpha * c.alpha;
  if (!c.visible) return out;
  if (c instanceof Graphics) {
    for (const [op, ...args] of c.calls) {
      const pairs = POINTS[op] ?? 0;
      const moved = args.map((v, i) => (i < pairs * 2 && typeof v === "number" ? v + (i % 2 ? y : x) : v));
      out.push(`${op}(${moved.map(r2).join(",")})@${r2(a)}`);
    }
  } else if (c instanceof Text) {
    out.push(
      `text ${JSON.stringify(c.text)} ${r2(x)},${r2(y)} ${JSON.stringify(c.style.options)} ${c.resolution}@${r2(a)}`,
    );
  }
  for (const child of c.children) picture(child, x, y, a, out);
  return out;
}

/** Draws drawings one after another, keeping what it can, like a canvas window. */
function keeper() {
  const styles = fakeStyles(rule, { "--flash": "mark 450ms" }, { contexts: true });
  const paints = new PaintCache();
  const scenes = new SceneCache();
  let last: Container | null = null;
  return {
    paints,
    scenes,
    draw(drawing: Mark, flash: boolean) {
      const built = buildScene(paintDrawing(drawing, styles, paints), { resolution: 2, flash }, scenes);
      last?.destroy({ children: true });
      last = built.root as unknown as Container;
      return built;
    },
  };
}

/** The same drawing, built from nothing. */
function fresh(drawing: Mark, flash: boolean) {
  return buildScene(paintDrawing(drawing, fakeStyles(rule, { "--flash": "mark 450ms" })), { resolution: 2, flash });
}

const examples = JAVASCRIPT_EXAMPLES.filter((_, i) => i % 3 === 0);

describe("kept paint and objects draw what a fresh build draws", () => {
  it.each(examples.map((e) => [e.name, e.code] as const))(
    "%s: the memory view, step by step, with boxes moved and hovered",
    async (_name, code) => {
      const trace = applyHints(await traceJavaScript(code, 600));
      const keep = keeper();
      const positions = new Map<string, Point>();
      // Bodies drawn in the last build, and how many were drawn again.
      let before = new Set<unknown>();
      let reused = 0;
      const n = trace.steps.length;
      for (let i = 0; i < Math.min(n, 40); i++) {
        const scene = memoryScene(trace, i, diffSteps(trace.steps[i - 1], trace.steps[i]));
        // Now and then a box moves, so kept boxes are drawn somewhere new.
        if (i % 7 === 3 && scene.objects[0]) positions.set(scene.objects[0].key, { x: 40 * i, y: 500 + i });
        const drawing = memoryDrawing(scene, { positions });
        const flash = i % 2 === 0;
        const kept = keep.draw(drawing, flash);
        expect(picture(kept.root as unknown as Container), `step ${i + 1}`).toEqual(
          picture(fresh(drawing, flash).root as unknown as Container),
        );
        expect(kept.flashes.length).toBe(fresh(drawing, flash).flashes.length);
        // Hovering a box: the same drawing, with its arrows in focus.
        const key = scene.objects.at(-1)?.key;
        if (key && i % 5 === 1) {
          applyFocus(drawing, key);
          expect(picture(keep.draw(drawing, false).root as unknown as Container)).toEqual(
            picture(fresh(drawing, false).root as unknown as Container),
          );
          applyFocus(drawing, null);
        }
        const bodies = new Set([...kept.layers.values()].map((layer) => layer.children[0]));
        for (const body of bodies) if (before.has(body)) reused++;
        before = bodies;
      }
      expect(reused).toBeGreaterThan(0);
    },
    60_000,
  );

  it.each(examples.map((e) => [e.name, e.code] as const))(
    "%s: the loop history, step by step",
    async (_name, code) => {
      const trace = applyHints(await traceJavaScript(code, 600));
      const keep = keeper();
      for (let i = 0; i < Math.min(trace.steps.length, 60); i++) {
        const history = buildLoopHistory(trace, i, null);
        if (!history?.rows.length) continue;
        for (const vertical of [false, true]) {
          const drawing = loopDrawing(loopScene(trace, history, { hideQuiet: false }), { vertical });
          expect(picture(keep.draw(drawing, true).root as unknown as Container), `step ${i + 1}`).toEqual(
            picture(fresh(drawing, true).root as unknown as Container),
          );
        }
      }
    },
    60_000,
  );
});

describe("SceneCache", () => {
  const svg = (markup: string) => {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${markup}</svg>`,
      "image/svg+xml",
    );
    return document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  };
  const styles = fakeStyles(rule);
  const cell = (x: number, value: string, cls = "cell") =>
    `<g class="${cls}" data-cell="a|${x}"><rect x="${x}" y="0" width="20" height="20"/><text x="${x}" y="10">${value}</text></g>`;

  it("keeps a group that draws the same, moved to where it is now", () => {
    const cache = new SceneCache();
    const first = buildScene(paintDrawing(svg(cell(0, "1")), styles), { resolution: 1, flash: false }, cache);
    const [body] = [...first.layers.values()][0].children;
    const second = buildScene(paintDrawing(svg(cell(50, "1")), styles), { resolution: 1, flash: false }, cache);
    const layer = [...second.layers.values()][0];
    expect(layer.children[0]).toBe(body);
    expect(body.x).toBe(50);
    // Something else in it: built again.
    const third = buildScene(paintDrawing(svg(cell(50, "2")), styles), { resolution: 1, flash: false }, cache);
    expect([...third.layers.values()][0].children[0]).not.toBe(body);
  });

  it("never draws one kept body twice, and doesn't keep text at another resolution", () => {
    const cache = new SceneCache();
    const one = buildScene(paintDrawing(svg(cell(0, "1")), styles), { resolution: 1, flash: false }, cache);
    const kept = [...one.layers.values()][0].children[0];
    const two = buildScene(
      paintDrawing(svg(cell(0, "1") + cell(30, "1")), styles),
      { resolution: 1, flash: false },
      cache,
    );
    const bodies = [...two.layers.values()].map((l) => l.children[0]);
    expect(new Set(bodies).size).toBe(2);
    expect(bodies).toContain(kept);
    const sharper = buildScene(paintDrawing(svg(cell(0, "1")), styles), { resolution: 2, flash: false }, cache);
    expect(bodies).not.toContain([...sharper.layers.values()][0].children[0]);
  });

  it("starts a kept cell's flash again", () => {
    const cache = new SceneCache();
    const markup = cell(0, "1", "cell is-changed");
    const first = buildScene(paintDrawing(svg(markup), styles), { resolution: 1, flash: true }, cache);
    expect(first.flashes).toHaveLength(1);
    first.flashes[0].alpha = 0; // played out
    const again = buildScene(paintDrawing(svg(markup), styles), { resolution: 1, flash: true }, cache);
    expect(again.flashes).toEqual(first.flashes);
    expect(again.flashes[0].alpha).toBe(1);
  });
});

describe("PaintCache", () => {
  it("doesn't read the styles inside groups it kept, and forgets on clear", async () => {
    const styles = fakeStyles(rule, {}, { contexts: true });
    const seen: number[] = [];
    const read = styles.read.bind(styles);
    styles.read = (root, skip) =>
      read(root, (el, context) => {
        const kept = skip?.(el, context) ?? false;
        seen.push(kept ? 1 : 0);
        return kept;
      });
    const cache = new PaintCache();
    const trace = await traceJavaScript("const a = [1, 2, 3];\nlet b = 1;\n");
    const s = memoryScene(trace, 1, diffSteps(trace.steps[0], trace.steps[1]));
    const layout = { positions: new Map<string, Point>() };
    const first = paintDrawing(memoryDrawing(s, layout), styles, cache);
    expect(seen.every((k) => k === 0)).toBe(true);
    seen.length = 0;
    const second = paintDrawing(memoryDrawing(s, layout), styles, cache);
    expect(seen).toContain(1);
    expect(JSON.stringify(second.root)).toBe(JSON.stringify(first.root));
    cache.clear();
    seen.length = 0;
    paintDrawing(memoryDrawing(s, layout), styles, cache);
    expect(seen.every((k) => k === 0)).toBe(true);
  });
});
