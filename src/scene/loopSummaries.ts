/**
 * Summaries in the loop history: rows far from the one running, folded.
 *
 * Stacked, a loop's history is a row per pass, every row drawn when the
 * whole history is in view (Auto-fit). A history of 120 passes over a
 * 60 × 60 grid is 430,000 cells, too many to read and slow to draw, though
 * what's being looked at is the last few passes. So past a budget of cells
 * the history keeps its first row (where it started) and its latest rows,
 * and the passes between become one band:
 *
 *   #1    [5][2][4][1]
 *   ┄┄ #2 to #97: 96 passes folded · click to show ┄┄
 *   #98   [1][2][4][5]
 *   ...
 *   #120  [1][2][4][5]     (running)
 *
 * The budget comes from the zoom, as memory's does (scene/summaries.ts):
 * zoomed out, less is drawn. With Auto-fit on the zoom follows the
 * drawing's size, so the budget is full detail's. Clicking the band opens
 * it: its key (the first pass it folds) is kept across steps by the loop
 * window's controller, until the person folds it again.
 *
 * The rows after the band stay where they are from step to step: the band
 * grows by a chunk of rows at a time (half the rows kept), not one row a
 * step, so rows kept between steps (render/loopView/rowCache.ts) stay at
 * their place and aren't drawn again.
 */
import type { LoopRow } from "../trace/loopHistory";

/** Cells drawn in the loop history at each level of detail (render/lod.ts), full to overview. */
const CELL_BUDGETS = [40_000, 30_000, 20_000, 10_000, 5_000];

/** The loop history's cell budget at a zoom's level of detail; with Auto-fit on, full detail's. */
export function loopDetailBudget(lod: number, autoFit: boolean): number {
  return autoFit ? CELL_BUDGETS[0] : CELL_BUDGETS[Math.max(0, Math.min(CELL_BUDGETS.length - 1, lod))];
}

/** What to fold, and what not to. */
export interface LoopDetail {
  /** Cells to draw at most (loopDetailBudget). */
  cells: number;
  /** Folds the person opened, by key: drawn in full. */
  expanded: ReadonlySet<string>;
}

/** A fold's key starts with this. */
export const FOLD_PREFIX = "fold:";

/** The latest rows kept below a fold, at least. */
const MIN_TAIL = 2;

/** Rows folded: the first and last of them, how many, and its key. */
export interface Fold {
  kind: "fold";
  first: LoopRow;
  last: LoopRow;
  count: number;
  key: string;
}

/**
 * Fold the rows of a history's items past a budget. `cost(index)`: the
 * cells a row (by its index in the history) draws. Items that aren't rows
 * (headers, quiet bands, gaps) between folded rows fold with them; a
 * header just before the first row kept below the fold stays, as it starts
 * that row's run.
 */
export function foldRows<T extends { kind: string }>(
  items: (T | Fold)[],
  rowOf: (item: T | Fold) => { row: LoopRow; index: number } | null,
  cost: (index: number) => number,
  detail: LoopDetail,
): (T | Fold)[] {
  const at: number[] = [];
  items.forEach((item, i) => {
    if (rowOf(item)) at.push(i);
  });
  const m = at.length;
  if (m < MIN_TAIL + 3) return items;
  const costOf = (p: number) => cost(rowOf(items[at[p]])!.index);
  // The latest rows that fit the budget, with the first row's cost spent first.
  let spent = costOf(0);
  let tail = 0;
  while (tail < m - 1 && spent + costOf(m - 1 - tail) <= detail.cells) spent += costOf(m - 1 - tail++);
  tail = Math.max(MIN_TAIL, tail);
  if (tail > m - 3) return items;
  // Where the tail starts, moved a chunk of rows at a time.
  const chunk = Math.max(1, Math.ceil(tail / 2));
  const tailStart = 1 + Math.floor((m - tail - 1) / chunk) * chunk;
  const count = tailStart - 1;
  if (count < 2) return items;
  const first = rowOf(items[at[1]])!.row;
  const key = `${FOLD_PREFIX}${first.loop ?? ""}:${first.stepIndex}`;
  if (detail.expanded.has(key)) return items;
  // The items folded: after the first row, up to the first row kept (less a header starting its run).
  const from = at[0] + 1;
  let to = at[tailStart];
  while (to > from && items[to - 1].kind === "header") to--;
  const fold: Fold = { kind: "fold", first, last: rowOf(items[at[tailStart - 1]])!.row, count, key };
  return [...items.slice(0, from), fold, ...items.slice(to)];
}
