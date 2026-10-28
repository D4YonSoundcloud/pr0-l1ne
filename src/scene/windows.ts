/**
 * Sliding windows (`viz: window nums: [left, right]`): which part of a list
 * a window covers at a step. Part of the scene, like pointers.ts: what the
 * band says, not where it goes.
 */
import type { CompareHint, Value, WindowBound, WindowHint } from "../trace/types";

/** A window over a list at one step: items `start` up to (not including) `end`. */
export interface WindowSpan {
  /** How it was written: `[left, right]`. */
  label: string;
  start: number;
  /** Exclusive. Equal to `start` for an empty window. */
  end: number;
  /** One of its ends moved since the step before. */
  changed: boolean;
  /** A labeled region (`viz: region`): its label and which of the list's regions it is, for its color. */
  region?: { label: string | null; index: number };
}

/** A whole number from a variable, or null. */
function wholeNumber(value: Value | undefined): number | null {
  if (value?.kind !== "prim" || (value.type !== "int" && value.type !== "number")) return null;
  const n = Number(value.repr);
  return Number.isInteger(n) ? n : null;
}

/** What an end comes to with these variables, or null if any of them isn't a whole number here. */
export function evaluateBound(bound: WindowBound, locals: Map<string, Value>): number | null {
  let total = 0;
  for (const term of bound.terms) {
    const n = term.name !== undefined ? wholeNumber(locals.get(term.name)) : (term.value ?? null);
    if (n === null) return null;
    total += term.sign * n;
  }
  return total;
}

const namesIn = (bound: WindowBound) => bound.terms.flatMap((t) => (t.name ? [t.name] : []));

/** The windows over a container (by its variable's name) at a step. */
export function windowsFor(
  containerName: string,
  hints: readonly WindowHint[] | undefined,
  locals: Map<string, Value>,
  changedNames: Set<string> = new Set(),
): WindowSpan[] {
  const out: WindowSpan[] = [];
  for (const hint of hints ?? []) {
    if (hint.container !== containerName) continue;
    const a = evaluateBound(hint.start, locals);
    const b = evaluateBound(hint.end, locals);
    if (a === null || b === null) continue;
    const start = hint.startOpen ? a + 1 : a;
    const end = hint.endOpen ? b : b + 1;
    out.push({
      label: hint.text,
      start,
      end: Math.max(start, end),
      changed: [...namesIn(hint.start), ...namesIn(hint.end)].some((n) => changedNames.has(n)),
      ...(hint.region ? { region: hint.region } : {}),
    });
  }
  return out;
}

/** Does a container have labeled regions (so its drawing needs a row for their labels)? */
export const hasRegionLabels = (containerName: string, hints: readonly WindowHint[] | undefined): boolean =>
  !!hints?.some((h) => h.container === containerName && h.region?.label);

/** The two cells a `viz: compare` hint marks in a list at a step. */
export interface CompareSpan {
  label: string;
  indexes: [number, number];
  changed: boolean;
}

export function comparesFor(
  containerName: string,
  hints: readonly CompareHint[] | undefined,
  locals: Map<string, Value>,
  changedNames: Set<string> = new Set(),
): CompareSpan[] {
  const out: CompareSpan[] = [];
  for (const hint of hints ?? []) {
    if (hint.container !== containerName) continue;
    const a = evaluateBound(hint.a, locals);
    const b = evaluateBound(hint.b, locals);
    if (a === null || b === null) continue;
    out.push({
      label: hint.text,
      indexes: [a, b],
      changed: [...namesIn(hint.a), ...namesIn(hint.b)].some((n) => changedNames.has(n)),
    });
  }
  return out;
}
