/**
 * How much memory things take, under one of three models:
 *
 *   python    What a 64-bit CPython really uses (sys.getsizeof, recorded by
 *             the tracer; converted from 32-bit when it runs in the browser).
 *             Every value is an object: an int is 28 bytes, and a list slot
 *             is an 8-byte pointer to it.
 *   textbook  The model algorithm courses use: an 8-byte slot per element,
 *             numbers stored in the slot, a string takes one byte a
 *             character, a hash map 16 bytes (key + value) per entry.
 *             Language-neutral, so sizes are easy to reason about: an array
 *             of n numbers is 8n bytes.
 *   v8        An estimate of what V8 (Chrome, Node) uses on 64-bit with
 *             pointer compression: 4-byte slots, small integers stored in
 *             the slot, 12-byte object headers. JavaScript can't measure
 *             objects, so these are approximations, shown with "≈".
 *
 * For each object there are two numbers: its own size (the object itself:
 * header and slots) and its total (own plus everything it holds, with
 * anything reachable twice counted once).
 */
import { liveFrames, type Frame, type HeapObject, type PrimValue, type Step, type Trace, type Value } from "./types";

export type SizeModel = "python" | "textbook" | "v8";

export const SIZE_MODELS: Record<"python" | "javascript", { value: SizeModel; label: string; title: string }[]> = {
  python: [
    { value: "python", label: "Python (64-bit)", title: "What a 64-bit CPython uses (sys.getsizeof)" },
    { value: "textbook", label: "Textbook", title: "8-byte slots, numbers in the slot, 1 byte per character" },
  ],
  javascript: [
    { value: "textbook", label: "Textbook", title: "8-byte slots, numbers in the slot, 1 byte per character" },
    { value: "v8", label: "Estimated (V8)", title: "An estimate of what Chrome's V8 engine uses" },
  ],
};

export interface StepSizes {
  model: SizeModel;
  /** True when the numbers are estimates (V8). */
  approximate: boolean;
  /** The object itself: its header and slots. Null when the model has no answer. */
  own(id: string): number | null;
  /** The object and everything it holds, shared things counted once. */
  total(id: string): number | null;
  /** What one stored value costs: its slot, plus what it needs elsewhere. */
  cell(value: Value, container?: HeapObject): number | null;
  /** What a frame's variables keep alive. */
  frame(frame: Frame): number;
  /** Everything these values reach, each object once (e.g. a graph's nodes). */
  of(values: Value[]): number;
  /** Everything in the program at this step. */
  program: number;
  /** Python lists: their capacity, for "room for 8". */
  capacity(id: string): number | null;
}

// ---------------------------------------------------------------------------
// Primitive sizes
// ---------------------------------------------------------------------------

