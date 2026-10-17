// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { LayoutController, makeDivider } from "./layout";
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

function page() {
  document.body.innerHTML = `
    <main id="workspace"><section id="editor-pane"></section><div id="divider"></div><section id="canvas-pane"><div id="canvas"><div id="canvas-divider"></div></div></section></main>
    <button id="swap"></button>`;
  const $ = (id: string) => document.getElementById(id)!;
  return {
    $,
    els: {
      workspace: $("workspace"),
      editorPane: $("editor-pane"),
      canvasPane: $("canvas-pane"),
      divider: $("divider"),
      canvas: $("canvas"),
      canvasDivider: $("canvas-divider"),
      swap: $("swap") as HTMLButtonElement,
    },
    order: () => [...$("workspace").children].map((c) => c.id),
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
