// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cubicBezier, easing, Tweens } from "./motion";

describe("easing", () => {
  it("knows the CSS keywords and cubic-bezier()", () => {
    expect(easing("linear")(0.3)).toBeCloseTo(0.3);
    // ease = cubic-bezier(0.25, 0.1, 0.25, 1): at 50% of the time, about 80% of the way.
    expect(easing("ease")(0.5)).toBeCloseTo(0.8024, 3);
    expect(easing("ease-in")(0.5)).toBeCloseTo(0.3153, 3);
    expect(easing("ease-out")(0.5)).toBeCloseTo(0.6847, 3);
    expect(easing("ease-in-out")(0.5)).toBeCloseTo(0.5, 3);
    expect(easing("cubic-bezier(0.2, 0.7, 0.2, 1)")(0.5)).toBeGreaterThan(0.85);
    expect(easing(" cubic-bezier(0,0,1,1) ")(0.25)).toBeCloseTo(0.25, 4);
  });

  it("starts at 0, ends at 1, and can overshoot in between", () => {
    const overshoot = easing("cubic-bezier(0.34, 1.56, 0.64, 1)");
    expect(overshoot(0)).toBe(0);
    expect(overshoot(1)).toBe(1);
    expect(Math.max(...[0.5, 0.6, 0.7, 0.8].map(overshoot))).toBeGreaterThan(1);
  });

  it("is linear for anything it doesn't know", () => {
    expect(easing("steps(4)")(0.4)).toBeCloseTo(0.4);
    expect(easing("bouncy")(2)).toBe(1);
    expect(easing("constructor")(0.5)).toBe(0.5);
  });

  it("solves steep curves too", () => {
    const snap = cubicBezier(0.85, 0, 0.15, 1);
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const v = snap(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(snap(0.5)).toBeCloseTo(0.5, 3);
    // A flat start: Newton's method can't, bisection does.
    expect(cubicBezier(0, 0, 0, 1)(0.001)).toBeGreaterThan(0);
  });
});

function fakeClock() {
  let now = 0;
  let next: (() => void) | null = null;
  return {
    clock: {
      now: () => now,
      request: (callback: () => void) => {
        next = callback;
        return 1;
      },
      cancel: () => {
        next = null;
      },
    },
    advance(ms: number) {
      now += ms;
      const run = next;
      next = null;
      run?.();
    },
    get waiting() {
      return next !== null;
    },
  };
}

describe("Tweens", () => {
  it("applies the start at once, then each frame, and draws after each", () => {
    const time = fakeClock();
    let frames = 0;
    const tweens = new Tweens(() => frames++, time.clock);
    const seen: number[] = [];
    tweens.add({ duration: 100, ease: (t) => t, apply: (p) => seen.push(p) });
    expect(seen).toEqual([0]);
    expect(tweens.active).toBe(true);
    time.advance(50);
    time.advance(60);
    expect(seen).toEqual([0, 0.5, 1]);
    expect(frames).toBe(2);
    expect(tweens.active).toBe(false);
    expect(time.waiting).toBe(false);
  });

  it("runs a zero-length tween to its end straight away", () => {
    const time = fakeClock();
    const tweens = new Tweens(() => {}, time.clock);
    const seen: number[] = [];
    tweens.add({ duration: 0, ease: (t) => t, apply: (p) => seen.push(p) });
    expect(seen).toEqual([1]);
    expect(time.waiting).toBe(false);
  });

  it("clear() stops where things are; finish() jumps to the end", () => {
    const time = fakeClock();
    let frames = 0;
    const tweens = new Tweens(() => frames++, time.clock);
    const seen: number[] = [];
    tweens.add({ duration: 100, ease: (t) => t, apply: (p) => seen.push(p) });
    tweens.clear();
    time.advance(50);
    expect(seen).toEqual([0]);
    tweens.add({ duration: 100, ease: (t) => t, apply: (p) => seen.push(p) });
    tweens.finish();
    expect(seen).toEqual([0, 0, 1]);
    expect(frames).toBe(1);
    tweens.finish(); // nothing running: nothing drawn
    expect(frames).toBe(1);
  });

  it("uses the page's clock by default", () => {
    const tweens = new Tweens(() => {});
    const seen: number[] = [];
    tweens.add({ duration: 10_000, ease: (t) => t, apply: (p) => seen.push(p) });
    expect(seen).toEqual([0]);
    tweens.clear();
  });
});
