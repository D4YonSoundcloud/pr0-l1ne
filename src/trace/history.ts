/**
 * A value over the whole run, and finding a step by what's true at it.
 *
 * A value is a variable of one call (a frame, by its id: a recursive
 * function's `n` in this call, not another), or a slot of an object (a
 * list's index, a dict's key, an object's field; objects keep their ids
 * through a run). Its history is the steps where it changed, with what it
 * became: where it appears, every change, and where it goes. A long list
 * drawn as a window of it doesn't know the slots outside the window: those
 * steps don't count as a change.
 *
 * A condition is a hint's kind of expression (expr.ts: `best > 10`,
 * `len(stack) == 0`), worked out at each step with the running function's
 * variables, then the program's globals. A step where it can't be worked
 * out (a name that isn't set yet) doesn't count.
 */
import { objectNames, show } from "./changes";
import { slotsOf, valueKey } from "./diff";
import { compiled, evaluate, toVal, truthy } from "./expr";
import { type Frame, liveFrames, type Step, type Trace, type Value } from "./types";

/** A value to follow: a variable of a call, or an object's slot (slotsOf's key). */
export type ValueTarget = { kind: "var"; frame: string; name: string } | { kind: "slot"; object: string; slot: string };

/**
 * The value a drawing's element stands for: a cell (data-cell,
 * `${object}|${slot}`) or a frame's variable (data-var, `${frame}|${name}`).
 * Split at the first `|`: ids have none, a dict's slot key may.
 */
export function targetOf(cell: string | null | undefined, variable: string | null | undefined): ValueTarget | null {
  const split = (text: string): [string, string] | null => {
    const at = text.indexOf("|");
    return at > 0 ? [text.slice(0, at), text.slice(at + 1)] : null;
  };
  if (variable) {
    const parts = split(variable);
    return parts ? { kind: "var", frame: parts[0], name: parts[1] } : null;
  }
  if (cell) {
    const parts = split(cell);
    return parts ? { kind: "slot", object: parts[0], slot: parts[1] } : null;
  }
  return null;
}

/** The same value, as one string: to compare two, and to key what's kept about one. */
export const targetKey = (t: ValueTarget): string =>
  t.kind === "var" ? `v|${t.frame}|${t.name}` : `s|${t.object}|${t.slot}`;

/** A change in a value's history: the step, what it became ("" when it went), and as a number when it is one. */
export interface HistoryPoint {
  step: number;
  value: string;
  /** Its value as a number, for a sparkline; null when it isn't one (or it went). */
  num: number | null;
  /** It went (its call returned, its object or slot is gone). */
  gone?: boolean;
}

export interface ValueHistory {
  /** What it's called, at the step asked from: `i`, `nums[2]`, `n in fact()`. */
  name: string;
  points: HistoryPoint[];
  /** More changes than are listed (past MAX_POINTS). */
  truncated: boolean;
}

/** A history lists at most this many changes. */
export const MAX_POINTS = 5000;

const NUMBER_TYPES = new Set(["int", "float", "number", "bigint"]);

/** A target's value at a step: the value, null when it's not there, or undefined when it can't be told (outside a window). */
export function valueAt(step: Step, target: ValueTarget): Value | null | undefined {
  if (target.kind === "var") {
    const frame = liveFrames(step).find((f) => f.id === target.frame);
    const local = frame?.locals.find(([name]) => name === target.name);
    return local ? local[1] : null;
  }
  const obj = step.heap[target.object];
  if (!obj) return null;
  if (obj.kind === "list" || obj.kind === "tuple") {
    const index = Number(target.slot);
    const at = index - (obj.offset ?? 0);
    if (at >= 0 && at < obj.items.length) return obj.items[at];
    // Outside the window drawn: it's there (within its length), but not known here.
    return index < obj.length ? undefined : null;
  }
  return slotsOf(obj).get(target.slot) ?? null;
}

