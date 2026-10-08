/**
 * Time and space complexity: an estimate from the code's shape, checked
 * against the run.
 *
 * The tracers describe each function's shape (Trace.cost): loops and how
 * many times each runs per pass of the code around it, calls to the
 * program's own functions and how their arguments shrink, built-ins that
 * aren't O(1), and memory that grows. This file turns that into Big-O
 * (trace/bigO.ts): nested loops multiply, code in sequence adds, recursion
 * is solved by its pattern (one call on n - 1 is n levels; two calls on
 * halves with linear work is n log n; two calls on n - 1 is 2ⁿ, unless a
 * memo prunes it).
 *
 * Then it checks against the run, which is what fixes the cases reading the
 * code alone gets wrong:
 *
 * - A loop the code doesn't bound (`while queue:`) is sized by how many times
 *   it actually ran, matched to the program's input sizes.
 * - An inner loop that ran about as many times in total as its outer loop
 *   (a sliding window's `while`), or once per edge in total (a BFS's
 *   neighbor loop), is amortized: it adds to the outer loop instead of
 *   multiplying it.
 * - Recursion that the code can't classify (a flood fill, a DFS) is sized by
 *   how many calls the run made; exponential recursion that made far fewer
 *   calls than predicted is pruned by a check.
 * - Collections the program builds are sized by how big they got.
 *
 * It's worst case for the code's shape, not average case: an early `break`
 * or a lucky input doesn't make it smaller. Everything it decided, and why,
 * is kept for the explanation panel and the editor labels.
 */
import {
  add, evaluate, expOf, setCanBeZero, factOf, format, isOne, logOf, mul, ONE, power, rename, size, sizesIn, ZERO,
  type BigO, type Term,
} from "./bigO";
import {
  liveFrames, type CostFunction, type CostNode, type Frame, type HeapObject, type SizeRef, type Step, type Trace,
  type Value,
} from "./types";

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface LoopEstimate {
  line: number;
  func: string;
  /** "× n", "× log n", "n in total", "× ?" */
  label: string;
  /** Why the code says so: "range(n)". */
  why: string;
  /** What the run showed, when it was used or checked. */
  checked?: string;
  /** True when the run decided its cost (alone, or by showing how it adds up). */
  fromRun: boolean;
  /** "code": the code says; "run": only the run could say; "both": the code gives a per-pass count and the run showed how it adds up. */
  sizedBy: "code" | "run" | "both";
}

export interface FunctionEstimate {
  name: string;
  line: number;
  time: string;
  space: string;
  /** How it was worked out, one line each. */
  why: string[];
  /** The run's counts: calls and deepest recursion. */
  checked?: string;
}

export interface SizeLegend {
  /** n, m, V, E */
  name: string;
  /** "len(nums)", "nodes in head", "edges in graph" */
  meaning: string;
  /** Its value in this run. */
  value: number;
}

export interface Estimate {
  time: string;
  space: string;
  /** Time and space of the most expensive function, when it's worse than the top level's own code. */
  legend: SizeLegend[];
  functions: FunctionEstimate[];
  loops: LoopEstimate[];
  /** Things to know about this estimate (what it couldn't size). */
  notes: string[];
  /** The run's own numbers: steps, peak recursion. */
  run: string[];
  /** Raw expressions, for tests. */
  raw: { time: BigO; space: BigO };
}

// ---------------------------------------------------------------------------
// Sizes: the symbols in the Big-O, and their values in the run
// ---------------------------------------------------------------------------

type SymKind = "value" | "len" | "inner" | "total";

interface Sym {
  key: string;
  kind: SymKind;
  /** What the program calls it: "nums", "graph", "head". */
  name: string;
  /** "len(nums)" */
  meaning: string;
  value: number;
  /** A graph (adjacency dict, objects linking to each other): shown as V, d, E. */
  graph: boolean;
  /** Built by the program rather than given to it: re-sized from the run. */
  derived: boolean;
  /** For inner/total: the collection's own length symbol. */
  of?: string;
  /** Where its name lives: "Global" or a function. */
  scope: string;
  struct?: string;
  /** Named by the code (a loop bound, a built-in's argument), not just probed. */
  static?: boolean;
  /** A list of edges (a `viz: graph ... edgelist` hint): its length is E. */
  edgeList?: boolean;
}

interface LoopStat {
  /** Most passes in one run of the loop. */
  maxPasses: number;
  /** Total passes over one run of the outer loop, for the outer loop's busiest run. */
  innerTotal?: { outerPasses: number; total: number };
  ran: boolean;
}

interface CallStat {
  calls: number;
  /** Most calls in one call from outside (all the recursion one call caused). */
  perOutsideCall: number;
  depth: number;
}

class RunFacts {
  readonly steps: Step[];
  /** func -> [step, frame] for every step it's live (sampled for long runs). */
  private framesOf = new Map<string, [Step, Frame][]>();
  readonly loops = new Map<string, LoopStat>();
  readonly calls = new Map<string, CallStat>();
  /** Step index where each loop first ran, and each function was first called. */
  readonly firstLoopStep = new Map<string, number>();
  readonly firstCallStep = new Map<string, number>();

  constructor(readonly trace: Trace) {
    this.steps = trace.steps;
    const stride = Math.max(1, Math.floor(this.steps.length / 600));
    for (let i = 0; i < this.steps.length; i += stride) {
      const step = this.steps[i];
      for (const frame of liveFrames(step)) {
        let list = this.framesOf.get(frame.func);
        if (!list) this.framesOf.set(frame.func, (list = []));
        list.push([step, frame]);
      }
    }
    this.countLoops();
    this.countCalls();
  }

  frames(func: string): [Step, Frame][] {
    return this.framesOf.get(func) ?? [];
  }

