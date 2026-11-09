/**
 * Heaps sent as deltas (Trace.heapDelta): each step carries only the
 * objects that differ from their last version sent (in any step before), plus every id in order
 * (heapIds), or `sameIds` when they're the same ids as the step before, or
 * `heapIdsPart` [first ids kept, last ids kept, the ids between]. A
 * frame that didn't change since the step before comes as just its id and
 * `same` (Python's tracer: a deep call stack is otherwise most of a
 * trace). Rebuilt here into full stacks that share what didn't change, and
 * heaps kept as what changed (trace/heapStore.ts: each step's heap a view
 * of its version), so a long trace costs memory for what changes rather
 * than for every snapshot.
 *
 * Objects are shared between steps, so nothing may change a trace's
 * objects in place (nothing does: renderers and applyHints only read).
 */
import { HeapStore } from "./heapStore";
import type { Frame, HeapObject, Step, Trace } from "./types";

/** A frame as sent: whole, or only its id when it's the same as in the step before. */
type SentFrame = Frame | { id: string; same: true };

/** A step as sent: its heap only what changed, and how to find the rest (see the top of this file). */
type SentStep = Step & { sameIds?: boolean; heapIdsPart?: [number, number, string[]] };

export function expandHeaps(trace: Trace): Trace {
  if (!trace.heapDelta) return trace;
  const expander = new HeapExpander();
  for (const step of trace.steps) expander.add(step);
  delete trace.heapDelta;
  return trace;
}

/**
 * Rebuilds steps sent as deltas into full ones, in order, one at a time:
 * a whole trace (expandHeaps), or a trace that arrives a piece at a time
 * while it runs (trace/stream.ts), each piece following on from the last.
 * Steps from the program's side are checked as they're rebuilt: a step of
 * the wrong shape throws, and so does a `__proto__` id (an assignment to it
 * would change the heap's prototype instead of adding an object).
 */
export class HeapExpander {
  /** The heaps so far, as what changed. */
  private readonly store = new HeapStore();
  private prevHeap: Record<string, HeapObject> | null = null;
  private prevFrames = new Map<string, Frame>();

  /** Rebuild `sent` in place (its heap, stack and paused frames), and return it. */
  add(sent: Step): Step {
    const step = sent as SentStep;
    if (typeof step !== "object" || step === null || typeof step.heap !== "object" || step.heap === null)
      throw new Error("a step isn't an object with a heap");
    // Frames first: the same as last step's, by id.
    const frames = new Map<string, Frame>();
    const rebuild = (list: SentFrame[] | undefined): Frame[] | undefined => {
      if (list !== undefined && !Array.isArray(list)) throw new Error("a step's stack isn't a list");
      return list?.map((frameSent) => {
        const frame = "same" in frameSent ? this.prevFrames.get(frameSent.id) : frameSent;
        if (!frame) throw new Error(`frame ${frameSent.id} isn't in the step before`);
        frames.set(frame.id, frame);
        return frame;
      });
    };
    step.stack = rebuild(step.stack as SentFrame[]) ?? [];
    if (step.suspended) step.suspended = rebuild(step.suspended as SentFrame[]);
    this.prevFrames = frames;

    // The ids: as sent, the same as before, or a change to the step before's.
    const part = step.heapIdsPart;
    if (
      part !== undefined &&
      (!Array.isArray(part) || !Array.isArray(part[2]) || !Number.isInteger(part[0]) || !Number.isInteger(part[1]))
    )
      throw new Error("a step's heap ids aren't a list");
    const changed = step.heap;
    for (const id in changed) if (id === "__proto__") throw new Error('it has a "__proto__" key');
    if (!step.sameIds && !part && step.heapIds === undefined) {
      // A full heap (a trace not sent as deltas): as it is.
      this.prevHeap = step.heap;
      return step;
    }
    if (!step.sameIds && !part && !Array.isArray(step.heapIds)) throw new Error("a step's heap ids aren't a list");
    // The same ids and nothing sent: the step before's heap itself (trace/graph.ts keeps what it worked out by heap).
    let sentAny = false;
    for (const _ in changed) {
      sentAny = true;
      break;
    }
    if (step.sameIds && !sentAny && this.prevHeap) {
      step.heap = this.prevHeap;
      delete step.sameIds;
      return step;
    }
    const heap = this.store.add(
      step.sameIds ? { same: true } : part ? { part } : { full: step.heapIds as string[] },
      changed,
    );
    step.heap = heap;
    this.prevHeap = heap;
    delete step.heapIds;
    delete step.sameIds;
    delete step.heapIdsPart;
    return step;
  }
}