/** What a target's called at a step: as the Changes list names it. */
export function targetName(step: Step, target: ValueTarget): string {
  if (target.kind === "var") {
    const running = step.stack.at(-1);
    const frame = liveFrames(step).find((f) => f.id === target.frame);
    return frame && frame !== running ? `${target.name} in ${frame.func}()` : target.name;
  }
  const frames = [...liveFrames(step)].reverse();
  const owner = objectNames(step, frames).get(target.object) ?? step.heap[target.object]?.typeName ?? "?";
  const obj = step.heap[target.object];
  if (obj?.kind === "dict") {
    const key = obj.entries.find(([k]) => valueKey(k) === target.slot)?.[0];
    if (key?.kind === "prim") return key.type === "key" ? `${owner}.${key.repr}` : `${owner}[${key.repr}]`;
    return `${owner}[…]`;
  }
  if (obj?.kind === "object" || obj?.kind === "function") return `${owner}.${target.slot}`;
  if (obj?.kind === "opaque") return owner;
  return `${owner}[${target.slot}]`;
}

/** A target's history over the run: each step where it changed, appeared or went. Named at step `at`. */
export function valueHistory(trace: Trace, target: ValueTarget, at: number): ValueHistory {
  const points: HistoryPoint[] = [];
  let truncated = false;
  let was: string | null = null; // valueKey, or null when it isn't there
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    const value = valueAt(step, target);
    if (value === undefined) continue; // not known here: as it was
    const key = value === null ? null : valueKey(value);
    if (key === was) continue;
    was = key;
    if (points.length >= MAX_POINTS) {
      truncated = true;
      break;
    }
    if (value === null) {
      // Gone: only once it had been there.
      if (points.length) points.push({ step: i, value: "", num: null, gone: true });
      continue;
    }
    points.push({
      step: i,
      value: show(value, step),
      num: value.kind === "prim" && NUMBER_TYPES.has(value.type) ? Number.parseFloat(value.repr) : null,
    });
  }
  const named = trace.steps[Math.min(Math.max(0, at), trace.steps.length - 1)];
  return { name: named ? targetName(named, target) : "", points, truncated };
}

/** The variables a condition reads at a step: the running function's, then the program's globals. */
function variablesAt(step: Step): Map<string, Value> {
  const vars = new Map<string, Value>();
  const running: Frame | undefined = step.stack.at(-1);
  const global = step.stack[0];
  for (const frame of [running, global])
    if (frame) for (const [name, value] of frame.locals) if (!vars.has(name)) vars.set(name, value);
  return vars;
}

/** Where a condition is true: the next step after `from` (`back`: the one before it), no earlier than `first`. */
export interface Found {
  step: number | null;
  /** Why the condition can't be worked out at all (it doesn't read). */
  error?: string;
}

export function findWhere(trace: Trace, text: string, from: number, back: boolean, first = 0): Found {
  let expr: ReturnType<typeof compiled>;
  try {
    expr = compiled(text.trim());
  } catch (error) {
    return { step: null, error: error instanceof Error ? error.message : String(error) };
  }
  const language =
    trace.language === "python" ? "python" : trace.language === "typescript" ? "typescript" : "javascript";
  const holds = (i: number): boolean => {
    const step = trace.steps[i];
    const vars = variablesAt(step);
    try {
      return truthy(
        evaluate(
          expr,
          (name) => {
            const value = vars.get(name);
            if (!value) throw new Error(`${name} isn't set`);
            return toVal(value, step.heap);
          },
          language,
        ),
      );
    } catch {
      return false;
    }
  };
  if (back) {
    for (let i = Math.min(from - 1, trace.steps.length - 1); i >= first; i--) if (holds(i)) return { step: i };
  } else {
    for (let i = Math.max(from + 1, first); i < trace.steps.length; i++) if (holds(i)) return { step: i };
  }
  return { step: null };
}
