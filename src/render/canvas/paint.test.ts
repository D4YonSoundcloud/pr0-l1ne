// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../../js/trace";
import { memoryScene } from "../../scene/memoryScene";
import { fakeStyles, svgOf } from "../../testing/canvasStyles";
import { diffSteps } from "../../trace/diff";
import { renderMemory } from "../memory";
import { groups, type PaintGroup, type PaintShape, type PaintText, paintDrawing } from "./paint";

const shapes = (g: PaintGroup) => g.children.filter((c): c is PaintShape => c.kind === "shape");
const texts = (g: PaintGroup) => g.children.filter((c): c is PaintText => c.kind === "text");

describe("paintDrawing: shapes", () => {
  it("turns rects, circles, lines and paths into shapes with resolved colors", () => {
    const paint = paintDrawing(
      svgOf(`<rect class="a" x="1" y="2" width="30" height="20" rx="3"/>
             <circle class="b" cx="5" cy="6" r="4"/>
             <line class="c" x1="0" y1="0" x2="10" y2="0"/>
             <path class="c" d="M0,0 L5,5"/>`),
      fakeStyles((el) =>
        el.classList.contains("a")
          ? { fill: "rgb(255, 0, 0)", stroke: "rgb(0, 0, 255)", strokeWidth: 2 }
          : el.classList.contains("c")
            ? { stroke: "rgb(0, 128, 0)", strokeOpacity: 0.5 }
            : {},
      ),
    );
    expect(paint.width).toBe(200);
    expect(paint.height).toBe(100);
    const [rect, circle, line, path] = shapes(paint.root);
    expect(rect.geometry).toEqual({ type: "rect", x: 1, y: 2, w: 30, h: 20, r: 3 });
    expect(rect.fill).toEqual({ color: 0xff0000, alpha: 1 });
    expect(rect.stroke).toMatchObject({ color: 0x0000ff, width: 2, dash: [], cap: "butt", join: "miter" });
    expect(circle.geometry).toEqual({ type: "circle", cx: 5, cy: 6, r: 4 });
    // Lines are never filled, even with the default black fill.
    expect(line.fill).toBeNull();
    expect(line.stroke).toMatchObject({ color: 0x008000, alpha: 0.5 });
    expect(path.geometry).toMatchObject({ type: "path" });
    expect(paint.root.bounds).toEqual({ x: -0.5, y: -0.5, w: 32.5, h: 23.5 });
  });

  it("takes the corner radius from CSS before the attribute, and never more than half the box", () => {
    const paint = paintDrawing(
      svgOf(`<rect class="css" width="40" height="20" rx="2"/><rect width="40" height="20" rx="99"/>`),
      fakeStyles((el) => (el.classList.contains("css") ? { rx: 5 } : {})),
    );
    const [css, pill] = shapes(paint.root);
    expect(css.geometry).toMatchObject({ r: 5 });
    expect(pill.geometry).toMatchObject({ r: 10 });
  });

  it("skips what draws nothing", () => {
    const paint = paintDrawing(
      svgOf(`<rect width="0" height="5"/><circle r="0"/><path d=""/><rect class="none" width="5" height="5"/>
             <rect class="hidden" width="5" height="5"/><rect class="clear" width="5" height="5"/>
             <rect class="thin" width="5" height="5"/><ellipse rx="3" ry="3"/>`),
      fakeStyles((el) => {
        if (el.classList.contains("none")) return { fill: "none" };
        if (el.classList.contains("hidden")) return { hidden: true };
        if (el.classList.contains("clear")) return { opacity: 0 };
        if (el.classList.contains("thin")) return { fill: "none", stroke: "rgb(0, 0, 0)", strokeWidth: 0 };
        return {};
      }),
    );
    expect(paint.root.children).toEqual([]);
    expect(paint.root.bounds).toBeNull();
  });

  it("counts an invisible but transparent-filled shape in its group's bounds, as SVG's hit test does", () => {
    const paint = paintDrawing(
      svgOf(`<g class="node" data-node-key="a"><rect class="hit" x="0" y="0" width="50" height="40"/><rect x="10" y="20" width="5" height="5"/></g>
             <g class="node" data-node-key="b"><rect class="none" x="100" y="0" width="50" height="40"/><rect x="110" y="20" width="5" height="5"/></g>`),
      fakeStyles((el) =>
        el.classList.contains("hit")
          ? { fill: "transparent" }
          : el.classList.contains("none")
            ? { fill: "none" }
            : { fill: "rgb(0, 0, 0)" },
      ),
    );
    const [a, b] = paint.root.children as PaintGroup[];
    expect(a.children).toHaveLength(1); // nothing drawn for it...
    expect(a.bounds).toEqual({ x: 0, y: 0, w: 50, h: 40 }); // ...but it catches the pointer
    expect(b.bounds).toEqual({ x: 110, y: 20, w: 5, h: 5 }); // fill: none doesn't
  });

  it("keeps dashes, caps and joins", () => {
    const paint = paintDrawing(
      svgOf(`<path d="M0,0 H10" />`),
      fakeStyles(() => ({
        fill: "none",
        stroke: "rgb(1, 2, 3)",
        dash: [3, 3],
        dashOffset: 1,
        cap: "round",
        join: "bevel",
      })),
    );
    expect(shapes(paint.root)[0].stroke).toEqual({
      color: 0x010203,
      alpha: 1,
      width: 1,
      dash: [3, 3],
      dashOffset: 1,
      cap: "round",
      join: "bevel",
    });
    const odd = paintDrawing(
      svgOf(`<path d="M0,0 H10" />`),
      fakeStyles(() => ({ fill: "none", stroke: "red", cap: "weird", join: "odd" })),
    );
    expect(shapes(odd.root)).toEqual([]); // "red" isn't a computed color: jsdom has no canvas to ask
  });

  it("adds an arrowhead where a path has marker-end, pointing along it", () => {
    const svg = svgOf(`<defs>
        <marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"><path class="head" d="M0,1 L10,5 L0,9 z"/></marker>
        <marker id="fixed" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="11" markerUnits="userSpaceOnUse"><path class="head" d="M0,1 L10,5 L0,9 z"/></marker>
        <marker id="empty"/>
      </defs>
      <path class="arrow" d="M0,0 L100,0" marker-end="url(#m)"/>
      <path class="arrow" d="M0,0 L0,100" marker-end="url(#fixed)"/>
      <path class="arrow" d="M0,0 L0,50" marker-end="url(#missing)"/>`);
    const paint = paintDrawing(
      svg,
      fakeStyles((el) =>
        el.classList.contains("arrow")
          ? { fill: "none", stroke: "rgb(0, 0, 0)", strokeWidth: 2 }
          : el.classList.contains("head")
            ? { fill: "rgb(9, 9, 9)" }
            : {},
      ),
    );
    const [line, head, down, fixedHead, plain] = shapes(paint.root);
    expect(line.geometry.type).toBe("path");
    expect(head.fill).toEqual({ color: 0x090909, alpha: 1 });
    // markerWidth 7 per 10 units, times the stroke width 2: 1.4 per unit. The tip (10,5) is
    // 1 unit past refX, so it lands 1.4 beyond the end of the line.
    const tip = head.geometry.type === "path" ? head.geometry.commands[1] : null;
    expect(tip).toMatchObject({ op: "L" });
    if (tip && tip.op === "L") {
      expect(tip.x).toBeCloseTo(101.4);
      expect(tip.y).toBeCloseTo(0);
    }
    // userSpaceOnUse: 1.1 per unit whatever the stroke, pointing down.
    expect(down.geometry.type).toBe("path");
    const fixedTip = fixedHead.geometry.type === "path" ? fixedHead.geometry.commands[1] : null;
    if (fixedTip && fixedTip.op === "L") {
      expect(fixedTip.x).toBeCloseTo(0);
      expect(fixedTip.y).toBeCloseTo(102.2);
    }
    expect(plain.geometry.type).toBe("path");
    expect(shapes(paint.root)).toHaveLength(5);
  });

  it("draws curved arrowheads too", () => {
    const svg = svgOf(`<defs><marker id="c" viewBox="0 0 10 10" refX="0" refY="0" markerWidth="10">
        <path class="head" d="M0,0 Q5,5 10,0 C10,2 8,4 0,0 Z"/></marker></defs>
      <path class="arrow" d="M0,0 L10,0" marker-end="url(#c)"/>`);
    const paint = paintDrawing(
      svg,
      fakeStyles((el) => (el.classList.contains("arrow") ? { fill: "none", stroke: "rgb(0, 0, 0)" } : {})),
    );
    const head = shapes(paint.root)[1];
    expect(head.geometry.type === "path" && head.geometry.commands.map((c) => c.op)).toEqual(["M", "Q", "C", "Z"]);
  });

  it("marks changed cells for the flash, only when --flash is on", () => {
    const markup = `<g class="cell is-changed"><rect width="10" height="10"/></g><g class="cell"><rect width="10" height="10"/></g>`;
    const on = paintDrawing(
      svgOf(markup),
      fakeStyles(() => ({}), { "--flash": "mark 450ms ease-out" }),
    );
    const flashes = [...groups(on.root)].flatMap((g) => shapes(g).map((s) => s.flash));
    expect(flashes).toEqual([true, false]);
    const off = paintDrawing(
      svgOf(markup),
      fakeStyles(() => ({}), { "--flash": "none" }),
    );
    expect([...groups(off.root)].flatMap((g) => shapes(g).map((s) => s.flash))).toEqual([false, false]);
  });
});

