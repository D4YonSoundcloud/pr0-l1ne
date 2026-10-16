/**
 * Measure for JavaScript and TypeScript: run the program at full size with
 * counters instead of a trace. The same report as worker/measure.py.
 *
 * Counters are added with a Babel pass (much lighter than the tracing
 * instrumenter):
 *
 *   __m.c[__m.l = 12]++;          before every statement: counts line 12
 *                                 and remembers it as the line running
 *   __m.p[5]++;                   first in a loop body: counts a pass
 *   __m.f[3]++;                   first in a function: counts a call
 *   if (--__m.t < 0) __m.poll();  in loop bodies and functions: every few
 *                                 thousand times, check the clock, report
 *                                 progress, stop at the time limit
 *   for (x of __m.it(5, xs))      records a loop's length as it starts
 *
 * Work inside built-ins (shift, splice, indexOf, includes, slice, sort...)
 * is counted by wrapping those Array.prototype methods for the run: each
 * adds its array's length to the line in __m.l. They're put back after.
 *
 * If the counted run was quick, the program then runs once more untouched,
 * for an honest time.
 */
import { generate } from "@babel/generator";
import _traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Measurement, MeasureProgress } from "../trace/measurement";
import { macrotask, onUnhandledRejection } from "./trace";

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

const M = "__m";
const POLL_EVERY = 5000;
const PROGRESS_EVERY = 250;
const PLAIN_RUN_UNDER = 5000;
const MAX_OUTPUT = 100_000;
const MAX_TURNS = 10_000;

/** Thrown at the time limit. Not an Error, and re-thrown at every check after, so a catch can't keep the run going. */
const LIMIT = Symbol("measure limit");

// ---------------------------------------------------------------------------
// Rewriting the program
// ---------------------------------------------------------------------------

const member = (obj: t.Expression, prop: string) => t.memberExpression(obj, t.identifier(prop));
const m = (prop: string) => member(t.identifier(M), prop);

/** __m.c[__m.l = line]++ */
const countLine = (line: number) =>
  t.expressionStatement(
    t.updateExpression(
      "++",
      t.memberExpression(m("c"), t.assignmentExpression("=", m("l"), t.numericLiteral(line)), true),
      false,
    ),
  );
/** __m.p[line]++ */
const countPass = (line: number) =>
  t.expressionStatement(t.updateExpression("++", t.memberExpression(m("p"), t.numericLiteral(line), true), false));
/** __m.f[line]++ */
const countCall = (line: number) =>
  t.expressionStatement(t.updateExpression("++", t.memberExpression(m("f"), t.numericLiteral(line), true), false));
/** if (--__m.t < 0) __m.poll(); */
const poll = () =>
  t.ifStatement(
    t.binaryExpression("<", t.updateExpression("--", m("t"), true), t.numericLiteral(0)),
    t.expressionStatement(t.callExpression(m("poll"), [])),
  );

const isCounter = (s: t.Statement) => !!(s as { _measure?: boolean })._measure;
const mark = <T extends t.Statement>(s: T): T => Object.assign(s, { _measure: true });

function asBlock(body: t.Statement): t.BlockStatement {
  return t.isBlockStatement(body) ? body : t.blockStatement([body]);
}

/** Simple enough to evaluate one extra time: names, numbers, a.length, arithmetic. */
function pure(n: t.Node): boolean {
  if (t.isIdentifier(n) || t.isNumericLiteral(n)) return true;
  if (t.isMemberExpression(n) && !n.computed) return pure(n.object);
  if (t.isBinaryExpression(n) && /^[-+*/%]$/.test(n.operator)) return pure(n.left as t.Node) && pure(n.right);
  if (t.isUnaryExpression(n) && n.operator === "-") return pure(n.argument);
  return false;
}

