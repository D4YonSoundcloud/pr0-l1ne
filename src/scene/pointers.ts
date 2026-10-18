/**
 * Index pointers: which variables point into a list (i, j, lo, hi...), and
 * where. Part of the scene: what a list's markers say, not where they go.
 */
import type { Value } from "../trace/types";

/** An index variable pointing into a list: `i` at 3. */
export interface Pointer {
  name: string;
  index: number;
  changed: boolean;
}

/**
 * Names that conventionally hold an index. They're drawn as pointers on any
 * container the code indexes, even when they aren't used as a subscript
 * themselves (binary search uses lo and hi, but only indexes nums[mid]).
 */
export const CONVENTIONAL_POINTERS = [
  "lo",
  "hi",
  "low",
  "high",
  "left",
  "right",
  "l",
  "r",
  "start",
  "end",
  "mid",
  "slow",
  "fast",
];

/** Resolve index variables for a container: names that hold an int. */
export function pointersFor(
  containerName: string,
  indexNames: Record<string, string[]>,
  locals: Map<string, Value>,
  changedNames: Set<string> = new Set(),
): Pointer[] {
  const out: Pointer[] = [];
  const subscripts = indexNames[containerName];
  if (!subscripts) return out;
  // In a grid, a conventional name the code only uses for the other
  // dimension (matrix[row][left]: left picks a column) isn't this one's.
  const otherKey = containerName.endsWith("[]") ? containerName.slice(0, -2) : `${containerName}[]`;
  const other = indexNames[otherKey] ?? [];
  const conventional = CONVENTIONAL_POINTERS.filter(
    (n) => locals.has(n) && !(other.includes(n) && !subscripts.includes(n)),
  );
  const names = new Set([...subscripts, ...conventional]);
  for (const name of names) {
    const value = locals.get(name);
    // Python reports "int"; JavaScript reports "number", which may not be whole.
    const isIndex =
      value?.kind === "prim" &&
      (value.type === "int" || (value.type === "number" && Number.isInteger(Number(value.repr))));
    if (isIndex) out.push({ name, index: Number(value.repr), changed: changedNames.has(name) });
  }
  return out;
}