describe("paintDrawing: text", () => {
  it("reads runs, tspans with dx, the anchor and the baseline", () => {
    const paint = paintDrawing(
      svgOf(
        `<text x="10" y="20" text-anchor="middle" dominant-baseline="central">for i<tspan class="arrow" dx="10">→</tspan><tspan dx="4"> 3 </tspan></text>`,
      ),
      fakeStyles((el) => (el.classList.contains("arrow") ? { fill: "rgb(255, 0, 0)", fontWeight: "700" } : {})),
    );
    const [t] = texts(paint.root);
    expect(t).toMatchObject({ x: 10, y: 20, anchor: "middle", baseline: "central" });
    expect(t.runs.map((r) => [r.text, r.dx, r.font.weight])).toEqual([
      ["for i", 0, "400"],
      ["→", 10, "700"],
      [" 3", 4, "400"],
    ]);
    expect(t.runs[1].fill).toEqual({ color: 0xff0000, alpha: 1 });
  });

  it("collapses white space as SVG does, unless it's pre", () => {
    const paint = paintDrawing(
      svgOf(`<text>  a   b\n c </text><text class="pre">a   b\tc</text><text>   </text>`),
      fakeStyles((el) => (el.classList.contains("pre") ? { whiteSpace: "pre" } : {})),
    );
    expect(texts(paint.root).map((t) => t.runs[0].text)).toEqual(["a b c", "a   b c"]);
  });

  it("draws a halo for paint-order: stroke, and other baselines and anchors", () => {
    const paint = paintDrawing(
      svgOf(`<text class="halo" text-anchor="end" dominant-baseline="hanging">x</text>
             <text dominant-baseline="middle">y</text><text dominant-baseline="text-before-edge">z</text>
             <text dominant-baseline="mathematical">w</text><text><tspan class="gone">h</tspan>v</text>`),
      fakeStyles((el) =>
        el.classList.contains("halo")
          ? { paintOrder: "stroke", stroke: "rgb(255, 255, 255)", strokeWidth: 3 }
          : el.classList.contains("gone")
            ? { hidden: true }
            : {},
      ),
    );
    const [halo, middle, edge, other, hidden] = texts(paint.root);
    expect(halo.anchor).toBe("end");
    expect(halo.baseline).toBe("hanging");
    expect(halo.runs[0].stroke).toMatchObject({ color: 0xffffff, width: 3 });
    expect(middle.baseline).toBe("middle");
    expect(edge.baseline).toBe("hanging");
    expect(other.baseline).toBe("alphabetic");
    expect(hidden.runs.map((r) => r.text)).toEqual(["v"]);
  });

  it("drops text with nothing to show", () => {
    const paint = paintDrawing(
      svgOf(`<text class="clear">x</text>`),
      fakeStyles(() => ({ fill: "none" })),
    );
    expect(paint.root.children).toEqual([]);
  });
});

