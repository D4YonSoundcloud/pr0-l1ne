/**
 * Compares two consecutive snapshots and reports what changed. The renderer
 * uses this to highlight cells and variables; it never inspects code.
 */
import type { HeapObject, Step, Value } from "./types";

/** A string that is equal for equal values, used for comparison and as map keys. */
export function valueKey(value: Value): string {
  return value.kind === "prim" ? `p:${value.type}:${value.repr}` : `r:${value.id}`;
}

export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  if (!a || !b) return a === b;
  return valueKey(a) === valueKey(b);
}

/**
 * Every object kind is a list of named slots. A slot key is the index for a
 * sequence, the key for a dict, and the field name for objects and functions.
 */
export function slotsOf(obj: HeapObject): Map<string, Value> {
  const slots = new Map<string, Value>();
  switch (obj.kind) {
    case "list":
    case "tuple":
    case "set":
      obj.items.forEach((item, index) => slots.set(String(index), item));
      break;
    case "dict":
      for (const [key, val] of obj.entries) slots.set(valueKey(key), val);
      break;
    case "object":
    case "function":
      for (const [name, val] of obj.fields) slots.set(name, val);
      break;
    case "opaque":
      slots.set("*", { kind: "prim", type: "repr", repr: obj.repr });
      break;
    case "class":
      break;
  }
  return slots;
}

/** Slot keys of `next` whose value differs from `prev` (or that are new). */
export function changedSlots(prev: HeapObject | undefined, next: HeapObject): Set<string> {
  const changed = new Set<string>();
  if (!prev || prev.kind !== next.kind) return changed;
  const before = slotsOf(prev);
  for (const [key, value] of slotsOf(next)) {
    if (!sameValue(before.get(key), value)) changed.add(key);
  }
  return changed;
}

export interface StepDiff {
  /** `${frameId}/${name}` for locals that changed or appeared. */
  changedLocals: Set<string>;
  /** Object id -> slot keys that changed. */
  changedSlots: Map<string, Set<string>>;
  /** Objects that did not exist at the previous step. */
  newObjects: Set<string>;
  /** Frames that did not exist at the previous step (a new call). */
  newFrames: Set<string>;
}

export const localKey = (frameId: string, name: string) => `${frameId}/${name}`;

export function diffSteps(prev: Step | undefined, next: Step): StepDiff {
  const diff: StepDiff = {
    changedLocals: new Set(),
    changedSlots: new Map(),
    newObjects: new Set(),
    newFrames: new Set(),
  };
  if (!prev) return diff;

  const prevFrames = new Map(prev.stack.map((frame) => [frame.id, frame]));
  for (const frame of next.stack) {
    const before = prevFrames.get(frame.id);
    if (!before) {
      diff.newFrames.add(frame.id);
      continue;
    }
    const beforeLocals = new Map(before.locals);
    for (const [name, value] of frame.locals) {
      if (!sameValue(beforeLocals.get(name), value)) diff.changedLocals.add(localKey(frame.id, name));
    }
  }

  for (const [id, obj] of Object.entries(next.heap)) {
    const before = prev.heap[id];
    if (!before) {
      diff.newObjects.add(id);
      continue;
    }
    const slots = changedSlots(before, obj);
    if (slots.size) diff.changedSlots.set(id, slots);
  }
  return diff;
}
