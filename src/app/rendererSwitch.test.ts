// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LoopScene } from "../scene/loopScene";
import type { MemoryScene } from "../scene/memoryScene";
import type {
  AutoFit,
  LoopRenderer,
  MemoryRenderer,
  MemoryRendererEvents,
  Point,
  RendererFactory,
  RendererStyle,
  ViewportChange,
} from "../scene/renderer";
import { RendererSwitch } from "./rendererSwitch";

/** A renderer of a named kind that remembers what it's told. */
class Fake implements MemoryRenderer, LoopRenderer {
  calls: [string, ...unknown[]][] = [];
  disposed = false;
  view = { pan: { x: 0, y: 0 }, zoom: 1 };
  moved = new Map<string, Point>();
  controls: HTMLElement;
  ready?: Promise<void>;

  constructor(
    readonly kind: string,
    readonly el: HTMLElement,
    readonly events: MemoryRendererEvents,
  ) {
    this.controls = document.createElement("div");
    el.append(this.controls);
  }
  render(scene: unknown, previous: unknown) {
    this.calls.push(["render", scene, previous]);
  }
  showMessage(text: string) {
    this.calls.push(["showMessage", text]);
  }
  setViewport(change: ViewportChange) {
    this.calls.push(["setViewport", change]);
    if (change.pan) this.view = { ...this.view, pan: change.pan };
    if (change.zoom !== undefined) this.view = { ...this.view, zoom: change.zoom };
  }
  get viewport() {
    return this.view;
  }
  hitTest() {
    return { kind: "background" as const };
  }
  setAppearance(style: RendererStyle) {
    this.calls.push(["setAppearance", style]);
  }
  addControl(label: string) {
    const button = document.createElement("button");
    button.textContent = `${this.kind}:${label}`;
    this.controls.prepend(button);
    return button;
  }
  toSVG() {
    return `<svg data-kind="${this.kind}"/>`;
  }
  dispose() {
    this.disposed = true;
    this.controls.remove();
  }
  resetLayout() {
    this.moved.clear();
  }
  get hasMovedBoxes() {
    return this.moved.size > 0;
  }
  get movedBoxes() {
    return this.moved;
  }
  moveBoxes(positions: ReadonlyMap<string, Point>) {
    this.moved = new Map(positions);
  }
  setLayout(layout: { vertical: boolean }) {
    this.calls.push(["setLayout", layout]);
  }
  called(name: string) {
    return this.calls.filter((c) => c[0] === name);
  }
}

function kinds() {
  const made: Fake[] = [];
  const factory = (kind: string, ready?: () => Promise<void>): RendererFactory => ({
    memory: (el, events) => {
      const r = new Fake(kind, el, events);
      if (ready) r.ready = ready();
      made.push(r);
      return r;
    },
    loop: (el, events) => {
      const r = new Fake(kind, el, events);
      if (ready) r.ready = ready();
      made.push(r);
      return r;
    },
  });
  return { made, factory };
}

const scene = (n: number) => ({ n }) as unknown as MemoryScene;

