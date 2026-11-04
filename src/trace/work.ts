/**
 * Work over a whole run, done a slice at a time so the page keeps
 * drawing: after each slice (about 40 ms of work) the page gets a frame,
 * so the progress bar moves, clicks are answered and nothing looks frozen.
 *
 * Work is a generator that yields how far it's got, step by step
 * (`Progress`): cheap to yield often, and it decides nothing about when to
 * pause. `finishInSlices` runs it on the page, pausing between slices and
 * reporting progress at each pause; `finishNow` runs it in one go (tests,
 * Node, and anything that needs the answer at once). Work that's done
 * within the first slice never pauses, so a small run costs nothing more.
 *
 * This is a step toward doing it off the page altogether (a worker), which
 * would report progress the same way.
 */

/** How far some work has got: `done` of `total` steps in its current part, and `share` (0 to 1) of all of it. */
export interface Progress {
  /** What it's doing, as people say it: "Finding graphs". */
  label: string;
  done: number;
  total: number;
  share: number;
}

export type Work<T> = Generator<Progress, T, void>;

/** Run work to its end, at once. */
export function finishNow<T>(work: Work<T>): T {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

export interface SliceOptions {
  /** Work per slice before the page gets a frame, in milliseconds. */
  sliceMs?: number;
  /** Let the page draw a frame (tests pass their own). */
  pause?: () => Promise<void>;
  /** The clock (tests pass their own). */
  now?: () => number;
}

const SLICE_MS = 40;

/** A frame for the page: past the next paint (or a task, in a hidden tab, where frames don't come). */
export function pauseForFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function" || (typeof document !== "undefined" && document.hidden))
    return new Promise((resolve) => setTimeout(resolve, 0));
  // The frame's callback runs before its paint; the task after it, after.
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * Run work a slice at a time, reporting progress at each pause (never for
 * work done within the first slice).
 */
export async function finishInSlices<T>(
  work: Work<T>,
  report: (progress: Progress) => void,
  options: SliceOptions = {},
): Promise<T> {
  const sliceMs = options.sliceMs ?? SLICE_MS;
  const pause = options.pause ?? pauseForFrame;
  const now = options.now ?? (() => performance.now());
  let sliceStart = now();
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
    if (now() - sliceStart < sliceMs) continue;
    report(next.value);
    await pause();
    sliceStart = now();
  }
}

/** Work whose progress is scaled into a part of a bigger whole: from `from` to `to` of it. */
export function* within<T>(work: Work<T>, from: number, to: number): Work<T> {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
    yield { ...next.value, share: from + next.value.share * (to - from) };
  }
}

/** Progress through `total` steps of one part. */
export function stepOf(label: string, done: number, total: number): Progress {
  return { label, done, total, share: total ? done / total : 1 };
}
