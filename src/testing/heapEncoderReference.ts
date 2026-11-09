/**
 * The heap encoder as it was before it read what each step changed from
 * the runtime (trace/delta.ts HeapEncoder): every step's heap scanned for
 * the objects not sent before. The tests hold the fast one to this: the
 * same steps, sent the same way, byte for byte.
 */
import { idsPart, sameData } from "../trace/delta";
import type { Frame, HeapObject, Step } from "../trace/types";

type SentFrame = Frame | { id: string; same: true };
type SentStep = Step & { sameIds?: boolean; heapIdsPart?: [number, number, string[]]; heapIds?: string[] };

export class HeapEncoderReference {
  private readonly sent = new Map<string, HeapObject>();
  private prevIds: string[] | null = null;
  private prevFrames = new Map<string, Frame>();

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
