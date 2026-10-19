/**
 * What the loop view's parts share: spacing, the column and track layouts
 * every row is drawn in, and small pieces every lane uses.
 */
import { scalarIn } from "../../scene/loopScene";
import { valueKey } from "../../trace/diff";
import type { LinkedTrack } from "../../trace/linked";
import type { LoopRow } from "../../trace/loopHistory";
import type { Value } from "../../trace/types";
import { CELL_H, s } from "../draw";
import type { Mark } from "../drawing";

export const MARGIN = 20;
export const GUTTER_W = 64;
export const SCALARS_GAP = 28; // space between the last container and "i = 2  j = 0"
export const ROW_GAP = 34;
export const BAND_H = 30;
export const CONTAINER_GAP = 44;
// Linked track (see trace/linked.ts)
export const SLOT_W = 18; // a node's link slot
export const NODE_GAP = 30; // room between nodes for a straight arrow
export const ARC_TOP = 30; // room above the cells for links that arc over
export const ARC_BOTTOM = 26; // ...and below, for a second link field
export const LEVEL_H = CELL_H + 34; // one level of a tree drawn top-down
/** Indent per level of nesting, in the row labels' gutter. */
export const INDENT = 16;
/** Between lanes stacked one above another. */
export const LANE_GAP = 16;

export const EMPTY: Value = { kind: "prim", type: "none", repr: "" };

export interface LoopViewOptions {
  /**
   * Each container (and the graph, and the linked list) on its own line,
   * one above another, instead of side by side; the row's label and its
   * variables sit at the middle of the stack.
   */
  vertical?: boolean;
}

export interface ContainerColumn {
  name: string;
  x: number; // where cells start
  cellW: number;
  hasPointers: boolean;
  /** Set when this is a list of lists, drawn as a grid. */
  grid?: { rows: number; cols: number; rowIndexW: number; hasColumnPointers: boolean };
  /** Height of the content under the top line of cells. */
  bodyH: number;
  /** Width of the widest row of cells. */
  cellsW?: number;
  /** Some row is a long list of numbers: a color strip of all of it goes above the cells. */
  strip?: boolean;
  /** Stacked vertically (LoopViewOptions.vertical): its top within the row. */
  dy?: number;
}

export interface TrackLayout {
  track: LinkedTrack;
  x: number; // where the first node starts
  valueW: number; // width of a node's value cell
  nodeW: number; // value cell plus link slots
  /**
   * One above another: separate lists (chains of linked nodes) each on its
   * own line. Each node's line and column; without it, one line in
   * `track.order`'s columns.
   */
  places?: Map<string, { line: number; column: number }>;
  lines?: number;
  /** From one line's cells to the next's. */
  lineStep?: number;
}

/**
 * A name to the left of a row's content, with its size under it when sizes
 * are shown (in their own color), so storage growth reads down the rows.
 */
export function nameLabel(g: Mark, x: number, midY: number, name: string, size: string | null): void {
  g.append(
    s(
      "text",
      { class: "container-name", x, y: size ? midY - 7 : midY, "text-anchor": "end", "dominant-baseline": "central" },
      name,
    ),
  );
  if (size)
    g.append(
      s("text", { class: "loop-size", x, y: midY + 8, "text-anchor": "end", "dominant-baseline": "central" }, size),
    );
}

/** Mark a cell so a value moving between slots can slide (render/animate.ts). */
export function markCell(el: Mark, container: string, slot: string, value: Value, cx: number): void {
  el.setAttribute("data-cell", `${container}|${slot}`);
  el.setAttribute("data-value", valueKey(value));
  el.setAttribute("data-cx", String(Math.round(cx)));
  el.setAttribute("data-cy", "0");
}

export function scalarText(row: LoopRow, names: string[]): string {
  return names
    .map((name) => {
      const value = scalarIn(row, name);
      return value?.kind === "prim" ? `${name} = ${value.repr}` : "";
    })
    .filter(Boolean)
    .join("   ");
}
