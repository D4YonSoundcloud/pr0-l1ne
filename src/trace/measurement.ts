/**
 * What a Measure run reports: the program run at full size with counters
 * instead of a trace (worker/measure.py for Python, js/measure.ts for
 * JavaScript and TypeScript). Line numbers are keys, as strings.
 */
export interface Measurement {
  /** "limit": stopped at the time limit; `stoppedAt` says how far it got. */
  status: "done" | "limit" | "error";
  error: { type: string; message: string; line: number | null } | null;
  /** How many times each line ran. */
  lines: Record<string, number>;
  /** How many times each loop's body ran, by the loop's line. */
  passes: Record<string, number>;
  /** How many times each function was called, by the line it starts on. */
  calls: Record<string, number>;
  /** Items moved, scanned, copied or sorted inside built-ins, by line. */
  work: Record<string, number>;
  /** m: moved, s: scanned, c: copied, o: sorted. */
  workKind: Record<string, "m" | "s" | "c" | "o">;
  /** Passes a loop was going to make, when known as it started. */
  totals: Record<string, number>;
  /** The counted run's time. */
  ms: number;
  /** The untouched program's time, when it was quick enough to run again. */
  plainMs: number | null;
  /** Peak memory (Python, quick programs only), in 64-bit bytes. */
  peakBytes: number | null;
  /** What the program's variables hold at the end, in 64-bit bytes (Python). */
  heldBytes: number | null;
  stdout: string;
  /** Characters of output beyond what was kept. */
  droppedOutput: number;
  stoppedAt?: MeasureProgress;
}

/** Sent while a Measure run is going. */
export interface MeasureProgress {
  elapsedMs: number;
  /** The outermost loop running, when its length was known. */
  loop?: { line: number; done: number; total: number };
}

const WORK_WORDS = { m: "moved", s: "scanned", c: "copied", o: "sorted" } as const;

/** "moved", "scanned"... for a line's built-in work. */
export function workWord(kind: string | undefined): string {
  return WORK_WORDS[kind as keyof typeof WORK_WORDS] ?? "processed";
}

/** 400000000 -> "400M", 12345 -> "12.3K", 999 -> "999". */
export function compact(n: number): string {
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2).replace(/\.?0+$/, "")}${unit}`;
    }
  }
  return String(Math.round(n));
}

/** 1834.2 -> "1.83 s", 87.4 -> "87 ms", 95000 -> "1 min 35 s". */
export function duration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m - h * 60} min` : `${Math.round(h / 24)} days`;
}

/**
 * How long the whole run would take, for one stopped at the time limit:
 * the time so far, over the fraction of the outermost loop done. Assumes
 * each pass takes about as long as the ones so far. Null when unknown.
 */
export function projectedMs(m: Measurement): number | null {
  const at = m.stoppedAt;
  if (!at?.loop || at.loop.done <= 0 || !at.loop.total) return null;
  return at.elapsedMs * (at.loop.total / at.loop.done);
}

/** Totals over every line. */
export function totals(m: Measurement): { lines: number; work: number } {
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  return { lines: sum(m.lines), work: sum(m.work) };
}