  private countLoops(): void {
    // passes per loop run, and which run of the enclosing loop (same frame) it was in
    const runs = new Map<string, { loop: string; passes: number; parent?: string }>();
    this.steps.forEach((step, index) => {
      const lastInFrame = new Map<string, string>();
      for (const ctx of step.loops) {
        if (!this.firstLoopStep.has(ctx.loop)) this.firstLoopStep.set(ctx.loop, index);
        const key = `${ctx.frame}|${ctx.loop}|${ctx.instance}`;
        const run = runs.get(key) ?? { loop: ctx.loop, passes: 0, parent: lastInFrame.get(ctx.frame) };
        run.passes = Math.max(run.passes, ctx.iteration);
        runs.set(key, run);
        lastInFrame.set(ctx.frame, key);
      }
    });
    const totals = new Map<string, Map<string, number>>(); // loop -> parent run -> total passes
    for (const run of runs.values()) {
      const stat = this.loops.get(run.loop) ?? { maxPasses: 0, ran: true };
      stat.maxPasses = Math.max(stat.maxPasses, run.passes);
      this.loops.set(run.loop, stat);
      if (run.parent) {
        const byParent = totals.get(run.loop) ?? new Map<string, number>();
        byParent.set(run.parent, (byParent.get(run.parent) ?? 0) + run.passes);
        totals.set(run.loop, byParent);
      }
    }
    for (const [loop, byParent] of totals) {
      let best: { outerPasses: number; total: number } | undefined;
      for (const [parent, total] of byParent) {
        const outerPasses = runs.get(parent)?.passes ?? 0;
        if (!best || outerPasses > best.outerPasses || (outerPasses === best.outerPasses && total > best.total)) {
          best = { outerPasses, total };
        }
      }
      this.loops.get(loop)!.innerTotal = best;
    }
  }

  private countCalls(): void {
    const current = new Map<string, number>(); // func -> calls in the current outside call
    this.steps.forEach((step, index) => {
      const depth = new Map<string, number>();
      for (const frame of step.stack) depth.set(frame.func, (depth.get(frame.func) ?? 0) + 1);
      for (const [func, d] of depth) {
        const stat = this.calls.get(func) ?? { calls: 0, perOutsideCall: 0, depth: 0 };
        stat.depth = Math.max(stat.depth, d);
        this.calls.set(func, stat);
      }
      if (step.event !== "call") return;
      const top = step.stack[step.stack.length - 1];
      const caller = step.stack[step.stack.length - 2];
      if (!top) return;
      if (!this.firstCallStep.has(top.func)) this.firstCallStep.set(top.func, index);
      const stat = this.calls.get(top.func) ?? { calls: 0, perOutsideCall: 0, depth: 1 };
      stat.calls++;
      const fromOutside = !caller || caller.func !== top.func && !step.stack.slice(0, -1).some((f) => f.func === top.func);
      if (fromOutside) current.set(top.func, 0);
      current.set(top.func, (current.get(top.func) ?? 0) + 1);
      stat.perOutsideCall = Math.max(stat.perOutsideCall, current.get(top.func)!);
      this.calls.set(top.func, stat);
    });
  }

  /** The first step where a global name exists. */
  firstGlobal(name: string): number {
    const base = name.split(".")[0];
    const i = this.steps.findIndex((s) => s.stack[0]?.locals.some(([n]) => n === base));
    return i < 0 ? this.steps.length - 1 : i;
  }
}

/** Follow a dotted name ("self.items") from a frame's variables. */
function lookup(step: Step, frame: Frame, name: string, global?: Frame): Value | undefined {
  const [base, ...rest] = name.split(".");
  let value = frame.locals.find(([n]) => n === base)?.[1] ?? global?.locals.find(([n]) => n === base)?.[1];
  for (const field of rest) {
    if (!value || value.kind !== "ref") return undefined;
    const obj = step.heap[value.id];
    if (!obj || obj.kind !== "object") return undefined;
    value = obj.fields.find(([n]) => n === field)?.[1];
  }
  return value;
}

function lengthOf(step: Step, value: Value | undefined): number | null {
  if (!value) return null;
  if (value.kind === "prim") {
    if (value.type === "str" || value.type === "string") return value.length ?? Math.max(0, value.repr.length - 2);
    return null;
  }
  const obj = step.heap[value.id];
  if (!obj) return null;
  if (obj.kind === "list" || obj.kind === "tuple" || obj.kind === "set" || obj.kind === "dict") return obj.length;
  return null;
}

/** Items of a collection, as values. */
function itemsOf(obj: HeapObject): Value[] {
  if (obj.kind === "list" || obj.kind === "tuple" || obj.kind === "set") return obj.items;
  if (obj.kind === "dict") return obj.entries.map(([, v]) => v);
  return [];
}

/** Objects of one class reachable from an object (a linked list's nodes, a tree's). */
function structureOf(step: Step, start: string): { type: string; nodes: number; links: number } | null {
  const first = step.heap[start];
  if (!first || first.kind !== "object") return null;
  const type = first.typeName;
  const seen = new Set<string>([start]);
  const queue = [start];
  let links = 0;
  while (queue.length && seen.size < 2000) {
    const obj = step.heap[queue.shift()!];
    if (!obj) continue;
    const out: Value[] = [];
    if (obj.kind === "object") for (const [, v] of obj.fields) out.push(v);
    else out.push(...itemsOf(obj));
    for (const v of out) {
      if (v.kind !== "ref") continue;
      const target = step.heap[v.id];
      if (!target) continue;
      if (target.kind === "object" && target.typeName === type) {
        links++;
        if (!seen.has(v.id)) { seen.add(v.id); queue.push(v.id); }
      } else if (target.kind !== "object" && target.kind !== "function" && target.kind !== "class" && !seen.has(v.id)) {
        seen.add(v.id);
        queue.unshift(v.id); // a list or dict of children: look inside it
      }
    }
  }
  let nodes = 0;
  for (const id of seen) if (step.heap[id]?.kind === "object" && step.heap[id].typeName === type) nodes++;
  return { type, nodes, links };
}

class Symbols {
  readonly all = new Map<string, Sym>();
  onCreate: (sym: Sym) => void = () => {};
  /** Names the program grows (appends to, adds to, stores into). */
  private grown = new Set<string>();

  constructor(private facts: RunFacts, private trace: Trace, functions: CostFunction[]) {
    const walk = (nodes: CostNode[]) => {
      for (const node of nodes) {
        if (node.kind === "loop") walk(node.body);
        else if (node.kind === "alloc" && node.into) this.grown.add(node.into.split(".")[0]);
      }
    };
    for (const f of functions) walk(f.body);
  }

  private scopeOf(name: string, fn: CostFunction): string {
    if (fn.name === "Global") return "Global";
    const base = name.split(".")[0];
    if (fn.params.includes(base)) return fn.name;
    for (const [, frame] of this.facts.frames(fn.name)) {
      if (frame.locals.some(([n]) => n === base)) return fn.name;
    }
    return "Global";
  }