/**
 * What made a heap, as the JavaScript runtime noted it when it committed
 * the step (js/runtime.ts): its ids in order, and the ids whose object
 * changed since it was last in a committed step (or is new). The encoder
 * reads these instead of scanning every object of every step. A heap with
 * no note (a step built some other way) is scanned as before.
 */
const heapNotes = new WeakMap<object, { ids: string[]; changed: string[] }>();

/** Note how a committed step's heap was made (see heapNotes). */
export function noteHeap(heap: Record<string, HeapObject>, ids: string[], changed: string[]): void {
  heapNotes.set(heap, { ids, changed });
}

/**
 * This step's ids as a change to the step before's: [how many of its first
 * ids are kept, how many of its last, and the ids between] (a new node at
 * the head of a list is one id, not every id again). Null when that saves
 * little. The same as the Python tracer's (worker/steplog.py ids_part).
 */
export function idsPart(before: readonly string[] | null, ids: readonly string[]): [number, number, string[]] | null {
  if (!before) return null;
  const n = before.length;
  const m = ids.length;
  const limit = Math.min(n, m);
  let head = 0;
  while (head < limit && before[head] === ids[head]) head++;
  let tail = 0;
  while (tail < limit - head && before[n - 1 - tail] === ids[m - 1 - tail]) tail++;
  if (head + tail < Math.floor(m / 2) || m < 16) return null;
  return [head, tail, ids.slice(head, m - tail)];
}

/**
 * The other way: full steps (a JavaScript trace's, whose unchanged objects
 * are the same objects from step to step) as deltas, for sending a trace a
 * piece at a time (js/serve.ts). Each object is sent when it isn't the one
 * last sent under its id; the ids as the same as the step before's, or a
 * change to them; and a frame that's the same as in the step before as its
 * id and `same`, as the Python tracer sends them. (A call 12 deep otherwise
 * sends all 12 frames every step: most of a recursive program's trace.)
 */
export class HeapEncoder {
  private readonly sent = new Map<string, HeapObject>();
  private prevIds: string[] | null = null;
  private prevFrames = new Map<string, Frame>();
  private prevHeap: Record<string, HeapObject> | null = null;

  /** `step` as sent: a copy, its heap only the objects not sent before. */
  encode(step: Step): Step {
    const heap: Record<string, HeapObject> = {};
    let ids: string[];
    const note = heapNotes.get(step.heap);
    if (step.heap === this.prevHeap && this.prevIds) {
      // The step before's heap itself: nothing to send, the same ids.
      ids = this.prevIds;
    } else if (note) {
      // The runtime said what changed: only those can be ones not sent before.
      ids = note.ids;
      for (const id of note.changed) {
        const obj = step.heap[id];
        if (this.sent.get(id) !== obj) {
          heap[id] = obj;
          this.sent.set(id, obj);
        }
      }
    } else {
      ids = [];
      for (const id in step.heap) {
        ids.push(id);
        const obj = step.heap[id];
        if (this.sent.get(id) !== obj) {
          heap[id] = obj;
          this.sent.set(id, obj);
        }
      }
    }
    this.prevHeap = step.heap;
    const out: SentStep = { ...step, heap };
    const prev = this.prevIds;
    if (prev && (prev === ids || (prev.length === ids.length && prev.every((id, i) => id === ids[i]))))
      out.sameIds = true;
    else {
      const part = idsPart(prev, ids);
      if (part) out.heapIdsPart = part;
      else out.heapIds = ids;
    }
    this.prevIds = ids;
    // Frames: the same as last step's (by id, and equal) as just their id.
    const frames = new Map<string, Frame>();
    const sendFrames = (list: Frame[]): SentFrame[] =>
      list.map((frame) => {
        frames.set(frame.id, frame);
        const before = this.prevFrames.get(frame.id);
        return before && (before === frame || sameData(before, frame)) ? { id: frame.id, same: true } : frame;
      });
    (out as { stack: SentFrame[] }).stack = sendFrames(step.stack);
    if (step.suspended) (out as { suspended?: SentFrame[] }).suspended = sendFrames(step.suspended);
    this.prevFrames = frames;
    return out;
  }
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
