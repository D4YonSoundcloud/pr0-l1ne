/**
 * The shape of a trace, without the details that differ between languages,
 * for checking that two tracers agree (src/trace/conformance.test.ts).
 *
 * Kept: what the program printed, how it ended, its loops (how many times
 * each ran and which passes were recorded), and the global variables at the
 * end with everything they point to, as nested data with shared and cyclic
 * references marked.
 *
 * Dropped: step counts and step lines (Python and JavaScript don't stop on
 * the same things), type names (int vs number, list vs Array), sizes, ids,
 * and functions and classes.
 */
import { expandHeaps } from "./delta";
import type { HeapObject, Trace, Value } from "./types";

export type Shaped =
  | string
  | { list: Shaped[] }
  | { set: Shaped[] }
  | { dict: [Shaped, Shaped][] }
  | { object: string; fields: [string, Shaped][] }
  | { function: true }
  | { opaque: string }
  | { same: number }; // the nth object already seen (a shared or cyclic reference)

export interface LoopShape {
  kind: "for" | "while";
  /** How many times the loop started. */
  runs: number;
  /** Each run's highest pass. */
  passes: number[];
  /** Passes recorded, when a run was sampled (some passes not recorded). */
  recorded?: number[][];
}

export interface TraceShape {
  output: string;
  error: string | null;
  truncated: boolean;
  stoppedBy?: "steps" | "time";
  sampled: boolean;
  loops: LoopShape[];
  globals: Record<string, Shaped>;
}

export function shapeOf(trace: Trace, options: { ignore?: string[] } = {}): TraceShape {
  const full = expandHeaps(structuredClone(trace));
  const ignore = new Set(options.ignore ?? []);
  const last = full.steps[full.steps.length - 1];

  const globals: Record<string, Shaped> = {};
  // One walk over all the globals, so a second name for an object already
  // seen shows as { same: n }: two names for one list aren't two lists.
  const walked = new Map<string, number>();
  for (const [name, value] of last?.stack[0]?.locals ?? []) {
    if (ignore.has(name)) continue;
    const obj = value.kind === "ref" ? last.heap[value.id] : undefined;
    if (obj && (obj.kind === "function" || obj.kind === "class")) continue;
    globals[name] = shapeValue(value, last.heap, walked);
  }

  return {
    output: full.stdout,
    error: full.error ? full.error.message : null,
    truncated: full.truncated,
    ...(full.stoppedBy ? { stoppedBy: full.stoppedBy } : {}),
    sampled: !!full.sampled,
    loops: loopShapes(full),
    globals,
  };
}

function loopShapes(trace: Trace): LoopShape[] {
  // loop id -> run (instance) -> passes seen
  const seen = new Map<string, Map<string, Set<number>>>();
  for (const step of trace.steps) {
    for (const ctx of step.loops ?? []) {
      const runs = seen.get(ctx.loop) ?? new Map<string, Set<number>>();
      seen.set(ctx.loop, runs);
      const run = `${ctx.frame}#${ctx.instance}`;
      const passes = runs.get(run) ?? new Set<number>();
      runs.set(run, passes);
      passes.add(ctx.iteration);
    }
  }
  return [...trace.loops]
    .sort((a, b) => a.line - b.line)
    .map((info) => {
      const runs = [...(seen.get(info.id)?.values() ?? [])];
      const passes = runs.map((set) => Math.max(...set));
      const gaps = runs.some((set) => set.size < Math.max(...set) + 1);
      return {
        kind: info.kind,
        runs: runs.length,
        passes,
        ...(gaps ? { recorded: runs.map((set) => [...set].sort((a, b) => a - b)) } : {}),
      };
    });
}

function shapeValue(value: Value, heap: Record<string, HeapObject>, walked: Map<string, number>): Shaped {
  if (value.kind === "prim") return shapePrim(value.type, value.repr);
  const known = walked.get(value.id);
  if (known !== undefined) return { same: known };
  const obj = heap[value.id];
  if (!obj) return { opaque: "missing" };
  walked.set(value.id, walked.size);
  const inner = (v: Value) => shapeValue(v, heap, walked);
  switch (obj.kind) {
    case "list":
    case "tuple":
      return { list: obj.items.map(inner) };
    case "set":
      return { set: obj.items.map(inner).sort(byText) };
    case "dict":
      return { dict: obj.entries.map(([k, v]) => [inner(k), inner(v)] as [Shaped, Shaped]) };
    case "object":
      return { object: obj.typeName, fields: obj.fields.map(([name, v]) => [name, inner(v)] as [string, Shaped]) };
    case "function":
    case "class":
      return { function: true };
    default:
      return { opaque: obj.typeName };
  }
}

/** A primitive as one spelling for both languages: 3, 1.5, true, null, "text". */
export function shapePrim(type: string, repr: string): string {
  switch (type) {
    case "int":
    case "float":
    case "number":
      return String(Number(repr));
    case "bool":
    case "boolean":
      return repr.toLowerCase();
    case "none":
    case "null":
    case "undefined":
      return "null";
    case "str":
    case "string":
      return JSON.stringify(unquote(repr));
    case "key": // an unquoted object key (JavaScript)
      return JSON.stringify(repr);
    default:
      return `${type}:${repr}`;
  }
}

function unquote(repr: string): string {
  const q = repr[0];
  if ((q === "'" || q === '"') && repr.endsWith(q) && repr.length >= 2) {
    return repr.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  }
  return repr;
}

const byText = (a: Shaped, b: Shaped) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