  /** The value a name has in a scope, at every sampled step. */
  private *values(scope: string, name: string): Generator<[Step, Value]> {
    for (const [step, frame] of this.facts.frames(scope)) {
      const value = lookup(step, frame, name, step.stack[0]);
      if (value) yield [step, value];
    }
  }

  /** The symbol for a size, in a function's terms. */
  get(ref: SizeRef, fn: CostFunction): string {
    const scope = this.scopeOf(ref.name, fn);
    // What is it in the run? A structure of objects is named by its class.
    let probe: [Step, Value] | undefined;
    for (const entry of this.values(scope, ref.name)) { probe = entry; if (entry[1].kind === "ref") break; }
    const obj = probe && probe[1].kind === "ref" ? probe[0].heap[probe[1].id] : undefined;
    if (obj?.kind === "object") return this.structSym(obj.typeName, ref, scope);
    const isCollection = !!obj && obj.kind !== "function" && obj.kind !== "class" && obj.kind !== "opaque";
    const isString = probe?.[1].kind === "prim" && (probe[1].type === "str" || probe[1].type === "string");
    const len = !!ref.len || isCollection || isString;
    const kind: SymKind = ref.inner ? "inner" : len ? "len" : "value";
    const key = `${scope}:${ref.name}:${kind}`;
    if (this.all.has(key)) return key;
    const base = ref.name.split(".")[0];
    const sym: Sym = {
      key, kind, name: ref.name, scope, value: 0, graph: false,
      meaning: kind === "value" ? `the value of ${ref.name}` : kind === "len" ? `len(${ref.name})` : `an item of ${ref.name}`,
      derived: kind !== "value" && this.grown.has(base) && !(scope !== "Global" && this.isParam(scope, base)),
    };
    this.all.set(key, sym);
    this.measure(sym);
    if (kind === "inner") {
      const of = this.get({ name: ref.name, len: true }, fn);
      sym.of = of;
      sym.graph = this.all.get(of)!.graph;
      sym.meaning = sym.graph ? `neighbors of a node in ${ref.name}` : `len(${ref.name}[i])`;
      this.totalSym(sym);
      this.onCreate(sym);
    }
    return key;
  }

  private isParam(scope: string, name: string): boolean {
    return this.functions.get(scope)?.params.includes(name) ?? false;
  }

  functions = new Map<string, CostFunction>();

  private measure(sym: Sym): void {
    let best = 0;
    let graph = false;
    let total = 0;
    for (const [step, value] of this.values(sym.scope, sym.name)) {
      if (sym.kind === "value") {
        if (value.kind === "prim" && /^-?\d+(\.\d+)?$/.test(value.repr)) best = Math.max(best, Number(value.repr));
        continue;
      }
      const n = lengthOf(step, value);
      if (n === null) continue;
      best = Math.max(best, n);
      if (value.kind === "ref") {
        const obj = step.heap[value.id];
        const items = obj ? itemsOf(obj) : [];
        let t = 0;
        let nested = 0;
        for (const item of items) {
          const len = lengthOf(step, item);
          if (len !== null && item.kind === "ref") { t += len; nested++; }
        }
        if (nested && nested === items.length) {
          total = Math.max(total, t);
          if (obj?.kind === "dict" && obj.entries.length) graph = true;
        }
      }
    }
    const hint = this.trace.viz?.graphs.find((g) => g.target === sym.name);
    const hinted = !!hint;
    if (hint?.options.includes("edgelist")) sym.edgeList = true;
    if (sym.kind === "inner") {
      const parentLen = best;
      sym.value = parentLen;
      return;
    }
    sym.value = best;
    sym.graph = graph || hinted;
    (sym as Sym & { totalValue?: number }).totalValue = total;
  }

  private totalSym(inner: Sym): void {
    const of = this.all.get(inner.of!)!;
    const key = `${of.key}:total`;
    if (!this.all.has(key)) {
      const totalValue = (of as Sym & { totalValue?: number }).totalValue ?? 0;
      this.all.set(key, {
        key, kind: "total", name: of.name, scope: of.scope, value: totalValue, graph: of.graph, derived: of.derived, of: of.key,
        meaning: of.graph ? `edges in ${of.name}` : `items in all of ${of.name}`, struct: of.struct,
      });
    }
    // An item's typical length: total / count.
    inner.value = of.value ? Math.round(this.all.get(key)!.value / of.value) : 0;
  }

  private structSym(type: string, ref: SizeRef, scope: string): string {
    const key = `struct:${type}`;
    if (!this.all.has(key)) {
      let nodes = 0;
      let links = 0;
      for (const [step, value] of this.values(scope, ref.name)) {
        if (value.kind !== "ref") continue;
        const s = structureOf(step, value.id);
        if (s) { nodes = Math.max(nodes, s.nodes); links = Math.max(links, s.links); }
      }
      this.all.set(key, {
        key, kind: "len", name: ref.name, scope, value: nodes, graph: false, derived: false, struct: type,
        meaning: `${type} objects reachable from ${ref.name}`,
      });
      this.all.set(`${key}:total`, {
        key: `${key}:total`, kind: "total", name: ref.name, scope, value: links, graph: true, derived: false, of: key,
        struct: type, meaning: `links between ${type} objects`,
      });
      this.onCreate({ key: `${key}:inner`, kind: "inner", graph: true } as Sym);
      this.all.set(`${key}:inner`, {
        key: `${key}:inner`, kind: "inner", name: ref.name, scope, value: nodes ? Math.round(links / nodes) : 0,
        graph: true, derived: false, of: key, struct: type, meaning: `links from one ${type}`,
      });
    }
    if (ref.inner) {
      this.all.get(key)!.graph = true;
      return `${key}:inner`;
    }
    return key;
  }

