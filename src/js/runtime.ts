/**
 * The JavaScript runtime recorder: the counterpart of tracer.py.
 *
 * Instrumented code (see instrument.ts) calls these methods as it runs. The
 * runtime keeps a shadow call stack, tracks loop iterations, and at every
 * event serializes all frames and everything they reach into a Step, in
 * exactly the format the Python tracer produces.
 */
import type { HeapObject, LoopContext, PrimValue, Step, Value } from "../trace/types";

/** [name, () => value] for each visible variable, produced by the instrumenter. */
export type Getter = () => [string, () => unknown][];

const MAX_ITEMS = 60;
const MAX_REPR = 48;
const MAX_OBJECTS = 400;
const MAX_DEPTH = 250;

/** Thrown to stop the program when the step budget runs out. */
export class StepLimit {
  readonly reason = "step limit";
}

interface FrameState {
  id: string;
  func: string;
  line: number;
  getter: Getter;
  loops: Map<string, { instance: number; iteration: number }>;
}

const prim = (type: string, repr: string): PrimValue => ({
  kind: "prim",
  type,
  repr: repr.length > MAX_REPR ? `${repr.slice(0, MAX_REPR - 1)}…` : repr,
});

export class Runtime {
  readonly steps: Step[] = [];
  readonly ABORT = new StepLimit();
  stdout = "";

  private frames: FrameState[] = [];
  private frameCounter = 0;
  private aborted = false;
  private recording = false;
  private loopInstances = new Map<string, number>();
  private objectIds = new WeakMap<object, string>();
  private objectCounter = 0;
  private closures = new WeakMap<Function, { name: string; captured: Getter }>();
  private errorLines = new WeakMap<object, number>();
  private lastErrorLine: number | null = null;

  constructor(private readonly maxSteps: number) {}

  // -- called by instrumented code ------------------------------------------

  enter(func: string, line: number, getter: Getter): FrameState {
    if (this.frames.length >= MAX_DEPTH) {
      throw new RangeError(`More than ${MAX_DEPTH} nested calls. Is a recursive function missing its base case?`);
    }
    const frame: FrameState = { id: `f${++this.frameCounter}`, func, line, getter, loops: new Map() };
    this.frames.push(frame);
    this.record("call");
    return frame;
  }

  exit(frame: FrameState): void {
    const index = this.frames.lastIndexOf(frame);
    if (index >= 0) this.frames.length = index;
  }

  line(line: number, getter: Getter): void {
    const frame = this.top();
    frame.line = line;
    frame.getter = getter;
    this.record("line");
  }

  ret<T>(value: T, getter?: Getter): T {
    const frame = this.top();
    if (getter) frame.getter = getter;
    this.record("return", { returnValue: value });
    return value;
  }

  raise(error: unknown): void {
    if (error === this.ABORT) return;
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return;
    if (typeof error === "object" && error !== null && !this.errorLines.has(error)) {
      this.errorLines.set(error, frame.line);
    }
    this.lastErrorLine ??= frame.line;
    this.record("exception", { exception: { type: errorName(error), message: errorMessage(error) } });
  }

  loopEnter(id: string, line: number, getter: Getter): void {
    const frame = this.top();
    const key = `${frame.id}/${id}`;
    const instance = (this.loopInstances.get(key) ?? 0) + 1;
    this.loopInstances.set(key, instance);
    frame.loops.set(id, { instance, iteration: 0 });
    this.line(line, getter);
  }

  loopIter(id: string): void {
    const state = this.top().loops.get(id);
    if (state) state.iteration++;
  }

  /** End of an iteration: a snapshot at the loop header, like Python's re-check. */
  tail(id: string, line: number, getter: Getter): void {
    if (this.top().loops.has(id)) this.line(line, getter);
  }

  loopExit(id: string): void {
    this.frames[this.frames.length - 1]?.loops.delete(id);
  }

  /** Remember which variables a closure captured, for the heap view. */
  fn<F extends Function>(fn: F, name: string, captured: Getter): F {
    this.closures.set(fn, { name, captured });
    return fn;
  }

  // -- results ----------------------------------------------------------------

