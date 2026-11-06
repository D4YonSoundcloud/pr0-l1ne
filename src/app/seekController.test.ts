// @vitest-environment jsdom
/**
 * Run to a line (seekController.ts): the switch in the code window's
 * header turns it on and off, and is remembered; each line that ran says
 * whether there's a step at it before this one (◀) and after (▶), as the
 * step moves; ◀ and ▶ go there; and Ctrl + F10 at the cursor says why
 * when it can't go anywhere (◀ and ▶ never do: they're dimmed instead).
 */
import { describe, expect, it } from "vitest";
import type { RunnableLine } from "../editor";
import { SeekController } from "./seekController";
import { makeApp, memoryStorage, showJavaScript } from "./testHelpers";

const CODE = `let total = 0;
for (let i = 0; i < 3; i++) {
  total += i;
}
console.log(total);
`;

function setup(storage = memoryStorage()) {
  const { app, settings } = makeApp(storage);
  const runnable: (Map<number, RunnableLine> | null)[] = [];
  const on: boolean[] = [];
  const messages: [number, string][] = [];
  let click: (line: number, back: boolean) => void = () => {};
  let cursor: number | null = 3;
  const toggle = document.createElement("button");
  const seek = new SeekController({
    app,
    settings,
    toggle,
    editor: {
      setRunToLine: (value) => on.push(value),
      setRunnable: (lines) => runnable.push(lines),
      onGutterClick: (handler) => {
        click = handler;
      },
      showMessage: (line, text) => messages.push([line, text]),
      cursorLine: () => cursor,
    },
    goTo: (step) => app.setStep(step),
    firstStep: () => 2,
  });
  return {
    app,
    seek,
    toggle,
    on,
    storage,
    lines: () => runnable.at(-1),
    messages,
    click: (line: number, back = false) => click(line, back),
    setCursor: (line: number | null) => {
      cursor = line;
    },
  };
}

describe("run to a line", () => {
  it("is on until it's switched off in the code window's header, and stays as it was left", () => {
    const { toggle, on, storage } = setup();
    expect(on).toEqual([true]);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    expect(on.at(-1)).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(setup(storage).on).toEqual([false]);
  });

  it("says, for each line that ran, whether a step at it comes before this one and after, as the step moves", async () => {
    const { app, lines } = setup();
    const trace = await showJavaScript(app, CODE, 2);
    const at3 = [...Array(trace.steps).keys()].filter((i) => trace.lines[i] === 3 && trace.events[i] === "line");
    expect(lines()!.get(3)).toEqual({ back: false, next: true, steps: 3 });
    expect(lines()!.has(4)).toBe(false); // the closing brace never runs
    app.setStep(at3[1]);
    expect(lines()!.get(3)).toEqual({ back: true, next: true, steps: 3 });
    app.setStep(at3[2]);
    expect(lines()!.get(3)).toEqual({ back: true, next: false, steps: 3 });
    app.markStale();
    expect(lines()).toBeNull();
  });

  it("◀ and ▶ go to the step before and after at the line; nothing, quietly, when there's none", async () => {
    const { app, click, messages } = setup();
    const trace = await showJavaScript(app, CODE, 2);
    const at3 = [...Array(trace.steps).keys()].filter((i) => trace.lines[i] === 3 && trace.events[i] === "line");
    click(3);
    expect(app.get().stepIndex).toBe(at3[0]);
    click(3);
    expect(app.get().stepIndex).toBe(at3[1]);
    click(3, true);
    expect(app.get().stepIndex).toBe(at3[0]);
    click(3, true);
    expect(app.get().stepIndex).toBe(at3[0]);
    click(5);
    click(5);
    expect(trace.lines[app.get().stepIndex]).toBe(5);
    expect(messages).toEqual([]);
  });

  it("Ctrl + F10 runs to the cursor's line, and says why when it can't", async () => {
    const { app, seek, setCursor, messages } = setup();
    seek.runToCursor(false);
    expect(messages.at(-1)).toEqual([3, expect.stringMatching(/^Run the code first/)]);
    const trace = await showJavaScript(app, CODE, 2);
    setCursor(5);
    seek.runToCursor(false);
    expect(trace.lines[app.get().stepIndex]).toBe(5);
    setCursor(4);
    seek.runToCursor(false);
    expect(messages.at(-1)).toEqual([4, "No recorded step is at line 4: it never ran."]);
    setCursor(null);
    seek.runToCursor(false); // no cursor: nothing
    app.markStale();
    setCursor(3);
    seek.runToCursor(false);
    expect(messages.at(-1)).toEqual([3, expect.stringMatching(/^The code changed since it ran/)]);
  });
});
