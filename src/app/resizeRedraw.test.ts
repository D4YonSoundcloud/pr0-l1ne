import { describe, expect, it } from "vitest";
import { resizeRedraw } from "./resizeRedraw";

function setup(start = "wide") {
  let shape = start;
  let redraws = 0;
  const timers = new Map<number, () => void>();
  let next = 0;
  const notify = resizeRedraw({
    shape: () => shape,
    redraw: () => redraws++,
    setTimeout: (callback) => {
      timers.set(++next, callback);
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const pause = () => {
    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      callback();
    }
  };
  return {
    notify,
    pause,
    setShape: (s: string) => {
      shape = s;
    },
    redraws: () => redraws,
    pending: () => timers.size,
  };
}

describe("redrawing when the windows change size", () => {
  it("waits for resizing to pause: many resizes, one check", () => {
    const s = setup();
    s.setShape("tall");
    for (let i = 0; i < 50; i++) s.notify();
    expect(s.pending()).toBe(1);
    expect(s.redraws()).toBe(0);
    s.pause();
    expect(s.redraws()).toBe(1);
  });

  it("redraws only when the shape of the windows changes", () => {
    const s = setup();
    s.notify();
    s.pause();
    expect(s.redraws()).toBe(0); // a new size, the same shape: the viewport moves the drawing
    s.setShape("tall");
    s.notify();
    s.pause();
    s.notify();
    s.pause();
    expect(s.redraws()).toBe(1);
  });
});
