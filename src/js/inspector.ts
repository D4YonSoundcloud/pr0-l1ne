/**
 * The value inspector: how the JavaScript tracer sees the program's values.
 * Serializer turns values into the trace's Values and heap objects (in the
 * same format as the Python tracer's serialize.py), and inspect() formats
 * them for console.log, close to what Node and browsers print. Neither runs
 * user code: getters are shown, not called.
 */

import type { Frame, HeapObject, PrimValue, SequenceObject, Value } from "../trace/types";

/** [name, () => value] for each visible variable, produced by the instrumenter. */
export type Getter = () => [string, () => unknown][];

export const MAX_ITEMS = 60;
const MAX_REPR = 48;
export const MAX_OBJECTS = 2000;

const prim = (type: string, repr: string): PrimValue => ({
  kind: "prim",
  type,
  repr: repr.length > MAX_REPR ? `${repr.slice(0, MAX_REPR - 1)}…` : repr,
});

/** Reads a property without running user code (getters show as "(getter)"). */
function readOwn(obj: object, key: PropertyKey): { value: unknown } | { getter: true } {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) return { value: undefined };
  return "value" in desc ? { value: desc.value } : { getter: true };
}

function constructorName(obj: object): string {
  const proto = Object.getPrototypeOf(obj);
  if (!proto) return "Object";
  const ctor = Object.getOwnPropertyDescriptor(proto, "constructor")?.value;
  return typeof ctor === "function" && ctor.name ? ctor.name : "Object";
}

function isPlainObject(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  return proto === null || proto === Object.prototype;
}

export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error === "object" && error !== null ? constructorName(error) : typeof error;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return typeof error === "string" ? error : inspect(error);
  } catch {
    return String(error);
  }
}

/** Parameter names from a function's source text. */
export function parseParams(source: string): string[] {
  const single = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(source);
  if (single) return [single[1]];
  const open = source.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let current = "";
  const params: string[] = [];
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) {
      params.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  params.push(current);
  return params.map((p) => p.split("=")[0].trim()).filter(Boolean);
}

// biome-ignore lint/complexity/noBannedTypes: built-in constructors (Date, RegExp...) used with instanceof
// biome-ignore lint/suspicious/noExplicitAny: each formatter takes its own constructor's instances
const OPAQUE_TYPES: [Function, (v: any) => string][] = [
  [Date, (v: Date) => (Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString())],
  [RegExp, (v: RegExp) => String(v)],
  [Error, (v: Error) => `${v.name}: ${v.message}`],
  [Promise, () => "Promise"],
  [WeakMap, () => "WeakMap"],
  [WeakSet, () => "WeakSet"],
  [ArrayBuffer, (v: ArrayBuffer) => `ArrayBuffer(${v.byteLength})`],
];

// Long lists: the cells shown follow the index variables (a window of
// MAX_ITEMS), and a strip of evenly spaced samples shows the whole list.
const STRIP_SAMPLES = 256;
/** Names that conventionally hold an index (as render/draw.ts's pointersFor). */
export const CONVENTIONAL_POINTERS = [
  "lo",
  "hi",
  "low",
  "high",
  "left",
  "right",
  "l",
  "r",
  "start",
  "end",
  "mid",
  "slow",
  "fast",
];

/** Where the window of MAX_ITEMS cells starts, to show these indices. Moves in steps of 10. */
export function windowStart(indices: number[], length: number): number {
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  const center = hi - lo < MAX_ITEMS - 4 ? Math.floor((lo + hi) / 2) : lo;
  const start = Math.floor(Math.max(0, center - MAX_ITEMS / 2) / 10) * 10;
  return Math.max(0, Math.min(start, length - MAX_ITEMS));
}

/** Evenly spaced samples of a long list of numbers, or null if it holds anything else. */
function stripOf(read: (i: number) => unknown, n: number): { values: number[]; min: number; max: number } | null {
  const count = Math.min(STRIP_SAMPLES, n);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    let x = read(Math.floor((i * n) / count));
    if (typeof x === "boolean") x = Number(x);
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    values.push(x);
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { values, min, max };
}

export const isListLike = (v: unknown): v is ArrayLike<unknown> =>
  Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));

