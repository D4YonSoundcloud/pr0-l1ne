// @vitest-environment jsdom
/**
 * How tall the Output and Changes panel is (consoleSize.ts): dragged by
 * its top edge (up is taller), moved with the keys on it, kept between
 * the least and the most there's room for, remembered, and back to the
 * default on a double-click.
 */
import { describe, expect, it } from "vitest";
import { ConsoleSize, DEFAULT_CONSOLE_HEIGHT, MIN_CONSOLE_HEIGHT } from "./consoleSize";
import { makeApp, memoryStorage } from "./testHelpers";

function setup(storage = memoryStorage()) {
  document.body.innerHTML = `<section id="pane"><div id="console"><div id="grip"></div></div></section>`;
  const $ = (id: string) => document.getElementById(id)!;
  const pane = $("pane");
  Object.defineProperty(pane, "clientHeight", { value: 600 });
  const grip = $("grip");
  grip.setPointerCapture = () => {};
  const { settings } = makeApp(storage);
  const size = new ConsoleSize({ settings, els: { console: $("console"), consoleGrip: grip, editorPane: pane } });
  return { size, grip, settings, storage };
}

const pointer = (type: string, clientY: number) =>
  Object.assign(new MouseEvent(type, { clientY, button: 0 }), { pointerId: 1 }) as unknown as PointerEvent;

describe("the Output and Changes panel's height", () => {
  it("starts at the default; dragging its top edge up makes it taller, and it's remembered", () => {
    const { size, grip, storage } = setup();
    expect(size.height()).toBe(DEFAULT_CONSOLE_HEIGHT);
    grip.dispatchEvent(pointer("pointerdown", 500));
    grip.dispatchEvent(pointer("pointermove", 400));
    expect(size.height()).toBe(DEFAULT_CONSOLE_HEIGHT + 100);
    grip.dispatchEvent(pointer("pointerup", 400));
    expect(setup(storage).size.height()).toBe(DEFAULT_CONSOLE_HEIGHT + 100);
  });

  it("keeps between the least and the most there's room for, moves with the keys, and resets on a double-click", () => {
    const { size, grip, settings } = setup();
    size.set(10, true);
    expect(size.height()).toBe(MIN_CONSOLE_HEIGHT);
    size.set(10_000, true);
    expect(size.height()).toBe(600 - 120); // room left for the code
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(size.height()).toBe(600 - 120 - 16);
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(size.height()).toBe(MIN_CONSOLE_HEIGHT);
    grip.dispatchEvent(new MouseEvent("dblclick"));
    expect(size.height()).toBe(DEFAULT_CONSOLE_HEIGHT);
    expect(settings.consoleHeight.get()).toBeNull();
  });
});