  /**
   * Sizes the run can be matched against: the inputs a function was given,
   * and the program's collections that existed at step `when` (so a result
   * computed later isn't mistaken for an input). `forCollection`: sizing a
   * collection the program built, where an item's length isn't a candidate.
   */
  candidates(fn: CostFunction, when: number, forCollection = false): Sym[] {
    const out = new Map<string, Sym>();
    const consider = (key: string) => {
      const s = this.all.get(key);
      if (s && !s.derived && s.value >= 2 && !(forCollection && s.kind === "inner")) out.set(key, s);
    };
    for (const p of fn.params) {
      const key = this.get({ name: p }, fn);
      if (this.all.get(key)?.kind !== "value") consider(key); // a node number isn't a size
    }
    const step = this.facts.trace.steps[Math.min(when, this.facts.trace.steps.length - 1)];
    const global = step?.stack[0];
    const globalFn = this.functions.get("Global")!;
    const present = new Set((global?.locals ?? []).map(([n]) => n));
    for (const [name, value] of global?.locals ?? []) {
      if (value.kind !== "ref") continue; // strings and numbers count only when the code uses them as sizes
      const obj = value.kind === "ref" ? step.heap[value.id] : undefined;
      if (obj && (obj.kind === "function" || obj.kind === "class" || obj.kind === "opaque")) continue;
      const key = this.get({ name, len: true }, globalFn);
      consider(key);
      const sym = this.all.get(key)!;
      if (sym.kind === "len" && !sym.struct && ((sym as Sym & { totalValue?: number }).totalValue ?? 0) > 0) {
        consider(this.get({ name, len: true, inner: true }, globalFn));
        consider(`${key}:total`);
      }
      if (sym.struct && this.all.get(key)!.graph) consider(`${key}:total`);
    }
    for (const s of this.all.values()) {
      if (s.scope !== fn.name && s.scope !== "Global" && !s.struct) continue;
      if (s.scope === "Global" && !present.has(s.name.split(".")[0])) continue;
      if (s.kind !== "value" || s.static) consider(s.key);
    }
    return [...out.values()];
  }
}

// ---------------------------------------------------------------------------
// Matching run counts to sizes
// ---------------------------------------------------------------------------

interface Match {
  cost: BigO;
  why: string;
}

const KIND_ORDER: Record<SymKind, number> = { len: 0, value: 1, total: 2, inner: 3 };

function match(count: number, candidates: Sym[], what: string): Match {
  if (count <= 1) return { cost: ONE, why: `${what} ${count === 1 ? "once" : "never"}` };
  const sorted = [...candidates].sort((a, b) =>
    Math.abs(a.value - count) - Math.abs(b.value - count) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const close = sorted.find((s) => Math.abs(s.value - count) <= Math.max(1, 0.15 * s.value));
  if (close) return { cost: size(close.key), why: `${what} ${count} times, about ${close.meaning} (${close.value})` };
  // log needs a big enough input to tell apart from "a few": log₂ 8 is 3.
  const log = candidates.find((s) => s.value >= 16 && count < s.value / 3 && Math.abs(count - Math.log2(s.value)) <= 1.2);
  if (log) return { cost: logOf(log.key), why: `${what} ${count} times, about log₂ of ${log.meaning} (${log.value})` };
  const square = candidates.find((s) => s.value >= 3 && Math.abs(count - s.value * s.value) <= 0.25 * s.value * s.value);
  if (square) return { cost: power(square.key, 2), why: `${what} ${count} times, about ${square.meaning}² (${square.value}²)` };
  const above = [...candidates].filter((s) => s.value >= count).sort((a, b) => a.value - b.value || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])[0];
  if (above) return { cost: size(above.key), why: `${what} ${count} times, at most ${above.meaning} (${above.value})` };
  const biggest = [...candidates].sort((a, b) => b.value - a.value)[0];
  if (biggest) return { cost: size(biggest.key), why: `${what} ${count} times, more than ${biggest.meaning} (${biggest.value})` };
  return { cost: ONE, why: `${what} ${count} times; no input size to compare with` };
}

interface SizedLoop extends LoopEstimate {
  cost?: BigO;
  amortized?: boolean;
  unsized?: boolean;
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

interface Cost {
  /** Multiplied by the loops around it. */
  each: BigO;
  /** Added once per run of the enclosing loop (amortized inner loops). */
  once: BigO;
  /** Added once for the whole program (functions sized by their total calls). */
  total: BigO;
}


interface FunctionResult {
  time: BigO;
  space: BigO;
  /** Time is the program-wide total, not per call (sized from the run). */
  wholeRun: boolean;
  /** Memory that outlives a call (growing a global, a memo). */
  kept: BigO;
  why: string[];
  checked?: string;
}

class Estimator {
  private results = new Map<string, FunctionResult>();
  private inProgress = new Set<string>();
  readonly loops: LoopEstimate[] = [];
  readonly notes: string[] = [];
  private fns = new Map<string, CostFunction>();

  constructor(private facts: RunFacts, private syms: Symbols, functions: CostFunction[]) {
    for (const f of functions) this.fns.set(f.name, f);
    syms.functions = this.fns;
  }

  private sym(ref: SizeRef | null | undefined, fn: CostFunction): string | null {
    if (!ref) return null;
    const key = this.syms.get(ref, fn);
    const s = this.syms.all.get(key);
    if (s) s.static = true;
    if (s?.derived) return this.rematch(s, fn);
    return key;
  }

  private rematched = new Map<string, string | null>();

  /** A collection the program builds is sized by how big it got, in terms of the inputs. */
  private rematch(s: Sym, fn: CostFunction): string | null {
    if (this.rematched.has(s.key)) return this.rematched.get(s.key)!;
    this.rematched.set(s.key, null);
    const when = s.scope === "Global" || fn.name === "Global" ? this.facts.firstGlobal(s.name) : this.facts.firstCallStep.get(fn.name) ?? 0;
    const m = match(s.value, this.syms.candidates(fn, when, true), `${s.name} held up to`);
    const key = m.cost.length === 1 && Object.keys(m.cost[0].pow).length === 1 ? sizesIn(m.cost)[0] : null;
    this.rematched.set(s.key, key);
    return key;
  }

  private sizesCost(refs: SizeRef[], fn: CostFunction): BigO {
    const syms = refs.map((r) => this.sym(r, fn)).filter((k): k is string => !!k);
    return syms.length ? add(...syms.map((k) => size(k))) : ONE;
  }

  /** Big-O inside explanations, written once the sizes have their letters (see compute). */
  readonly formulas: BigO[] = [];
  private label(cost: BigO): string {
    this.formulas.push(cost);
    return `⟨${this.formulas.length - 1}⟩`;
  }

