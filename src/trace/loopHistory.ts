/**
 * Builds the "stacked iterations" view of a loop from the trace.
 *
 * A loop instance is one entry into a loop (an inner loop gets a new instance
 * on every pass of the outer loop). Its rows are the state at the end of each
 * iteration, plus a "before" row for the state when the loop was entered.
 */
import { liveFrames, type Frame, type HeapObject, type LoopContext, type LoopInfo, type Step, type Trace } from "./types";

export interface LoopRow {
  /** 0 is the "before" row. */
  iteration: number;
  stepIndex: number;
  frame: Frame;
  heap: Record<string, HeapObject>;
  /** All loops together: which loop and which run of it this row is a pass of, and how deeply it's nested (0 outermost). */
  loop?: string;
  instance?: number;
  depth?: number;
}

/** "L4#2": one run of a loop. */
export const runKey = (loop: string, instance: number) => `${loop}#${instance}`;

/** The loop tab that draws every loop of a frame together. */
export const ALL_LOOPS = "*";

export interface LoopHistory {
  info: LoopInfo;
  context: LoopContext;
  rows: LoopRow[];
  /** False when the current step is past the end of this loop. */
  running: boolean;
  /** Every loop running in the frame, drawn together: rows of all of them, in the order they ran. */
  nested?: boolean;
  /** Each run's header with its values (LoopContext.call), by runKey. */
  calls: Map<string, string>;
}

const sameInstance = (a: LoopContext, b: LoopContext) =>
  a.frame === b.frame && a.loop === b.loop && a.instance === b.instance;

function contextIn(step: Step, target: LoopContext): LoopContext | undefined {
  return step.loops.find((ctx) => sameInstance(ctx, target));
}

/**
 * The loops a person can pick from at this step. If no loop is running, use
 * the most recent step that was inside one, so a finished loop's full history
 * stays visible.
 */
export function availableLoops(trace: Trace, stepIndex: number): { contexts: LoopContext[]; running: boolean } {
  const current = trace.steps[stepIndex];
  if (current?.loops.length) return { contexts: current.loops, running: true };
  for (let i = stepIndex - 1; i >= 0; i--) {
    const loops = trace.steps[i].loops;
    if (loops.length) return { contexts: loops, running: false };
  }
  return { contexts: [], running: false };
}

export function buildLoopHistory(
  trace: Trace,
  stepIndex: number,
  preferredLoopId: string | null,
): LoopHistory | null {
  const { contexts, running } = availableLoops(trace, stepIndex);
  if (!contexts.length) return null;

  // Prefer the loop the person picked; otherwise the innermost one if it's
  // running, or the outermost one once everything has finished.
  const picked =
    contexts.find((ctx) => ctx.loop === preferredLoopId) ??
    (running ? contexts[contexts.length - 1] : contexts[0]);
  const info = trace.loops.find((loop) => loop.id === picked.loop);
  if (!info) return null;

  // Find the step range for this instance. Its steps are contiguous: calls
  // made from inside the loop keep the caller's loop context on the stack.
  let last = Math.min(stepIndex, trace.steps.length - 1);
  while (last > 0 && !contextIn(trace.steps[last], picked)) last--;
  let first = last;
  while (first > 0 && contextIn(trace.steps[first - 1], picked)) first--;

  // The last step of each iteration is that iteration's row.
  const lastStepOfIteration = new Map<number, number>();
  for (let i = first; i <= last; i++) {
    const ctx = contextIn(trace.steps[i], picked);
    if (ctx) lastStepOfIteration.set(ctx.iteration, i);
  }

  const rows: LoopRow[] = [];
  for (const [iteration, index] of [...lastStepOfIteration].sort((a, b) => a[0] - b[0])) {
    const step = trace.steps[index];
    const frame = liveFrames(step).find((f) => f.id === picked.frame);
    if (frame) rows.push({ iteration, stepIndex: index, frame, heap: step.heap });
  }

  const latest = contextIn(trace.steps[last], picked) ?? picked;
  const calls = new Map<string, string>();
  for (let i = first; i <= last; i++) {
    const ctx = contextIn(trace.steps[i], picked);
    if (ctx?.call) { calls.set(runKey(ctx.loop, ctx.instance), ctx.call); break; }
  }
  return { info, context: latest, rows, running: running && last === stepIndex, calls };
}