export function instrumentForMeasure(ast: t.File): string {
  traverse(ast, {
    // Count every statement in every list of statements.
    "Program|BlockStatement|SwitchCase"(path: NodePath<t.Program | t.BlockStatement | t.SwitchCase>) {
      const node = path.node;
      const list = t.isSwitchCase(node) ? node.consequent : node.body;
      const out: t.Statement[] = [];
      for (const s of list) {
        if (
          !isCounter(s) &&
          s.loc &&
          !t.isFunctionDeclaration(s) &&
          !t.isClassDeclaration(s) &&
          !t.isEmptyStatement(s)
        ) {
          out.push(mark(countLine(s.loc.start.line)));
        }
        out.push(s);
      }
      if (t.isSwitchCase(node)) node.consequent = out;
      else node.body = out;
    },
    Loop: {
      enter(path: NodePath<t.Loop>) {
        const node = path.node;
        if (!node.loc) return;
        const line = node.loc.start.line;
        const body = asBlock(node.body);
        body.body.unshift(mark(countPass(line)), mark(poll()));
        node.body = body;
        // for (x of xs): note how many passes it will make
        if (t.isForOfStatement(node)) {
          node.right = t.callExpression(m("it"), [t.numericLiteral(line), node.right]);
        }
        // for (let i = A; i < B; i++): B - A passes, when both are simple
        if (t.isForStatement(node) && t.isVariableDeclaration(node.init) && node.init.declarations.length === 1) {
          const decl = node.init.declarations[0];
          const test = node.test;
          const update = node.update;
          const id = t.isIdentifier(decl.id) ? decl.id.name : null;
          const steps =
            update &&
            ((t.isUpdateExpression(update) &&
              update.operator === "++" &&
              t.isIdentifier(update.argument, { name: id ?? "" })) ||
              (t.isAssignmentExpression(update) &&
                update.operator === "+=" &&
                t.isIdentifier(update.left, { name: id ?? "" }) &&
                t.isNumericLiteral(update.right, { value: 1 })));
          if (
            id &&
            steps &&
            decl.init &&
            pure(decl.init) &&
            t.isBinaryExpression(test) &&
            (test.operator === "<" || test.operator === "<=") &&
            t.isIdentifier(test.left, { name: id }) &&
            pure(test.right)
          ) {
            const count = t.binaryExpression("-", t.cloneNode(test.right as t.Expression), t.cloneNode(decl.init));
            const total = test.operator === "<=" ? t.binaryExpression("+", count, t.numericLiteral(1)) : count;
            // Recorded when the loop starts: the init runs first, then this.
            decl.init = t.sequenceExpression([t.callExpression(m("tot"), [t.numericLiteral(line), total]), decl.init]);
          }
        }
      },
    },
    // if (x) y; -> if (x) { y; } so the statement inside gets its own count
    IfStatement(path: NodePath<t.IfStatement>) {
      const node = path.node;
      node.consequent = asBlock(node.consequent);
      if (node.alternate && !t.isIfStatement(node.alternate)) node.alternate = asBlock(node.alternate);
    },
    Function(path: NodePath<t.Function>) {
      const node = path.node;
      if (!node.loc) return;
      if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
        const line = node.body.loc?.start.line ?? node.loc.start.line;
        node.body = t.blockStatement([
          mark(countCall(node.loc.start.line)),
          mark(poll()),
          mark(countLine(line)),
          t.returnStatement(node.body),
        ]);
        return;
      }
      (node.body as t.BlockStatement).body.unshift(mark(countCall(node.loc.start.line)), mark(poll()));
    },
  });
  return generate(ast).code;
}

// ---------------------------------------------------------------------------
// Built-ins that aren't O(1)
// ---------------------------------------------------------------------------

/** Method -> what it costs and how to say it. */
const ARRAY_WORK: Record<
  string,
  { kind: "m" | "s" | "c" | "o"; cost: (self: unknown[], args: unknown[], result: unknown) => number }
