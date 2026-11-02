// @vitest-environment jsdom
/**
 * The SVG renderers behind the renderer contract (scene/renderer.ts): what
 * each call does to the window. What's drawn is tested in memory.test.ts,
 * loopView.test.ts and layout.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { traceJavaScript } from "../js/trace";
import { loopScene } from "../scene/loopScene";
import { memoryScene } from "../scene/memoryScene";
import { diffSteps } from "../trace/diff";
import { buildLoopHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { SVG_RENDERERS } from "./svgRenderers";

const sceneAt = (t: Trace, i = t.steps.length - 1) => memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]));

function windowEl(): HTMLElement {
  document.body.innerHTML = `<div id="w"></div>`;
  const el = document.getElementById("w")!;
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  return el;
}

/** A pointer event jsdom can dispatch (it has no PointerEvent). */
function pointer(type: string, target: Element, x: number, y: number) {
  const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(e, "pointerId", { value: 1 });
  target.dispatchEvent(e);
}

afterEach(() => vi.restoreAllMocks());

describe("SvgMemoryRenderer", () => {
  it("draws a scene, or a message instead", async () => {
    const el = windowEl();
    const r = SVG_RENDERERS.memory(el, {});
    r.showMessage("Nothing yet");
    expect(el.textContent).toContain("Nothing yet");
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null);
    expect(el.querySelector(".memory-svg")).not.toBeNull();
  });

  it("dragging a box moves it, tells the app, and Reset layout puts it back", async () => {
    const el = windowEl();
    const changes: number[] = [];
    const r = SVG_RENDERERS.memory(el, { onLayoutChange: () => changes.push(1) });
    const scene = sceneAt(await traceJavaScript("const a = [1];\n"));
    r.render(scene, null);
    const node = el.querySelector<SVGGElement>(`.node[data-node-key="${scene.objects[0].key}"]`)!;
    pointer("pointerdown", node, 10, 10);
    pointer("pointermove", el, 60, 40);
    pointer("pointerup", el, 60, 40);
    expect(changes.length).toBeGreaterThan(0);
    expect(r.hasMovedBoxes).toBe(true);
    r.render(scene, scene);
    expect(el.querySelector(`.node[data-node-key="${scene.objects[0].key}"]`)!.classList.contains("is-moved")).toBe(
      true,
    );
    r.resetLayout();
    expect(r.hasMovedBoxes).toBe(false);
    r.moveBoxes(new Map([[scene.objects[0].key, { x: 3, y: 4 }]]));
    expect(r.movedBoxes.get(scene.objects[0].key)).toEqual({ x: 3, y: 4 });
  });

  it("saves its drawing as a standalone SVG, and says where it's looking", async () => {
    const el = windowEl();
    const r = SVG_RENDERERS.memory(el, {});
    expect(r.toSVG()).toBeNull();
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null);
    const file = r.toSVG()!;
    expect(file).toMatch(/^<\?xml/);
    expect(new DOMParser().parseFromString(file, "image/svg+xml").documentElement.localName).toBe("svg");
    expect(file).not.toContain("data-node-key");
    // Read afresh each time (the look may have changed), and the probe goes once it's read.
    expect(el.querySelector(".canvas-probe")).toBeNull();
    r.render(sceneAt(await traceJavaScript("const a = [1];\n")), null);
    expect(r.toSVG()).toBe(file);
    r.setViewport({ pan: { x: 12, y: 34 }, zoom: 1.5 });
    expect(r.viewport).toEqual({ pan: { x: 12, y: 34 }, zoom: 1.5 });
    r.dispose();
  });

  it("hovering a box highlights it and its arrows, and keeps doing so across steps", async () => {
    const el = windowEl();
    const r = SVG_RENDERERS.memory(el, {});
    const t = await traceJavaScript("const a = [1];\nconst b = a;\n");
    const scene = sceneAt(t);
    r.render(scene, null);
    const key = scene.objects[0].key;
    pointer("pointerover", el.querySelector(`.node[data-node-key="${key}"]`)!, 0, 0);
    expect(el.querySelector(".is-focus")).not.toBeNull();
    r.render(scene, scene); // redrawn: still highlighted
    expect(el.querySelector(`.node.is-focus[data-node-key="${key}"]`)).not.toBeNull();
    el.dispatchEvent(new MouseEvent("pointerleave"));
    expect(el.querySelector(".is-focus")).toBeNull();
  });

  it("says what's under a point", async () => {
    const el = windowEl();
    const r = SVG_RENDERERS.memory(el, {});
    const scene = sceneAt(await traceJavaScript("const a = [1];\n"));
    r.render(scene, null);
    const node = el.querySelector(`.node[data-node-key="${scene.objects[0].key}"] rect`)!;
    const at = vi.fn<(x: number, y: number) => Element | null>();
    document.elementFromPoint = at;
    at.mockReturnValue(node);
    expect(r.hitTest(5, 5)).toEqual({ kind: "box", key: scene.objects[0].key });
    at.mockReturnValue(el.querySelector(".memory-svg"));
    expect(r.hitTest(5, 5)).toEqual({ kind: "background" });
    at.mockReturnValue(document.body);
    expect(r.hitTest(5, 5)).toBeNull();
  });

  it("moves, zooms and styles the window, and lets go of it", () => {
    const el = windowEl();
    const r = SVG_RENDERERS.memory(el, {});
    r.setViewport({ pan: { x: 30, y: 40 }, zoom: 2 });
    expect(el.querySelector<HTMLElement>(".viewport-layer")!.style.transform).toBe("translate(30px, 40px) scale(2)");
    r.setViewport({ zoom: 99 });
    expect(el.querySelector<HTMLElement>(".viewport-layer")!.style.transform).toContain("scale(3)"); // the most it zooms
    r.setAppearance({ gridSize: 10, zoom: { duration: 100, easing: "ease" } });
    expect(el.style.backgroundSize).toBe("30px 30px");
    r.setViewport({ autoFit: { on: true, mode: "both" }, refit: true });
    expect(el.querySelector(".auto-fit")!.getAttribute("aria-pressed")).toBe("true");
    const button = r.addControl("Hello", "A control", () => {});
    expect(el.contains(button)).toBe(true);
    r.dispose();
    expect(el.children).toHaveLength(0);
    expect(el.classList.contains("viewport")).toBe(false);
  });
});

