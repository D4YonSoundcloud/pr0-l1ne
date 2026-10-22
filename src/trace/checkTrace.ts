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
 */
import { heapObject, shell } from "virtual:trace-validators";
import { describe } from "./schemaErrors";
import type { Trace } from "./types";

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
export const TRACE_LIMITS: DataLimits = { objects: 5_000_000, depth: 100, chars: 200_000_000 };

/** Smaller things from the runner (a Measure result, its progress). */
export const MESSAGE_LIMITS: DataLimits = { objects: 1_000_000, depth: 100, chars: 50_000_000 };

/** Why some data isn't plain, bounded data, or null if it is. */
export function dataLimitProblem(value: unknown, limits: DataLimits = TRACE_LIMITS): string | null {
  let objects = 0;
  let chars = 0;
  const done = new Set<object>();
  const open = new Set<object>(); // on the current path: seen again here, it's a cycle
  // An explicit stack, so a deep structure can't overflow the call stack.
  // Arrays are walked by index (keys: null), objects by their keys.
  const stack: { node: object; keys: string[] | null; at: number; length: number }[] = [];

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
    if (stack.length >= limits.depth) return "it nests too deeply";
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
  if (first) return first;
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
    if (problem) return problem;
  }
  return null;
}

/** What's wrong with a trace from the runner, or null if the app can use it. */
export function traceProblem(trace: unknown): string | null {
  const limit = dataLimitProblem(trace, TRACE_LIMITS);
  if (limit) return limit;
  if (!shell(trace)) return describe(shell.errors?.[0] ?? { instancePath: "", keyword: "", params: {} });
  // Each heap object once, wherever it's shared.
  const checked = new Set<unknown>();
  const steps = (trace as Trace).steps;
  for (let i = 0; i < steps.length; i++) {
    const heap = steps[i].heap;
    for (const id of Object.keys(heap)) {
      const object = heap[id];
      if (checked.has(object)) continue;
      checked.add(object);
      if (!heapObject(object)) {
        const error = heapObject.errors?.[0] ?? { instancePath: "", keyword: "", params: {} };
        const at = `/steps/${i}/heap/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        return describe({ ...error, instancePath: at + error.instancePath });
      }
    }
  }
  return null;
}
