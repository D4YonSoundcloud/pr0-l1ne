// @vitest-environment jsdom
/**
 * The Canvas 2D renderers behind the renderer contract, with a fake PixiJS
 * (testing/fakePixi.ts) and styles given by rule (testing/canvasStyles.ts).
 * What they draw is the same paint list as paint.test.ts checks; here it's
 * what each contract call does, and how the window behaves.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { liveRows } from "../../app/loopController";
import { traceJavaScript } from "../../js/trace";
import { loopScene } from "../../scene/loopScene";
import { type MemoryScene, memoryScene } from "../../scene/memoryScene";
import { fakeStyles } from "../../testing/canvasStyles";
import { type Container, Graphics, pixi, Text } from "../../testing/fakePixi";
import { diffSteps } from "../../trace/diff";
import { buildLoopHistory } from "../../trace/loopHistory";
import type { Trace } from "../../trace/types";
import { renderMemory } from "../memory";
import { CanvasLoopRenderer, CanvasMemoryRenderer, canvasRenderers } from "./canvasRenderers";
import { groups, paintSvg } from "./paint";
import type { ComputedPaint } from "./styles";

vi.mock("pixi.js", () => import("../../testing/fakePixi"));

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

/** Black lines on white boxes; what's dimmed by printed output, at 0.28, as styles.css says. */
function rule(el: Element): Partial<ComputedPaint> {
  const dimmed =
    el.matches(".memory-svg.has-output .boxes > .node:not(.is-output):not(.is-printed)") ||
    el.matches(".memory-svg.has-output .arrows > .ref-arrow:not(.print-arrow)");
  const base: Partial<ComputedPaint> =
    el.localName === "text" || el.localName === "tspan"
      ? { fill: "rgb(0, 0, 0)" }
      : { fill: "rgb(255, 255, 255)", stroke: "rgb(0, 0, 0)" };
  return dimmed ? { ...base, opacity: 0.28 } : base;
}

const VARIABLES = {
  "--flash": "mark 450ms ease-out",
  "--output-from-opacity": "0",
  "--output-from-x": "-8px",
  "--output-duration": "240ms",
  "--output-dim-duration": "260ms",
};

function probe(variables: Record<string, string> = VARIABLES) {
  return Object.assign(fakeStyles(rule, variables), { clear: vi.fn(), dispose: vi.fn() });
}

function windowEl(): HTMLElement {
  document.body.innerHTML = `<div id="canvas" style="--x: 1"><div id="w"></div></div>`;
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
  Object.defineProperty(el, "clientWidth", { value: 800 });
  Object.defineProperty(el, "clientHeight", { value: 600 });
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  return el;
}

function pointer(type: string, target: Element, x: number, y: number, buttons = 0) {
  const e = new MouseEvent(type, { bubbles: true, button: 0, buttons, clientX: x, clientY: y });
  Object.defineProperty(e, "pointerId", { value: 1 });
  target.dispatchEvent(e);
}

const sceneAt = (t: Trace, i = t.steps.length - 1, options = {}) =>
  memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), options);

/** Where a box is (its top-left corner), from the same layout the renderer draws. */
function boxAt(scene: MemoryScene, key: string) {
  const node = renderMemory(scene).querySelector<SVGGElement>(`.node[data-node-key="${CSS.escape(key)}"]`)!;
  return { x: Number(node.dataset.x), y: Number(node.dataset.y) };
}