/**
 * The loops that can be drawn together at this step: those running in the
 * same frame as the innermost one, when a loop inside the outermost one has
 * run. Empty otherwise (one loop at a time).
 */
export function nestedLoopsAt(trace: Trace, stepIndex: number): LoopContext[] {
  const { contexts, running } = availableLoops(trace, stepIndex);
  if (!contexts.length) return [];
  const frame = (running ? contexts[contexts.length - 1] : contexts[0]).frame;
  const inFrame = contexts.filter((c) => c.frame === frame);
  const root = inFrame[0];
  const range = runRange(trace, stepIndex, root);
  for (let i = range.first; i <= range.last; i++) {
    if (trace.steps[i].loops.some((c) => c.frame === frame && c.loop !== root.loop)) return inFrame;
  }
  return [];
}

/** The steps of one run of a loop, up to this step. */
function runRange(trace: Trace, stepIndex: number, ctx: LoopContext): { first: number; last: number } {
  let last = Math.min(stepIndex, trace.steps.length - 1);
  while (last > 0 && !contextIn(trace.steps[last], ctx)) last--;
  let first = last;
  while (first > 0 && contextIn(trace.steps[first - 1], ctx)) first--;
  return { first, last };
}

/**
 * Every loop in a frame, together: the outermost loop's run, with a row for
 * each pass of it and of every loop inside it (each at the last step of
 * that pass), in the order they happened. An inner loop's passes come
 * before the end of the outer pass they're in. Null when there's nothing
 * nested to draw together.
 */
export function buildNestedHistory(trace: Trace, stepIndex: number): LoopHistory | null {
  const inFrame = nestedLoopsAt(trace, stepIndex);
  if (!inFrame.length) return null;
  const { running } = availableLoops(trace, stepIndex);
  const root = inFrame[0];
  const info = trace.loops.find((loop) => loop.id === root.loop);
  if (!info) return null;
  const { first, last } = runRange(trace, stepIndex, root);

  // The last step of each pass of each run, and how deep that loop is.
  const lastStep = new Map<string, { index: number; ctx: LoopContext; depth: number }>();
  const calls = new Map<string, string>();
  for (let i = first; i <= last; i++) {
    const here = trace.steps[i].loops.filter((c) => c.frame === root.frame);
    here.forEach((ctx, depth) => {
      const key = runKey(ctx.loop, ctx.instance);
      if (ctx.call && !calls.has(key)) calls.set(key, ctx.call);
      // Inner runs start without a "before" row; the outermost has one.
      if (ctx.iteration === 0 && depth > 0) return;
      // A step belongs to the innermost loop running: an outer pass's row is
      // its state once its inner loops are done, not a copy of theirs.
      if (depth < here.length - 1 && !(ctx.iteration === 0 && here[depth + 1]?.iteration === 0)) return;
      lastStep.set(`${key}|${ctx.iteration}`, { index: i, ctx, depth });
    });
  }
  const rows: LoopRow[] = [];
  const entries = [...lastStep.values()].sort((a, b) => a.index - b.index || b.depth - a.depth);
  for (const { index, ctx, depth } of entries) {
    const step = trace.steps[index];
    const frame = liveFrames(step).find((f) => f.id === root.frame);
    if (frame) rows.push({ iteration: ctx.iteration, stepIndex: index, frame, heap: step.heap, loop: ctx.loop, instance: ctx.instance, depth });
  }
  const latest = contextIn(trace.steps[last], root) ?? root;
  return { info, context: latest, rows, running: running && last === stepIndex, nested: true, calls };
}
