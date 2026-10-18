/**
 * Animation for the canvas renderer: CSS easing curves, and tweens run once
 * per frame. What a step animates is planned once for both renderers
 * (render/animate.ts, `plan`); the SVG renderer plays the plan with the Web
 * Animations API, and the canvas renderer plays it here, moving and fading
 * PixiJS containers and redrawing each frame until everything has settled.
 */

export type Ease = (t: number) => number;

/** A cubic-bezier(x1, y1, x2, y2) timing function, solved for y at time x. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    // Newton's method, then bisection if it didn't converge.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solve(x)));
}

const KEYWORDS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

const eases = new Map<string, Ease>();

/** A CSS easing (as the Style panel allows: keywords and cubic-bezier()) as a function. Unknown: linear. */
export function easing(css: string): Ease {
  const key = css.trim();
  let ease = eases.get(key);
  if (ease) return ease;
  const m = /^cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,)]+)\s*\)$/.exec(key);
  const points = m ? m.slice(1).map(Number) : Object.hasOwn(KEYWORDS, key) ? KEYWORDS[key] : null;
  ease = points?.every(Number.isFinite)
    ? cubicBezier(points[0], points[1], points[2], points[3])
    : (t: number) => Math.max(0, Math.min(1, t));
  eases.set(key, ease);
  return ease;
}

export interface Tween {
  /** In milliseconds. */
  duration: number;
  ease: Ease;
  /** Called with the eased progress (0 at the start, 1 at the end). */
  apply(progress: number): void;
}

interface Running extends Tween {
  start: number;
}

/**
 * Tweens that run together, one frame at a time. `onFrame` is called after
 * each frame's tweens are applied, to draw.
 */
export class Tweens {
  private running: Running[] = [];
  private handle: number | null = null;

  constructor(
    private readonly onFrame: () => void,
    private readonly clock: {
      now(): number;
      request(callback: () => void): number;
      cancel(handle: number): void;
    } = {
      now: () => performance.now(),
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    },
  ) {}

  get active(): boolean {
    return this.running.length > 0;
  }

  /** Start a tween now. It's applied at once at its start (like fill: backwards). */
  add(tween: Tween): void {
    if (tween.duration <= 0) {
      tween.apply(1);
      return;
    }
    tween.apply(tween.ease(0));
    this.running.push({ ...tween, start: this.clock.now() });
    this.schedule();
  }

  /** Stop everything where it is (the drawing it moved is being replaced). */
  clear(): void {
    this.running = [];
    if (this.handle !== null) this.clock.cancel(this.handle);
    this.handle = null;
  }

  /** Jump everything to its end. */
  finish(): void {
    const all = this.running;
    this.clear();
    for (const t of all) t.apply(1);
    if (all.length) this.onFrame();
  }

  private schedule(): void {
    if (this.handle === null) this.handle = this.clock.request(() => this.tick());
  }

  private tick(): void {
    this.handle = null;
    const now = this.clock.now();
    const still: Running[] = [];
    for (const t of this.running) {
      const linear = Math.min(1, (now - t.start) / t.duration);
      t.apply(linear >= 1 ? 1 : t.ease(linear));
      if (linear < 1) still.push(t);
    }
    this.running = still;
    this.onFrame();
    if (still.length) this.schedule();
  }
}
