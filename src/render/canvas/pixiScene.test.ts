// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fakeStyles, svgOf } from "../../testing/canvasStyles";
import { CanvasTextMetrics, type Container, Graphics, GraphicsContext, Text } from "../../testing/fakePixi";
import { paintDrawing } from "./paint";
import { buildScene, forgetFonts, SceneCache } from "./pixiScene";
import type { ComputedPaint } from "./styles";

vi.mock("pixi.js", () => import("../../testing/fakePixi"));

beforeAll(() => {
  // jsdom has no 2D canvas: say so quietly (the em box falls back to 0.8 / 0.2 of the size).
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

const ink = () => ({ fill: "rgb(255, 255, 255)", stroke: "rgb(0, 0, 0)", strokeWidth: 1 });
/** The scene built, typed as the fake PixiJS objects it's made of. */
const asFake = (built: ReturnType<typeof buildScene>) =>
  built as unknown as { root: Container; layers: Map<unknown, Container>; flashes: Container[] };
const build = (
  markup: string,
  rule: (el: Element) => Partial<ComputedPaint> = ink,
  flash = false,
  variables: Record<string, string> = {},
) => asFake(buildScene(paintDrawing(svgOf(markup), fakeStyles(rule, variables)), { resolution: 2, flash }));
const kids = (c: Container) => c.children;

describe("buildScene: shapes", () => {
  it("draws shapes in a row into one Graphics, filled then stroked on the same path", () => {
    const { root } = build(`<rect width="10" height="10"/><circle cx="5" cy="5" r="2"/>`);
    expect(kids(root)).toHaveLength(1);
    const g = kids(root)[0] as Graphics;
    expect(g.ops).toEqual(["rect", "fill", "stroke", "circle", "fill", "stroke"]);
    expect(g.calls[2][1]).toMatchObject({ width: 1, color: 0, alpha: 1, alignment: 0.5 });
  });

  it("rounds small corners with roundRect, and traces big ones as arcs", () => {
    const { root } = build(`<rect width="40" height="20" rx="3"/><rect width="40" height="20" rx="10"/>`);
    const g = kids(root)[0] as Graphics;
    expect(g.ops.slice(0, 3)).toEqual(["roundRect", "fill", "stroke"]);
    const pill = g.ops.slice(3);
    expect(pill.filter((op) => op === "bezierCurveTo")).toHaveLength(4);
    expect(pill).toContain("closePath");
  });

  it("draws a dashed outline as dashes, after the fill", () => {
    const { root } = build(
      `<rect width="20" height="10"/><path d="M0,0 Q5,5 10,0 C10,5 5,5 0,0"/><line x2="10"/>`,
      () => ({
        fill: "rgb(255, 255, 255)",
        stroke: "rgb(0, 0, 0)",
        dash: [3, 3],
      }),
    );
    const g = kids(root)[0] as Graphics;
    const [first, second, third] = [g.ops.indexOf("rect"), g.ops.indexOf("fill"), g.ops.indexOf("moveTo")];
    expect([first, second]).toEqual([0, 1]);
    expect(third).toBe(2);
    expect(g.ops.filter((op) => op === "stroke").length).toBe(3);
    // No solid outline: the rect is traced once, for its fill.
    expect(g.ops.filter((op) => op === "rect")).toHaveLength(1);
    // A dashed circle, and a dashed pattern that draws nothing.
    const circle = build(`<circle r="5" cx="5" cy="5"/>`, () => ({
      fill: "none",
      stroke: "rgb(0, 0, 0)",
      dash: [2, 2],
    }));
    expect((kids(circle.root)[0] as Graphics).ops[0]).toBe("moveTo");
    const empty = build(`<path d="M0,0 L0,0"/>`, () => ({ fill: "none", stroke: "rgb(0, 0, 0)", dash: [2, 2] }));
    expect((kids(empty.root)[0] as Graphics).ops).toEqual([]);
  });

  it("traces paths command by command", () => {
    const { root } = build(`<path d="M0,0 L1,1 Q2,2 3,3 C4,4 5,5 6,6 Z"/>`);
    expect((kids(root)[0] as Graphics).ops).toEqual([
      "moveTo",
      "lineTo",
      "quadraticCurveTo",
      "bezierCurveTo",
      "closePath",
      "fill",
      "stroke",
    ]);
  });

  it("puts a flash over each changed cell, under its text, and lists it", () => {
    const markup = `<g class="cell is-changed"><rect width="10" height="10"/><text>1</text></g><rect width="5" height="5"/>`;
    const on = build(markup, ink, true, { "--flash": "mark 450ms ease-out" });
    expect(on.flashes).toHaveLength(1);
    const [cellShapes, overlay, label, after] = kids(on.root);
    expect(cellShapes).toBeInstanceOf(Graphics);
    expect(overlay).toBe(on.flashes[0]);
    expect((overlay as Graphics).calls.find((c) => c[0] === "fill")?.[1]).toEqual({ color: 0xffffff, alpha: 0.55 });
    expect((overlay as Graphics).calls.find((c) => c[0] === "stroke")?.[1]).toMatchObject({ width: 2 });
    expect(label).toBeInstanceOf(Text);
    expect(after).toBeInstanceOf(Graphics); // shapes after the flash draw above it
    const unstroked = build(
      `<g class="cell is-changed"><rect width="10" height="10"/></g>`,
      () => ({ fill: "rgb(1, 1, 1)" }),
      true,
      {
        "--flash": "mark 1s",
      },
    );
    expect((unstroked.flashes[0] as Graphics).ops).toEqual(["rect", "fill"]);
    expect(build(markup, ink, false, { "--flash": "mark 450ms" }).flashes).toEqual([]);
  });
});

describe("buildScene: groups", () => {
  it("gives keyed groups their own container, and flattens the rest in order", () => {
    const paint = paintDrawing(
      svgOf(`<rect width="1" height="1"/><g class="node" data-flip="a"><rect width="2" height="2"/></g>
             <g><rect width="3" height="3"/></g><rect width="4" height="4"/>`),
      fakeStyles((el) => (el.classList.contains("node") ? { ...ink(), opacity: 0.5 } : ink())),
    );
    const { root, layers } = asFake(buildScene(paint, { resolution: 1, flash: false }));
    const [first, node, plain, last] = kids(root);
    expect(first).toBeInstanceOf(Graphics);
    expect(node).not.toBeInstanceOf(Graphics);
    expect(node.alpha).toBe(0.5);
    expect([...layers.values()]).toEqual([node]);
    expect((plain as Graphics).calls[0]).toEqual(["rect", 0, 0, 3, 3]);
    expect((last as Graphics).calls[0]).toEqual(["rect", 0, 0, 4, 4]);
  });

  it("makes layers for loop rows and the arrows layer's contents", () => {
    const { layers } = build(
      `<g class="loop-row" data-top="0" data-bottom="10"><rect width="1" height="1"/></g><g class="arrows"><path d="M0,0 L1,1"/></g>`,
    );
    expect(layers.size).toBe(2);
  });
});

describe("buildScene: text", () => {
  const texts = (root: Container): Text[] =>
    root.children.flatMap((c) => (c instanceof Text ? [c] : texts(c))) as Text[];

  it("lays runs out left to right from the anchor, snapped to pixels at the resolution asked", () => {
    const { root } = build(`<text x="100" y="50" text-anchor="middle">ab<tspan dx="10">cd</tspan></text>`, () => ({
      fill: "rgb(0, 0, 0)",
      fontSize: 10,
    }));
    const [ab, cd] = texts(root);
    // Each character is 6 wide (the fake's 0.6em): 12 + 10 + 12 = 34, centered on 100.
    expect(ab.x).toBeCloseTo(83);
    expect(cd.x).toBeCloseTo(83 + 12 + 10);
    expect(ab.resolution).toBe(2);
    expect(ab.roundPixels).toBe(true);
    // Alphabetic baseline at y: the fake's ascent is 7.5.
    expect(ab.y).toBeCloseTo(50 - 7.5);
  });

  it("puts y where the baseline says", () => {
    const at = (baseline: string, anchor = "start") => {
      const { root } = build(
        `<text x="100" y="50" text-anchor="${anchor}" dominant-baseline="${baseline}">ab</text>`,
        () => ({ fill: "rgb(0, 0, 0)", fontSize: 10 }),
      );
      return texts(root)[0];
    };
    // jsdom has no canvas: the em box is 8 above and 2 below the baseline.
    expect(at("central").y).toBeCloseTo(50 + (8 - 2) / 2 - 7.5);
    expect(at("middle").y).toBeCloseTo(50 + 2.5 - 7.5);
    expect(at("hanging").y).toBeCloseTo(50 + 8 * 0.8 - 7.5);
    expect(at("auto", "end").x).toBeCloseTo(100 - 12);
  });

  it("draws halos (paint-order: stroke) and fades with the text's opacity", () => {
    const { root } = build(`<g class="faded"><text x="10" y="10">hi</text></g>`, (el) =>
      el.classList.contains("faded")
        ? { opacity: 0.5 }
        : { fill: "rgb(0, 0, 0)", fontSize: 10, paintOrder: "stroke", stroke: "rgb(255, 255, 255)", strokeWidth: 4 },
    );
    const [t] = texts(root);
    expect(t.style.options.stroke).toMatchObject({ color: 0xffffff, width: 4 });
    // Shifted by half the halo, which the text texture adds around the glyphs.
    expect(t.x).toBeCloseTo(8);
    expect(t.style.options.fill).toEqual({ color: 0, alpha: 0.5 });
  });

  it("shares one TextStyle between runs that look the same, until fonts change", () => {
    const one = texts(build(`<text>a</text><text>b</text>`, () => ({ fill: "rgb(0, 0, 0)" })).root);
    expect(one[0].style).toBe(one[1].style);
    // It never changes, so nothing needs to hear about it (see buildScene).
    expect(one[0].style.listeners).toBe(0);
    const cleared = CanvasTextMetrics.cleared;
    forgetFonts();
    expect(CanvasTextMetrics.cleared).toBe(cleared + 1);
    const two = texts(build(`<text>a</text>`, () => ({ fill: "rgb(0, 0, 0)" })).root);
    expect(two[0].style).not.toBe(one[0].style);
  });

  it("text with only a halo still draws", () => {
    const { root } = build(`<text>a</text>`, () => ({
      fill: "none",
      paintOrder: "stroke",
      stroke: "rgb(0, 0, 0)",
    }));
    expect(texts(root)[0].style.options.fill).toEqual({ color: 0, alpha: 0 });
  });
});

describe("buildScene: shared geometry", () => {
  /** A grid of cells, each its own keyed group (data-cell), in a few colors. */
  const grid = (rows: number, cols: number) => {
    let out = "";
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        out += `<g class="cell c${(r + c) % 4}" data-cell="g|${r}|${c}"><rect x="${10 + c * 34}" y="${10 + r * 24}" width="34" height="24" rx="3"/></g>`;
    return out;
  };
  const colors = (el: Element): Partial<ComputedPaint> => {
    const c = /\bc(\d)\b/.exec(el.parentElement?.getAttribute("class") ?? "")?.[1] ?? "0";
    return { fill: ["rgb(255, 0, 0)", "rgb(0, 255, 0)", "rgb(0, 0, 255)", "rgb(9, 9, 9)"][Number(c)], stroke: "none" };
  };
  const graphicsIn = (c: Container, out: Graphics[] = []): Graphics[] => {
    for (const child of c.children) {
      if (child instanceof Graphics) out.push(child);
      else graphicsIn(child, out);
    }
    return out;
  };

  it("draws every same-looking cell from one context, each Graphics at its own corner", () => {
    const cache = new SceneCache();
    const made = GraphicsContext.made;
    const built = buildScene(
      paintDrawing(svgOf(grid(30, 30)), fakeStyles(colors)),
      { resolution: 1, flash: false },
      cache,
    );
    const all = graphicsIn(built.root as unknown as Container);
    expect(all).toHaveLength(900);
    // Four colors, one size: four contexts for 900 cells, each drawn once, from its own corner.
    expect(GraphicsContext.made - made).toBe(4);
    expect(new Set(all.map((g) => g.context)).size).toBe(4);
    expect(cache.contexts.size).toBe(4);
    const g = all[31]; // row 1, column 1
    expect([g.x, g.y]).toEqual([44, 34]);
    expect(g.calls[0]).toEqual(["roundRect", 0, 0, 34, 24, 3]);
    // Nothing changes a shared context, and nothing collects it: its Graphics don't listen to it.
    expect(g.context.listening.get("update") ?? []).toHaveLength(0);
    expect(g.context.autoGarbageCollect).toBe(false);
  });

  it("lets a context go once no scene draws it, keeping those a kept body still draws", () => {
    const cache = new SceneCache();
    const paint = (markup: string) => paintDrawing(svgOf(markup), fakeStyles(colors));
    const build = (markup: string) => buildScene(paint(markup), { resolution: 1, flash: false }, cache);
    const first = build(grid(2, 2));
    const contexts = () => [...cache.contexts.values()] as unknown as GraphicsContext[];
    const cells = contexts();
    expect(cells).toHaveLength(3); // colors 0, 1, 1, 2
    // The next drawing keeps three of the four cells (the fourth moved, drawn by its color's context) and adds a wider one.
    const next = `${grid(2, 2).replace('x="44" y="34"', 'x="400" y="400"')}<g data-cell="w"><rect x="10" y="200" width="90" height="24"/></g>`;
    const second = build(next);
    (first.root as unknown as Container).destroy({ children: true });
    expect(contexts()).toHaveLength(4);
    // Drawings of the wide one alone: the cells' contexts stay while the scene before still draws them,
    // and go at the build after (by then that scene has been let go of).
    const wide = `<g data-cell="w"><rect x="10" y="200" width="90" height="24"/></g>`;
    const third = build(wide);
    (second.root as unknown as Container).destroy({ children: true });
    expect(cells.some((c) => c.destroyed)).toBe(false);
    const fourth = build(wide);
    (third.root as unknown as Container).destroy({ children: true });
    expect(cells.every((c) => c.destroyed)).toBe(true);
    expect(contexts()).toHaveLength(1);
    expect(contexts()[0].destroyed).toBe(false);
    (fourth.root as unknown as Container).destroy({ children: true });
  });
});