describe("RendererSwitch", () => {
  it("passes every call to the renderer underneath", () => {
    const { made, factory } = kinds();
    const sw = new RendererSwitch(
      { svg: () => factory("svg"), canvas: () => factory("canvas") },
      { kind: "svg", factory: factory("svg") },
    );
    const el = document.createElement("div");
    const memory = sw.factory.memory(el, {});
    const inner = made[0];
    memory.render(scene(1), null);
    memory.showMessage("hi");
    memory.setViewport({ zoom: 2 });
    memory.setAppearance({ gridSize: 10 });
    expect(inner.calls.map((c) => c[0])).toEqual(["render", "showMessage", "setViewport", "setAppearance"]);
    expect(memory.viewport.zoom).toBe(2);
    expect(memory.hitTest(0, 0)).toEqual({ kind: "background" });
    expect(memory.toSVG()).toBe('<svg data-kind="svg"/>');
    memory.moveBoxes(new Map([["a", { x: 1, y: 2 }]]));
    expect(memory.hasMovedBoxes).toBe(true);
    expect(memory.movedBoxes.get("a")).toEqual({ x: 1, y: 2 });
    memory.resetLayout();
    expect(memory.hasMovedBoxes).toBe(false);
    expect(memory.ready).toBeUndefined();
    expect(sw.active).toBe("svg");
    memory.dispose();
    expect(inner.disposed).toBe(true);
  });

  it("swaps every window's renderer, and it looks just as it did", async () => {
    const { made, factory } = kinds();
    const sw = new RendererSwitch(
      { svg: () => factory("svg"), canvas: async () => factory("canvas") },
      { kind: "svg", factory: factory("svg") },
    );
    const memEl = document.createElement("div");
    const loopEl = document.createElement("div");
    const memory = sw.factory.memory(memEl, {});
    const loop = sw.factory.loop(loopEl, {});
    const reset = memory.addControl("Reset layout", "t", () => {});
    reset.hidden = true;
    const save = memory.addControl("Save SVG", "t", () => {});
    const step = { duration: 200, easing: "ease", enter: { fade: true, slide: false } };
    memory.setAppearance({ step, gridSize: 30 });
    memory.setAppearance({ zoom: { duration: 100, easing: "linear" } });
    memory.setViewport({ pan: { x: 5, y: 6 }, zoom: 1.5 });
    memory.moveBoxes(new Map([["box", { x: 9, y: 9 }]]));
    memory.render(scene(7), scene(6));
    loop.setLayout({ vertical: true });
    loop.showMessage("No loop here");

    await sw.use("canvas");
    expect(sw.active).toBe("canvas");
    const [oldMemory, oldLoop, newMemory, newLoop] = made;
    expect(oldMemory.disposed && oldLoop.disposed).toBe(true);
    expect([newMemory.kind, newLoop.kind]).toEqual(["canvas", "canvas"]);
    // The Style panel's settings, the view, dragged boxes...
    expect(newMemory.called("setAppearance")[0][1]).toEqual({
      step,
      gridSize: 30,
      zoom: { duration: 100, easing: "linear" },
    });
    expect(newMemory.called("setViewport")).toEqual([["setViewport", { pan: { x: 5, y: 6 }, zoom: 1.5 }]]);
    expect(newMemory.movedBoxes.get("box")).toEqual({ x: 9, y: 9 });
    // ...the same buttons (the app keeps hold of them), in the same order...
    expect([...newMemory.controls.children]).toEqual([save, reset]);
    expect(reset.hidden).toBe(true);
    // ...and what was drawn, drawn again without animating.
    const [, , redraw, restore] = newMemory.calls;
    expect(redraw).toEqual([
      "setAppearance",
      { step: { duration: 0, easing: "linear", enter: { fade: false, slide: false } } },
    ]);
    expect(restore).toEqual(["render", scene(7), null]);
    expect(newMemory.calls[4]).toEqual(["setAppearance", { step }]);
    expect(newLoop.called("setLayout")).toEqual([["setLayout", { vertical: true }]]);
    expect(newLoop.called("showMessage")).toEqual([["showMessage", "No loop here"]]);
    // Picking the same kind again does nothing.
    await sw.use("canvas");
    expect(made).toHaveLength(4);
  });

  it("keeps Auto-fit, and lets it place the view", async () => {
    const { made, factory } = kinds();
    const sw = new RendererSwitch(
      { svg: () => factory("svg"), canvas: () => factory("canvas") },
      { kind: "svg", factory: factory("svg") },
    );
    const remembered: AutoFit[] = [];
    const memory = sw.factory.memory(document.createElement("div"), { onAutoFitChange: (s) => remembered.push(s) });
    memory.setViewport({ autoFit: { on: false, mode: "out" } });
    // The person turns Auto-fit on in the window: the app hears, and so does the switch.
    made[0].events.onAutoFitChange?.({ on: true, mode: "both" });
    expect(remembered).toEqual([{ on: true, mode: "both" }]);
    await sw.use("canvas");
    expect(made[1].called("setViewport")).toEqual([["setViewport", { autoFit: { on: true, mode: "both" } }]]);
    // Nothing drawn yet: nothing to draw again.
    expect(made[1].called("render")).toEqual([]);
  });

  it("goes back to what was there if the new renderer can't start", async () => {
    const { made, factory } = kinds();
    const sw = new RendererSwitch(
      { svg: () => factory("svg"), canvas: () => factory("canvas", () => Promise.reject(new Error("no canvas"))) },
      { kind: "svg", factory: factory("svg") },
    );
    const memory = sw.factory.memory(document.createElement("div"), {});
    memory.render(scene(1), null);
    await expect(sw.use("canvas")).rejects.toThrow("no canvas");
    expect(sw.active).toBe("svg");
    expect(made.map((r) => r.kind)).toEqual(["svg", "canvas", "svg"]);
    expect(made[2].called("render")).toEqual([["render", scene(1), null]]);
  });

  it("a second pick while the first is loading wins", async () => {
    const { made, factory } = kinds();
    let finish: (f: RendererFactory) => void = () => {};
    const sw = new RendererSwitch(
      { svg: () => factory("svg"), canvas: () => new Promise<RendererFactory>((r) => (finish = r)) },
      { kind: "svg", factory: factory("svg") },
    );
    sw.factory.loop(document.createElement("div"), {}).render({} as LoopScene, null);
    const slow = sw.use("canvas");
    await sw.use("svg"); // already svg: nothing to do, but the canvas pick is stale now
    finish(factory("canvas"));
    await slow;
    expect(sw.active).toBe("svg");
    expect(made).toHaveLength(1);
  });

  it("a failure that's been overtaken doesn't undo the newer pick", async () => {
    const { made, factory } = kinds();
    let fail: (e: Error) => void = () => {};
    const sw = new RendererSwitch(
      {
        svg: () => factory("svg"),
        canvas: () => factory("canvas", () => new Promise<void>((_, reject) => (fail = reject))),
      },
      { kind: "svg", factory: factory("svg") },
    );
    sw.factory.memory(document.createElement("div"), {});
    const first = sw.use("canvas");
    await Promise.resolve();
    await Promise.resolve();
    const second = sw.use("svg");
    await second;
    fail(new Error("late"));
    await expect(first).rejects.toThrow("late");
    expect(sw.active).toBe("svg");
    expect(made.map((r) => r.kind)).toEqual(["svg", "canvas", "svg"]);
  });
});