describe("paintDrawing: groups", () => {
  it("keeps what dragging and animation need from data attributes, and tooltips", () => {
    const paint = paintDrawing(
      svgOf(`<g class="node" data-node-key="obj:1" data-flip="obj:1" data-x="5" data-y="6"><title>A box</title><rect x="5" y="6" width="10" height="10"/></g>
             <g class="cell" data-cell="list|0" data-value="3" data-cx="1" data-cy="2" data-no-fade=""><rect width="1" height="1"/></g>
             <g class="loop-row" data-top="10" data-bottom="40"><rect width="1" height="1"/></g>`),
      fakeStyles(),
    );
    const [node, cell, row] = paint.root.children as PaintGroup[];
    expect(node).toMatchObject({
      nodeKey: "obj:1",
      flip: "obj:1",
      at: { x: 5, y: 6 },
      title: "A box",
      classes: "node",
    });
    expect(node.bounds).toEqual({ x: 5, y: 6, w: 10, h: 10 });
    expect(cell.cell).toEqual({ key: "list|0", value: "3", cx: 1, cy: 2 });
    expect(cell.noFade).toBe(true);
    expect(row.current).toEqual({ top: 10, bottom: 40 });
  });

  it("gives keyed groups their opacity, and passes other groups' opacity down", () => {
    const paint = paintDrawing(
      svgOf(
        `<g class="faded"><g class="node" data-flip="a"><rect width="5" height="5"/></g><rect class="r" width="5" height="5"/></g>`,
      ),
      fakeStyles((el) =>
        el.classList.contains("faded") ? { opacity: 0.5 } : el.classList.contains("node") ? { opacity: 0.5 } : {},
      ),
    );
    const faded = paint.root.children[0] as PaintGroup;
    expect(faded.alpha).toBe(1);
    const node = faded.children[0] as PaintGroup;
    expect(node.alpha).toBe(0.25); // its own 0.5, times the plain group's 0.5
    expect(shapes(node)[0].fill?.alpha).toBe(1);
    expect(shapes(faded)[0].fill?.alpha).toBe(0.5);
  });

  it("puts each thing in the arrows layer in a layer of its own, carrying its opacity", () => {
    const paint = paintDrawing(
      svgOf(
        `<g class="arrows"><path class="ref-arrow" d="M0,0 L5,0"/><g class="pointer"><path d="M0,0 L1,1"/></g><text>t</text></g>`,
      ),
      fakeStyles((el) =>
        el.classList.contains("ref-arrow")
          ? { fill: "none", stroke: "rgb(0, 0, 0)", opacity: 0.28 }
          : { stroke: "rgb(0, 0, 0)" },
      ),
    );
    const arrows = paint.root.children[0] as PaintGroup;
    const [arrow, pointer, label] = arrows.children as PaintGroup[];
    expect(arrow).toMatchObject({ layer: true, alpha: 0.28, classes: "ref-arrow", parentClasses: "arrows" });
    expect(shapes(arrow)[0].stroke?.alpha).toBe(1); // the layer fades it, not the shape
    expect(pointer).toMatchObject({ layer: true, parentClasses: "arrows" });
    expect(label.layer).toBe(true);
    expect(label.children[0].kind).toBe("text");
  });

  it("drops empty groups and leaves out defs and titles", () => {
    const paint = paintDrawing(
      svgOf(`<g><g/></g><defs><rect width="5" height="5"/></defs><title>x</title>`),
      fakeStyles(),
    );
    expect(paint.root.children).toEqual([]);
    expect(paint.root.title).toBe("x");
  });
});

describe("paintDrawing: a real memory drawing", () => {
  it("has a group for every box, keyed as the SVG is", async () => {
    const trace = await traceJavaScript("const a = [1, 2];\nconst b = { a };\nlet c = b;\n");
    const i = trace.steps.length - 1;
    const svg = renderMemory(memoryScene(trace, i, diffSteps(trace.steps[i - 1], trace.steps[i])));
    const paint = paintDrawing(
      svg,
      fakeStyles(() => ({ stroke: "rgb(0, 0, 0)" })),
    );
    const keys = [...groups(paint.root)].filter((g) => g.nodeKey).map((g) => g.nodeKey);
    expect(keys).toEqual([...svg.querySelectorAll(".node")].map((n) => (n as SVGGElement).dataset.nodeKey));
    expect(paint.classes).toContain("memory-svg");
    for (const g of groups(paint.root)) if (g.nodeKey) expect(g.bounds).not.toBeNull();
  });
});
