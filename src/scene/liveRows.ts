/**
 * The loop's live rows at a step, for the loop history's animated mode:
 * the row running now and the one at the step before, for each loop.
 */

import type { LoopHistory, LoopRow } from "../trace/loopHistory";
import { liveFrames, type Trace } from "../trace/types";
import type { LiveRow } from "./loopScene";

/** The loop's live state at a step, and at the step before, for animated mode. */
export function liveRows(t: Trace, index: number, history: LoopHistory): { prev: LoopRow; current: LoopRow } {
  const { frame: frameId, loop, instance } = history.context;
  const at = (i: number): LoopRow | null => {
    const step = t.steps[i];
    const context = step?.loops.find((c) => c.frame === frameId && c.loop === loop && c.instance === instance);
    const frame = step && liveFrames(step).find((f) => f.id === frameId);
    return context && frame ? { iteration: context.iteration, stepIndex: i, frame, heap: step.heap } : null;
  };
  const current = at(index) ?? history.rows[history.rows.length - 1];
  return { prev: at(index - 1) ?? current, current };
}

/**
 * Animated mode with every loop together: a live row for each loop of the
 * nest, outermost first, so an inner loop runs under the loop around it
 * instead of replacing it. A loop that isn't running at this step (an inner
 * one between runs, or one that has finished) shows how it last was.
 */
export function liveNestedRows(t: Trace, index: number, history: LoopHistory): LiveRow[] {
  const frameId = history.context.frame;
  // Each loop of the nest once, outermost first, in the order they first ran.
  const levels: { loop: string; depth: number }[] = [];
  for (const row of history.rows) {
    if (row.loop !== undefined && !levels.some((l) => l.loop === row.loop))
      levels.push({ loop: row.loop, depth: row.depth ?? 0 });
  }
  levels.sort((a, b) => a.depth - b.depth);
  const step = t.steps[index];
  const here = step?.loops.filter((c) => c.frame === frameId) ?? [];
  const frameAt = (i: number) => {
    const at = t.steps[i];
    return at ? liveFrames(at).find((f) => f.id === frameId) : undefined;
  };
  const out: LiveRow[] = [];
  for (const level of levels) {
    const ctx = here.find((c) => c.loop === level.loop);
    const frame = frameAt(index);
    if (ctx && frame) {
      const current: LoopRow = {
        iteration: ctx.iteration,
        stepIndex: index,
        frame,
        heap: step.heap,
        loop: ctx.loop,
        instance: ctx.instance,
        depth: level.depth,
      };
      const before = t.steps[index - 1]?.loops.find(
        (c) => c.frame === frameId && c.loop === ctx.loop && c.instance === ctx.instance,
      );
      const beforeFrame = frameAt(index - 1);
      const prev: LoopRow =
        before && beforeFrame
          ? {
              ...current,
              iteration: before.iteration,
              stepIndex: index - 1,
              frame: beforeFrame,
              heap: t.steps[index - 1].heap,
            }
          : current;
      out.push({ prev, current });
      continue;
    }
    const last = [...history.rows].reverse().find((row) => row.loop === level.loop);
    if (last) out.push({ prev: last, current: last, done: true });
  }
  return out;
}