  /** How many times a loop runs per pass of what's around it, deciding per-pass vs amortized. */
  private loopCost(node: Extract<CostNode, { kind: "loop" }>, fn: CostFunction, outer: BigO | null): { perPass: BigO; amortized: BigO | null; estimate: LoopEstimate } {
    const stat = node.loop ? this.facts.loops.get(node.loop) : undefined;
    const b = node.bound;
    const est: LoopEstimate = { line: node.line, func: fn.name, label: "", why: b.why, fromRun: false, sizedBy: "code" };
    let perPass: BigO = ONE;
    let amortized: BigO | null = null;
    const when = (node.loop ? this.facts.firstLoopStep.get(node.loop) : undefined) ?? this.facts.firstCallStep.get(fn.name) ?? 0;
    const candidates = (perItem = false) => this.syms.candidates(fn, when, !perItem);

    if (b.kind === "size") perPass = this.sizesCost(b.sizes, fn);
    else if (b.kind === "log") {
      const k = this.sym(b.size, fn);
      perPass = k ? logOf(k) : ONE;
    } else if (b.kind === "const") perPass = ONE;

    const innerKind = b.kind === "size" && b.sizes.some((r) => r.inner);
    if (stat?.innerTotal && outer && (b.kind === "unknown" || innerKind)) {
      const { outerPasses, total } = stat.innerTotal;
      if (innerKind) {
        // Each item's list: over the whole outer loop, every list once?
        const innerKey = this.sym(b.sizes.find((r) => r.inner)!, fn);
        const totalKey = innerKey ? this.syms.all.get(innerKey)?.of && `${this.syms.all.get(innerKey)!.of}:total` : null;
        const totalSym = totalKey ? this.syms.all.get(totalKey) : undefined;
        if (totalSym && totalSym.value > 0 && total <= totalSym.value + 1 && outerPasses >= 2) {
          amortized = size(totalSym.key);
          est.checked = `ran ${total} times in all over ${outerPasses} passes of the outer loop: at most once per ${totalSym.graph ? "edge" : "item"} (${totalSym.meaning}: ${totalSym.value})`;
          est.fromRun = true;
        }
      } else if (outerPasses >= 2 && total <= 1.5 * outerPasses + 2) {
        amortized = outer;
        est.checked = `ran ${total} times in all over ${outerPasses} passes of the outer loop, so it adds to that loop instead of multiplying it`;
        est.fromRun = true;
      } else if (outerPasses >= 1) {
        const m = match(Math.round(total / Math.max(1, outerPasses)), candidates(true), "ran on average");
        perPass = m.cost;
        est.checked = `${m.why} per pass of the outer loop`;
        est.fromRun = true;
      }
    } else if (b.kind === "unknown") {
      if (stat?.ran) {
        const m = match(stat.maxPasses, candidates(), "ran");
        perPass = m.cost;
        est.checked = m.why;
        est.fromRun = true;
      } else {
        est.checked = "didn't run, so it couldn't be sized";
        this.notes.push(`The loop on line ${node.line} depends on the data and didn't run, so it's counted as O(1).`);
      }
    } else if (stat?.ran && b.kind === "const") {
      est.checked = `ran up to ${stat.maxPasses} time${stat.maxPasses === 1 ? "" : "s"}`;
    } else if (stat?.ran) {
      // A loop the code sizes: say whether the run agrees.
      const predicted = evaluate(perPass, (k) => this.syms.all.get(k)?.value ?? 1);
      if (stat.maxPasses > 2 * predicted + 2 && predicted > 0) {
        const m = match(stat.maxPasses, candidates(), "ran");
        perPass = m.cost;
        est.checked = `${m.why}: more than the code suggests`;
        est.fromRun = true;
      } else {
        est.checked = `ran up to ${stat.maxPasses} time${stat.maxPasses === 1 ? "" : "s"} per run (expected about ${Math.round(predicted)})`;
      }
    }
    if (est.fromRun) est.sizedBy = b.kind === "unknown" ? "run" : "both";
    const sized = est as SizedLoop;
    sized.cost = amortized ?? perPass;
    sized.amortized = !!amortized;
    sized.unsized = b.kind === "unknown" && !est.fromRun;
    return { perPass, amortized, estimate: est };
  }

  /** Time of a block of code, per run of it. */
  private block(nodes: CostNode[], fn: CostFunction, outer: BigO | null, selfCalls: { mult: BigO; shrink: string; alt: boolean }[], mult: BigO): Cost {
    let each: BigO = ONE; // every block does some constant work
    let once: BigO = ZERO;
    let total: BigO = ZERO;
    for (const node of nodes) {
      if (node.kind === "loop") {
        const { perPass, amortized, estimate } = this.loopCost(node, fn, outer);
        this.loops.push(estimate);
        const passes = amortized ?? perPass;
        const inner = this.block(node.body, fn, passes, selfCalls, amortized ? mult : mul(mult, perPass));
        const loopTime = add(mul(passes, add(ONE, inner.each)), inner.once);
        if (amortized) once = add(once, loopTime);
        else each = add(each, loopTime);
        total = add(total, inner.total);
      } else if (node.kind === "call") {
        if (node.callee === fn.name) {
          selfCalls.push({ mult, shrink: node.shrink, alt: !!node.alt });
          each = add(each, ONE);
          continue;
        }
        const callee = this.fns.get(node.callee);
        if (!callee) { each = add(each, ONE); continue; }
        const r = this.function(callee);
        if (!r) { each = add(each, ONE); continue; }
        const renamed = this.renameInto(r.time, callee, node.args, fn);
        if (r.wholeRun) total = add(total, renamed);
        else each = add(each, renamed);
      } else if (node.kind === "op") {
        const cost = this.opCost(node, fn);
        each = add(each, cost);
        // A costly built-in inside a loop is easy to miss: say so.
        if (!isOne(mult) && !isOne(cost) && node.cost !== "log") {
          const shift = /\.shift\(\)/.test(node.what) ? " (it moves every item; a real queue, or an index into the array, makes it O(1))"
            : /\.unshift\(\)/.test(node.what) ? " (it moves every item; pushing, then reversing once at the end, is cheaper)"
            : /\.pop\(0\)/.test(node.what) ? " (it moves every item; collections.deque makes it O(1))"
              : /^in /.test(node.what) ? " (searching a list; a set makes it O(1))" : "";
          this.notes.push(`Line ${node.line}: ${node.what.replace(/ \(copies\)$/, "")} costs ${this.label(cost)} each time it runs${shift}.`);
        }
      }
    }
    return { each, once, total };
  }

