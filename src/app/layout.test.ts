// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BAR, columnsPreset, moveWindow, parseArrangement, stackedPreset } from "./arrangement";
import { expand, isMaximized, LayoutController, maximize, minimize, parseCollapsed } from "./layout";
import { makeApp } from "./testHelpers";

const controls = (name: string) =>
  `<button data-window="${name}" data-action="expand"></button><button data-window="${name}" data-action="minimize"></button><button data-window="${name}" data-action="maximize"></button>`;

function page() {
  document.body.innerHTML = `
    <main id="workspace"><section id="editor-pane">${controls("editor")}</section><div id="divider" tabindex="0"></div><section id="canvas-pane"><div id="loading-card"></div><div id="canvas"><section id="memory-section">${controls("memory")}</section><div id="canvas-divider" tabindex="0"></div><section id="loop-section">${controls("loop")}</section></div></section></main>
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
    loadingCard: $("loading-card"),
  };
  const click = (name: string, action: string) =>
    document.querySelector<HTMLButtonElement>(`[data-window="${name}"][data-action="${action}"]`)!.click();
  const place = (id: string) => [
    $(id).style.getPropertyValue("--grid-column"),
    $(id).style.getPropertyValue("--grid-row"),
  ];
  return {
    $,
    els,
    click,
    place,
    order: () => [...$("workspace").children].map((c) => c.id),
    canvasOrder: () => [...$("canvas").children].map((c) => c.id),
    folded: () =>
      ["editor-pane", "memory-section", "loop-section"].filter((id) => $(id).classList.contains("is-collapsed")),
  };
}

describe("LayoutController", () => {
  it("starts with the code beside memory over loop history, each window in its grid place", () => {
    const { els, place } = page();
    new LayoutController(els, makeApp().settings);
    // Row 1 is the banner's.
    expect(place("editor-pane")).toEqual(["1 / 2", "2 / 5"]);
    expect(place("memory-section")).toEqual(["3 / 4", "2 / 3"]);
    expect(place("loop-section")).toEqual(["3 / 4", "4 / 5"]);
    expect(place("divider")).toEqual(["2 / 3", "2 / 5"]);
    expect(place("canvas-divider")).toEqual(["3 / 4", "3 / 4"]);
    expect(place("loading-card")).toEqual(place("memory-section"));
    expect(els.workspace.style.getPropertyValue("--workspace-rows")).toBe("auto minmax(0, 55fr) 6px minmax(0, 45fr)");
    expect(els.divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(els.canvasDivider.getAttribute("aria-orientation")).toBe("horizontal");
    expect(els.canvasDivider.classList.contains("is-paper")).toBe(true);
  });

  it("starts from the layout saved before windows could move", () => {
    const { els } = page();
    const { settings } = makeApp();
    settings.split.set(30);
    settings.swapped.set(true);
    settings.layoutMode.set("columns");
    const layout = new LayoutController(els, settings);
    expect(layout.arrangement.items).toEqual(["memory", "loop", "editor"]);
    expect(layout.arrangement.weights.at(-1)).toBe(30);
  });

  it("mirrors the page with ⇄, in the page itself too (so Tab follows), and remembers it", () => {
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
    layout.toggleSwapped();

    const again = page();
    new LayoutController(again.els, makeApp(storage).settings);
    expect(again.order()).toEqual(["canvas-pane", "divider", "editor-pane"]);
  });

  it("switches to side by side and back with the layout button, keeping the code's side", () => {
    const { els } = page();
    const { settings, storage } = makeApp();
    const layout = new LayoutController(els, settings);
    els.swap.click();
    els.layoutMode.click();
    expect(layout.mode).toBe("columns");
    expect(layout.arrangement.items).toEqual(["memory", "loop", "editor"]);
    expect(els.layoutMode.getAttribute("aria-pressed")).toBe("true");
    expect(els.canvasDivider.getAttribute("aria-orientation")).toBe("vertical");
    els.layoutMode.click();
    expect(layout.mode).toBe("stacked");
    expect(layout.arrangement.items.at(-1)).toBe("editor");
    els.layoutMode.click();
    expect(new LayoutController(page().els, makeApp(storage).settings).mode).toBe("columns");
  });

  it("puts windows anywhere, in the page's tab order too", () => {
    const { els, place, canvasOrder, order } = page();
    const layout = new LayoutController(els, makeApp().settings);
    // Loop history on the left, then the code, then memory.
    layout.setArrangement({ ...columnsPreset(), items: ["loop", "editor", "memory"] });
    expect(place("loop-section")[0]).toBe("1 / 2");
    expect(place("editor-pane")[0]).toBe("3 / 4");
    expect(place("memory-section")[0]).toBe("5 / 6");
    expect(canvasOrder()).toEqual(["loop-section", "canvas-divider", "memory-section"]);
    expect(order()).toEqual(["canvas-pane", "divider", "editor-pane"]);
    // Neither divider is between memory and loop history now: neither takes the canvas's colors.
    expect(els.canvasDivider.classList.contains("is-paper")).toBe(false);
    expect(els.canvasDivider.getAttribute("aria-label")).toBe("Resize the code and memory");
  });
});

describe("dividers", () => {
  function setup() {
    const p = page();
    const { settings } = makeApp();
    const layout = new LayoutController(p.els, settings);
    layout.setArrangement({ ...stackedPreset(), weights: [40, 60], pairSplit: 50 });
    // The windows' places on the page: the code 0-400, the canvas 406-1006; memory 0-400, loop 406-806.
    const rect = (x: number, y: number, w: number, h: number) => () =>
      ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) as DOMRect;
    p.els.editorPane.getBoundingClientRect = rect(0, 0, 400, 806);
    p.els.memorySection.getBoundingClientRect = rect(406, 0, 600, 400);
    p.els.loopSection.getBoundingClientRect = rect(406, 406, 600, 400);
    for (const d of [p.els.divider, p.els.canvasDivider]) d.setPointerCapture = () => {};
    const pointer = (el: HTMLElement, type: string, clientX: number, clientY = 0) =>
      el.dispatchEvent(
        Object.assign(new MouseEvent(type, { button: 0, clientX, clientY, bubbles: true }), { pointerId: 1 }),
      );
    const key = (el: HTMLElement, k: string) => {
      const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event;
    };
    return { ...p, layout, settings, pointer, key };
  }

  it("follows the pointer while dragged, and resets on double-click", () => {
    const { els, layout, pointer, settings } = setup();
    pointer(els.divider, "pointerdown", 400);
    pointer(els.divider, "pointermove", 503); // half way along the code and the canvas
    expect(layout.arrangement.weights).toEqual([50, 50]);
    expect(els.divider.classList.contains("is-dragging")).toBe(true);
    pointer(els.divider, "pointerup", 503);
    pointer(els.divider, "pointermove", 100);
    expect(layout.arrangement.weights).toEqual([50, 50]);
    expect(parseArrangement(settings.arrangement.get())?.weights).toEqual([50, 50]);
    els.divider.dispatchEvent(new MouseEvent("dblclick"));
    expect(layout.arrangement.weights[0] / (layout.arrangement.weights[0] + layout.arrangement.weights[1])).toBeCloseTo(
      0.4,
    );
  });

  it("splits a pair: memory's share of the canvas", () => {
    const { els, layout, pointer } = setup();
    pointer(els.canvasDivider, "pointerdown", 0, 400);
    pointer(els.canvasDivider, "pointermove", 0, 605);
    expect(layout.arrangement.pairSplit).toBeCloseTo(75, 0);
    pointer(els.canvasDivider, "pointermove", 0, 2000);
    expect(layout.arrangement.pairSplit).toBe(90); // never all of it
  });

  it("moves with the arrow keys along its own axis, which then don't step the program", () => {
    const { els, layout, key } = setup();
    expect(key(els.divider, "ArrowRight").defaultPrevented).toBe(true);
    expect(layout.arrangement.weights[0]).toBeCloseTo(43);
    expect(key(els.divider, "ArrowDown").defaultPrevented).toBe(false); // not its axis
    key(els.canvasDivider, "ArrowUp");
    expect(layout.arrangement.pairSplit).toBe(47);
  });

  it("does nothing when one side is folded", () => {
    const { els, layout, key, click } = setup();
    click("editor", "minimize");
    expect(els.divider.classList.contains("is-inactive")).toBe(true);
    expect(els.divider.tabIndex).toBe(-1);
    key(els.divider, "ArrowRight");
    expect(layout.arrangement.weights).toEqual([40, 60]);
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

  it("maximizes, minimizes and opens windows from their buttons and bars, and remembers them", () => {
    const { els, click, folded } = page();
    const { settings, storage } = makeApp();
    new LayoutController(els, settings);
    click("memory", "maximize");
    expect(folded()).toEqual(["editor-pane", "loop-section"]);
    expect(els.divider.classList.contains("is-inactive")).toBe(true);
    const max = document.querySelector('[data-window="memory"][data-action="maximize"]')!;
    expect(max.getAttribute("aria-pressed")).toBe("true");
    expect(max.getAttribute("aria-label")).toBe("Restore all windows");
    click("loop", "expand"); // its bar
    expect(folded()).toEqual(["editor-pane"]);
    expect(els.workspace.style.getPropertyValue("--workspace-columns")).toBe(`${BAR}px 0px minmax(0, 60fr)`);
    click("loop", "minimize");
    expect(folded()).toEqual(["editor-pane", "loop-section"]);
    click("memory", "maximize"); // again: back to all three
    expect(folded()).toEqual([]);
    click("editor", "minimize");

    const again = page();
    new LayoutController(again.els, makeApp(storage).settings);
    expect(again.folded()).toEqual(["editor-pane"]);
  });

  it("stands a folded window's bar upright when its column folded", () => {
    const { els, $ } = page();
    const layout = new LayoutController(els, makeApp().settings);
    layout.setCollapsed(["loop"]);
    expect($("loop-section").classList.contains("is-upright")).toBe(false);
    layout.setArrangement(moveWindow(layout.arrangement, "loop", { edge: "right" }));
    expect($("loop-section").classList.contains("is-upright")).toBe(true);
    // The loading card covers loop history while memory is folded.
    layout.setCollapsed(["memory"]);
    expect($("loading-card").style.getPropertyValue("--grid-column")).toBe(
      $("loop-section").style.getPropertyValue("--grid-column"),
    );
  });
});
