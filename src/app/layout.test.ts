// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  BAR,
  expand,
  isMaximized,
  LayoutController,
  layoutTracks,
  makeDivider,
  maximize,
  minimize,
  parseCollapsed,
} from "./layout";
import { makeApp } from "./testHelpers";

function divider(saved: number | null = null) {
  document.body.innerHTML = `<div id="box"><div id="divider" tabindex="0"></div></div>`;
  const box = document.getElementById("box")!;
  const el = document.getElementById("divider")!;
  box.getBoundingClientRect = () => ({ left: 100, top: 0, width: 1000, height: 500 }) as DOMRect;
  el.setPointerCapture = () => {};
  const { settings } = makeApp();
  if (saved !== null) settings.split.set(saved);
  const applied: number[] = [];
  let direction: 1 | -1 = 1;
  const set = makeDivider(el, {
    axis: "x",
    container: box,
    min: 20,
    max: 75,
    initial: 40,
    saved: settings.split,
    apply: (v) => applied.push(v),
    keyDirection: () => direction,
  });
  const key = (k: string) => {
    const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };
  const pointer = (type: string, clientX: number) =>
    el.dispatchEvent(Object.assign(new MouseEvent(type, { button: 0, clientX, bubbles: true }), { pointerId: 1 }));
  return { el, set, applied, settings, key, pointer, reverse: () => (direction = -1) };
}

describe("makeDivider", () => {
  it("starts where it was left, within its limits", () => {
    expect(divider(60).applied).toEqual([60]);
    expect(divider().applied).toEqual([40]);
    const { set, applied, el, settings } = divider();
    set(90);
    expect(applied.at(-1)).toBe(75);
    expect(el.getAttribute("aria-valuenow")).toBe("75");
    expect(settings.split.get()).toBe(75);
  });

  it("moves with the arrow keys, which then don't step the program", () => {
    const { key, applied, reverse } = divider(50);
    const event = key("ArrowRight");
    expect(applied.at(-1)).toBe(53);
    expect(event.defaultPrevented).toBe(true);
    reverse(); // e.g. the panes are swapped
    key("ArrowRight");
    expect(applied.at(-1)).toBe(50);
    key("ArrowUp"); // the other axis
    expect(applied).toHaveLength(3);
  });

  it("follows the pointer while dragged, and resets on double-click", () => {
    const { pointer, applied, el } = divider(50);
    pointer("pointerdown", 400);
    pointer("pointermove", 700); // 60% of the way along
    expect(applied.at(-1)).toBe(60);
    expect(el.classList.contains("is-dragging")).toBe(true);
    pointer("pointerup", 700);
    pointer("pointermove", 200);
    expect(applied.at(-1)).toBe(60);
    expect(el.classList.contains("is-dragging")).toBe(false);
    el.dispatchEvent(new MouseEvent("dblclick"));
    expect(applied.at(-1)).toBe(40);
  });
});

const controls = (name: string) =>
  `<button data-window="${name}" data-action="expand"></button><button data-window="${name}" data-action="minimize"></button><button data-window="${name}" data-action="maximize"></button>`;

function page() {
  document.body.innerHTML = `
    <main id="workspace"><section id="editor-pane">${controls("editor")}</section><div id="divider"></div><section id="canvas-pane"><div id="canvas"><section id="memory-section">${controls("memory")}</section><div id="canvas-divider"></div><section id="loop-section">${controls("loop")}</section></div></section></main>
    <button id="swap"></button><button id="layout-mode"></button>`;
  const $ = (id: string) => document.getElementById(id)!;
  const els = {
    workspace: $("workspace"),
    editorPane: $("editor-pane"),
    canvasPane: $("canvas-pane"),
    divider: $("divider"),
    canvas: $("canvas"),
    canvasDivider: $("canvas-divider"),
    swap: $("swap") as HTMLButtonElement,
    layoutMode: $("layout-mode") as HTMLButtonElement,
    memorySection: $("memory-section"),
    loopSection: $("loop-section"),
  };
  const click = (name: string, action: string) =>
    document.querySelector<HTMLButtonElement>(`[data-window="${name}"][data-action="${action}"]`)!.click();
  return {
    $,
    els,
    click,
    order: () => [...$("workspace").children].map((c) => c.id),
    folded: () =>
      ["editor-pane", "memory-section", "loop-section"].filter((id) => $(id).classList.contains("is-collapsed")),
  };
}

describe("LayoutController", () => {
  it("applies the saved splits", () => {
    const { els } = page();
    const { settings } = makeApp();
    settings.split.set(30);
    new LayoutController(els, settings);
    expect(els.workspace.style.getPropertyValue("--split")).toBe("30%");
    expect(els.canvas.style.getPropertyValue("--canvas-split")).toBe("55%");
  });

  it("swaps the panes in the page itself (so Tab follows), and remembers it", () => {
    const { els, order } = page();
    const { settings, storage } = makeApp();
    const layout = new LayoutController(els, settings);
    expect(order()).toEqual(["editor-pane", "divider", "canvas-pane"]);
    els.swap.click();
    expect(order()).toEqual(["canvas-pane", "divider", "editor-pane"]);
    expect(els.workspace.classList.contains("is-swapped")).toBe(true);
    expect(els.swap.getAttribute("aria-pressed")).toBe("true");
    layout.toggleSwapped();
    expect(order()).toEqual(["editor-pane", "divider", "canvas-pane"]);
    layout.setSwapped(true);

    const again = page();
    new LayoutController(again.els, makeApp(storage).settings);
    expect(again.order()).toEqual(["canvas-pane", "divider", "editor-pane"]);
  });
});

