/**
 * How long each stage of drawing a step takes, for the benchmarks
 * (scripts/bench.ts in Node, scripts/bench-browser.mjs in the page; see
 * bench/README.md). Off unless asked for: `perf.on = true` in code, or the
 * page opened with ?perf (it's then window.__pr0l1nePerf). When off, timed()
 * is a plain call.
 *
 *   run.trace       a run, from asking the runner to the trace arriving
 *   run.hints       applying the hints to it
 *   run.show        showing it: the first step drawn
 *   memory.scene    the memory scene (scene/memoryScene.ts)
 *   memory.layout   laying out the memory drawing, arrows included
 *   memory.route    routing its arrows (part of memory.layout)
 *   memory.render   the memory window's renderer: layout, then SVG or canvas
 *   loop.history    the loop history's rows (trace/loopHistory.ts)
 *   loop.layout     laying out the loop drawing
 *   loop.render     the loop window's renderer
 *   svg.patch       making the page's SVG match a new drawing
 *   canvas.paint    turning a drawing into the canvas's shapes (paint.ts)
 *   canvas.build    turning those into PixiJS objects (pixiScene.ts)
 *   canvas.draw     PixiJS drawing the window
 */
export const perf = {
  on: false,
  /** Draw everything in full at every zoom (?nolod): to measure what levels of detail save. */
  noLod: false,
  /** The last trace the page showed, in numbers (the browser benchmark reads it). */
  lastTrace: null as TraceStats | null,
  /** Every time recorded, by stage, in milliseconds. */
  samples: new Map<string, number[]>(),
  record(stage: string, ms: number): void {
    const list = this.samples.get(stage);
    if (list) list.push(ms);
    else this.samples.set(stage, [ms]);
  },
  reset(): void {
    this.samples.clear();
  },
  /** Each stage's count, median, 90th percentile and largest time. */
  summary(): Record<string, { n: number; median: number; p90: number; max: number }> {
    const out: Record<string, { n: number; median: number; p90: number; max: number }> = {};
    for (const [stage, list] of this.samples) {
      const sorted = [...list].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      out[stage] = { n: sorted.length, median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
    }
    return out;
  },
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Run `fn`, recording how long it took under `stage` when timing is on. */
export function timed<T>(stage: string, fn: () => T): T {
  if (!perf.on) return fn();
  const start = now();
  try {
    return fn();
  } finally {
    perf.record(stage, now() - start);
  }
}

/** A trace's size, in the numbers the benchmarks report. */
export interface TraceStats {
  steps: number;
  truncated: boolean;
  stoppedBy: string | null;
  /** The most heap objects any step records, and how many on average. */
  maxHeap: number;
  meanHeap: number;
  /** The steps that ran, recorded or not. */
  ran: number;
}

export function traceStats(trace: {
  steps: { heap: Record<string, unknown> }[];
  truncated: boolean;
  stoppedBy?: string;
  counts?: { steps: number };
}): TraceStats {
  let max = 0;
  let sum = 0;
  for (const step of trace.steps) {
    const n = Object.keys(step.heap).length;
    sum += n;
    if (n > max) max = n;
  }
  return {
    steps: trace.steps.length,
    truncated: trace.truncated,
    stoppedBy: trace.stoppedBy ?? null,
    maxHeap: max,
    meanHeap: trace.steps.length ? Math.round(sum / trace.steps.length) : 0,
    ran: trace.counts?.steps ?? trace.steps.length,
  };
}