/** A string's characters, from a repr: Python 'it\'s' or JSON "it's". */
function stringText(value: PrimValue): string | null {
  const repr = value.repr;
  if (repr.endsWith("…")) return null;
  if (value.type === "string" || value.type === "key") {
    if (value.type === "key") return repr;
    try {
      return JSON.parse(repr) as string;
    } catch {
      return repr.slice(1, -1);
    }
  }
  // Python: unescape enough to count characters right.
  const body = repr.replace(/^[bru]*(['"])/i, "").slice(0, -1);
  return body.replace(/\\(x[0-9a-f]{2}|u[0-9a-f]{4}|U[0-9a-f]{8}|N\{[^}]*\}|.)/gi, "_");
}

/** How many characters a string value has. */
function stringLength(value: PrimValue): number {
  if (value.length !== undefined) return value.length;
  const text = stringText(value);
  if (text !== null) return [...text].length;
  // A shortened Python string: its recorded size says (ASCII: 41 + length).
  if (value.size !== undefined) return Math.max(0, value.size - 41);
  return value.repr.length;
}

const isString = (v: PrimValue) => v.type === "str" || v.type === "string" || v.type === "key";

/** Python: every value is an object. Sizes on a 64-bit CPython 3.12. */
function pythonPrim(v: PrimValue): number | null {
  if (v.size !== undefined) return v.size;
  switch (v.type) {
    case "int":
    case "bool":
      return 28;
    case "float":
      return 24;
    case "complex":
      return 32;
    case "none":
      return 16;
    case "str":
      return 41 + stringLength(v);
    case "bytes":
      return 33 + stringLength(v);
    default:
      return null;
  }
}

const isSmi = (v: PrimValue) => v.type === "number" && /^-?\d+$/.test(v.repr) && Math.abs(Number(v.repr)) < 2 ** 30;
const round4 = (n: number) => Math.ceil(n / 4) * 4;

/** V8: what a value needs outside its slot. */
function v8Extra(v: PrimValue, inDoubleArray: boolean): number {
  if (v.type === "number") return isSmi(v) || inDoubleArray ? 0 : 12; // a HeapNumber
  if (v.type === "string" || v.type === "key") {
    const text = stringText(v);
    const twoByte = text !== null && [...text].some((c) => c.codePointAt(0)! > 255);
    return round4(12 + stringLength(v) * (twoByte ? 2 : 1));
  }
  if (v.type === "bigint") return 16 + 8 * Math.ceil(v.repr.length / 19);
  return 0; // true, false, null, undefined: shared, nothing extra
}

// ---------------------------------------------------------------------------
// Object sizes
// ---------------------------------------------------------------------------

const TYPED_ARRAY_BYTES: Record<string, number> = {
  Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1, Int16Array: 2, Uint16Array: 2,
  Int32Array: 4, Uint32Array: 4, Float32Array: 4, Float64Array: 8, BigInt64Array: 8, BigUint64Array: 8,
};

/** V8 arrays of only numbers, some not small integers, store unboxed doubles. */
function isDoubleArray(obj: HeapObject): boolean {
  if (obj.kind !== "list" || obj.typeName !== "Array" || !obj.items.length) return false;
  const prims = obj.items.filter((v): v is PrimValue => v.kind === "prim");
  return prims.length === obj.items.length && prims.every((v) => v.type === "number") && prims.some((v) => !isSmi(v));
}

/** V8's OrderedHashMap / OrderedHashSet: buckets plus entries of `words` slots. */
function v8HashTable(n: number, words: number): number {
  let capacity = 4;
  while (capacity < n) capacity *= 2;
  return 12 + 4 * (capacity / 2) + 4 * words * capacity;
}

function ownSize(obj: HeapObject, model: SizeModel): number | null {
  if (model === "python") return obj.size ?? null;
  const typed = TYPED_ARRAY_BYTES[obj.typeName];
  if (model === "textbook") {
    switch (obj.kind) {
      case "list":
        return typed ? typed * obj.length : 8 * obj.length;
      case "tuple":
      case "set":
        return 8 * obj.length;
      case "dict":
        // A hash map: key and value per entry. JavaScript plain objects are
        // drawn as dicts, so they're counted the same way.
        return 16 * obj.length;
      case "object":
        return 8 * obj.fields.length;
      default:
        return null; // functions, classes and the rest aren't data
    }
  }
  // V8 estimates (64-bit, pointer compression).
  switch (obj.kind) {
    case "list":
      if (typed) return 64 + typed * obj.length;
      if (!obj.length) return 16;
      return 16 + 8 + (isDoubleArray(obj) ? 8 : 4) * obj.length;
    case "tuple":
      return 16 + 8 + 4 * obj.length;
    case "set":
      return 16 + v8HashTable(obj.length, 2);
    case "dict":
      if (obj.typeName === "Map") return 16 + v8HashTable(obj.length, 3);
      return 12 + 4 * obj.length; // a plain object used as a map: one field per key
    case "object":
      return 12 + 4 * obj.fields.length;
    case "function":
      return 32 + (obj.fields.length ? 16 + 4 * obj.fields.length : 0);
    case "class":
      return 32;
    case "opaque":
      return null;
  }
}

/** Every value an object holds, keys included. */
function valuesOf(obj: HeapObject): Value[] {
  switch (obj.kind) {
    case "list":
    case "tuple":
    case "set":
      return obj.items;
    case "dict":
      return obj.entries.flat();
    case "object":
    case "function":
      return obj.fields.map(([, v]) => v);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Per step
// ---------------------------------------------------------------------------

const cache = new WeakMap<Step, Map<SizeModel, StepSizes>>();

/** The model to use by default for a language. */
export function defaultModel(trace: Trace): SizeModel {
  return trace.language === "python" || trace.language === undefined ? "python" : "textbook";
}

export function stepSizes(step: Step, model: SizeModel): StepSizes {
  let byModel = cache.get(step);
  if (!byModel) cache.set(step, (byModel = new Map()));
  const known = byModel.get(model);
  if (known) return known;

  const heap = step.heap;
  const slot = (container?: HeapObject) => {
    if (model !== "v8") return 8;
    return container && isDoubleArray(container) ? 8 : 4;
  };
  /** Bytes a primitive needs outside the slot that holds it. */
  const extra = (v: PrimValue, container?: HeapObject): number => {
    if (model === "python") return pythonPrim(v) ?? 0;
    if (model === "textbook") return isString(v) ? stringLength(v) : 0;
    return v8Extra(v, !!container && isDoubleArray(container));
  };
  const own = (id: string) => (heap[id] ? ownSize(heap[id], model) : null);

  /** Own sizes and primitive extras of everything reachable from `values`. */
  const sum = (values: Value[], container: HeapObject | undefined, seen: Set<string>): number => {
    let bytes = 0;
    for (const v of values) {
      if (v.kind === "prim") {
        bytes += extra(v, container);
        continue;
      }
      if (seen.has(v.id) || !heap[v.id]) continue;
      seen.add(v.id);
      bytes += (own(v.id) ?? 0) + sum(valuesOf(heap[v.id]), heap[v.id], seen);
    }
    return bytes;
  };

  const totals = new Map<string, number | null>();
  const total = (id: string): number | null => {
    if (totals.has(id)) return totals.get(id)!;
    const obj = heap[id];
    const mine = obj ? own(id) : null;
    const value = obj && mine !== null ? sum([{ kind: "ref", id }], undefined, new Set()) : null;
    totals.set(id, value);
    return value;
  };

  const cell = (value: Value, container?: HeapObject): number | null => {
    if (value.kind === "ref") {
      const t = total(value.id);
      return t === null ? null : slot(container) + t;
    }
    if (model === "python" && pythonPrim(value) === null) return null;
    return slot(container) + extra(value, container);
  };

  const frame = (f: Frame) => sum(f.locals.map(([, v]) => v), undefined, new Set());

  // Everything at this step, each object once.
  const everything = new Set<string>();
  let program = 0;
  for (const [id, obj] of Object.entries(heap)) {
    everything.add(id);
    program += own(id) ?? 0;
    for (const v of valuesOf(obj)) if (v.kind === "prim") program += extra(v, obj);
  }
  for (const f of liveFrames(step)) for (const [, v] of f.locals) if (v.kind === "prim") program += extra(v);

  const sizes: StepSizes = {
    model,
    approximate: model === "v8",
    own,
    total,
    cell,
    frame,
    of: (values) => sum(values, undefined, new Set()),
    program,
    capacity: (id) => {
      const obj = heap[id];
      return model === "python" && obj?.kind === "list" && obj.capacity !== undefined ? obj.capacity : null;
    },
  };
  byModel.set(model, sizes);
  return sizes;
}

/** "36 B", "1.2 KB", "≈ 64 B". */
export function formatBytes(bytes: number, approximate = false): string {
  const prefix = approximate ? "≈ " : "";
  if (bytes < 1024) return `${prefix}${Math.round(bytes)} B`;
  if (bytes < 10 * 1024) return `${prefix}${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024) return `${prefix}${Math.round(bytes / 1024)} KB`;
  return `${prefix}${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "88 B · total 248 B", or just "88 B" when it holds nothing more. */
export function ownAndTotal(sizes: StepSizes, id: string): string | null {
  const own = sizes.own(id);
  if (own === null) return null;
  const total = sizes.total(id);
  const text = formatBytes(own, sizes.approximate);
  return total !== null && total > own ? `${text} · total ${formatBytes(total, sizes.approximate)}` : text;
}
