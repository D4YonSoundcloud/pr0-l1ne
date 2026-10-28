// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { type Arrangement, order, stackedPreset, type WindowName } from "./arrangement";
import { WindowDocking } from "./docking";

/**
 * The default arrangement on a 1000 × 800 page: the code 0-400 wide, memory
 * over loop history beside it (each 400 high).
 */
function setup(options: { wide?: boolean } = {}) {
  document.body.innerHTML = `
    <section id="editor"><div class="head" data-dock="editor"><button class="window-grip"></button><span data-dock-name>Code</span></div></section>
    <section id="memory"><div class="head" data-dock="memory"><button class="window-grip"></button><h2 data-dock-name>Memory</h2><button class="tool">Arrows</button><label><input type="checkbox"> Sizes</label></div></section>
    <section id="loop"><div class="head" data-dock="loop"><button class="window-grip"></button><h2 data-dock-name>Loop history</h2></div></section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const windows = { editor: $("editor"), memory: $("memory"), loop: $("loop") };
  const rect = (x: number, y: number, w: number, h: number) => () =>
    ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y }) as DOMRect;
  windows.editor.getBoundingClientRect = rect(0, 0, 400, 800);
  windows.memory.getBoundingClientRect = rect(400, 0, 600, 400);
  windows.loop.getBoundingClientRect = rect(400, 400, 600, 400);
  let arrangement: Arrangement = stackedPreset();
  const moves: Arrangement[] = [];
  const said: string[] = [];
  const docking = new WindowDocking({
    layout: {
      get arrangement() {
        return arrangement;
      },
      collapsed: [],
      windows,
      setArrangement(next) {
        arrangement = next;
        moves.push(next);
      },
    },
    announce: (text) => said.push(text),
    reducedMotion: () => true,
    wide: () => options.wide ?? true,
  });
  const grip = (w: WindowName) => document.querySelector<HTMLElement>(`#${w} .window-grip`)!;
  const head = (w: WindowName) => document.querySelector<HTMLElement>(`[data-dock="${w}"]`)!;
  for (const w of ["editor", "memory", "loop"] as const) head(w).setPointerCapture = () => {};
  /** A pointer event on a window's grip (or another part of its header). */
  const pointer = (w: WindowName, type: string, x: number, y: number, on: Element = grip(w)) =>
    on.dispatchEvent(
      Object.assign(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }), {
        pointerId: 1,
      }),
    );
  const previewBox = () => {
    const s = docking.preview.style;
    return [s.left, s.top, s.width, s.height].map((v) => Number.parseFloat(v));
  };
  return { docking, pointer, previewBox, moves, said, grip, arrangement: () => arrangement };
}

describe("dragging a window", () => {
  it("shows where it would go, and moves it there on drop", () => {
    const { docking, pointer, previewBox, moves, said, arrangement } = setup();
    pointer("memory", "pointerdown", 450, 10);
    expect(docking.preview.hidden).toBe(true); // a press isn't a drag yet
    pointer("memory", "pointermove", 460, 20);
    expect(docking.preview.hidden).toBe(false);
    // It starts on the window itself...
    expect(previewBox()).toEqual([400, 0, 600, 400]);
    expect(document.body.classList.contains("is-docking")).toBe(true);
    // ...and goes to the left of the code: a third of the page's width on the left.
    pointer("memory", "pointermove", 60, 400);
    expect(docking.preview.classList.contains("is-target")).toBe(true);
    expect(docking.preview.textContent).toBe("left of Code");
    const [x, y, , h] = previewBox();
    expect([x, y, h]).toEqual([0, 0, 800]);
    pointer("memory", "pointerup", 60, 400);
    expect(docking.preview.hidden).toBe(true);
    expect(document.body.classList.contains("is-docking")).toBe(false);
    expect(moves).toHaveLength(1);
    expect(order(arrangement())).toEqual(["memory", "editor", "loop"]);
    expect(said).toEqual(["Memory moved left of Code."]);
  });

  it("goes back to the window over itself, and changes nothing dropped there", () => {
    const { pointer, previewBox, moves, docking } = setup();
    pointer("memory", "pointerdown", 450, 10);
    pointer("memory", "pointermove", 200, 400);
    pointer("memory", "pointermove", 700, 200);
    expect(previewBox()).toEqual([400, 0, 600, 400]);
    expect(docking.preview.classList.contains("is-target")).toBe(false);
    pointer("memory", "pointerup", 700, 200);
    expect(moves).toEqual([]);
  });

  it("is cancelled with Escape", () => {
    const { pointer, moves, docking } = setup();
    pointer("loop", "pointerdown", 450, 410);
    pointer("loop", "pointermove", 60, 400);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(docking.preview.hidden).toBe(true);
    pointer("loop", "pointerup", 60, 400);
    expect(moves).toEqual([]);
  });

  it("swaps two windows dropped in the middle of one", () => {
    const { pointer, arrangement } = setup();
    pointer("editor", "pointerdown", 10, 10);
    pointer("editor", "pointermove", 700, 600);
    pointer("editor", "pointerup", 700, 600);
    expect(order(arrangement())).toEqual(["loop", "memory", "editor"]);
  });

  it("does nothing on a phone, which has its own layout", () => {
    const { pointer, moves, docking } = setup({ wide: false });
    pointer("memory", "pointerdown", 450, 10);
    pointer("memory", "pointermove", 60, 400);
    expect(docking.preview.hidden).toBe(true);
    pointer("memory", "pointerup", 60, 400);
    expect(moves).toEqual([]);
  });
});

describe("where a drag starts", () => {
  it("anywhere on the header: its name, its background", () => {
    const { pointer, arrangement } = setup();
    const name = document.querySelector("#memory h2")!;
    pointer("memory", "pointerdown", 450, 10, name);
    pointer("memory", "pointermove", 60, 400, name);
    pointer("memory", "pointerup", 60, 400, name);
    expect(order(arrangement())).toEqual(["memory", "editor", "loop"]);
  });

  it("not on the header's own controls, which work as usual", () => {
    const { pointer, moves, docking } = setup();
    for (const control of [document.querySelector("#memory .tool")!, document.querySelector("#memory input")!]) {
      pointer("memory", "pointerdown", 450, 10, control);
      pointer("memory", "pointermove", 60, 400, control);
      expect(docking.preview.hidden).toBe(true);
      pointer("memory", "pointerup", 60, 400, control);
    }
    expect(moves).toEqual([]);
  });
});

describe("moving a window from the keyboard", () => {
  it("moves it to the edge of the page an arrow key points to", () => {
    const { grip, arrangement, said } = setup();
    const press = (key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      grip("loop").dispatchEvent(event);
      return event;
    };
    expect(press("ArrowUp").defaultPrevented).toBe(true); // and doesn't step the program
    expect(arrangement().dir).toBe("column");
    expect(order(arrangement())[0]).toBe("loop");
    expect(said.at(-1)).toBe("Loop history moved along the top edge.");
    press("ArrowUp");
    expect(said.at(-1)).toBe("Loop history is already along the top edge.");
  });
});
