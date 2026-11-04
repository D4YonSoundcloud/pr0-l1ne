// @vitest-environment jsdom
/**
 * The controllers draw only through the renderer contract (scene/renderer.ts):
 * given renderers that just record what they're asked, everything still
 * works. This is what a canvas, WebGL or WebGPU renderer will be plugged
 * into. Each step is laid out for the view the renderer gives
 * (layoutView) and handed back to it to show (show): here on the page,
 * from the page's trace, as the controllers do without a layout worker.
 */
import { describe, expect, it } from "vitest";
import type { LoopLaidOut, MemoryLaidOut } from "../layout/requests";
import { Mark } from "../render/drawing";
import type { LoopScene } from "../scene/loopScene";
import type { MemoryScene } from "../scene/memoryScene";
import type {
  Hit,
  LoopRenderer,
  MemoryRenderer,
  MemoryRendererEvents,
  Renderer,
  RendererEvents,
  RendererFactory,
} from "../scene/renderer";
import { LoopController } from "./loopController";
import { MemoryController } from "./memoryController";
import { makeApp, showJavaScript } from "./testHelpers";

/** A renderer that draws nothing and remembers every call. */
function recorder<S>() {
  const calls: { method: string; args: unknown[] }[] = [];
  const scenes: { scene: S; previous: S | null }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) =>
      void calls.push({ method, args });
  const renderer: Renderer<S> = {
    render: (scene, previous) => {
      scenes.push({ scene, previous });
      calls.push({ method: "render", args: [] });
    },
    showMessage: record("showMessage"),
    setViewport: record("setViewport"),
    hitTest: (): Hit | null => null,
    setAppearance: record("setAppearance"),
    addControl: (label, title, onClick) => {
      calls.push({ method: "addControl", args: [label, title] });
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", onClick);
      return button;
    },
    get viewport() {
      return { pan: { x: 0, y: 0 }, zoom: 1 };
    },
    toSVG: () => "<svg/>",
    dispose: record("dispose"),
  };
  return { renderer, calls, scenes, called: (method: string) => calls.filter((c) => c.method === method) };
}

function fakeRenderers() {
  const memory = recorder<MemoryScene>();
  const loop = recorder<LoopScene>();
  let moved = false;
  const memoryShown: MemoryLaidOut<Mark>[] = [];
  const loopShown: LoopLaidOut<Mark>[] = [];
  let memoryEvents: MemoryRendererEvents = {};
  let loopEvents: RendererEvents = {};
  const factory: RendererFactory = {
    memory(_el, events) {
      memoryEvents = events;
      const r: MemoryRenderer = {
        ...memory.renderer,
        layoutView: () => ({ positions: [], raise: null, simpleArrows: false, level: 0, budget: 64 }),
        show: (laidOut) => {
          memoryShown.push(laidOut);
          memory.calls.push({ method: "show", args: [] });
        },
        detailBudget: () => 64,
        resetLayout: () => {
          moved = false;
          memory.calls.push({ method: "resetLayout", args: [] });
        },
        get hasMovedBoxes() {
          return moved;
        },
        movedBoxes: new Map(),
        moveBoxes: () => {},
      };
      return r;
    },
    loop(_el, events) {
      loopEvents = events;
      const r: LoopRenderer = {
        ...loop.renderer,
        layoutView: () => ({
          vertical: false,
          fit: { level: 0, fitting: false, keep: false, fitW: 0, fitH: 0, viewW: 0, viewH: 0 },
          budget: 40_000,
        }),
        show: (laidOut, step) => {
          loopShown.push(laidOut);
          loop.calls.push({ method: "show", args: [step] });
        },
        setLayout: (layout) => loop.calls.push({ method: "setLayout", args: [layout] }) && undefined,
        detailBudget: () => 40_000,
      };
      return r;
    },
  };
  return {
    factory,
    memory,
    loop,
    memoryShown,
    loopShown,
    drag: () => {
      moved = true;
      memoryEvents.onLayoutChange?.();
    },
    autoFitChanged: (on: boolean) => {
      memoryEvents.onAutoFitChange?.({ on, mode: "out" });
      loopEvents.onAutoFitChange?.({ on, mode: "both" });
    },
  };
}

const STILL = { duration: 0, easing: "linear", enter: { fade: false, slide: false } };

