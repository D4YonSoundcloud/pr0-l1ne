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
    <section id="editor"><button class="window-grip" data-dock="editor"></button><span data-dock="editor" data-dock-name>Code</span></section>
    <section id="memory"><button class="window-grip" data-dock="memory"></button><h2 data-dock="memory" data-dock-name>Memory</h2></section>
    <section id="loop"><button class="window-grip" data-dock="loop"></button><h2 data-dock="loop" data-dock-name>Loop history</h2></section>`;
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
  const grip = (w: WindowName) => document.querySelector<HTMLElement>(`.window-grip[data-dock="${w}"]`)!;
  for (const w of ["editor", "memory", "loop"] as const) grip(w).setPointerCapture = () => {};
  const pointer = (w: WindowName, type: string, x: number, y: number) =>
    grip(w).dispatchEvent(
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
