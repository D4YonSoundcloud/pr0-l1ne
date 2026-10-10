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
  /**
   * Python only: bytes this value takes on a 64-bit CPython, for values whose
   * size the repr can't tell (strings and bytes, which may be shortened,
   * and big ints). Other sizes are fixed (see trace/memory.ts).
   */
  size?: number;
  /** A shortened string's real length (JavaScript). */
  length?: number;
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
  /** Python only: bytes on a 64-bit CPython (sys.getsizeof). */
  size?: number;
  /** Python lists only: how many items it has room for before growing. */
  capacity?: number;
}

export interface DictObject {
  kind: "dict";
  id: string;
  typeName: string;
  entries: [Value, Value][];
  length: number;
  /** Python only: bytes on a 64-bit CPython. */
  size?: number;
}

/** An instance of a user class (fields from __dict__ or __slots__). */
export interface InstanceObject {
  kind: "object";
  id: string;
  typeName: string;
  fields: [string, Value][];
  /** Python only: the instance plus its attribute dict, on a 64-bit CPython. */
  size?: number;
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
  /** Python only: bytes on a 64-bit CPython. */
  size?: number;
}

export interface ClassObject {
  kind: "class";
  id: string;
  typeName: string;
  name: string;
  /** Python only: bytes on a 64-bit CPython. */
  size?: number;
}

/** Anything we don't have a dedicated drawing for. */
export interface OpaqueObject {
  kind: "opaque";
  id: string;
  typeName: string;
  repr: string;
  /** Python only: bytes on a 64-bit CPython. */
  size?: number;
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
  /**
   * "suspended" for a generator or async function paused at a yield or
   * await. Suspended frames aren't on the call stack; see Step.suspended.
   */
  state?: "suspended";
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
  /**
   * yield / await: a generator or async function pauses (its frame moves
   * from the stack to `suspended`). resume: it picks up again.
   */
  event: "call" | "line" | "return" | "exception" | "yield" | "await" | "resume";
  /** The line about to run (for "line"), or where the event happened. */
  line: number;
  /** Outermost frame first. The last frame is the one executing. */
  stack: Frame[];
  /**
   * Generators and async functions that are paused, oldest first. Their
   * variables are kept, so they can be shown next to the stack.
   */
  suspended?: Frame[];
  /** Every heap object reachable from the stack at this step. */
  heap: Record<string, HeapObject>;
  /** How much of `Trace.stdout` had been printed by this step. */
  stdoutLength: number;
  loops: LoopContext[];
  /**
   * Set on the step right after a print() / console.log() ran: the line
   * that printed, and the printed objects that are drawn at this step. The
   * text itself is Trace.stdout, from the previous step's stdoutLength to
   * this one's.
   */
  output?: { line: number; refs: string[] };
  /** The returned value (return) or the yielded value (yield). */
  returnValue?: Value;
  exception?: { type: string; message: string };
}