  private opCost(node: Extract<CostNode, { kind: "op" }>, fn: CostFunction): BigO {
    if (node.container && this.isHashed(node.container, fn)) return ONE;
    const k = this.sym(node.size, fn);
    if (!k) return ONE;
    if (node.cost === "log") return logOf(k);
    if (node.cost === "nlogn") return mul(size(k), logOf(k));
    return size(k);
  }

  /** Is a container a set or dict in the run (so `in` and friends are O(1))? */
  private isHashed(name: string, fn: CostFunction): boolean {
    const frames = [...this.facts.frames(fn.name), ...this.facts.frames("Global")];
    for (const [step, frame] of frames) {
      const v = lookup(step, frame, name, step.stack[0]);
      if (v?.kind === "ref") {
        const obj = step.heap[v.id];
        if (obj) return obj.kind === "dict" || obj.kind === "set" || /^(Set|Map|WeakMap|WeakSet)$/.test(obj.typeName);
      }
    }
    return false;
  }

  /** A callee's cost is in its own sizes; put it in the caller's. */
  private renameInto(x: BigO, callee: CostFunction, args: (SizeRef | null)[], caller: CostFunction): BigO {
    const map = new Map<string, string>();
    callee.params.forEach((param, i) => {
      const arg = args[i];
      if (!arg) return;
      for (const kind of ["value", "len", "inner"] as const) {
        const from = `${callee.name}:${param}:${kind}`;
        if (!this.syms.all.has(from)) continue;
        const to = this.sym({ name: arg.name, len: kind !== "value" || arg.len, inner: kind === "inner" || arg.inner }, caller);
        if (to && to !== from) {
          map.set(from, to);
          const toSym = this.syms.all.get(to);
          if (kind === "len" && toSym && this.syms.all.has(`${from}:total`) && this.syms.all.has(`${to}:total`)) {
            map.set(`${from}:total`, `${to}:total`);
          }
        }
      }
    });
    return map.size ? rename(x, (s) => map.get(s) ?? s) : x;
  }

  /** The size a recursive function works down: its first parameter that's a size. */
  private primary(fn: CostFunction): string | null {
    for (const p of fn.params) {
      const key = this.syms.get({ name: p }, fn);
      const s = this.syms.all.get(key);
      if (s && (s.value >= 1 || s.struct)) return key;
    }
    return fn.params.length ? this.syms.get({ name: fn.params[0] }, fn) : null;
  }

  function(fn: CostFunction): FunctionResult | null {
    const cached = this.results.get(fn.name);
    if (cached) return cached;
    if (this.inProgress.has(fn.name)) return null; // mutual recursion: counted where it's sized
    this.inProgress.add(fn.name);
    const selfCalls: { mult: BigO; shrink: string; alt: boolean }[] = [];
    const body = this.block(fn.body, fn, null, selfCalls, ONE);
    const work = add(body.each, body.once);
    const space = this.space(fn);
    const why: string[] = [];
    let time = work;
    let depth: BigO = ONE;
    let wholeRun = false;
    let checked: string | undefined;
    const stat = this.facts.calls.get(fn.name);

    if (selfCalls.length) {
      const p = this.primary(fn);
      // `return f(a)` in one branch and `return f(b)` in another: only one runs.
      const a = selfCalls.filter((c) => !c.alt).length + (selfCalls.some((c) => c.alt) ? 1 : 0);
      const inLoop = selfCalls.some((c) => !isOne(c.mult));
      const shrinks = new Set(selfCalls.map((c) => c.shrink));
      const kind = shrinks.has("unknown") || shrinks.has("same") ? "unknown"
        : shrinks.has("half") ? "half" : shrinks.has("child") ? "child" : "minus";
      const pName = () => (p ? this.label(size(p)) : "n");
      const calls = stat?.perOutsideCall ?? 0;
      if (fn.memo && p) {
        time = mul(size(p), work);
        depth = size(p);
        why.push(`remembers its answers (a memo), so it does the work once per value of ${pName()}`);
      } else if (kind === "half" && p) {
        const c = Math.log2(a);
        const k = Math.max(0, ...work.map((t) => t.pow[p] ?? 0));
        const j = Math.max(0, ...work.map((t) => t.log[p] ?? 0));
        if (a === 1) time = k === 0 ? mul(work, logOf(p)) : work;
        else if (k > c + 1e-9) time = work;
        else if (Math.abs(k - c) < 1e-9) time = mul(power(p, k), mulLogs(p, j + 1));
        else time = power(p, c);
        depth = logOf(p);
        why.push(`calls itself ${a === 1 ? "once" : `${a} times`} on half of ${pName()}, with ${this.label(work)} work per call: ${this.label(time)} in all`);
      } else if (kind === "child" && p) {
        time = mul(size(p), work);
        depth = size(p);
        why.push(`calls itself on each ${this.syms.all.get(p)?.struct ?? "child"} once, with ${this.label(work)} work per call`);
      } else if (kind === "minus" && p) {
        if (inLoop) { time = mul(factOf(p), work); why.push(`calls itself in a loop on ${pName()} - 1: a permutation-style search`); }
        else if (a === 1) { time = mul(size(p), work); why.push(`calls itself once on ${pName()} - 1, with ${this.label(work)} work per call`); }
        else { time = mul(expOf(p, a), work); why.push(`calls itself ${a} times on ${pName()} - 1`); }
        depth = size(p);
        // Does the run agree? A check (visited, a memo) can prune it.
        const v = this.syms.all.get(p)?.value ?? 0;
        if (!inLoop && a >= 2 && calls && v >= 4) {
          const predictedExp = a ** Math.min(30, v);
          if (Math.abs(Math.log(calls) - Math.log(v)) < Math.abs(Math.log(calls) - Math.log(predictedExp)) && calls <= (a + 1) * v) {
            time = mul(size(p), work);
            why.push(`but the run made only ${calls} calls for ${pName()} = ${v}: something (a check or a cache) prunes it to about one call per value`);
          }
        }
      } else {
        // Can't tell from the code: size it by how many calls the run made.
        const all = stat?.calls ?? 0;
        const m = match(all, this.syms.candidates(fn, this.facts.firstCallStep.get(fn.name) ?? 0, true), "was called");
        time = mul(m.cost, work);
        wholeRun = true;
        // Worst case, the stack is as deep as the calls (a search down one long path).
        depth = stat && stat.depth > 1 ? m.cost : ONE;
        why.push(`${m.why} in all, with ${this.label(work)} work per call`);
        checked = `${all} calls in all, ${stat?.depth ?? 0} deep at most`;
      }
      if (stat && !checked) checked = `${stat.calls} call${stat.calls === 1 ? "" : "s"} in all${stat.depth > 1 ? `, ${stat.depth} deep at most` : ""}`;
    } else {
      if (stat && fn.name !== "Global") checked = `${stat.calls} call${stat.calls === 1 ? "" : "s"}`;
    }
    time = add(time, body.total);

    // Space: the call stack, plus memory per call and kept memory.
    let spaceCost: BigO = space.peak;
    if (selfCalls.length) {
      const perFrame = space.local;
      const geometric = depth.some((t: Term) => Object.keys(t.log).length > 0);
      spaceCost = geometric ? add(depth, perFrame) : mul(depth, add(ONE, perFrame));
      if (fn.memo) spaceCost = add(spaceCost, depth);
      const kept = wholeRun || fn.memo ? space.kept : mul(isOne(time) ? ONE : time, space.kept);
      spaceCost = add(spaceCost, kept, space.globalGrowth);
      if (!isOne(depth)) why.push(`the call stack goes ${this.label(depth)} deep`);
    } else {
      spaceCost = add(spaceCost, space.kept, space.globalGrowth);
    }
    const result: FunctionResult = { time, space: spaceCost, wholeRun, kept: space.kept, why, checked };
    this.inProgress.delete(fn.name);
    this.results.set(fn.name, result);
    return result;
  }