describe("SvgLoopRenderer", () => {
  it("zoomed out, builds the step at the level; zoomed in past it, lays it out again once the zoom settles", async () => {
    vi.useFakeTimers();
    try {
      const el = windowEl();
      const changes: number[] = [];
      const r = SVG_RENDERERS.memory(el, { onLayoutChange: () => changes.push(1) });
      const scene = sceneAt(await traceJavaScript("const a = [17, 23];\n"));
      r.setViewport({ zoom: 0.2 }); // blocks
      vi.advanceTimersByTime(1000);
      changes.length = 0;
      r.render(scene, null);
      expect(el.dataset.builtLod).toBe("2");
      r.setViewport({ zoom: 0.25 }); // still blocks: nothing to do
      vi.advanceTimersByTime(1000);
      expect(changes).toHaveLength(0);
      r.setViewport({ zoom: 1 }); // full: more detail than it was built with
      vi.advanceTimersByTime(100);
      expect(changes).toHaveLength(0); // not mid-zoom
      vi.advanceTimersByTime(200);
      expect(changes).toHaveLength(1);
      r.render(scene, scene);
      expect(el.dataset.builtLod).toBe("0");
      expect(el.querySelector(".memory-svg text")?.textContent).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  const code = "const a = [1, 2];\nconst b = [3, 4];\nfor (let i = 0; i < 2; i++) {\n  a[i] = b[i];\n  b[i] = 0;\n}\n";

  it("clicking a fold in the loop history asks for its rows; the zoom settling at another budget asks to fold again", async () => {
    vi.useFakeTimers();
    try {
      const el = windowEl();
      const opened: string[] = [];
      let refolds = 0;
      const r = SVG_RENDERERS.loop(el, { onExpand: (key) => opened.push(key), onLayoutChange: () => refolds++ });
      const t = await traceJavaScript("const a = [];\nfor (let i = 0; i < 30; i++) {\n  a.push(i);\n}\n");
      const at = t.steps.length - 2;
      const budget = r.detailBudget();
      const scene = loopScene(t, buildLoopHistory(t, at, null)!, {
        hideQuiet: false,
        detail: { cells: 40, expanded: new Set() },
      });
      r.render({ ...scene, cellBudget: budget }, null);
      const band = el.querySelector<SVGGElement>(".fold-band")!;
      expect(band).not.toBeNull();
      pointer("pointerdown", band.querySelector("text") ?? band, 50, 50);
      pointer("pointerup", el, 50, 50);
      expect(opened).toEqual([band.dataset.summary]);
      // A press that pans opens nothing.
      pointer("pointerdown", band, 50, 50);
      pointer("pointermove", el, 120, 90);
      pointer("pointerup", el, 120, 90);
      expect(opened).toHaveLength(1);
      // Zoomed out to where the budget is smaller: once it settles, the app is asked to fold again.
      r.setViewport({ zoom: 0.05 });
      vi.advanceTimersByTime(300);
      expect(r.detailBudget()).toBeLessThan(budget);
      expect(refolds).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a loop scene side by side or stacked, keeping the running row in view", async () => {
    const el = windowEl();
    const r = SVG_RENDERERS.loop(el, {});
    const t = await traceJavaScript(code);
    const at = t.steps.length - 2;
    const scene = loopScene(t, buildLoopHistory(t, at, null)!, { hideQuiet: false });
    r.render(scene, null);
    const side = Number(el.querySelector(".loop-svg")!.getAttribute("width"));
    r.setLayout({ vertical: true });
    r.render(scene, scene);
    expect(Number(el.querySelector(".loop-svg")!.getAttribute("width"))).toBeLessThan(side);
    // Zoomed out, then in again past what it was built with: drawn again once the zoom settles.
    vi.useFakeTimers();
    try {
      r.setViewport({ zoom: 0.05 });
      r.render(scene, scene);
      expect(el.dataset.builtLod).toBe("3");
      r.setViewport({ zoom: 1 });
      vi.advanceTimersByTime(300);
      expect(el.dataset.builtLod).toBe("0");
    } finally {
      vi.useRealTimers();
    }
    r.showMessage("No loop");
    expect(el.querySelector(".loop-svg")).toBeNull();
    expect(el.textContent).toContain("No loop");
  });
});