/** What a heap object or frame was made from (slotsOf), and what it was. */
export interface Reused<T> {
  slots: unknown[];
  made: T;
}

/** Each object's last heap object, and each frame's last view, kept between steps (Serializer). */
export interface ReuseCache {
  objects: Map<string, Reused<HeapObject>>;
  frames: Map<string, Reused<Frame>>;
}

export const newReuseCache = (): ReuseCache => ({ objects: new Map(), frames: new Map() });

/** A getter in a slot (its value isn't read) or a variable before its declaration. */
const UNREAD = Symbol("unread");

/** The same things in the same order (Object.is: -0 and 0 differ, as their reprs do). */
function sameSlots(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * What an object's heap object is made from, flat: its prototype and
 * length, then what it holds (and its keys), to tell cheaply whether it
 * changed since the last step. Null for what isn't worth it or can't be
 * told this way: long lists (their window follows the index variables),
 * functions (their closures), and anything that isn't an array, a Map, a
 * Set or an object with plain own properties.
 */
function slotsOf(obj: object): unknown[] | null {
  const own = (key: PropertyKey) => {
    const read = readOwn(obj, key);
    return "getter" in read ? UNREAD : read.value;
  };
  if (Array.isArray(obj)) {
    if (obj.length > MAX_ITEMS) return null;
    const slots: unknown[] = [Object.getPrototypeOf(obj), obj.length];
    for (let i = 0; i < obj.length; i++) slots.push(own(i));
    return slots;
  }
  if (typeof obj === "function" || ArrayBuffer.isView(obj)) return null;
  if (obj instanceof Map) {
    if (obj.size > MAX_ITEMS) return null;
    const slots: unknown[] = [Map, obj.size];
    for (const [k, v] of Map.prototype.entries.call(obj)) slots.push(k, v);
    return slots;
  }
  if (obj instanceof Set) {
    if (obj.size > MAX_ITEMS) return null;
    return [Set, obj.size, ...Set.prototype.values.call(obj)];
  }
  const tag = Object.prototype.toString.call(obj).slice(8, -1);
  if (tag !== "Object") return null; // Dates, generators, promises...
  if (OPAQUE_TYPES.some(([type]) => obj instanceof type)) return null;
  const keys = Object.keys(obj);
  if (keys.length > MAX_ITEMS) return null;
  const slots: unknown[] = [Object.getPrototypeOf(obj), keys.length];
  for (const key of keys) slots.push(key, own(key));
  return slots;
}

export class Serializer {
  readonly heap: Record<string, HeapObject> = {};
  private count = 0;

  constructor(
    private readonly ids: WeakMap<object, string>,
    private readonly newId: () => string,
    // biome-ignore lint/complexity/noBannedTypes: keys are the user's own functions and classes, of any shape
    private readonly closures: WeakMap<Function, { name: string; captured: Getter }>,
    /** Long lists' index variables' values (see windowStart). */
    private readonly focus: Map<object, number[]> = new Map(),
    /**
     * Last step's heap objects and frames, by id, with what they were made
     * from: one holding the same things gets the same object back, without
     * being described again (and the trace shares it between steps). Only
     * what it holds is visited, so the heap still has everything reachable.
     */
    private readonly reuse: ReuseCache = newReuseCache(),
  ) {}

  /** A frame of the stack: the same view as last step if its line and variables are the same. */
  frame(id: string, func: string, line: number, getter: Getter): Frame {
    const slots: unknown[] = [line];
    for (const [name, read] of getter()) {
      let value: unknown;
      try {
        value = read();
      } catch {
        value = UNREAD; // let/const before its declaration (temporal dead zone)
      }
      slots.push(name, value);
    }
    const known = this.reuse.frames.get(id);
    if (known && known.made.func === func && sameSlots(known.slots, slots)) {
      for (let i = 2; i < slots.length; i += 2) this.visit(slots[i]);
      return known.made;
    }
    const locals: [string, Value][] = [];
    for (let i = 1; i < slots.length; i += 2) {
      if (slots[i + 1] !== UNREAD) locals.push([slots[i] as string, this.value(slots[i + 1])]);
    }
    const made: Frame = { id, func, line, locals };
    this.reuse.frames.set(id, { slots, made });
    return made;
  }

  /** Put an object (and what it holds) in this step's heap. */
  private visit(v: unknown): void {
    if ((typeof v === "object" && v !== null) || typeof v === "function") this.ref(v as object);
  }

  locals(getter: Getter): [string, Value][] {
    const out: [string, Value][] = [];
    for (const [name, read] of getter()) {
      let value: unknown;
      try {
        value = read();
      } catch {
        continue; // let/const before its declaration (temporal dead zone)
      }
      out.push([name, this.value(value)]);
    }
    return out;
  }

  value(v: unknown): Value {
    switch (typeof v) {
      case "number":
        return prim("number", Object.is(v, -0) ? "-0" : String(v));
      case "string": {
        // A shortened string still knows its real length, for memory sizes.
        const value = prim("string", JSON.stringify(v));
        if (value.repr.endsWith("…")) value.length = v.length;
        return value;
      }
      case "boolean":
        return prim("boolean", String(v));
      case "undefined":
        return prim("undefined", "undefined");
      case "bigint":
        return prim("bigint", `${v}n`);
      case "symbol":
        return prim("symbol", v.toString());
    }
    if (v === null) return prim("null", "null");
    return { kind: "ref", id: this.ref(v as object) };
  }

  private ref(obj: object): string {
    let id = this.ids.get(obj);
    if (!id) {
      id = this.newId();
      this.ids.set(obj, id);
    }
    if (id in this.heap) return id;
    if (this.count >= MAX_OBJECTS) {
      this.heap[id] = { kind: "opaque", id, typeName: constructorName(obj), repr: "…" };
      return id;
    }
    this.count++;
    this.heap[id] = { kind: "opaque", id, typeName: "", repr: "" }; // placeholder for cycles
    const slots = slotsOf(obj);
    const known = slots ? this.reuse.objects.get(id) : undefined;
    if (slots && known && sameSlots(known.slots, slots)) {
      // Unchanged: the same heap object, and only what it holds visited (keys and values).
      this.heap[id] = known.made;
      for (let i = 2; i < slots.length; i++) this.visit(slots[i]);
      return id;
    }
    this.heap[id] = this.describe(obj, id);
    if (slots) this.reuse.objects.set(id, { slots, made: this.heap[id] });
    return id;
  }

  private items(values: Iterable<unknown>): Value[] {
    const out: Value[] = [];
    for (const value of values) {
      if (out.length >= MAX_ITEMS) break;
      out.push(this.value(value));
    }
    return out;
  }

  private slot(obj: object, key: PropertyKey): Value {
    const read = readOwn(obj, key);
    return "getter" in read ? prim("getter", "(getter)") : this.value(read.value);
  }

  private describe(obj: object, id: string): HeapObject {
    if (Array.isArray(obj)) {
      const n = obj.length;
      const indices = n > MAX_ITEMS ? this.focus.get(obj) : undefined;
      const start = indices ? windowStart(indices, n) : 0;
      const items: Value[] = [];
      for (let i = start; i < Math.min(n, start + MAX_ITEMS); i++) items.push(this.slot(obj, i));
      const out: SequenceObject = { kind: "list", id, typeName: "Array", items, length: n };
      if (start) out.offset = start;
      if (n > MAX_ITEMS) {
        const strip = stripOf((i) => {
          const r = readOwn(obj, i);
          return "getter" in r ? undefined : r.value;
        }, n);
        if (strip) out.strip = strip;
      }
      return out;
    }
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      const view = obj as unknown as ArrayLike<number>;
      const n = view.length;
      const indices = n > MAX_ITEMS ? this.focus.get(obj) : undefined;
      const start = indices ? windowStart(indices, n) : 0;
      const items: Value[] = [];
      for (let i = start; i < Math.min(n, start + MAX_ITEMS); i++) items.push(this.value(view[i]));
      const out: SequenceObject = { kind: "list", id, typeName: constructorName(obj), items, length: n };
      if (start) out.offset = start;
      if (n > MAX_ITEMS) {
        const strip = stripOf((i) => view[i], n);
        if (strip) out.strip = strip;
      }
      return out;
    }
    if (obj instanceof Map) {
      const entries: [Value, Value][] = [];
      for (const [key, value] of Map.prototype.entries.call(obj)) {
        if (entries.length >= MAX_ITEMS) break;
        entries.push([this.value(key), this.value(value)]);
      }
      return { kind: "dict", id, typeName: "Map", entries, length: obj.size };
    }
    if (obj instanceof Set) {
      return { kind: "set", id, typeName: "Set", items: this.items(Set.prototype.values.call(obj)), length: obj.size };
    }
    if (typeof obj === "function") {
      const source = Function.prototype.toString.call(obj);
      if (/^class[\s{]/.test(source)) return { kind: "class", id, typeName: "class", name: obj.name || "anonymous" };
      const builtin = source.includes("[native code]");
      const closure = this.closures.get(obj);
      return {
        kind: "function",
        id,
        typeName: "function",
        name: closure?.name ?? (obj.name || "anonymous"),
        params: builtin ? [] : parseParams(source),
        fields: closure ? this.locals(closure.captured) : [],
        builtin,
      };
    }
    // Generators and promises have no visible state in JavaScript; name them.
    const tag = Object.prototype.toString.call(obj).slice(8, -1);
    if (tag === "Generator" || tag === "AsyncGenerator") {
      return {
        kind: "opaque",
        id,
        typeName: tag,
        repr: tag === "Generator" ? "generator object" : "async generator object",
      };
    }
    for (const [type, show] of OPAQUE_TYPES) {
      if (obj instanceof type) return { kind: "opaque", id, typeName: constructorName(obj), repr: show(obj) };
    }

    const keys = Object.keys(obj);
    if (isPlainObject(obj)) {
      // Plain objects are JavaScript's everyday dictionary, so draw them as
      // one. Keys are shown unquoted.
      const entries: [Value, Value][] = keys.slice(0, MAX_ITEMS).map((key) => [prim("key", key), this.slot(obj, key)]);
      return { kind: "dict", id, typeName: "Object", entries, length: keys.length };
    }
    return {
      kind: "object",
      id,
      typeName: constructorName(obj),
      fields: keys.slice(0, MAX_ITEMS).map((key) => [key, this.slot(obj, key)]),
    };
  }
}

// ---------------------------------------------------------------------------
// console.log formatting, close to what Node and browsers print
// ---------------------------------------------------------------------------

export function inspect(value: unknown, depth = 0, seen = new Set<object>()): string {
  switch (typeof value) {
    case "string":
      return depth === 0 ? value : `'${value}'`;
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function": {
      const source = Function.prototype.toString.call(value);
      if (/^class[\s{]/.test(source)) return `[class ${value.name || "(anonymous)"}]`;
      return value.name ? `[Function: ${value.name}]` : "[Function (anonymous)]";
    }
    case "object":
      break;
    default:
      return String(value);
  }
  if (value === null) return "null";
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof RegExp) return String(obj);
  if (obj instanceof Error) return `${obj.name}: ${obj.message}`;
  if (depth > 2) return Array.isArray(obj) ? "[Array]" : "[Object]";

  seen.add(obj);
  const show = (v: unknown) => inspect(v, depth + 1, seen);
  const read = (o: object, k: PropertyKey) => {
    const r = readOwn(o, k);
    return "getter" in r ? "[Getter]" : show(r.value);
  };
  let text: string;
  if (Array.isArray(obj)) {
    const parts = obj.slice(0, 100).map((_, i) => read(obj, i));
    if (obj.length > 100) parts.push(`... ${obj.length - 100} more items`);
    text = parts.length ? `[ ${parts.join(", ")} ]` : "[]";
  } else if (obj instanceof Map) {
    const parts = [...obj].map(([k, v]) => `${show(k)} => ${show(v)}`);
    text = `Map(${obj.size}) ${parts.length ? `{ ${parts.join(", ")} }` : "{}"}`;
  } else if (obj instanceof Set) {
    const parts = [...obj].map(show);
    text = `Set(${obj.size}) ${parts.length ? `{ ${parts.join(", ")} }` : "{}"}`;
  } else {
    const parts = Object.keys(obj).map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${read(obj, k)}`);
    const name = constructorName(obj);
    const body = parts.length ? `{ ${parts.join(", ")} }` : "{}";
    text = name === "Object" ? body : `${name} ${body}`;
  }
  seen.delete(obj);
  return text;
}