  /**
   * Memory a function uses: `local` (made fresh per call), `kept` (outlives
   * the call), `globalGrowth` (collections it fills that the run sized).
   */
  private space(fn: CostFunction): { peak: BigO; local: BigO; kept: BigO; globalGrowth: BigO } {
    let local: BigO = ZERO;
    let kept: BigO = ZERO;
    let globalGrowth: BigO = ZERO;
    const intoSeen = new Set<string>();
    const walk = (nodes: CostNode[], mult: BigO) => {
      for (const node of nodes) {
        if (node.kind === "loop") {
          const est = this.loops.find((l) => l.line === node.line && l.func === fn.name) as SizedLoop | undefined;
          walk(node.body, mul(mult, est?.cost ?? ONE));
        } else if (node.kind === "alloc") {
          const own = node.sizes.length ? mul(...node.sizes.map((r) => { const k = this.sym(r, fn); return k ? size(k) : ONE; })) : ONE;
          if (node.into && node.into.includes(".")) {
            kept = add(kept, mul(mult, own)); // a field of an object: the structure grows
          } else if (node.into) {
            if (intoSeen.has(node.into)) continue;
            intoSeen.add(node.into);
            // How big did it get? That's its size, in terms of the inputs.
            const scope = this.isLocal(node.into, fn) ? fn : this.fns.get("Global")!;
            const key = this.syms.get({ name: node.into, len: true }, scope);
            const s = this.syms.all.get(key);
            let cost: BigO;
            if (s && s.value > 0) {
              const when = scope.name === "Global" ? this.facts.firstGlobal(node.into) : this.facts.firstCallStep.get(fn.name) ?? 0;
              const m = match(s.value, this.syms.candidates(fn, when, true), `${node.into} held up to`);
              cost = m.cost;
            } else cost = mul(mult, own);
            if (scope === fn) local = add(local, cost);
            else globalGrowth = add(globalGrowth, cost);
          } else if (node.name && !isOne(mult)) {
            local = add(local, own); // replaced each pass
          } else {
            const c = node.name ? own : mul(mult, own);
            if (fn.name === "Global" || this.isLocal(node.name ?? "", fn)) local = add(local, c);
            else kept = add(kept, c);
          }
        } else if (node.kind === "op" && /copies/.test(node.what)) {
          const k = this.sym(node.size, fn);
          if (k) local = add(local, size(k));
        } else if (node.kind === "call" && node.callee !== fn.name) {
          const callee = this.fns.get(node.callee);
          const r = callee && this.function(callee);
          if (r && callee) {
            local = add(local, this.renameInto(r.space, callee, node.args, fn));
            // What it keeps (a stack's push) builds up over every call.
            if (!isOne(mult) && !r.wholeRun) kept = add(kept, mul(mult, this.renameInto(r.kept, callee, node.args, fn)));
          }
        }
      }
    };
    walk(fn.body, ONE);
    return { peak: local, local, kept, globalGrowth };
  }