function setup() {
  document.body.innerHTML = `
    <div id="memory"></div><div id="loop"></div><div id="loop-tabs"></div>
    <button id="mode-arrows"></button><button id="mode-nested"></button>
    <button id="sizes"></button><select id="size-model"></select>
    <button id="show-output"></button><button id="dim-output"></button><span id="memory-total"></span>
    <input id="hide-quiet" type="checkbox"><input id="loop-vertical" type="checkbox">
    <button id="loop-stacked"></button><button id="loop-animated"></button>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const { app, settings } = makeApp();
  const fakes = fakeRenderers();
  const memory = new MemoryController({
    app,
    settings,
    renderers: fakes.factory,
    els: {
      memory: $("memory"),
      modeArrows: $("mode-arrows"),
      modeNested: $("mode-nested"),
      sizes: $("sizes"),
      sizeModel: $("size-model"),
      showOutput: $("show-output"),
      dimOutput: $("dim-output"),
      memoryTotal: $("memory-total"),
    },
    animation: () => STILL,
    redraw: () => memory.render(),
  });
  const loop = new LoopController({
    app,
    settings,
    renderers: fakes.factory,
    els: {
      loop: $("loop"),
      loopTabs: $("loop-tabs"),
      hideQuiet: $("hide-quiet"),
      loopVertical: $("loop-vertical"),
      loopStacked: $("loop-stacked"),
      loopAnimated: $("loop-animated"),
    },
    sizes: () => null,
    animation: () => STILL,
    redraw: () => loop.render(),
  });
  return { app, settings, memory, loop, fakes, $ };
}

const CODE = "const nums = [3, 1, 2];\nfor (let i = 0; i < nums.length; i++) {\n  nums[i] *= 2;\n}\n";

describe("the memory window, through its renderer", () => {
  it("starts with Auto-fit on (nothing saved yet) and a Reset layout control", () => {
    const { fakes } = setup();
    expect(fakes.memory.called("setViewport")[0].args[0]).toEqual({ autoFit: { on: true, mode: "both" } });
    expect(fakes.memory.called("addControl").map((c) => c.args[0])).toEqual(["Reset layout"]);
  });

  it("hands over a drawing per step, laid out for the renderer's view, and its animation", async () => {
    const { app, memory, fakes } = setup();
    memory.showEmpty();
    expect(fakes.memory.called("showMessage")[0].args[0]).toMatch(/press Run/);
    await showJavaScript(app, CODE, 2);
    memory.render();
    await memory.drawn();
    app.setStep(3);
    memory.render();
    await memory.drawn();
    const [first, second] = fakes.memoryShown;
    expect(first.drawing).toBeInstanceOf(Mark);
    expect(second.drawing.querySelector(".node")).not.toBeNull();
    expect(second.drawing).not.toBe(first.drawing);
    expect(fakes.memory.called("setAppearance").at(-1)?.args[0]).toEqual({ step: STILL });
  });

  it("asked for two steps at once, shows only the last", async () => {
    const { app, memory, fakes } = setup();
    await showJavaScript(app, CODE, 2);
    memory.render();
    app.setStep(3);
    memory.render();
    app.setStep(4);
    memory.render();
    await memory.drawn();
    // The first was being laid out; the second was replaced by the third before its turn.
    expect(fakes.memoryShown).toHaveLength(2);
  });

  it("redraws when a box is dragged, and Reset layout puts it back", async () => {
    const { app, memory, fakes, $ } = setup();
    await showJavaScript(app, CODE);
    memory.render();
    const reset = [...$("memory").querySelectorAll("button")];
    expect(reset).toEqual([]); // the fake keeps its controls to itself
    await memory.drawn();
    const before = fakes.memoryShown.length;
    fakes.drag();
    await memory.drawn();
    expect(fakes.memoryShown.length).toBe(before + 1);
    memory.reset();
    expect(fakes.memory.called("resetLayout")).toHaveLength(1);
    expect(fakes.memory.called("setViewport").at(-1)?.args[0]).toEqual({ refit: true });
  });

  it("remembers Auto-fit when the person changes it", () => {
    const { settings, fakes } = setup();
    fakes.autoFitChanged(true);
    expect(JSON.parse(settings.autoFit("memory").get()!)).toEqual({ on: true, mode: "out" });
    expect(JSON.parse(settings.autoFit("loop").get()!)).toEqual({ on: true, mode: "both" });
  });
});

describe("the loop window, through its renderer", () => {
  it("draws the loop's scene, says when there's no loop, and passes the layout on", async () => {
    const { app, loop, fakes, $ } = setup();
    expect(fakes.loop.called("setLayout")[0].args[0]).toEqual({ vertical: false });
    await showJavaScript(app, CODE, 0);
    loop.render();
    await loop.drawn();
    expect(fakes.loopShown.at(-1)?.drawing).toBeNull();
    expect(fakes.loopShown.at(-1)?.message).toMatch(/enters a loop/);
    await showJavaScript(app, CODE, 6);
    loop.render();
    await loop.drawn();
    expect(fakes.loopShown.at(-1)?.drawing?.textContent).toContain("nums");
    expect(fakes.loop.called("show").at(-1)?.args[0]).toBe(true); // a step
    // A new step waiting to be laid out, replaced by a redraw for the view: that one is shown as the step.
    app.setStep(7);
    loop.render(); // laid out at once
    app.setStep(8);
    loop.render(); // waits...
    loop.render(false); // ...and is replaced by a redraw for the view
    await loop.drawn();
    expect(
      fakes.loop
        .called("show")
        .slice(-2)
        .map((c) => c.args[0]),
    ).toEqual([true, true]);
    const vertical = $<HTMLInputElement>("loop-vertical");
    vertical.checked = true;
    vertical.dispatchEvent(new Event("change"));
    expect(fakes.loop.called("setLayout").at(-1)?.args[0]).toEqual({ vertical: true });
    loop.showEmpty();
    expect(fakes.loop.called("showMessage").at(-1)?.args[0]).toBe("");
  });
});