/** Every live frame: the call stack, then paused generators/async functions. */
export function liveFrames(step: Step): Frame[] {
  return step.suspended?.length ? [...step.stack, ...step.suspended] : step.stack;
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

/** A `# viz:` / `// viz:` comment, as written. Parsed by trace/hints.ts. */
export interface RawHint {
  line: number;
  /** Everything after "viz:", trimmed. */
  text: string;
}

/** `viz: tree Node(left, right)` or `viz: list Node(next)`. */
export interface LinkedHint {
  shape: "tree" | "list";
  typeName: string;
  links: string[];
  line: number;
}

/** Options a `viz: graph` hint can carry. */
export type GraphOption = "directed" | "undirected" | "circle" | "layered" | "force" | "matrix" | "edgelist";
export const GRAPH_OPTIONS: readonly GraphOption[] = ["directed", "undirected", "circle", "layered", "force", "matrix", "edgelist"];

/**
 * `viz: graph adj`, `viz: graph Node(neighbors)`, with options and the
 * names of variables to draw on it: `viz: graph adj directed: seen, queue`.
 */
export interface GraphHint {
  /** A variable (`adj`, `self.adj`) or, with `fields`, a class. */
  target: string;
  /** For a class: the fields that hold its neighbors. */
  fields?: string[];
  options: GraphOption[];
  names: string[];
  line: number;
}

/** Parsed hints (trace/hints.ts), kept on the trace for the renderers. */
export interface VizHints {
  hide: string[];
  show: string[];
  /** Extra index names, keyed like Trace.indexNames ("nums", "grid[]"). */
  pointers: Record<string, string[]>;
  linked: LinkedHint[];
  graphs: GraphHint[];
  /** Variables or classes never to draw as a graph. */
  plain: string[];
  /** Hints that couldn't be understood, to show to the person. */
  warnings: { line: number; message: string }[];
}

// ---------------------------------------------------------------------------
// The shape of the code, for estimating time and space complexity
// (trace/complexity.ts). Written by each tracer's static analysis.
// ---------------------------------------------------------------------------

/**
 * Something the running time can depend on, named as the program names it.
 * `{ name: "nums", len: true }` is len(nums) / nums.length;
 * `{ name: "n" }` is the value of n; `inner` is the length of one of its
 * items (a row of a grid, a node's neighbor list). For an object, `len` is
 * the number of objects of its kind reachable from it (a linked list's
 * nodes). `name` can be dotted: "self.items".
 */
export interface SizeRef {
  name: string;
  len?: boolean;
  inner?: boolean;
}

/** How many times a loop runs, each time it's reached. */
export type CostBound =
  /** Up to a size, or the sum of several (merging two lists). */
  | { kind: "size"; sizes: SizeRef[]; why: string }
  /** Halving or doubling toward a size. */
  | { kind: "log"; size: SizeRef; why: string }
  /** A fixed number of times (a literal range, a literal list). */
  | { kind: "const"; why: string }
  /** Depends on the data (`while queue:`); sized from the run. */
  | { kind: "unknown"; why: string };

/**
 * How a recursive call's arguments compare with the parameters:
 * `minus` (n - 1, i + 1, items[1:]), `half` (n // 2, items[:mid]),
 * `child` (node.left: one step down a structure), `same`, or `unknown`
 * (anything else, like a neighbor in a search).
 */
export type Shrink = "minus" | "half" | "child" | "same" | "unknown";

export type CostNode =
  /** A loop, or anything that loops: a comprehension, arr.map(...). `loop` is its LoopInfo id, when it has one. */
  | { kind: "loop"; loop?: string; line: number; bound: CostBound; body: CostNode[] }
  /** A call to one of the program's own functions. */
  | {
    kind: "call"; line: number; callee: string; args: (SizeRef | null)[]; shrink: Shrink;
    /** `return f(...)`: one of several alternatives, only one of which runs per call. */
    alt?: boolean;
  }
  /** A built-in that isn't O(1): `x in list`, sorted(), arr.indexOf(), heappush. */
  | { kind: "op"; line: number; what: string; cost: "linear" | "nlogn" | "log"; size: SizeRef | null; container?: string }
  /**
   * Memory: `sizes` multiplied together each time it runs ([] is one item).
   * `name`: assigned to a variable, replacing what it held (not kept per
   * pass). `into`: the collection that grows (`seen.add(x)`).
   */
  | { kind: "alloc"; line: number; what: string; sizes: SizeRef[]; name?: string; into?: string };

export interface CostFunction {
  /** "Global" for the top level. */
  name: string;
  line: number;
  params: string[];
  /** Caches results in a dict or Map keyed by its arguments (memoization). */
  memo: boolean;
  body: CostNode[];
}

export interface CostInfo {
  functions: CostFunction[];
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
   * `arr[j + 1]` in the code gives { arr: ["j"] }. For nested indexing,
   * `grid[i][j]` gives { grid: ["i"], "grid[]": ["j"] }: the "[]" key holds
   * names that index the inner lists.
   */
  indexNames: Record<string, string[]>;
  stdout: string;
  error: TraceError | null;
  /** True when the step budget ran out before the program finished. */
  truncated: boolean;
  /** `# viz:` / `// viz:` comments in the program (see README, "Hints"). */
  hints?: RawHint[];
  /** The shape of the code, for complexity estimates. */
  cost?: CostInfo;
  /** The hints, parsed and applied (added by applyHints, not by tracers). */
  viz?: VizHints;
}
