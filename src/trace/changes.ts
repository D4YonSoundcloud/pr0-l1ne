/**
 * What changed at a step, in words: `i: 1 → 2`, `nums[2]: 5 → 3`,
 * `node.next: Node → None`. The memory view shows the same changes as
 * highlights (diff.ts); this says them, for the Changes list under the code
 * and for screen readers.
 *
 * A change is named the way the program would reach it: a variable, then
 * indexes, keys and fields from there (the shortest way, from the running
 * frame's variables first). Lists drawn as a window of a long one
 * (`offset`) are compared only where the two windows meet, so the window
 * moving along isn't a change.
 */
import { slotsOf, valueKey } from "./diff";
import type { ValueTarget } from "./history";
import { type Frame, type HeapObject, liveFrames, type Step, type Value } from "./types";

export interface StepChange {
  /** What changed, as code would name it: "i", "nums[2]", "node.next", "counts['a']". */
  name: string;
  /** Its value before, as shown; null when it's new. */
  before: string | null;
  /** Its value now, as shown; null when it's gone. */
  after: string | null;
  /** The function whose variable it is, when that's not the one running. */
  frame?: string;
  /** What it is, to follow over the run (trace/history.ts); none for a set's items, which have no place. */
  target?: ValueTarget;
}

export interface StepChanges {
  changes: StepChange[];
  /** Changes past the ones listed. */
  more: number;
}

/** At most this many changes are listed for a step. */
export const MAX_CHANGES = 40;
/** Items shown in a list's or dict's value. */
const PREVIEW_ITEMS = 6;

/** What changed from `prev` to `step` (nothing for the first step). */
export function stepChanges(prev: Step | undefined, step: Step, max = MAX_CHANGES): StepChanges {
  const out: StepChange[] = [];
  if (!prev) return { changes: [], more: 0 };
  const frames = liveFrames(step);
  const running = step.stack.at(-1);

  // Variables: in the running frame first, then the frames that called it, then paused ones.
  const prevFrames = new Map(liveFrames(prev).map((f) => [f.id, f]));
  for (const frame of orderFrames(frames, running)) {
    const before = prevFrames.get(frame.id);
    const was = new Map(before?.locals ?? []);
    const where = frame === running ? {} : { frame: frame.func };
    for (const [name, value] of frame.locals) {
      const old = was.get(name);
      if (old && valueKey(old) === valueKey(value)) continue;
      out.push({
        name,
        before: old ? show(old, prev) : null,
        after: show(value, step),
        ...where,
        target: { kind: "var", frame: frame.id, name },
      });
    }
    if (!before) continue;
    const now = new Set(frame.locals.map(([name]) => name));
    for (const [name, value] of before.locals)
      if (!now.has(name))
        out.push({
          name,
          before: show(value, prev),
          after: null,
          ...where,
          target: { kind: "var", frame: frame.id, name },
        });
  }

  // What's inside objects, by the shortest name each has from a variable.
  const names = objectNames(step, orderFrames(frames, running));
  for (const [id, obj] of Object.entries(step.heap)) {
    const old = prev.heap[id];
    if (!old || old.kind !== obj.kind) continue;
    const name = names.get(id) ?? obj.typeName;
    for (const slot of changedSlotsOf(old, obj))
      out.push({
        name: `${name}${slot.label}`,
        before: slot.before ? show(slot.before, prev) : null,
        after: slot.after ? show(slot.after, step) : null,
        ...(slot.slot !== undefined ? { target: { kind: "slot" as const, object: id, slot: slot.slot } } : {}),
      });
  }
  return out.length > max ? { changes: out.slice(0, max), more: out.length - max } : { changes: out, more: 0 };
}

/** The running frame, then the ones below it on the stack (callers), then paused generators. */
function orderFrames(frames: Frame[], running: Frame | undefined): Frame[] {
  const stack = frames.filter((f) => f.state !== "suspended").reverse();
  const paused = frames.filter((f) => f.state === "suspended");
  return running ? [running, ...stack.filter((f) => f !== running), ...paused] : [...stack, ...paused];
}

/** Each object's shortest name from a variable: `grid[2]`, `node.next.next`, `counts['a']`. */
export function objectNames(step: Step, frames: Frame[]): Map<string, string> {
  const names = new Map<string, string>();
  const queue: string[] = [];
  const reach = (value: Value, name: string) => {
    if (value.kind !== "ref" || names.has(value.id) || !step.heap[value.id]) return;
    names.set(value.id, name);
    queue.push(value.id);
  };
  for (const frame of frames) for (const [name, value] of frame.locals) reach(value, name);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const obj = step.heap[id];
    const name = names.get(id)!;
    switch (obj.kind) {
      case "list":
      case "tuple": {
        const offset = obj.offset ?? 0;
        for (let k = 0; k < obj.items.length; k++) reach(obj.items[k], `${name}[${offset + k}]`);
        break;
      }
      case "dict":
        for (const [key, value] of obj.entries) reach(value, `${name}${keyAccess(key)}`);
        break;
      case "object":
        for (const [field, value] of obj.fields) reach(value, `${name}.${field}`);
        break;
      default:
        // A set's items, a function's or a class's insides: nothing a program indexes.
        break;
    }
  }
  return names;
}

interface SlotChange {
  /** How the slot is reached from its object: "[2]", "['a']", ".next". */
  label: string;
  before: Value | null;
  after: Value | null;
  /** Its key among the object's slots (diff.ts slotsOf); none for a set's items. */
  slot?: string;
}

