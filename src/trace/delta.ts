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
  /** Every object's last version, from whichever step sent it. */
  private readonly known = new Map<string, HeapObject>();
  private prevIds: string[] = [];
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
    if (part !== undefined && (!Array.isArray(part) || !Array.isArray(part[2])))
      throw new Error("a step's heap ids aren't a list");
    const ids = step.sameIds
      ? this.prevIds
      : part
        ? [...this.prevIds.slice(0, part[0]), ...part[2], ...this.prevIds.slice(this.prevIds.length - part[1])]
        : step.heapIds;
    const changed = step.heap;
    for (const id in changed) {
      if (id === "__proto__") throw new Error('it has a "__proto__" key');
      this.known.set(id, changed[id]);
    }
    if (!ids) {
      // A full heap.
      this.prevIds = Object.keys(step.heap);
      this.prevHeap = step.heap;
      return step;
    }
    if (!Array.isArray(ids)) throw new Error("a step's heap ids aren't a list");
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
    const heap: Record<string, HeapObject> = {};
    for (const id of ids) {
      if (id === "__proto__") throw new Error('it has a "__proto__" key');
      const obj = this.known.get(id);
      if (obj) heap[id] = obj;
    }
    step.heap = heap;
    this.prevHeap = heap;
    delete step.heapIds;
    delete step.sameIds;
    delete step.heapIdsPart;
    this.prevIds = ids;
    return step;
  }
}

/**
 * The other way: full steps (a JavaScript trace's, whose unchanged objects
 * are the same objects from step to step) as deltas, for sending a trace a
 * piece at a time (js/serve.ts). Each object is sent when it isn't the one
 * last sent under its id; frames are sent whole.
 */
export class HeapEncoder {
  private readonly sent = new Map<string, HeapObject>();
  private prevIds: string[] | null = null;

  /** `step` as sent: a copy, its heap only the objects not sent before. */
  encode(step: Step): Step {
    const heap: Record<string, HeapObject> = {};
    const ids: string[] = [];
    for (const id in step.heap) {
      ids.push(id);
      const obj = step.heap[id];
      if (this.sent.get(id) !== obj) {
        heap[id] = obj;
        this.sent.set(id, obj);
      }
    }
    const out: SentStep = { ...step, heap };
    const prev = this.prevIds;
    if (prev && prev.length === ids.length && prev.every((id, i) => id === ids[i])) out.sameIds = true;
    else out.heapIds = ids;
    this.prevIds = ids;
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
