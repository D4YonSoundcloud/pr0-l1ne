/**
 * Heaps sent as deltas (Trace.heapDelta): each step carries only the
 * objects that differ from their last version sent (in any step before), plus every id in order
 * (heapIds), or `sameIds` when they're the same ids as the step before, or
 * `heapIdsPart` [first ids kept, last ids kept, the ids between]. A
 * frame that didn't change since the step before comes as just its id and
 * `same` (Python's tracer: a deep call stack is otherwise most of a
 * trace). Rebuilt here into full heaps and stacks that share what didn't
 * change, so a long trace costs memory for what changes rather than for
 * every snapshot.
 *
 * Objects are shared between steps, so nothing may change a trace's
 * objects in place (nothing does: renderers and applyHints only read).
 */
import type { Frame, HeapObject, Step, Trace } from "./types";

/** A frame as sent: whole, or only its id when it's the same as in the step before. */
type SentFrame = Frame | { id: string; same: true };

export function expandHeaps(trace: Trace): Trace {
  if (!trace.heapDelta) return trace;
  /** Every object's last version, from whichever step sent it. */
  const known = new Map<string, HeapObject>();
  let prevIds: string[] = [];
  let prevFrames = new Map<string, Frame>();
  for (const step of trace.steps as (Step & { sameIds?: boolean; heapIdsPart?: [number, number, string[]] })[]) {
    // Frames first: the same as last step's, by id.
    const frames = new Map<string, Frame>();
    const rebuild = (list: SentFrame[] | undefined): Frame[] | undefined =>
      list?.map((sent) => {
        const frame = "same" in sent ? prevFrames.get(sent.id) : sent;
        if (!frame) throw new Error(`frame ${sent.id} isn't in the step before`);
        frames.set(frame.id, frame);
        return frame;
      });
    step.stack = rebuild(step.stack as SentFrame[]) ?? [];
    if (step.suspended) step.suspended = rebuild(step.suspended as SentFrame[]);
    prevFrames = frames;

    // The ids: as sent, the same as before, or a change to the step before's.
    const part = step.heapIdsPart;
    const ids = step.sameIds
      ? prevIds
      : part
        ? [...prevIds.slice(0, part[0]), ...part[2], ...prevIds.slice(prevIds.length - part[1])]
        : step.heapIds;
    if (!ids) {
      // A full heap.
      for (const id in step.heap) known.set(id, step.heap[id]);
      prevIds = Object.keys(step.heap);
      continue;
    }
    const changed = step.heap;
    const heap: Record<string, HeapObject> = {};
    for (const id in changed) known.set(id, changed[id]);
    for (const id of ids) {
      const obj = changed[id] ?? known.get(id);
      if (obj) heap[id] = obj;
    }
    step.heap = heap;
    delete step.heapIds;
    delete step.sameIds;
    delete step.heapIdsPart;
    prevIds = ids;
  }
  delete trace.heapDelta;
  return trace;
}

/** Deep equality for trace values (plain objects, arrays and primitives). */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}