/** The slots of an object that changed, appeared or went. */
function changedSlotsOf(old: HeapObject, obj: HeapObject): SlotChange[] {
  const out: SlotChange[] = [];
  if (obj.kind === "list" || obj.kind === "tuple" || obj.kind === "set") {
    if (old.kind !== obj.kind) return out;
    // A set has no places: what's in it and what isn't any more.
    if (obj.kind === "set") {
      const was = new Set(old.items.map(valueKey));
      const now = new Set(obj.items.map(valueKey));
      for (const item of obj.items) if (!was.has(valueKey(item))) out.push({ label: " +", before: null, after: item });
      for (const item of old.items) if (!now.has(valueKey(item))) out.push({ label: " −", before: item, after: null });
      return out;
    }
    const oldStart = old.offset ?? 0;
    const start = obj.offset ?? 0;
    // Where the two windows meet, the items are compared; past the old length they're new, past the new one gone.
    for (let k = 0; k < obj.items.length; k++) {
      const index = start + k;
      const at = index - oldStart;
      const item = obj.items[k];
      if (at >= 0 && at < old.items.length) {
        if (valueKey(old.items[at]) !== valueKey(item))
          out.push({ label: `[${index}]`, before: old.items[at], after: item, slot: String(index) });
      } else if (index >= old.length) out.push({ label: `[${index}]`, before: null, after: item, slot: String(index) });
    }
    for (let k = 0; k < old.items.length; k++) {
      const index = oldStart + k;
      if (index >= obj.length)
        out.push({ label: `[${index}]`, before: old.items[k], after: null, slot: String(index) });
    }
    return out;
  }
  const before = slotsOf(old);
  const after = slotsOf(obj);
  const label = (key: string): string => {
    if (obj.kind === "dict" || old.kind === "dict") {
      const entry =
        (obj.kind === "dict" ? obj.entries : []).find(([k]) => valueKey(k) === key) ??
        (old.kind === "dict" ? old.entries : []).find(([k]) => valueKey(k) === key);
      return entry ? keyAccess(entry[0]) : `[${key}]`;
    }
    if (obj.kind === "opaque") return "";
    return `.${key}`;
  };
  for (const [key, value] of after) {
    const was = before.get(key);
    if (was && valueKey(was) === valueKey(value)) continue;
    out.push({ label: label(key), before: was ?? null, after: value, slot: key });
  }
  for (const [key, value] of before)
    if (!after.has(key)) out.push({ label: label(key), before: value, after: null, slot: key });
  return out;
}

/** Reaching a dict's entry as code would: `['a']` (Python), `.a` (a JavaScript object's own key), `[3]`. */
function keyAccess(key: Value): string {
  if (key.kind !== "prim") return "[…]";
  if (key.type === "key") return /^[A-Za-z_$][\w$]*$/.test(key.repr) ? `.${key.repr}` : `[${JSON.stringify(key.repr)}]`;
  return `[${key.repr}]`;
}

/** A value as the Changes list shows it: a number or a string as it's written, an object briefly. */
export function show(value: Value, step: Step): string {
  if (value.kind === "prim") return value.repr;
  const obj = step.heap[value.id];
  return obj ? preview(obj, step) : "…";
}

/** An object in a few words: `[5, 3, 8]`, `{'a': 1, 'b': 2}`, `Node(val=3, next=Node)`. */
function preview(obj: HeapObject, step: Step): string {
  const inner = (value: Value): string => {
    if (value.kind === "prim") return value.repr;
    const o = step.heap[value.id];
    if (!o) return "…";
    if (o.kind === "list") return o.length ? "[…]" : "[]";
    if (o.kind === "tuple") return o.length ? "(…)" : "()";
    if (o.kind === "dict") return o.length ? "{…}" : "{}";
    if (o.kind === "function" || o.kind === "class") return o.name;
    return o.typeName;
  };
  const items = (list: string[], length: number, open: string, close: string) => {
    const shown = list.slice(0, PREVIEW_ITEMS);
    const rest = length - shown.length;
    const body = rest > 0 ? `${shown.join(", ")}, …` : shown.join(", ");
    return rest > 0 && length > PREVIEW_ITEMS * 2
      ? `${open}${body}${close} (${length.toLocaleString()} items)`
      : `${open}${body}${close}`;
  };
  switch (obj.kind) {
    case "list":
      // A window of a long list: from where it starts.
      return (obj.offset ?? 0) > 0
        ? `[…] (${obj.length.toLocaleString()} items)`
        : items(obj.items.map(inner), obj.length, "[", "]");
    case "tuple":
      return items(obj.items.map(inner), obj.length, "(", ")");
    case "set":
      return obj.length ? items(obj.items.map(inner), obj.length, "{", "}") : `${obj.typeName}()`;
    case "dict":
      return items(
        obj.entries.map(([k, v]) => `${inner(k)}: ${inner(v)}`),
        obj.length,
        "{",
        "}",
      );
    case "object": {
      const fields = obj.fields.slice(0, 3).map(([name, v]) => `${name}=${inner(v)}`);
      if (!fields.length) return obj.typeName;
      return `${obj.typeName}(${fields.join(", ")}${obj.fields.length > 3 ? ", …" : ""})`;
    }
    case "function":
      return `function ${obj.name}`;
    case "class":
      return `class ${obj.name}`;
    case "opaque":
      return obj.repr;
  }
}
