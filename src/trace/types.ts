/**
 * The trace format: the contract between a language tracer and the renderer.
 *
 * Nothing in here is Python-specific. A new tracer only has to produce the
 * same shape for the whole visual layer to work with it.
 *
 * How it's kept honest
 * - schema/trace.schema.json is generated from this file (`npm run schema`).
 *   A test fails if it's out of date, so a change here shows up in review as
 *   a change to the schema.
 * - Every golden trace (src/examples/golden.test.ts) and conformance trace
 *   (src/trace/conformance.test.ts) is checked against the schema, and in
 *   development builds so is every trace a worker sends (worker/runner.ts).
 * - The conformance suite checks the Python and JavaScript tracers give the
 *   same shape for the same program.
 *
 * Versions: `Trace.version`, now 1
 * - Not breaking (no version change): adding an optional field that older
 *   code can ignore, adding a new kind of heap object or value that older
 *   code can draw as opaque, or loosening a rule (a required field becoming
 *   optional is NOT this: see below).
 * - Breaking (version goes to 2): removing or renaming a field; changing a
 *   field's type or what it means; making an optional field required;
 *   changing how ids, iterations or lines are counted.
 * - A breaking change comes with a `migrate` from the old version to the
 *   new, so saved traces and shared links keep opening, and a test that an
 *   old golden trace still migrates and validates.
 * - Never reuse a removed field's name for something else.
 * - The renderer accepts every version it can migrate from, and says so
 *   plainly when a trace is from a newer version than it knows.
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
  /**
   * A long list's `items` are a window of it, following its index
   * variables: the index of items[0]. Absent means 0.
   */
  offset?: number;
  /**
   * A long list of numbers, all of it: evenly spaced samples
   * (values[i] is item floor(i × length / values.length)), with the
   * samples' smallest and largest values, for a color strip.
   */
  strip?: { values: number[]; min: number; max: number };
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

export type HeapObject = SequenceObject | DictObject | InstanceObject | FunctionObject | ClassObject | OpaqueObject;

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
  /**
   * The loop's header with its values as this run of it started: Python
   * "range(0, 4)", JavaScript "j = 0; j < 4; j++". Only for counting loops.
   */
  call?: string;
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
  /**
   * Events that ran but weren't recorded just before this step: passes in
   * the middle of a long loop (see Trace.sampled).
   */
  skipped?: number;
  /** On the last step: events that ran after it without being recorded. */
  skippedAfter?: number;
  /**
   * With Trace.heapDelta: every object id in `heap`, in order. `heap` then
   * holds only objects that differ from the previous step's.
   */
  heapIds?: string[];
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
export type GraphOption =
  | "directed"
  | "undirected"
  | "circle"
  | "layered"
  | "force"
  | "matrix"
  | "edgelist"
  | "straight"
  | "curved"
  | "angled"
  | "sideways";
export const GRAPH_OPTIONS: readonly GraphOption[] = [
  "directed",
  "undirected",
  "circle",
  "layered",
  "force",
  "matrix",
  "edgelist",
  "straight",
  "curved",
  "angled",
  "sideways",
];

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
  /** `viz: size n = 40000, k`: input sizes, for Measure's growth runs. */
  sizes: { name: string; value?: number; line: number }[];
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
      kind: "call";
      line: number;
      callee: string;
      args: (SizeRef | null)[];
      shrink: Shrink;
      /** `return f(...)`: one of several alternatives, only one of which runs per call. */
      alt?: boolean;
    }
  /** A built-in that isn't O(1): `x in list`, sorted(), arr.indexOf(), heappush. */
  | {
      kind: "op";
      line: number;
      what: string;
      cost: "linear" | "nlogn" | "log";
      size: SizeRef | null;
      container?: string;
    }
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

export interface GridAccess {
  name: string;
  line: number;
  row: string;
  col: string;
}

export interface TraceError {
  type: string;
  message: string;
  line: number | null;
}

