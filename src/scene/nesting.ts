/**
 * Nested mode: which objects are drawn inside the one thing that refers to
 * them ("container in container"), and which stay boxes of their own.
 */
import { slotsOf } from "../trace/diff";
import { type HeapObject, liveFrames, type Step, type Value } from "../trace/types";

/** Nesting deeper than this switches back to arrows, so boxes stay readable. */
export const MAX_NEST_DEPTH = 6;

/** Every value an object holds, including dict keys. */
export function valuesOf(obj: HeapObject): Value[] {
  const values: Value[] = [];
  if (obj.kind === "dict") for (const [key] of obj.entries) values.push(key);
  values.push(...slotsOf(obj).values());
  return values;
}

/** References an object holds that could be drawn inside it (not dict keys). */
function nestableChildren(obj: HeapObject): string[] {
  const ids: string[] = [];
  for (const value of slotsOf(obj).values()) if (value.kind === "ref") ids.push(value.id);
  return ids;
}

/**
 * Which objects to draw inside the thing that refers to them. An object is
 * nested when exactly one reference to it exists in this snapshot (from a
 * variable, a field, an item or the return value). Anything referenced twice
 * (aliasing), part of a cycle, or nested deeper than MAX_NEST_DEPTH stays a
 * separate box, because only an arrow can show "these point at the same
 * object".
 */
export function chooseNested(step: Step): Set<string> {
  const incoming = new Map<string, number>();
  const count = (value: Value | undefined) => {
    if (value?.kind === "ref") incoming.set(value.id, (incoming.get(value.id) ?? 0) + 1);
  };
  for (const frame of liveFrames(step)) for (const [, value] of frame.locals) count(value);
  count(step.returnValue);
  for (const obj of Object.values(step.heap)) for (const value of valuesOf(obj)) count(value);

  const nested = new Set<string>();
  const visited = new Set<string>();
  const tryNest = (id: string, depth: number) => {
    const obj = step.heap[id];
    if (!obj || visited.has(id) || incoming.get(id) !== 1 || depth > MAX_NEST_DEPTH) return;
    visited.add(id);
    nested.add(id);
    for (const child of nestableChildren(obj)) tryNest(child, depth + 1);
  };
  // Start from the variables, then from every object that stayed separate,
  // so things inside a shared object can still nest inside it.
  for (const frame of liveFrames(step))
    for (const [, value] of frame.locals) if (value.kind === "ref") tryNest(value.id, 1);
  if (step.returnValue?.kind === "ref") tryNest(step.returnValue.id, 1);
  for (const [id, obj] of Object.entries(step.heap)) {
    if (nested.has(id)) continue;
    visited.add(id);
    for (const child of nestableChildren(obj)) tryNest(child, 1);
  }
  return nested;
}