  private isLocal(name: string, fn: CostFunction): boolean {
    if (fn.name === "Global") return true;
    const base = name.split(".")[0];
    if (base === "self") return false;
    return this.facts.frames(fn.name).some(([, frame]) => frame.locals.some(([n]) => n === base));
  }
}

function mulLogs(sym: string, times: number): BigO {
  let out: BigO = ONE;
  for (let i = 0; i < times; i++) out = mul(out, logOf(sym));
  return out;
}

// ---------------------------------------------------------------------------
// Naming sizes: n, m, V, E
// ---------------------------------------------------------------------------

/** Rewrite V·d (nodes times neighbors each) as E, since that's what it adds up to. */
function collapse(x: BigO, syms: Map<string, Sym>): BigO {
  let out = x;
  for (const s of syms.values()) {
    if (s.kind !== "inner" || !s.of) continue;
    const total = syms.get(`${s.of}:total`);
    if (!total || !total.graph) continue;
    out = out.map((t) => {
      const k = Math.min(t.pow[s.of!] ?? 0, t.pow[s.key] ?? 0);
      if (!k) return t;
      const pow = { ...t.pow, [s.of!]: t.pow[s.of!] - k, [s.key]: t.pow[s.key] - k, [total.key]: (t.pow[total.key] ?? 0) + k };
      for (const key of Object.keys(pow)) if (!pow[key]) delete pow[key];
      return { ...t, pow };
    });
    out = add(out);
  }
  return out;
}

function nameSizes(used: string[], syms: Map<string, Sym>): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const take = (key: string, name: string) => { names.set(key, name); taken.add(name); };
  // Graphs first: V, E, d. A list of edges is E.
  for (const key of used) if (syms.get(key)?.edgeList && !taken.has("E")) take(key, "E");
  const graphs = used.map((k) => syms.get(k)).filter((s): s is Sym => !!s && s.graph && !names.has(s.key));
  const roots = [...new Set(graphs.map((s) => (s.kind === "len" ? s.key : s.of ?? s.key)))];
  roots.forEach((root, i) => {
    const suffix = roots.length > 1 ? String(i + 1) : "";
    take(root, `V${suffix}`);
    take(`${root}:total`, `E${suffix}`);
    for (const s of syms.values()) if (s.kind === "inner" && s.of === root) take(s.key, `d${suffix}`);
  });
  // Short variable names keep their own name: n, k, m.
  for (const key of used) {
    const s = syms.get(key);
    if (!s || names.has(key)) continue;
    if (s.kind === "value" && /^[a-zA-Z]$/.test(s.name) && !taken.has(s.name)) take(key, s.name);
  }
  const letters = ["n", "m", "k", "p", "q", "r", "s", "t", "u", "w"];
  const byMeaning = new Map<string, string>();
  for (const [key, name] of names) { const m = syms.get(key)?.meaning; if (m && name) byMeaning.set(m, name); }
  for (const key of used) {
    if (names.has(key)) continue;
    const s = syms.get(key);
    const same = s && byMeaning.get(s.meaning);
    if (same) { names.set(key, same); continue; }
    // A grid's rows × columns reads better as n·m than as one symbol.
    const letter = letters.find((l) => !taken.has(l)) ?? `n${names.size}`;
    take(key, letter);
    if (s) byMeaning.set(s.meaning, letter);
    if (s?.kind === "len" && !s.graph) {
      const total = syms.get(`${key}:total`);
      if (total) names.set(total.key, "");
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const cache = new WeakMap<Trace, Estimate | null>();

export function estimateComplexity(trace: Trace): Estimate | null {
  if (cache.has(trace)) return cache.get(trace)!;
  const result = compute(trace);
  cache.set(trace, result);
  return result;
}

function compute(trace: Trace): Estimate | null {
  const functions = trace.cost?.functions;
  if (!functions?.length || !trace.steps.length) return null;
  // Neighbors of a node can be 0 (a node with no edges); a grid's row length can't.
  let graphs = new Set<string>();
  setCanBeZero((k) => graphs.has(k));
  try {
    return computeWith(trace, functions, (g) => (graphs = g));
  } finally {
    setCanBeZero(() => false);
  }
}

function computeWith(trace: Trace, functions: CostFunction[], shareGraphs: (keys: Set<string>) => void): Estimate | null {
  const facts = new RunFacts(trace);
  const syms = new Symbols(facts, trace, functions);
  const graphInner = new Set<string>();
  shareGraphs(graphInner);
  syms.onCreate = (sym) => { if (sym.kind === "inner" && sym.graph) graphInner.add(sym.key); };
  const est = new Estimator(facts, syms, functions);
  const global = functions.find((f) => f.name === "Global") ?? functions[0];

  const results = new Map<string, FunctionResult>();
  for (const f of functions) {
    const r = est.function(f);
    if (r) results.set(f.name, r);
  }
  const top = results.get(global.name)!;
  // A grid's n·m: rows × columns of the same grid, written with both letters.
  const expand = (x: BigO): BigO => {
    let out = collapse(x, syms.all);
    for (const s of syms.all.values()) {
      if (s.kind !== "total" || s.graph || !s.of) continue;
      const inner = [...syms.all.values()].find((i) => i.kind === "inner" && i.of === s.of);
      if (!inner) continue;
      out = out.map((t) => {
        const k = t.pow[s.key];
        if (!k) return t;
        const pow = { ...t.pow, [s.of!]: (t.pow[s.of!] ?? 0) + k, [inner.key]: (t.pow[inner.key] ?? 0) + k };
        delete pow[s.key];
        return { ...t, pow };
      });
      out = add(out);
    }
    return out;
  };

  const time = expand(top.time);
  const space = expand(top.space);
  const fnTimes = [...results.entries()].map(([name, r]) => [name, expand(r.time), expand(r.space)] as const);
  const loopCosts = est.loops.map((l) => expand((l as SizedLoop).cost ?? ONE));

  const used = new Set<string>();
  for (const x of [time, space, ...fnTimes.flatMap(([, t, s]) => [t, s]), ...loopCosts, ...est.formulas.map(expand)]) {
    for (const k of sizesIn(x)) used.add(k);
  }
  const names = nameSizes([...used], syms.all);
  const show = (k: string) => names.get(k) || syms.all.get(k)?.name || k;
  const order = [...names.keys()];
  const fmt = (x: BigO) => format(x, show, order);
  const inner = (x: BigO) => fmt(x).slice(2, -1);
  const fill = (text: string) => text.replace(/⟨(\d+)⟩/g, (_, i) => inner(expand(est.formulas[Number(i)])));

  const loops: LoopEstimate[] = (est.loops as SizedLoop[]).map((l, i) => {
    const text = inner(loopCosts[i]);
    const label = l.unsized ? "× ?" : l.amortized ? `${text} in total` : `× ${text}`;
    return { line: l.line, func: l.func, label, why: l.why, checked: l.checked, fromRun: l.fromRun, sizedBy: l.sizedBy };
  });

  const legend: SizeLegend[] = [];
  for (const [key, name] of names) {
    if (!name || !used.has(key)) continue;
    const s = syms.all.get(key);
    if (s && !legend.some((l) => l.name === name)) legend.push({ name, meaning: s.meaning, value: s.value });
  }

  const functionsOut: FunctionEstimate[] = fnTimes
    .filter(([name]) => name !== global.name)
    .map(([name, t, s]) => {
      const fn = functions.find((f) => f.name === name)!;
      const r = results.get(name)!;
      return { name, line: fn.line, time: fmt(t), space: fmt(s), why: r.why.map(fill), checked: r.checked };
    });

  const run: string[] = [`${trace.steps.length} steps`];
  const deepest = [...facts.calls.entries()].filter(([f]) => f !== "Global").sort((a, b) => b[1].depth - a[1].depth)[0];
  if (deepest && deepest[1].depth > 1) run.push(`${deepest[0]}() recursed ${deepest[1].depth} deep`);

  return {
    time: fmt(time),
    space: fmt(space),
    legend,
    functions: functionsOut,
    loops,
    notes: [...new Set(est.notes.map(fill))],
    run,
    raw: { time, space },
  };
}
