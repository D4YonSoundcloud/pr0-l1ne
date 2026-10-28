// @vitest-environment jsdom
/**
 * The viewport with a surface: a drawing that isn't an SVG in the page (the
 * canvas renderer). The SVG side is tested through svgRenderers.test.ts and
 * the browser checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gridStep, type View, Viewport, type ViewSurface, zoomText } from "./viewport";

function windowEl(): HTMLElement {
  document.body.innerHTML = `<div id="w"></div>`;
  const el = document.getElementById("w")!;
  el.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON() {},
  });
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  return el;
}

function pointer(type: string, target: Element, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(e, "pointerId", { value: 1 });
  target.dispatchEvent(e);
}

function surface(node: { key: string; x: number; y: number } | null = null) {
  const views: View[] = [];
  const s: ViewSurface = { onView: (v) => views.push({ ...v }), nodeAt: vi.fn(() => node) };
  return { s, views };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});
afterEach(() => vi.useRealTimers());

describe("Viewport with a surface", () => {
  it("tells the surface where the view is, instead of moving an SVG", () => {
    const el = windowEl();
    const { s, views } = surface();
    const view = new Viewport(el, { label: "Test", surface: s });
    view.moveTo({ x: 10, y: 20 }, 2);
    expect(views.at(-1)).toEqual({ x: 10, y: 20, z: 2 });
    expect(el.querySelector<HTMLElement>(".viewport-layer")!.style.transform).toBe("");
    expect(el.style.backgroundPosition).toBe("10px 20px");
    view.dispose();
  });

  it("knows a drawing's size without an SVG, and says when there's none", () => {
    const el = windowEl();
    const { s } = surface();
    const view = new Viewport(el, { label: "Test", surface: s });
    view.setDrawn({ width: 400, height: 300 });
    expect(el.querySelector<HTMLElement>(".viewport-controls")!.hidden).toBe(false);
    view.setDrawn(null, "Nothing to show");
    expect(el.querySelector(".viewport-empty")!.textContent).toBe("Nothing to show");
    expect(el.querySelector<HTMLElement>(".viewport-controls")!.hidden).toBe(true);
    expect(view.contentLayer.classList.contains("viewport-layer")).toBe(true);
    view.dispose();
  });

  it("asks the surface which box is under the pointer, to drag it", () => {
    const el = windowEl();
    const { s } = surface({ key: "obj:1", x: 40, y: 50 });
    const moves: [string, { x: number; y: number }, boolean][] = [];
    const view = new Viewport(el, { label: "Test", surface: s, onNodeMove: (k, p, d) => moves.push([k, p, d]) });
    view.setDrawn({ width: 400, height: 300 });
    pointer("pointerdown", el, 100, 100);
    pointer("pointermove", el, 130, 110);
    pointer("pointerup", el, 130, 110);
    expect(s.nodeAt).toHaveBeenCalledWith(100, 100);
    expect(moves.at(-1)).toEqual(["obj:1", { x: 70, y: 60 }, true]);
    view.dispose();
  });

  it("glides an Auto-fit frame by frame, and a manual move stops the glide", () => {
    const el = windowEl();
    Object.defineProperty(el, "clientHeight", { value: 600 });
    const { s, views } = surface();
    const view = new Viewport(el, { label: "Test", surface: s });
    view.setZoomAnimation(100, "linear");
    view.setDrawn({ width: 1600, height: 300 });
    view.setAutoFit({ on: true, mode: "both" });
    // Turning it on fits at once (snug); a bigger drawing then glides there.
    views.length = 0;
    view.setDrawn({ width: 3200, height: 300 });
    expect(views.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(50);
    const middle = views.at(-1)!;
    vi.advanceTimersByTime(100);
    const end = views.at(-1)!;
    expect(end.z).toBeCloseTo(0.25);
    expect(middle.z).toBeGreaterThan(end.z);
    // A new glide, cut short by a move.
    view.setDrawn({ width: 1600, height: 300 });
    view.setAutoFit({ on: false, mode: "both" });
    view.setDrawn({ width: 6400, height: 300 });
    view.moveTo({ x: 1, y: 2 }, 1);
    const count = views.length;
    vi.advanceTimersByTime(200);
    expect(views.length).toBe(count);
    view.dispose();
  });
});

describe("zoomed far out", () => {
  it("goes down to 1%, with the zoom said as it is and the graph paper coarser", () => {
    const el = windowEl();
    const view = new Viewport(el, { label: "Test" });
    view.moveTo(undefined, 0.001);
    expect(view.view.zoom).toBe(0.01);
    expect(el.querySelector(".zoom-label")!.textContent).toBe("1%");
    expect(zoomText(0.025)).toBe("2.5%");
    expect(zoomText(0.35)).toBe("35%");
    // 24 px squares at 1% would be a quarter of a pixel: five times coarser until they're 8 px or more.
    expect(gridStep(24, 0.01)).toBe(30);
    expect(gridStep(24, 1)).toBe(24);
    view.dispose();
  });

  it("says when the level of detail changes, and marks the window with it", () => {
    const el = windowEl();
    const levels: number[] = [];
    const view = new Viewport(el, { label: "Test", onLod: (lod) => levels.push(lod) });
    view.moveTo(undefined, 0.2);
    view.moveTo(undefined, 0.19);
    view.moveTo(undefined, 0.01);
    view.moveTo(undefined, 1);
    expect(levels).toEqual([2, 4, 0]);
    expect(view.lod).toBe(0);
    expect(el.dataset.lod).toBe("0");
    view.dispose();
  });

  it("shows landmarks over the drawing only when it's too small to read, where their boxes are", () => {
    const el = windowEl();
    const view = new Viewport(el, { label: "Test" });
    view.setLandmarks([{ x: 100, y: 200, text: "Global", kind: "frame" }]);
    const layer = el.querySelector<HTMLElement>(".viewport-landmarks")!;
    expect(layer.hidden).toBe(true);
    view.moveTo({ x: 10, y: 20 }, 0.05);
    expect(layer.hidden).toBe(false);
    const label = layer.querySelector<HTMLElement>(".landmark.is-frame")!;
    expect(label.textContent).toBe("Global");
    expect(label.style.transform).toBe("translate(15px, 30px)");
    view.dispose();
  });

  it("says what a box is under the pointer, and zooms in on it with a double-click", () => {
    const el = windowEl();
    const { s } = surface({ key: "obj:o1", x: 1000, y: 500, w: 200, h: 100, title: "list, 2,000 items" } as never);
    const view = new Viewport(el, { label: "Test", surface: s });
    view.setDrawn({ width: 4000, height: 3000 });
    view.moveTo({ x: 0, y: 0 }, 0.05);
    pointer("pointermove", el, 60, 30);
    const tip = el.querySelector<HTMLElement>(".viewport-tip")!;
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain("list, 2,000 items");
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 60, clientY: 30 }));
    // As big as fits in the 800 × 600 window, up to 100%: the box is 200 × 100.
    expect(view.view.zoom).toBe(1);
    expect(view.view.pan).toEqual({ x: 400 - 1100, y: 300 - 550 });
    view.dispose();
  });
});