> = {
  shift: { kind: "m", cost: (a) => a.length },
  unshift: { kind: "m", cost: (a) => a.length },
  splice: { kind: "m", cost: (a) => a.length },
  reverse: { kind: "m", cost: (a) => a.length },
  copyWithin: { kind: "m", cost: (a) => a.length },
  fill: { kind: "m", cost: (a) => a.length },
  indexOf: { kind: "s", cost: (a) => a.length },
  lastIndexOf: { kind: "s", cost: (a) => a.length },
  includes: { kind: "s", cost: (a) => a.length },
  join: { kind: "s", cost: (a) => a.length },
  slice: { kind: "c", cost: (_a, _args, r) => (Array.isArray(r) ? r.length : 0) },
  concat: { kind: "c", cost: (_a, _args, r) => (Array.isArray(r) ? r.length : 0) },
  flat: { kind: "c", cost: (_a, _args, r) => (Array.isArray(r) ? r.length : 0) },
  toReversed: { kind: "c", cost: (a) => a.length },
  sort: { kind: "o", cost: (a) => nLogN(a.length) },
  toSorted: { kind: "o", cost: (a) => nLogN(a.length) },
};

const nLogN = (n: number) => (n > 1 ? Math.round(n * Math.log2(n)) : n);

/** Wrap the Array methods above for one run; returns a function that puts them back. */
function countArrayWork(state: State): () => void {
  const proto = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = new Map<string, PropertyDescriptor>();
  for (const [name, { kind, cost }] of Object.entries(ARRAY_WORK)) {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    originals.set(name, descriptor);
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const wrapped = function (this: unknown[], ...args: unknown[]) {
      // shift/unshift/splice move what's there before they run; slice/concat copy what they return.
      const before = kind === "m" || kind === "s" || kind === "o" ? cost(this, args, undefined) : 0;
      const result = original.apply(this, args);
      const n = before || cost(this, args, result);
      const line = state.line();
      // Line 0: between the program's turns (the runtime's own calls aren't the program's work).
      if (state.counting && n > 0 && line > 0) {
        state.work[line] = (state.work[line] ?? 0) + n;
        if (!state.workKind[line]) state.workKind[line] = kind;
      }
      return result;
    };
    Object.defineProperty(proto, name, { ...descriptor, value: wrapped });
  }
  return () => {
    for (const [name, descriptor] of originals) Object.defineProperty(Array.prototype, name, descriptor);
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

interface State {
  counting: boolean;
  line: () => number;
  work: Record<number, number>;
  workKind: Record<number, "m" | "s" | "c" | "o">;
}

/** Virtual timers: callbacks run in due order, without waiting (like the trace). */
class Timers {
  private queue: { id: number; due: number; seq: number; fn: () => void; every?: number }[] = [];
  private now = 0;
  private seq = 0;
  private nextId = 1;
  readonly api = {
    setTimeout: (fn: unknown, ms = 0, ...args: unknown[]) => this.add(fn, ms, args),
    setInterval: (fn: unknown, ms = 0, ...args: unknown[]) => this.add(fn, ms, args, true),
    clearTimeout: (id: number) => this.clear(id),
    clearInterval: (id: number) => this.clear(id),
  };
  private add(fn: unknown, ms: number, args: unknown[], repeat = false): number {
    if (typeof fn !== "function") return 0;
    const id = this.nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    this.queue.push({
      id,
      due: this.now + delay,
      seq: this.seq++,
      fn: () => (fn as (...a: unknown[]) => void)(...args),
      every: repeat ? Math.max(1, delay) : undefined,
    });
    return id;
  }
  private clear(id: number): void {
    this.queue = this.queue.filter((t) => t.id !== id);
  }
  next(): (() => void) | null {
    if (!this.queue.length) return null;
    this.queue.sort((a, b) => a.due - b.due || a.seq - b.seq);
    const timer = this.queue.shift()!;
    this.now = timer.due;
    if (timer.every) this.queue.push({ ...timer, due: this.now + timer.every, seq: this.seq++ });
    return timer.fn;
  }
}

function capture(state?: State): {
  console: Record<string, (...args: unknown[]) => void>;
  text: () => string;
  dropped: () => number;
} {
  let out = "";
  let dropped = 0;
  const print = (...args: unknown[]) => {
    // Formatting the output uses array methods too; that's not the program's work.
    const counting = state?.counting ?? false;
    if (state) state.counting = false;
    try {
      write(args);
    } finally {
      if (state) state.counting = counting;
    }
  };
  const write = (args: unknown[]) => {
    const line = `${args.map((a) => (typeof a === "string" ? a : format(a))).join(" ")}\n`;
    const room = MAX_OUTPUT - out.length;
    if (room > 0) out += line.slice(0, room);
    if (line.length > room) dropped += line.length - Math.max(room, 0);
  };
  return {
    console: { log: print, info: print, warn: print, error: print, debug: print, table: print },
    text: () => out,
    dropped: () => dropped,
  };
}

function format(value: unknown): string {
  try {
    if (Array.isArray(value))
      return value.length > 100
        ? `[ ${value.slice(0, 100).map(format).join(", ")}, ... ${value.length - 100} more items ]`
        : `[ ${value.map(format).join(", ")} ]`;
    if (typeof value === "string") return `'${value}'`;
    if (typeof value === "object" && value !== null) return JSON.stringify(value) ?? String(value);
    return String(value);
  } catch {
    return String(value);
  }
}

type Run = (env: Record<string, unknown>) => void;

/** Run a script and its timers and async work; resolves with how it ended. */
async function execute(
  run: Run,
  env: Record<string, unknown>,
  timers: Timers,
  deadline: () => boolean,
  idle: () => void = () => {},
): Promise<{ status: "done" | "limit" | "error"; error: unknown }> {
  let failure: unknown = null;
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
  };
  const stop = onUnhandledRejection(fail);
  try {
    try {
      run(env);
    } catch (error) {
      fail(error);
    }
    for (let turn = 0; turn < MAX_TURNS && !failed; turn++) {
      idle();
      await macrotask();
      if (failed || deadline()) break;
      const timer = timers.next();
      if (!timer) break;
      try {
        timer();
      } catch (error) {
        fail(error);
      }
    }
    await macrotask();
  } finally {
    stop();
  }
  if (failed && failure === LIMIT) return { status: "limit", error: null };
  if (failed) return { status: "error", error: failure };
  return { status: "done", error: null };
}

function compile(code: string): Run {
  const fn = new Function(M, "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval", code);
  return (env) => fn(env[M], env.console, env.setTimeout, env.setInterval, env.clearTimeout, env.clearInterval);
}

/** Set top-level `const n = 40000` / `n = 40000` to other sizes (growth runs). */
export function applyOverrides(ast: t.File, overrides?: Record<string, number>): t.File {
  if (!overrides || !Object.keys(overrides).length) return ast;
  const set = (id: t.Node, init: t.Node | null | undefined) => {
    if (
      t.isIdentifier(id) &&
      init &&
      t.isNumericLiteral(init) &&
      Number.isInteger(init.value) &&
      id.name in overrides
    ) {
      init.value = overrides[id.name];
      delete (init as { extra?: unknown }).extra; // so the new value is printed, not the old text
    }
  };
  for (const stmt of ast.program.body) {
    if (t.isVariableDeclaration(stmt)) for (const d of stmt.declarations) set(d.id, d.init);
    else if (
      t.isExpressionStatement(stmt) &&
      t.isAssignmentExpression(stmt.expression) &&
      stmt.expression.operator === "="
    ) {
      set(stmt.expression.left, stmt.expression.right);
    }
  }
  return ast;
}

/**
 * Measure a program. `prepare` parses it (and, for TypeScript, strips its
 * types). `report` gets progress every quarter second.
 */
export async function measureProgram(
  source: string,
  limitMs: number,
  prepare: (source: string) => t.File,
  report?: (progress: MeasureProgress) => void,
  /** Growth runs (`viz: size n`): top-level `n = <integer>` set to these sizes. */
  overrides?: Record<string, number>,
): Promise<Measurement> {
  const result: Measurement = {
    status: "done",
    error: null,
    lines: {},
    passes: {},
    calls: {},
    work: {},
    workKind: {},
    totals: {},
    ms: 0,
    plainMs: null,
    peakBytes: null,
    heldBytes: null,
    stdout: "",
    droppedOutput: 0,
  };
  let counted: string;
  let plain: string;
  try {
    plain = generate(applyOverrides(prepare(source), overrides)).code;
    counted = instrumentForMeasure(applyOverrides(prepare(source), overrides));
  } catch (error) {
    const err = error as { message?: string; line?: number | null };
    result.status = "error";
    result.error = { type: "SyntaxError", message: err.message ?? String(error), line: err.line ?? null };
    return result;
  }

  const size = source.split("\n").length + 2;
  const lines = new Float64Array(size);
  const passes = new Float64Array(size);
  const calls = new Float64Array(size);
  const totals: Record<number, number> = {};
  const entered = new Map<number, { atEntry: number; order: number }>();
  let order = 0;
  let started = 0;
  let lastReport = 0;
  let overLimit = false;

  const progress = (): MeasureProgress => {
    let best: { line: number; done: number; total: number; order: number } | null = null;
    for (const [line, total] of Object.entries(totals)) {
      const at = entered.get(Number(line));
      const done = passes[Number(line)] - (at?.atEntry ?? 0);
      if (total > 0 && done < total && (!best || (at?.order ?? 0) < best.order))
        best = { line: Number(line), done, total, order: at?.order ?? 0 };
    }
    const out: MeasureProgress = { elapsedMs: Math.round(performance.now() - started) };
    if (best) out.loop = { line: best.line, done: best.done, total: best.total };
    return out;
  };

  const state: State = { counting: false, line: () => api.l, work: {}, workKind: {} };
  const api = {
    c: lines,
    p: passes,
    f: calls,
    l: 0,
    t: POLL_EVERY,
    poll() {
      api.t = POLL_EVERY;
      const now = performance.now();
      if (overLimit || now - started > limitMs) {
        overLimit = true;
        api.t = -1; // keep throwing at every check
        throw LIMIT;
      }
      if (report && now - lastReport >= PROGRESS_EVERY) {
        lastReport = now;
        report(progress());
      }
    },
    it(line: number, value: unknown) {
      const length =
        Array.isArray(value) || typeof value === "string"
          ? value.length
          : value instanceof Map || value instanceof Set
            ? value.size
            : null;
      if (length !== null) api.tot(line, length);
      return value;
    },
    tot(line: number, total: number) {
      if (typeof total === "number" && Number.isFinite(total)) {
        totals[line] = Math.max(0, total);
        entered.set(line, { atEntry: passes[line], order: ++order });
      }
      return total;
    },
  };

  // The counted run.
  const out = capture(state);
  const timers = new Timers();
  const restore = countArrayWork(state);
  const env = { [M]: api, console: out.console, ...timers.api };
  started = performance.now();
  lastReport = started;
  state.counting = true;
  let ended: { status: "done" | "limit" | "error"; error: unknown };
  try {
    ended = await execute(
      compile(counted),
      env,
      timers,
      () => overLimit,
      () => {
        api.l = 0;
      },
    );
  } finally {
    state.counting = false;
    restore();
  }
  result.ms = Math.round((performance.now() - started) * 100) / 100;
  result.status = ended.status;
  if (ended.status === "limit") result.stoppedAt = progress();
  if (ended.status === "error") {
    const e = ended.error;
    result.error = {
      type: e instanceof Error ? e.name : "Uncaught",
      message: e instanceof Error ? e.message : String(e),
      line: api.l || null,
    };
  }
  const record = (from: ArrayLike<number>) => {
    const r: Record<string, number> = {};
    for (let i = 0; i < from.length; i++) if (from[i]) r[String(i)] = from[i];
    return r;
  };
  result.lines = record(lines);
  result.passes = record(passes);
  result.calls = record(calls);
  result.work = Object.fromEntries(Object.entries(state.work).map(([k, v]) => [k, v]));
  result.workKind = Object.fromEntries(Object.entries(state.workKind));
  result.totals = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v]));
  result.stdout = out.text();
  result.droppedOutput = out.dropped();

  // The honest time: the untouched program, if it's quick enough to run twice.
  if (ended.status === "done" && result.ms < PLAIN_RUN_UNDER) {
    const plainTimers = new Timers();
    const env2 = { [M]: null, console: capture().console, ...plainTimers.api };
    const t0 = performance.now();
    const again = await execute(compile(plain), env2, plainTimers, () => false);
    if (again.status === "done") result.plainMs = Math.round((performance.now() - t0) * 100) / 100;
  }
  return result;
}