export interface Trace {
  version: 1;
  /** Which tracer produced this. Affects small details like "def" vs "function". */
  language?: "python" | "javascript" | "typescript" | "sql";
  steps: Step[];
  loops: LoopInfo[];
  /**
   * Which names are used to index which containers, from static analysis.
   * `arr[j + 1]` in the code gives { arr: ["j"] }. For nested indexing,
   * `grid[i][j]` gives { grid: ["i"], "grid[]": ["j"] }: the "[]" key holds
   * names that index the inner lists.
   */
  indexNames: Record<string, string[]>;
  /**
   * Every `grid[a][b]` in the code: the grid's name, the line, and the row
   * and column index expressions as written ("up", "col", "n - 1 - j").
   * The cell a step reads or writes is the one these give on the line that
   * ran (or is about to run): see trace/gridFocus.ts.
   */
  gridAccesses?: GridAccess[];
  stdout: string;
  error: TraceError | null;
  /**
   * Steps' heaps hold only what changed since the step before (see
   * Step.heapIds). trace/delta.ts's expandHeaps rebuilds them, sharing
   * unchanged objects between steps. Never set on a trace the page uses.
   */
  heapDelta?: boolean;
  /** True when the step budget (or the time budget) ran out before the program finished. */
  truncated: boolean;
  /** What stopped a truncated trace. */
  stoppedBy?: "steps" | "time";
  /**
   * Some long loops were sampled: their first passes, passes at round
   * numbers (10, 20 ... 100, 200 ...) and last passes were recorded; the
   * rest ran and were counted but not recorded (steps carry `skipped`).
   */
  sampled?: boolean;
  /** Counted over the whole run, recorded or not. */
  counts?: { steps: number; calls: Record<string, number>; depth: Record<string, number> };
  /** `# viz:` / `// viz:` comments in the program (see README, "Hints"). */
  hints?: RawHint[];
  /** The shape of the code, for complexity estimates. */
  cost?: CostInfo;
  /** The hints, parsed and applied (added by applyHints, not by tracers). */
  viz?: VizHints;
  /**
   * SQL only: what each step shows, a table at each stage of a query
   * (steps[i] is stages[i]). Its steps have no variables or heap: the
   * tables are here.
   */
  sql?: SqlTrace;
}

// ---------------------------------------------------------------------------
// SQL (src/sql/): a query stepped through clause by clause, in the order
// Postgres gives them meaning (FROM, WHERE, SELECT, DISTINCT, ORDER BY,
// LIMIT), each step a table.
// ---------------------------------------------------------------------------

/** A column of a table drawn at a SQL step. */
export interface SqlColumn {
  name: string;
  /** Postgres's name for its type: "integer", "text", "numeric"... */
  type: string;
  /** Numbers are drawn right-aligned. */
  numeric?: boolean;
  /**
   * What the column is at this step (absent: a column of the table):
   *   computed  made by an expression in SELECT (`expr`)
   *   check     part of the WHERE condition, worked out for each row (`expr`)
   *   result    the whole WHERE condition for each row: is it kept?
   *   sort      a value ORDER BY sorts on that the result doesn't show (`expr`)
   *   key       what GROUP BY groups on, worked out for each row (`expr`)
   *   inputs    the values an aggregate was given, for each group (`expr`:
   *             the aggregate; for COUNT(*), the group's rows)
   *   problem   a column that has different values within one group, in a
   *             query Postgres refused for it (see SqlStage.notes)
   *   case      which branch of a CASE expression in SELECT each row took
   *   outer     a value from the outer row a subquery uses
   */
  role?: "computed" | "check" | "result" | "sort" | "key" | "inputs" | "problem" | "case" | "outer";
  /** The expression, as written (one line). */
  expr?: string;
  /** ORDER BY sorts on this column: its place among the sort keys (1 first), and which way. */
  sort?: { rank: number; desc: boolean };
}

/** A row of a table drawn at a SQL step. */
export interface SqlRow {
  /**
   * The same row has the same id at every step of a statement ("pets:0,3":
   * its table and where Postgres keeps it), so it can be followed (and
   * animated) from step to step.
   */
  id: string;
  /** Its place in its table, "#3": how the text names it. */
  label: string;
  /** Each column's value as Postgres writes it; null is SQL's NULL. */
  values: (string | null)[];
  /**
   * removed  this step takes it out: WHERE's condition isn't true, a
   *          duplicate DISTINCT drops, past LIMIT, skipped by OFFSET, or
   *          deleted
   * added    a new row (INSERT)
   * changed  a row changed by UPDATE
   * unmatched  a join found no row to pair it with, and keeps it anyway
   *          (LEFT, RIGHT or FULL JOIN), with NULLs for the other table
   */
  status?: "removed" | "added" | "changed" | "unmatched";
  /** Why, in words: "age > 3 is NULL: unknown, so not kept". */
  note?: string;
  /** ORDER BY: its sort keys equal the row before's, so the two could come either way. */
  tie?: boolean;
  /** GROUP BY: which group it's in (an index into SqlTable.groups). */
  group?: number;
}

