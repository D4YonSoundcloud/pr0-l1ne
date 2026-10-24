// @vitest-environment jsdom
/**
 * The controllers draw only through the renderer contract (scene/renderer.ts):
 * given renderers that just record what they're asked, everything still
 * works. This is what a canvas, WebGL or WebGPU renderer will be plugged
 * into.
 */
import { describe, expect, it } from "vitest";
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
  let memoryEvents: MemoryRendererEvents = {};
  let loopEvents: RendererEvents = {};
  const factory: RendererFactory = {
    memory(_el, events) {
      memoryEvents = events;
      const r: MemoryRenderer = {
        ...memory.renderer,
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
        setLayout: (layout) => loop.calls.push({ method: "setLayout", args: [layout] }) && undefined,
      };
      return r;
    },
  };
  return {
    factory,
    memory,
    loop,
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

  it("hands over a scene per step, with the one before it, and its animation", async () => {
    const { app, memory, fakes } = setup();
    memory.showEmpty();
    expect(fakes.memory.called("showMessage")[0].args[0]).toMatch(/press Run/);
    await showJavaScript(app, CODE, 2);
    memory.render();
    app.setStep(3);
    memory.render();
    const [first, second] = fakes.memory.scenes;
    expect(first.previous).toBeNull();
    expect(second.previous).toBe(first.scene);
    expect(second.scene.stepIndex).toBe(3);
    expect(fakes.memory.called("setAppearance").at(-1)?.args[0]).toEqual({ step: STILL });
  });

  it("redraws when a box is dragged, and Reset layout puts it back", async () => {
    const { app, memory, fakes, $ } = setup();
    await showJavaScript(app, CODE);
    memory.render();
    const reset = [...$("memory").querySelectorAll("button")];
    expect(reset).toEqual([]); // the fake keeps its controls to itself
    const before = fakes.memory.scenes.length;
    fakes.drag();
    expect(fakes.memory.scenes.length).toBe(before + 1);
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
    expect(fakes.loop.called("showMessage").at(-1)?.args[0]).toMatch(/enters a loop/);
    await showJavaScript(app, CODE, 6);
    loop.render();
    expect(fakes.loop.scenes.at(-1)?.scene.containers).toEqual(["nums"]);
    const vertical = $<HTMLInputElement>("loop-vertical");
    vertical.checked = true;
    vertical.dispatchEvent(new Event("change"));
    expect(fakes.loop.called("setLayout").at(-1)?.args[0]).toEqual({ vertical: true });
    loop.showEmpty();
    expect(fakes.loop.called("showMessage").at(-1)?.args[0]).toBe("");
  });
});
