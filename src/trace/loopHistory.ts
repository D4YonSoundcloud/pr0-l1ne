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
}

export interface LoopHistory {
  info: LoopInfo;
  context: LoopContext;
  rows: LoopRow[];
  /** False when the current step is past the end of this loop. */
  running: boolean;
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
  return { info, context: latest, rows, running: running && last === stepIndex };
}