describe("folding windows", () => {
  it("maximizes one window by folding the other two, and minimizes one at a time", () => {
    expect(maximize("memory")).toEqual(["editor", "loop"]);
    expect(minimize([], "loop")).toEqual(["loop"]);
    expect(minimize(["loop"], "editor")).toEqual(["editor", "loop"]);
    // The last window open: the other two open instead.
    expect(minimize(["editor", "loop"], "memory")).toEqual(["memory"]);
    expect(expand(["editor", "loop"], "loop")).toEqual(["editor"]);
    expect(isMaximized(["editor", "loop"], "memory")).toBe(true);
    expect(isMaximized(["loop"], "memory")).toBe(false);
  });

  it("reads what was saved, never folding all three", () => {
    expect(parseCollapsed("loop, memory")).toEqual(["memory", "loop"]);
    expect(parseCollapsed("editor,memory,loop")).toEqual([]);
    expect(parseCollapsed("nonsense")).toEqual([]);
    expect(parseCollapsed(null)).toEqual([]);
  });
});

describe("layoutTracks", () => {
  it("stacks memory over loop history beside the code, or puts all three side by side", () => {
    const stacked = layoutTracks("stacked", [], false);
    expect(stacked.workspace).toBe("minmax(0, var(--split)) 6px minmax(0, 1fr)");
    expect(stacked.canvas).toBe("minmax(0, var(--canvas-split)) 6px minmax(0, 1fr)");
    expect(stacked.upright).toEqual({ editor: true, memory: false, loop: false });
    expect(layoutTracks("columns", [], false).upright).toEqual({ editor: true, memory: true, loop: true });
    expect(layoutTracks("stacked", [], true).workspace).toBe("minmax(0, 1fr) 6px minmax(0, var(--split))");
  });

  it("gives a folded window a bar, and its room to the others", () => {
    const code = layoutTracks("stacked", ["editor"], false);
    expect(code.workspace).toBe(`${BAR}px 0 minmax(0, 1fr)`);
    expect(code.divider).toBe(false);
    const loop = layoutTracks("stacked", ["loop"], false);
    expect(loop.canvas).toBe(`minmax(0, 1fr) 0 ${BAR}px`);
    expect(loop.canvasDivider).toBe(false);
    // Both canvas windows folded: a strip of bars, two wide side by side.
    const canvas = layoutTracks("columns", ["memory", "loop"], true);
    expect(canvas.workspace).toBe(`${2 * BAR}px 0 minmax(0, 1fr)`);
    expect(canvas.canvas).toBe(`${BAR}px 0 ${BAR}px`);
    expect(layoutTracks("stacked", ["memory", "loop"], false).upright.memory).toBe(true);
  });
});

describe("LayoutController's windows", () => {
  it("switches to side by side, with the canvas divider upright and its own remembered split", () => {
    const { els } = page();
    const { settings, storage } = makeApp();
    settings.canvasSplit.set(70);
    const layout = new LayoutController(els, settings);
    expect(els.canvasDivider.getAttribute("aria-orientation")).toBe("horizontal");
    els.layoutMode.click();
    expect(layout.mode).toBe("columns");
    expect(els.layoutMode.getAttribute("aria-pressed")).toBe("true");
    expect(els.canvas.classList.contains("is-columns")).toBe(true);
    expect(els.canvasDivider.getAttribute("aria-orientation")).toBe("vertical");
    expect(els.canvas.style.getPropertyValue("--canvas-split")).toBe("50%");
    expect(els.canvas.style.getPropertyValue("--canvas-columns")).toContain("var(--canvas-split)");
    expect(els.canvas.style.getPropertyValue("--canvas-rows")).toBe("minmax(0, 1fr)");
    layout.setMode("stacked");
    expect(els.canvas.style.getPropertyValue("--canvas-split")).toBe("70%");

    layout.setMode("columns");
    const again = page();
    expect(new LayoutController(again.els, makeApp(storage).settings).mode).toBe("columns");
  });

  it("maximizes, minimizes and opens windows from their buttons and bars, and remembers them", () => {
    const { els, click, folded } = page();
    const { settings, storage } = makeApp();
    new LayoutController(els, settings);
    click("memory", "maximize");
    expect(folded()).toEqual(["editor-pane", "loop-section"]);
    expect(els.divider.classList.contains("is-inactive")).toBe(true);
    expect(els.divider.tabIndex).toBe(-1);
    const max = document.querySelector('[data-window="memory"][data-action="maximize"]')!;
    expect(max.getAttribute("aria-pressed")).toBe("true");
    expect(max.getAttribute("aria-label")).toBe("Restore all windows");
    click("loop", "expand"); // its bar
    expect(folded()).toEqual(["editor-pane"]);
    expect(els.workspace.style.getPropertyValue("--workspace-columns")).toBe(`${BAR}px 0 minmax(0, 1fr)`);
    click("loop", "minimize");
    expect(folded()).toEqual(["editor-pane", "loop-section"]);
    click("memory", "maximize"); // again: back to all three
    expect(folded()).toEqual([]);
    click("editor", "minimize");

    const again = page();
    new LayoutController(again.els, makeApp(storage).settings);
    expect(again.folded()).toEqual(["editor-pane"]);
  });
});