  errorLine(error: unknown): number | null {
    if (typeof error === "object" && error !== null) return this.errorLines.get(error) ?? this.lastErrorLine;
    return this.lastErrorLine;
  }

  /** A console that prints into the trace's stdout. */
  readonly console = (() => {
    const print = (...args: unknown[]) => {
      this.stdout += args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" ") + "\n";
    };
    return { log: print, info: print, warn: print, error: print, debug: print, table: print };
  })();

  // -- internals --------------------------------------------------------------

  private top(): FrameState {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) throw new Error("AlgoViz runtime: no active frame");
    return frame;
  }

  private record(event: Step["event"], extra: { returnValue?: unknown; exception?: Step["exception"] } = {}): void {
    if (this.recording) return; // never record while reading user values
    // Once the budget is spent, every event throws. User code can catch the
    // first throw, but the first statement in any catch block is itself an
    // event, so the program can never make progress past the limit.
    if (this.aborted || this.steps.length >= this.maxSteps) {
      this.aborted = true;
      throw this.ABORT;
    }
    this.recording = true;
    try {
      const serializer = new Serializer(this.objectIds, () => `o${++this.objectCounter}`, this.closures);
      const stack = this.frames.map((frame) => ({
        id: frame.id,
        func: frame.func,
        line: frame.line,
        locals: serializer.locals(frame.getter),
      }));
      const loops: LoopContext[] = this.frames.flatMap((frame) =>
        [...frame.loops].map(([loop, state]) => ({ frame: frame.id, loop, ...state })));
      const step: Step = {
        event,
        line: this.frames[this.frames.length - 1]?.line ?? 0,
        stack,
        heap: serializer.heap,
        stdoutLength: this.stdout.length,
        loops,
      };
      if ("returnValue" in extra) step.returnValue = serializer.value(extra.returnValue);
      if (extra.exception) step.exception = extra.exception;
      this.steps.push(step);
    } finally {
      this.recording = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

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

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error === "object" && error !== null ? constructorName(error) : typeof error;
}

function errorMessage(error: unknown): string {
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

const OPAQUE_TYPES: [Function, (v: any) => string][] = [
  [Date, (v: Date) => (Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString())],
  [RegExp, (v: RegExp) => String(v)],
  [Error, (v: Error) => `${v.name}: ${v.message}`],
  [Promise, () => "Promise"],
  [WeakMap, () => "WeakMap"],
  [WeakSet, () => "WeakSet"],
  [ArrayBuffer, (v: ArrayBuffer) => `ArrayBuffer(${v.byteLength})`],
];

class Serializer {
  readonly heap: Record<string, HeapObject> = {};
  private count = 0;

  constructor(
    private readonly ids: WeakMap<object, string>,
    private readonly newId: () => string,
    private readonly closures: WeakMap<Function, { name: string; captured: Getter }>,
  ) {}

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
      case "number": return prim("number", Object.is(v, -0) ? "-0" : String(v));
      case "string": return prim("string", JSON.stringify(v));
      case "boolean": return prim("boolean", String(v));
      case "undefined": return prim("undefined", "undefined");
      case "bigint": return prim("bigint", `${v}n`);
      case "symbol": return prim("symbol", v.toString());
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
    this.heap[id] = this.describe(obj, id);
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
      const items: Value[] = [];
      for (let i = 0; i < Math.min(obj.length, MAX_ITEMS); i++) items.push(this.slot(obj, i));
      return { kind: "list", id, typeName: "Array", items, length: obj.length };
    }
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      const view = obj as unknown as ArrayLike<number>;
      return { kind: "list", id, typeName: constructorName(obj), items: this.items(Array.from(view).slice(0, MAX_ITEMS)), length: view.length };
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
    case "string": return depth === 0 ? value : `'${value}'`;
    case "bigint": return `${value}n`;
    case "symbol": return value.toString();
    case "function": {
      const source = Function.prototype.toString.call(value);
      if (/^class[\s{]/.test(source)) return `[class ${value.name || "(anonymous)"}]`;
      return value.name ? `[Function: ${value.name}]` : "[Function (anonymous)]";
    }
    case "object": break;
    default: return String(value);
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