/** A table drawn at a SQL step. */
export interface SqlTable {
  /** "pets", or "result". */
  name: string;
  /** How the query names it, when that differs ("p" in `FROM pets AS p`). */
  alias?: string;
  columns: SqlColumn[];
  rows: SqlRow[];
  /** Rows there are but not drawn (a step draws at most a hundred). */
  more?: number;
  /** Lines across the table (LIMIT, OFFSET) before the row at `before`. */
  cuts?: { before: number; label: string }[];
  /** GROUP BY: the groups, in order, each `count` rows from row `start`, and what its rows share ("category = Tea"). */
  groups?: { start: number; count: number; label: string }[];
  /** What the groups are: GROUP BY's groups (G1, G2...), or a window's partitions (P1, P2...). */
  groupKind?: "group" | "partition";
}

export type SqlStageKind =
  /** The sample database's tables, before the first statement. */
  | "tables"
  | "from"
  /**
   * One table joined to the rows so far: `tables` is those rows, the table
   * joined, and the rows the join makes; `links` pairs them up.
   */
  | "join"
  | "where"
  /** The rows gathered into groups (GROUP BY, or one group of every row for an aggregate without it). */
  | "group"
  /** Each group made into one row, its aggregates worked out from its rows. */
  | "aggregate"
  /** HAVING's condition for each group: whole groups dropped. */
  | "having"
  | "select"
  | "distinct"
  | "order"
  | "limit"
  /** A statement that isn't a query (CREATE TABLE, INSERT...): the table it changed. */
  | "statement"
  /** A query that isn't stepped through (yet): its result. */
  | "result"
  /** A subquery that uses the outer row: what it gives for each row (it runs once per row). */
  | "subquery"
  /** UNION, INTERSECT or EXCEPT: the two queries' rows, and the rows they make together. */
  | "combine"
  /** A window function worked out for each row, from the rows of its partition (its frame). */
  | "window"
  /** WITH RECURSIVE: one pass of the recursive query, on the rows the pass before made. */
  | "pass"
  /** A statement Postgres refused for a rule of the table's (a key, NOT NULL, a CHECK): the rows involved. */
  | "refused";

/** One step: a stage of a statement. */
export interface SqlStage {
  kind: SqlStageKind;
  /** The clause as written, on one line: "WHERE age > 3". */
  clause: string;
  /** What it did, in a few words: "kept 4 of 7 rows". */
  summary: string;
  /** Which statement (an index into SqlTrace.statements). */
  statement: number;
  /** The line the clause is on. */
  line: number;
  tables: SqlTable[];
  /** Rows left after this stage (in the pipeline, between stages). */
  rows?: number;
  /** Anything worth knowing about it ("No ORDER BY: ..."). */
  notes?: string[];
  /**
   * A stage of a part of the statement that runs before the rest: a WITH
   * query, a subquery, one side of a UNION. `depth` is how deeply it's
   * nested (1: inside the statement).
   */
  part?: { label: string; depth: number };
  /** A join: which row of the rows so far (tables[0]) pairs with which row of the table joined (tables[1]), by id. */
  links?: { from: string; to: string }[];
}

/** A statement of the script, in order. */
export interface SqlStatement {
  /** "SELECT", "CREATE TABLE", "INSERT"... */
  kind: string;
  /** Its first line, and its text on one line (shortened). */
  line: number;
  text: string;
  /** Why it's shown as its result rather than stepped through, if it is. */
  unsupported?: string;
}

export interface SqlTrace {
  /** The sample database it ran on (`-- viz: database shop`), if any. */
  database?: string;
  statements: SqlStatement[];
  /** One per step. */
  stages: SqlStage[];
}
