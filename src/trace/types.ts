/**
 * The trace format: the contract between a language tracer and the renderer.
 *
 * Nothing in here is Python-specific. A future TypeScript tracer only has to
 * produce the same shape for the whole visual layer to work with it.
 */

/** A primitive value, stored inline. `repr` is already display-ready. */
export interface PrimValue {
  kind: "prim";
  /**
   * Python: "int", "float", "str", "bool", "none", ...
   * JavaScript: "number", "string", "boolean", "null", "undefined", "bigint",
   * "symbol", plus "key" for an unquoted object key and "getter".
   */
  type: string;
  repr: string;
}

/** A pointer to a heap object, by stable id. */
export interface RefValue {
  kind: "ref";
  id: string;
}

export type Value = PrimValue | RefValue;

/** list, tuple, set: drawn as a horizontal row of cells. */
export interface SequenceObject {
  kind: "list" | "tuple" | "set";
  id: string;
  typeName: string;
  items: Value[];
  /** Real length; `items` may be truncated. */
  length: number;
}

export interface DictObject {
  kind: "dict";
  id: string;
  typeName: string;
  entries: [Value, Value][];
  length: number;
}

/** An instance of a user class (fields from __dict__ or __slots__). */
export interface InstanceObject {
  kind: "object";
  id: string;
  typeName: string;
  fields: [string, Value][];
}

/** A function. `fields` holds closed-over variables. */
export interface FunctionObject {
  kind: "function";
  id: string;
  typeName: string;
  name: string;
  params: string[];
  fields: [string, Value][];
  builtin: boolean;
}

export interface ClassObject {
  kind: "class";
  id: string;
  typeName: string;
  name: string;
}

/** Anything we don't have a dedicated drawing for. */
export interface OpaqueObject {
  kind: "opaque";
  id: string;
  typeName: string;
  repr: string;
}

export type HeapObject =
  | SequenceObject
  | DictObject
  | InstanceObject
  | FunctionObject
  | ClassObject
  | OpaqueObject;

/** One scope on the call stack. */
export interface Frame {
  /** Stable for the lifetime of the call, e.g. "f3". */
  id: string;
  /** Function name, or "Global" for module scope. */
  func: string;
  line: number;
  locals: [string, Value][];
}

/** Which loops are running at a step, and on which iteration. */
export interface LoopContext {
  frame: string;
  loop: string;
  /** Increments each time the loop is entered again (e.g. an inner loop). */
  instance: number;
  /** 0 while on the header before the first pass, then 1, 2, 3... */
  iteration: number;
}

export interface Step {
  event: "call" | "line" | "return" | "exception";
  /** The line about to run (for "line"), or where the event happened. */
  line: number;
  /** Outermost frame first. The last frame is the one executing. */
  stack: Frame[];
  /** Every heap object reachable from the stack at this step. */
  heap: Record<string, HeapObject>;
  /** How much of `Trace.stdout` had been printed by this step. */
  stdoutLength: number;
  loops: LoopContext[];
  returnValue?: Value;
  exception?: { type: string; message: string };
}

export interface LoopInfo {
  id: string;
  kind: "for" | "while";
  line: number;
  bodyStart: number;
  bodyEnd: number;
  /** Source text of the loop header, e.g. "for i in range(n)". */
  header: string;
}

export interface TraceError {
  type: string;
  message: string;
  line: number | null;
}

export interface Trace {
  version: 1;
  /** Which tracer produced this. Affects small details like "def" vs "function". */
  language?: "python" | "javascript" | "typescript";
  steps: Step[];
  loops: LoopInfo[];
  /**
   * Which names are used to index which containers, from static analysis.
   * `arr[j + 1]` in the code gives { arr: ["j"] }.
   */
  indexNames: Record<string, string[]>;
  stdout: string;
  error: TraceError | null;
  /** True when the step budget ran out before the program finished. */
  truncated: boolean;
}
