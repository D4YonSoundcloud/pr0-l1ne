/**
 * Heaps sent as deltas (Trace.heapDelta): each step carries only the
 * objects that changed since the step before, plus every id in order.
 * Rebuilt here into full heaps that share unchanged objects, so a long
 * trace costs memory for what changes rather than for every snapshot.
 *
 * Objects are shared between steps, so nothing may change a trace's
 * objects in place (nothing does: renderers and applyHints only read).
 */
import type { HeapObject, Trace } from "./types";

export function expandHeaps(trace: Trace): Trace {
  if (!trace.heapDelta) return trace;
  let prev: Record<string, HeapObject> = {};
  for (const step of trace.steps) {
    const ids = step.heapIds;
    if (!ids) {
      prev = step.heap; // a full heap
      continue;
    }
    const changed = step.heap;
    const heap: Record<string, HeapObject> = {};
    for (const id of ids) {
      const obj = changed[id] ?? prev[id];
      if (obj) heap[id] = obj;
    }
    step.heap = heap;
    delete step.heapIds;
    prev = heap;
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
