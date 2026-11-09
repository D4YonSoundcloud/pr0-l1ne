/**
 * Checking what the code runner sends, before the app uses it.
 *
 * A trace comes from a worker that also runs the program being traced, on
 * the runner's site (see "Security" in docs/how-it-works.md). The program
 * can tamper with anything in that worker, including the trace, so the app
 * treats every message as untrusted data: a tracer bug or a hostile program
 * should get a clear message, never a renderer failing somewhere deep, a
 * frozen tab, or anything acting on the page.
 *
 * Two passes:
 *   1. Limits (dataLimitProblem): plain data only (objects, arrays, strings,
 *      numbers, booleans, null), no cycles, no `__proto__` keys, and a
 *      sane size and depth. One pass over each object, however many times
 *      it's shared.
 *   2. The schema (schema/trace.schema.json), compiled when building into
 *      plain functions (traceValidators in vite.shared.ts), so no eval. The
 *      steps are checked in full except their heap objects, which many
 *      steps share: each of those is checked once.
 *
 * A trace that arrives in pieces (trace/stream.ts) is checked a piece at a
 * time as it comes (TraceCheck), while the program still runs, so little
 * is left to check when it ends: the steps keep the counts and the objects
 * already checked from piece to piece.
 */
import { heapObject, shell } from "virtual:trace-validators";
import { describe } from "./schemaErrors";
import type { Step, Trace } from "./types";

export interface DataLimits {
  /** Objects and arrays, each counted once however often it's shared. */
  objects: number;
  /** How deeply objects and arrays may nest. */
  depth: number;
  /** Characters in all strings (keys included), each string counted where it's found. */
  chars: number;
}

/**
 * Far above any real trace (the biggest examples have tens of thousands of
 * objects, nested a dozen deep), far below what would freeze a tab.
 */
export const TRACE_LIMITS: DataLimits = { objects: 25_000_000, depth: 100, chars: 1_000_000_000 };

/** Smaller things from the runner (a Measure result, its progress). */
export const MESSAGE_LIMITS: DataLimits = { objects: 1_000_000, depth: 100, chars: 50_000_000 };

/** Why some data isn't plain, bounded data, or null if it is. */
export function dataLimitProblem(value: unknown, limits: DataLimits = TRACE_LIMITS): string | null {
  return new DataLimitCheck(limits).check(value);
}

/**
 * dataLimitProblem over several values, as parts of one: the limits are
 * for them all together, and an object shared between them is checked
 * once.
 */
export class DataLimitCheck {
  private objects = 0;
  private chars = 0;
  private readonly done = new Set<object>();

  constructor(private readonly limits: DataLimits = TRACE_LIMITS) {}

  /** Why `value`, found `depth` objects deep, isn't plain, bounded data, or null if it is. */
  check(value: unknown, depth = 0): string | null {
    const { limits, done } = this;
    const open = new Set<object>(); // on the current path: seen again here, it's a cycle
    // An explicit stack, so a deep structure can't overflow the call stack.
    // Arrays are walked by index (keys: null), objects by their keys.
    const stack: { node: object; keys: string[] | null; at: number; length: number }[] = [];
    let { objects, chars } = this;
    const result = (problem: string | null) => {
      this.objects = objects;
      this.chars = chars;
      return problem;
    };

    const enter = (v: unknown): string | null => {
      if (typeof v === "string") {
        chars += v.length;
        return chars > limits.chars ? "it has too much text" : null;
      }
      if (v === null || typeof v === "number" || typeof v === "boolean") return null;
      if (typeof v !== "object") return `it holds a ${typeof v}`;
      // Shared objects are the common case: seen, and fine.
      if (done.has(v)) return null;
      if (open.has(v)) return "it refers to itself (a cycle)";
      if (++objects > limits.objects) return "it has too many objects";
      if (depth + stack.length >= limits.depth) return "it nests too deeply";
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype) return "it holds a non-plain array";
        open.add(v);
        stack.push({ node: v, keys: null, at: 0, length: v.length });
        return null;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null)
        return `it holds a ${proto?.constructor?.name ?? "non-plain"} object`;
      const keys = Object.keys(v);
      for (const key of keys) {
        if (key === "__proto__") return 'it has a "__proto__" key';
        chars += key.length;
      }
      if (chars > limits.chars) return "it has too much text";
      open.add(v);
      stack.push({ node: v, keys, at: 0, length: keys.length });
      return null;
    };

    const first = enter(value);
    if (first) return result(first);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.at >= top.length) {
        stack.pop();
        open.delete(top.node);
        done.add(top.node);
        continue;
      }
      const at = top.at++;
      const child = top.keys ? (top.node as Record<string, unknown>)[top.keys[at]] : (top.node as unknown[])[at];
      const problem = enter(child);
      if (problem) return result(problem);
    }
    return result(null);
  }
}

/** What's wrong with a trace from the runner, or null if the app can use it. */
export function traceProblem(trace: unknown): string | null {
  const limit = dataLimitProblem(trace, TRACE_LIMITS);
  if (limit) return limit;
  if (!shell(trace)) return describe(shell.errors?.[0] ?? { instancePath: "", keyword: "", params: {} });
  const check = new TraceCheck();
  const steps = (trace as Trace).steps;
  for (let i = 0; i < steps.length; i++) {
    const problem = check.heap(steps[i], i);
    if (problem) return problem;
  }
  return null;
}

/**
 * A trace checked as it arrives: `step` as each step comes (in order), then
 * `whole` once it's all there. The same checks as traceProblem.
 */
export class TraceCheck {
  private readonly limits = new DataLimitCheck(TRACE_LIMITS);
  /** Heap objects checked, each once wherever it's shared. */
  private readonly checked = new Set<unknown>();

  /** What's wrong with step `index`, or null. */
  step(step: unknown, index: number): string | null {
    // Inside the trace a step is two deep: the trace, then its steps.
    return this.limits.check(step, 2) ?? this.heap(step as Step, index);
  }

  /** What's wrong with the heap objects in step `index` not checked before, or null. */
  heap(step: Step, index: number): string | null {
    const heap = step.heap;
    if (typeof heap !== "object" || heap === null) return null; // the shell's to report
    for (const id of Object.keys(heap)) {
      const object = heap[id];
      if (this.checked.has(object)) continue;
      this.checked.add(object);
      if (!heapObject(object)) {
        const error = heapObject.errors?.[0] ?? { instancePath: "", keyword: "", params: {} };
        const at = `/steps/${index}/heap/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        return describe({ ...error, instancePath: at + error.instancePath });
      }
    }
    return null;
  }

  /** What's wrong with the whole trace, its steps each checked already, or null. */
  whole(trace: Trace): string | null {
    const { steps, ...rest } = trace;
    if (!Array.isArray(steps) || Object.getPrototypeOf(steps) !== Array.prototype) return "its steps aren't a list";
    const limit = this.limits.check(rest);
    if (limit) return limit;
    if (!shell(trace)) return describe(shell.errors?.[0] ?? { instancePath: "", keyword: "", params: {} });
    return null;
  }
}
