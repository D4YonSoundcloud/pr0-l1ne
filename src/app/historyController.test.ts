// @vitest-environment jsdom
/**
 * A value's history card (historyController.ts): shown once the pointer
 * rests on a value, kept while it moves onto the card, closed when it
 * leaves; a sparkline for numbers and a list otherwise, with where the
 * step on screen is; buttons and points that go to a change; a click on
 * the value goes to its next change, Shift the one before; one request per
 * value per run; pinned (or dragged, which pins it) it stays through
 * steps and a new run that still has its value, several at once; what's
 * pressed on it stays on it; and it opens off the windows' buttons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPoint, ValueTarget } from "../trace/history";
import { changeFrom, currentPoint, HistoryController } from "./historyController";
import { makeApp, showJavaScript } from "./testHelpers";

const CODE = `const nums = [5, 3];
let best = 0;
best = 5;
best = 9;
const word = "a";
nums[0] = 1;
`;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const { app, layout } = makeApp();
  const trace = await showJavaScript(app, CODE, 2);
  let asked = 0;
  const realHistory = layout.history.bind(layout);
  layout.history = (target, at) => {
    asked++;
    return realHistory(target, at);
  };
  const history = new HistoryController({
    app,
    layout,
    goTo: (step) => app.setStep(step),
    firstStep: () => 2,
    host: document.body,
    hoverDelay: 300,
  });
  return { app, trace, history, asked: () => asked };
}

const card = () => document.querySelector<HTMLElement>(".history-card");
const settle = async () => {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
};
const best = (frame: string): ValueTarget => ({ kind: "var", frame, name: "best" });

describe("a value's history card", () => {
  it("shows once the pointer rests on a value, and goes once it leaves (unless it's on the card)", async () => {
    const { history } = await setup();
    const target = best(globalId());
    history.hover(target, 100, 100);
    expect(card()).toBeNull();
    await settle();
    expect(card()!.hidden).toBe(false);
    expect(card()!.querySelector(".history-name")!.textContent).toBe("best");
    expect(card()!.querySelector(".history-count")!.textContent).toBe("2 changes");
    history.hover(null, 0, 0);
    card()!.dispatchEvent(new Event("pointerenter"));
    await settle();
    expect(card()!.hidden).toBe(false); // the pointer came to the card
    card()!.dispatchEvent(new Event("pointerleave"));
    await settle();
    expect(card()).toBeNull();
  });

  it("draws numbers as a sparkline, with where the step on screen is; other values as a list", async () => {
    const { app, history, trace } = await setup();
    await history.show(best(globalId()), { x: 10, y: 10 });
    expect(card()!.querySelector(".history-spark")).not.toBeNull();
    expect(card()!.querySelectorAll(".history-dot")).toHaveLength(3);
    expect(card()!.querySelector(".history-range")!.textContent).toBe("0 – 9");
    app.setStep(trace.steps - 1);
    expect(card()!.querySelector(".history-now")!.textContent).toBe("Now: 9");
    expect(card()!.querySelector(".history-dot.is-now")).not.toBeNull();
    await history.show({ kind: "var", frame: globalId(), name: "word" }, { x: 10, y: 10 });
    expect(card()!.querySelector(".history-spark")).toBeNull();
    expect([...card()!.querySelectorAll(".history-value")].map((e) => e.textContent)).toEqual(['"a"']);
  });

  it("its buttons and rows go to a change; a click on the value goes to its next change, Shift the one before", async () => {
    const { app, history, trace } = await setup();
    const target = best(globalId());
    const changesAt = (await history.history(target)).points.map((p) => p.step);
    app.setStep(2);
    await history.jump(target, false);
    expect(app.get().stepIndex).toBe(changesAt.find((s) => s > 2));
    await history.jump(target, false);
    const second = app.get().stepIndex;
    await history.jump(target, true);
    expect(app.get().stepIndex).toBeLessThan(second);
    await history.show(target, { x: 0, y: 0 });
    // The card's redrawn for each step: its buttons from where it is now.
    const buttons = () => card()!.querySelectorAll<HTMLButtonElement>(".history-go");
    buttons()[1].click();
    expect(app.get().stepIndex).toBe(second);
    buttons()[0].click();
    expect(app.get().stepIndex).toBeLessThan(second);
    app.setStep(trace.steps - 1);
    expect(card()!.querySelectorAll<HTMLButtonElement>(".history-go")[1].disabled).toBe(true);
  });

  it("asks for a value's history once a run, and closes for a new run", async () => {
    const { app, history, asked } = await setup();
    const before = asked();
    await history.show(best(globalId()), { x: 0, y: 0 });
    await history.jump(best(globalId()), false);
    await history.show(best(globalId()), { x: 0, y: 0 });
    expect(asked() - before).toBe(1);
    await showJavaScript(app, CODE, 2);
    expect(history.isOpen).toBe(false);
  });
});

describe("a pinned card", () => {
  const pinButton = (c: Element) => c.querySelector<HTMLButtonElement>(".history-pin")!;
  const pointer = (type: string, target: Element, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    target.dispatchEvent(event);
  };

  it("stays as the pointer leaves and the steps go by, and another value gets a card of its own", async () => {
    const { app, history, trace } = await setup();
    await history.show(best(globalId()), { x: 10, y: 10 });
    pinButton(card()!).click();
    expect(pinButton(card()!).getAttribute("aria-pressed")).toBe("true");
    expect(card()!.classList.contains("is-pinned")).toBe(true);
    card()!.dispatchEvent(new Event("pointerleave"));
    history.hover(null, 0, 0);
    await settle();
    app.setStep(trace.steps - 1);
    expect(card()!.querySelector(".history-now")!.textContent).toBe("Now: 9");
    // Another value: its own card, and the pinned one stays.
    await history.show({ kind: "var", frame: globalId(), name: "word" }, { x: 300, y: 10 });
    expect(document.querySelectorAll(".history-card")).toHaveLength(2);
    document.querySelectorAll(".history-card")[1].dispatchEvent(new Event("pointerleave"));
    await settle();
    expect(document.querySelectorAll(".history-card")).toHaveLength(1);
    // Hovering the pinned value: no second card for it.
    history.hover(best(globalId()), 10, 10);
    await settle();
    expect(document.querySelectorAll(".history-card")).toHaveLength(1);
    // Unpinned: it goes when the pointer leaves it; × closes one straight away.
    pinButton(card()!).click();
    card()!.dispatchEvent(new Event("pointerleave"));
    await settle();
    expect(card()).toBeNull();
    await history.show(best(globalId()), { x: 10, y: 10 });
    pinButton(card()!).click();
    card()!.querySelector<HTMLButtonElement>(".history-close")!.click();
    expect(history.isOpen).toBe(false);
  });

  it("is pinned by dragging its head, moves with the pointer, and by the arrow keys", async () => {
    const { history } = await setup();
    await history.show(best(globalId()), { x: 10, y: 10 });
    const c = card()!;
    c.style.left = "100px";
    c.style.top = "100px";
    Object.defineProperty(c, "offsetLeft", { get: () => Number.parseFloat(c.style.left) });
    Object.defineProperty(c, "offsetTop", { get: () => Number.parseFloat(c.style.top) });
    const head = c.querySelector(".history-head")!;
    pointer("pointerdown", head.querySelector(".history-name")!, 50, 50);
    pointer("pointermove", c, 51, 51); // not yet a drag
    expect(history.pinnedCount).toBe(0);
    pointer("pointermove", c, 90, 70);
    pointer("pointerup", c, 90, 70);
    expect(history.pinnedCount).toBe(1);
    expect([c.style.left, c.style.top]).toEqual(["140px", "120px"]);
    c.querySelector(".history-head")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(c.style.top).toBe("136px");
    // A press on its buttons isn't a drag.
    pointer("pointerdown", c.querySelector(".history-pin")!, 0, 0);
    pointer("pointermove", c, 200, 200);
    expect(c.style.top).toBe("136px");
  });

  it("follows its value into a new run, and goes when the run hasn't got it", async () => {
    const { app, history } = await setup();
    await history.show(best(globalId()), { x: 10, y: 10 });
    pinButton(card()!).click();
    await showJavaScript(app, CODE.replace("best = 9;", "best = 12;"), 2);
    await settle();
    expect(card()!.querySelector(".history-range")!.textContent).toBe("0 – 12");
    await showJavaScript(app, "let other = 1;\n", 2);
    await settle();
    expect(card()).toBeNull();
  });

  it("keeps what's pressed on it from what's under it, and opens off the windows' buttons", async () => {
    const { history } = await setup();
    const under = vi.fn();
    document.body.addEventListener("click", under);
    document.body.addEventListener("pointerdown", under);
    const controls = document.createElement("div");
    controls.className = "viewport-controls";
    controls.getBoundingClientRect = () =>
      ({ left: 395, right: 600, top: 0, bottom: 300, width: 205, height: 300 }) as DOMRect;
    document.body.append(controls);
    await history.show(best(globalId()), { x: 400, y: 10 });
    card()!.querySelector<HTMLButtonElement>(".history-next")!.click();
    pointer("pointerdown", card()!.querySelector(".history-next")!, 0, 0);
    expect(under).not.toHaveBeenCalled();
    // Right of the point would cover the buttons (and above it there's no room): it opens to the point's left.
    expect(card()!.style.left).toBe("114px");
  });
});

describe("the changes around a step", () => {
  const points: HistoryPoint[] = [3, 7, 12].map((step) => ({ step, value: String(step), num: step }));
  it("finds the next change after a step, the latest before it, and the one in effect", () => {
    expect(changeFrom(points, 0, false, 0)).toBe(3);
    expect(changeFrom(points, 7, false, 0)).toBe(12);
    expect(changeFrom(points, 12, false, 0)).toBeNull();
    expect(changeFrom(points, 7, true, 0)).toBe(3);
    expect(changeFrom(points, 9, true, 0)).toBe(7);
    expect(changeFrom(points, 7, true, 4)).toBeNull(); // not before the timeline's first step
    expect(currentPoint(points, 9)?.step).toBe(7);
    expect(currentPoint(points, 1)).toBeNull();
  });
});

/** The program's global frame: the JavaScript tracer numbers frames from f1, the first call. */
function globalId(): string {
  return "f1";
}
