/**
 * What every part of the memory view is made of: a Shape (a box that knows
 * its size before it's drawn), the View in a value slot, the arrows a shape
 * starts (OutRef), and the context shared while drawing one step (Ctx).
 * Shapes measure with arithmetic (see draw.ts), so the layout can place
 * everything before anything is drawn.
 */
import type { Pointer } from "../../scene/pointers";
import type { CompareSpan, WindowSpan } from "../../scene/windows";
import { type StepDiff, valueKey } from "../../trace/diff";
import type { GridFocus } from "../../trace/gridFocus";
import { formatBytes, type StepSizes } from "../../trace/memory";
import type { HeapObject, Step, Value } from "../../trace/types";
import { s, uiTextWidth } from "../draw";
import type { Mark } from "../drawing";

export interface OutRef {
  from: Point;
  target: string;
  changed: boolean;
  /** From the printed-output node to an object it printed. */
  printed?: boolean;
  /** The object whose cell the arrow starts in (none: a variable in a frame). */
  owner?: string;
  /** Key of the top-level box the arrow starts in (set by drawNode). */
  source?: string;
  /** From a list cell: leave downward, then turn at exitDownY (set by drawNode). */
  down?: boolean;
  exitDownY?: number;
}
export type Pointers = Pointer[];

export interface Shape {
  w: number;
  h: number;
  /** Where incoming arrows land, relative to the top of the shape. */
  inY: number;
  draw(x: number, y: number, layer: Mark, refs: OutRef[]): void;
}

export interface Point {
  x: number;
  y: number;
}

/** Where the person has dragged boxes, by node key, in diagram units. */
export interface MemoryLayout {
  positions: ReadonlyMap<string, Point>;
  /** The node being dragged right now, drawn on top of the others. */
  raise?: string | null;
}

/** Room around a box nested in a cell or row. */
export const NEST_PAD = 4;

/** Shared state for drawing one snapshot. */
export interface Ctx {
  step: Step;
  diff: StepDiff;
  nested: ReadonlySet<string>;
  functionKeyword: string;
  /** Index pointers for a list: level 0 is arr[i]; level 1 is grid[i][j]'s j. */
  pointersFor(id: string, level?: 0 | 1): Pointers;
  /** Sliding windows over a list (`viz: window`). */
  windowsFor(id: string): WindowSpan[];
  /** The two cells of a list being compared (`viz: compare`). */
  comparesFor(id: string): CompareSpan[];
  /** Does a list have labeled regions (room for their labels above it)? */
  regionLabelsFor(id: string): boolean;
  /** A box's title: its type, or with `viz: label`, its type and a field's value. */
  titleOf(obj: HeapObject): string;
  /** The grid cell this step reads or writes (trace/gridFocus.ts); null if the code never indexes it by name. */
  gridFocus(id: string, size: { rows: number; cols: (row: number) => number }): GridFocus | null;
  /** Memory sizes, when they're shown. */
  sizes: StepSizes | null;
  /** What goes in a value slot: a cell, or in nested mode the object's whole shape (objects.ts). */
  view(value: Value, cellH: number): View;
}

/** Height of the row of sizes above a list's cells (when sizes are shown). */
export const SIZE_H = 12;

/**
 * An object's size for its label: "184 B (room for 16) · total 436 B".
 * Null when sizes are off or the model has no answer for this object.
 */
export function sizeLabel(ctx: Ctx, id: string): string | null {
  const sizes = ctx.sizes;
  if (!sizes) return null;
  const own = sizes.own(id);
  if (own === null) return null;
  const obj = ctx.step.heap[id];
  const capacity = sizes.capacity(id);
  const room = capacity !== null && obj?.kind === "list" && capacity > obj.length ? ` (room for ${capacity})` : "";
  const total = sizes.total(id);
  const more = total !== null && total > own ? ` · total ${formatBytes(total, sizes.approximate)}` : "";
  return `${formatBytes(own, sizes.approximate)}${room}${more}`;
}

/** A label line with a size after it, the size in its own color. */
export function labelWithSize(x: number, y: number, label: string, size: string | null): Mark {
  return s(
    "text",
    { class: "seq-label", x, y },
    label,
    size && s("tspan", { class: "mem-size" }, `${label ? " · " : ""}${size}`),
  );
}

export const sizedLabelWidth = (label: string, size: string | null) =>
  uiTextWidth(label) + (size ? uiTextWidth(` · ${size}`) * 1.08 : 0);

/**
 * What goes in a value slot: a primitive or a reference dot ("cell"), or in
 * nested mode a whole child shape. Rows and list cells size to their views.
 */
export interface View {
  w: number;
  h: number;
  nested: boolean;
  /** Returns the cell element, for plain values (used for animation). */
  draw(
    x: number,
    y: number,
    w: number,
    h: number,
    layer: Mark,
    refs: OutRef[],
    changed: boolean,
    // biome-ignore lint/suspicious/noConfusingVoidType: some draw()s return nothing, others the group they drew
  ): Mark | void;
}

/** Mark a list or grid cell, so a value moving between slots can slide (animate.ts). */
// biome-ignore lint/suspicious/noConfusingVoidType: some draw()s return nothing, others the group they drew
export function markCell(el: Mark | void, container: string, slot: string, value: Value, cx: number, cy: number): void {
  if (!el) return;
  el.setAttribute("data-cell", `${container}|${slot}`);
  el.setAttribute("data-value", valueKey(value));
  el.setAttribute("data-cx", String(Math.round(cx)));
  el.setAttribute("data-cy", String(Math.round(cy)));
}