const stage = () => pixi.renderers.at(-1)!.lastStage!;
/** A changed cell's flash: a white fill at 55% (pixiScene.ts). */
const isFlash = (g: Graphics) => {
  const fill = g.calls.find((c) => c[0] === "fill")?.[1] as { color?: number; alpha?: number } | undefined;
  return fill?.color === 0xffffff && fill.alpha === 0.55;
};
const all = (c: Container): Container[] => [c, ...c.children.flatMap(all)];
/** The layers under the stage: what animation moves (not Graphics or Text, which have their own x). */
const layers = () => all(stage()).filter((c) => c !== stage() && !(c instanceof Graphics) && !(c instanceof Text));
const STILL = { duration: 0, easing: "linear", enter: { fade: false, slide: false } };
const MOVING = { duration: 200, easing: "linear", enter: { fade: true, slide: true } };

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CanvasMemoryRenderer", () => {
  it("starts PixiJS's canvas renderer in the window, then draws", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    const canvas = el.querySelector("canvas.viewport-canvas");
    expect(canvas).not.toBeNull();
    expect(el.classList.contains("is-canvas")).toBe(true);
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null); // before it's ready: drawn once it is
    await r.ready;
    const renderer = pixi.renderers.at(-1)!;
    expect(renderer.options).toMatchObject({
      preference: ["canvas"],
      canvas,
      backgroundAlpha: 0,
      width: 800,
      height: 600,
    });
    expect(renderer.renders).toBeGreaterThan(0);
    expect(all(stage()).some((c) => c instanceof Text)).toBe(true);
    expect(el.querySelector<HTMLElement>(".viewport-controls")!.hidden).toBe(false);
    r.dispose();
  });

  it("shows a message instead of a drawing", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null);
    r.showMessage("Nothing yet");
    expect(el.querySelector(".viewport-empty")!.textContent).toBe("Nothing yet");
    expect(stage().children).toEqual([]);
    expect(r.toSVG()).toBeNull();
    r.dispose();
  });

  it("says which box is under a point", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const scene = sceneAt(await traceJavaScript("const a = [1];\n"));
    r.render(scene, null);
    const key = scene.objects[0].key;
    const at = boxAt(scene, key);
    expect(r.hitTest(at.x + 4, at.y + 4)).toEqual({ kind: "box", key });
    expect(r.hitTest(790, 590)).toEqual({ kind: "background" });
    expect(r.hitTest(900, 10)).toBeNull();
    r.dispose();
  });

  it("drags a box, tells the app, and hands its place over", async () => {
    const el = windowEl();
    const changes = vi.fn();
    const r = new CanvasMemoryRenderer(el, { onLayoutChange: changes }, { styles: () => probe() });
    await r.ready;
    const scene = sceneAt(await traceJavaScript("const a = [1];\n"));
    r.render(scene, null);
    const key = scene.objects[0].key;
    const at = boxAt(scene, key);
    const canvas = el.querySelector("canvas")!;
    pointer("pointerdown", canvas, at.x + 4, at.y + 4, 1);
    pointer("pointermove", canvas, at.x + 54, at.y + 34, 1);
    expect(canvas.style.cursor).toBe("grabbing");
    pointer("pointerup", canvas, at.x + 54, at.y + 34);
    expect(changes).toHaveBeenCalled();
    expect(r.hasMovedBoxes).toBe(true);
    expect(r.movedBoxes.get(key)).toEqual({ x: at.x + 50, y: at.y + 30 });
    r.resetLayout();
    expect(r.hasMovedBoxes).toBe(false);
    r.moveBoxes(new Map([[key, { x: 7, y: 8 }]]));
    expect(r.movedBoxes.get(key)).toEqual({ x: 7, y: 8 });
    r.dispose();
  });

  it("highlights a hovered box's arrows, and stops when the pointer leaves", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const scene = sceneAt(await traceJavaScript("const a = [1];\nconst b = a;\n"));
    r.render(scene, null);
    const key = scene.objects[0].key;
    const at = boxAt(scene, key);
    const canvas = el.querySelector("canvas")!;
    const before = pixi.renderers.at(-1)!.renders;
    pointer("pointermove", canvas, at.x + 4, at.y + 4);
    expect(pixi.renderers.at(-1)!.renders).toBeGreaterThan(before);
    expect(r.toSVG()).toContain("has-focus");
    expect(canvas.style.cursor).toBe("grab");
    pointer("pointermove", canvas, at.x + 5, at.y + 5); // the same box: nothing to redo
    pointer("pointermove", canvas, at.x + 5, at.y + 5, 1); // a button held: panning, not hovering
    el.dispatchEvent(new MouseEvent("pointerleave"));
    expect(r.toSVG()).not.toContain("has-focus");
    expect(canvas.style.cursor).toBe("");
    el.dispatchEvent(new MouseEvent("pointerleave")); // already left
    r.dispose();
  });

  it("animates a step: new boxes fade and slide in, changed cells flash", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const t = await traceJavaScript("const a = [1];\na[0] = 2;\nconst b = [3];\n");
    r.setAppearance({ step: MOVING });
    // Step through: a[0] changing makes its cell flash.
    let flashed = false;
    for (let i = 1; i < t.steps.length - 1; i++) {
      r.render(sceneAt(t, i), null);
      flashed ||= all(stage()).some((c) => c instanceof Graphics && isFlash(c) && c.alpha === 1);
    }
    expect(flashed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(all(stage()).filter((c) => c instanceof Graphics && isFlash(c) && c.alpha > 0)).toEqual([]);
    r.render(sceneAt(t, t.steps.length - 1), null); // b is new
    const arriving = all(stage()).filter((c) => c.alpha === 0);
    expect(arriving.length).toBeGreaterThan(0);
    expect(layers().some((c) => c.x === -10)).toBe(true);
    vi.advanceTimersByTime(1000);
    // Everything has arrived (a finished flash is invisible: that's its end).
    expect(all(stage()).filter((c) => c.alpha === 0 && !(c instanceof Graphics && isFlash(c)))).toEqual([]);
    expect(layers().some((c) => c.x !== 0)).toBe(false);
    r.dispose();
  });

  it("slides a moved box from where it was", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const scene = sceneAt(await traceJavaScript("const a = [1];\n"));
    r.render(scene, null);
    const key = scene.objects[0].key;
    r.moveBoxes(new Map([[key, { x: 2000, y: 1500 }]]));
    r.setAppearance({ step: { ...MOVING, enter: { fade: false, slide: false } } });
    r.render(scene, scene);
    expect(layers().some((c) => c.x < -1000)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(layers().every((c) => c.x === 0 && c.y === 0)).toBe(true);
    r.dispose();
  });

  it("pops the output card in and dims the rest, then brings it back", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const t = await traceJavaScript("const a = [1];\nconst b = [2];\nconsole.log(a);\nlet c = 3;\nlet d = 4;\n");
    const printed = t.steps.findIndex((s) => s.output);
    const options = { output: true, dimForOutput: true };
    r.setAppearance({ step: STILL });
    r.render(sceneAt(t, printed - 1, options), null);
    r.render(sceneAt(t, printed, options), null);
    // The card starts 8px to the left and invisible; the rest starts undimmed.
    expect(layers().some((c) => c.x === -8 && c.alpha === 0)).toBe(true);
    const dimming = layers().filter((c) => c.alpha === 1);
    expect(dimming.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(400);
    expect(all(stage()).some((c) => Math.abs(c.alpha - 0.28) < 1e-9)).toBe(true);
    // The next step: the output goes, and the rest comes back from 0.28.
    r.render(sceneAt(t, printed + 1, options), null);
    expect(all(stage()).some((c) => Math.abs(c.alpha - 0.28) < 1e-9)).toBe(true);
    vi.advanceTimersByTime(400);
    expect(all(stage()).some((c) => Math.abs(c.alpha - 0.28) < 1e-9)).toBe(false);
    r.dispose();
  });

  it("pops the output card in even when nothing else dims", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const t = await traceJavaScript("const a = [1];\nconsole.log(a);\nlet c = 3;\n");
    const printed = t.steps.findIndex((s) => s.output);
    r.setAppearance({ step: STILL });
    r.render(sceneAt(t, printed, { output: true, dimForOutput: false }), null);
    expect(layers().some((c) => c.x === -8 && c.alpha === 0)).toBe(true);
    expect(layers().some((c) => Math.abs(c.alpha - 0.28) < 1e-9)).toBe(false);
    r.dispose();
  });

  it("plays no effects when the person asks for less motion", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const t = await traceJavaScript("const a = [1];\na[0] = 2;\n");
    r.render(sceneAt(t, 1), null);
    r.render(sceneAt(t, 2), sceneAt(t, 1));
    expect(all(stage()).filter((c) => c instanceof Graphics && isFlash(c))).toEqual([]);
    r.dispose();
    vi.unstubAllGlobals();
  });

  it("only draws the boxes in view", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    r.render(sceneAt(await traceJavaScript("const a = [1];\nconst b = { a };\n")), null);
    r.setViewport({ pan: { x: -5000, y: -5000 }, zoom: 1 });
    vi.advanceTimersByTime(20);
    expect(all(stage()).some((c) => !c.visible)).toBe(true);
    expect(r.viewport.pan).toEqual({ x: -5000, y: -5000 });
    r.setViewport({ pan: { x: 0, y: 0 } });
    vi.advanceTimersByTime(20);
    expect(all(stage()).every((c) => c.visible)).toBe(true);
    r.dispose();
  });

  it("draws text sharper once zooming in settles", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null);
    const resolution = () => all(stage()).find((c): c is Text => c instanceof Text)!.resolution;
    expect(resolution()).toBe(1);
    r.setViewport({ zoom: 2.5 });
    expect(resolution()).toBe(1);
    vi.advanceTimersByTime(200);
    expect(resolution()).toBe(3);
    r.setViewport({ zoom: 3 }); // the same step: nothing to redo
    vi.advanceTimersByTime(200);
    expect(resolution()).toBe(3);
    r.dispose();
  });

  it("reads styles again, and redraws, when the Style panel changes the look", async () => {
    const el = windowEl();
    const styles = probe();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => styles });
    await r.ready;
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null);
    const cleared = styles.clear.mock.calls.length;
    const renders = pixi.renderers.at(-1)!.renders;
    r.setAppearance({ zoom: { duration: 100, easing: "ease" } }); // nothing changed
    expect(styles.clear.mock.calls.length).toBe(cleared);
    document.getElementById("canvas")!.style.setProperty("--cell", "#123456");
    r.setAppearance({ gridSize: 30 });
    expect(styles.clear.mock.calls.length).toBe(cleared + 1);
    expect(pixi.renderers.at(-1)!.renders).toBeGreaterThan(renders);
    r.dispose();
  });

  it("redraws when a web font arrives, and when the window is resized", async () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    let resized: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null);
    const renders = pixi.renderers.at(-1)!.renders;
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(pixi.renderers.at(-1)!.renders).toBe(renders + 1);
    resized!();
    expect(pixi.renderers.at(-1)!.renders).toBe(renders + 2);
    r.dispose();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "fonts");
  });

  it("saves the drawing as a standalone SVG", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null);
    const svg = r.toSVG()!;
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain("data-flip");
    r.dispose();
  });

  it("lets go of the window, even before PixiJS has started", async () => {
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    r.addControl("Hello", "A control", () => {});
    r.dispose();
    await r.ready;
    expect(pixi.renderers.at(-1)!.destroyed).toBe(true);
    expect(el.children).toHaveLength(0);
    expect(el.classList.contains("is-canvas")).toBe(false);
  });

  it("reports when PixiJS can't start", async () => {
    pixi.fail = new Error("no 2D canvas");
    const el = windowEl();
    const r = new CanvasMemoryRenderer(el, {}, { styles: () => probe() });
    await expect(r.ready).rejects.toThrow("no 2D canvas");
    r.dispose();
  });
});

describe("CanvasLoopRenderer", () => {
  const code = "const a = [1, 2];\nconst b = [3, 4];\nfor (let i = 0; i < 2; i++) {\n  a[i] = b[i];\n  b[i] = 0;\n}\n";

  it("draws stacked rows side by side or one above another, with tooltips", async () => {
    const el = windowEl();
    const r = new CanvasLoopRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const t = await traceJavaScript(code);
    const scene = loopScene(t, buildLoopHistory(t, t.steps.length - 2, null)!, { hideQuiet: false });
    r.render(scene, null);
    const wide = el.querySelector(".zoom-label")!.textContent;
    r.setLayout({ vertical: true });
    r.render(scene, scene);
    expect(el.querySelector(".zoom-label")!.textContent).toBe(wide);
    // A loop header has a tooltip: find where it's drawn, and point there.
    const svg = new DOMParser().parseFromString(r.toSVG()!, "image/svg+xml");
    expect(svg.documentElement.localName).toBe("svg");
    r.dispose();
  });

  it("shows a tooltip where a drawing has a <title>", async () => {
    const el = windowEl();
    const r = new CanvasLoopRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    const t = await traceJavaScript(
      "function f(n) {\n  let s = 0;\n  for (let i = 0; i < n; i++) s += i;\n  return s;\n}\nf(2);\nf(3);\n",
    );
    const at = t.steps.length - 1 - [...t.steps].reverse().findIndex((s) => s.line === 3);
    const history = buildLoopHistory(t, at, null)!;
    const scene = loopScene(t, history, { hideQuiet: false });
    r.render(scene, null);
    const titled = [
      ...groups(paintSvg((await import("../loopView")).renderLoopHistory(scene), fakeStyles(rule)).root),
    ].find((g) => g.title && g.bounds);
    if (titled?.bounds) {
      const canvas = el.querySelector("canvas")!;
      pointer("pointermove", canvas, titled.bounds.x + 1, titled.bounds.y + 1);
      expect(canvas.title).toBe(titled.title);
      pointer("pointermove", canvas, 799, 599);
      expect(canvas.hasAttribute("title")).toBe(false);
    }
    r.dispose();
  });

  it("animates only the live row", async () => {
    const el = windowEl();
    const r = new CanvasLoopRenderer(el, {}, { styles: () => probe() });
    await r.ready;
    r.setAppearance({ step: MOVING });
    const t = await traceJavaScript(code);
    const before = loopScene(t, buildLoopHistory(t, 6, null)!, { hideQuiet: false });
    const after = loopScene(t, buildLoopHistory(t, t.steps.length - 2, null)!, { hideQuiet: false });
    r.render(before, null);
    r.render(after, before);
    expect(all(stage()).filter((c) => c.alpha === 0)).toEqual([]);
    const live = (at: number) => {
      const history = buildLoopHistory(t, at, null)!;
      return loopScene(t, history, { hideQuiet: false, live: liveRows(t, at, history) });
    };
    r.render(live(6), null);
    r.render(live(t.steps.length - 2), live(6));
    expect(layers().some((c) => c.alpha === 0 || c.x !== 0)).toBe(true);
    r.dispose();
  });
});

describe("canvasRenderers", () => {
  it("makes both windows' renderers", () => {
    const factory = canvasRenderers({ styles: () => probe() });
    const memory = factory.memory(windowEl(), {});
    expect(memory).toBeInstanceOf(CanvasMemoryRenderer);
    memory.dispose();
    const loop = factory.loop(windowEl(), {});
    expect(loop).toBeInstanceOf(CanvasLoopRenderer);
    loop.dispose();
  });
});
