/**
 * The memory view: one snapshot of the program.
 *
 *   frames (scopes)      heap, column 0        column 1 ...
 *   ┌ Global ───────┐    list  ┌──┬──┬──┐
 *   │ arr       ● ──┼──▶       │ 5│ 2│ 4│
 *   │ n         4   │          └──┴──┴──┘
 *   └───────────────┘    Node ┌────────┐     Node ┌────────┐
 *   ┌ fact ─────────┐         │ next ●─┼──▶       │ next   │
 *
 * Heap objects are placed in columns by distance from the stack, so a
 * linked list or tree reads left to right. Within a column, each object
 * lines up with the arrow pointing at it when there is room.
 *
 * Every frame and object is drawn in its own <g class="node"> with a stable
 * key (see nodeKey). A box the person has dragged is drawn at its saved
 * position instead of in its column, and arrows connect to wherever boxes
 * ended up.
 *
 * There are two ways to show a reference (MemoryMode):
 *   "arrows"  every object is its own box, and references are arrows.
 *   "nested"  an object that only one thing refers to is drawn inside that
 *             thing ("container in container"). Shared objects and cycles
 *             still need arrows, so they stay separate. See chooseNested.
 */
import { localKey, slotsOf, valueKey, type StepDiff } from "../trace/diff";
import { liveFrames, type Frame, type HeapObject, type SequenceObject, type Step, type Trace, type Value } from "../trace/types";
import {
  CELL_H, CELL_MIN_W, FONT, HEADER_H, INDEX_H, LABEL_H, POINTER_H, ROW_H, SMALL,
  arrowMarkers, cellWidth, pointerMarkers, pointersFor, rowPointerMarkers, rowPointersWidth, s, textWidth,
  uiTextWidth, valueCell,
} from "./draw";
import { findLinkedTrack, linkedRow, treeDepths } from "../trace/linked";
import { findFreeY, roundedPath, routeEdges, type Rect } from "./route";
import { graphOverlay, graphsAt, layoutFor, legendOverlaysFor, stepScopes, type GraphData, type GraphOverlay } from "../trace/graph";
import { graphPicture, type GraphPicture } from "./graphView";
import { formatBytes, stepSizes, type SizeModel, type StepSizes } from "../trace/memory";

interface OutRef {
  from: Point;
  target: string;
  changed: boolean;
  /** Key of the top-level box the arrow starts in (set by drawNode). */
  source?: string;
  /** From a list cell: leave downward, then turn at exitDownY (set by drawNode). */
  down?: boolean;
  exitDownY?: number;
}
type Pointers = { name: string; index: number; changed: boolean }[];

interface Shape {
  w: number;
  h: number;
  /** Where incoming arrows land, relative to the top of the shape. */
  inY: number;
  draw(x: number, y: number, layer: SVGGElement, refs: OutRef[]): void;
}

export interface Point { x: number; y: number }

export type MemoryMode = "arrows" | "nested";

/** Where the person has dragged boxes, by node key, in diagram units. */
export interface MemoryLayout {
  positions: ReadonlyMap<string, Point>;
  /** The node being dragged right now, drawn on top of the others. */
  raise?: string | null;
  mode?: MemoryMode;
  /** Show memory sizes under this model (see trace/memory.ts). */
  sizes?: SizeModel | null;
}

/**
 * Stable keys for draggable boxes. Frames are keyed by their position on the
 * stack and function name, so "the second factorial() call" keeps its place
 * across steps and re-runs. Objects are keyed by id, which both tracers keep
 * stable for the whole run and assign in the same order on every run.
 */
export const nodeKey = {
  frame: (index: number, func: string) => `frame:${index}:${func}`,
  /** A paused frame keeps its identity (its id) wherever it resumes. */
  paused: (id: string) => `paused:${id}`,
  object: (id: string) => `obj:${id}`,
};

const COLUMN_GAP = 90;
const STACK_GAP = 22;
const MARGIN = 24;
/** Room above the boxes for arrows that route over the top (see route.ts). */
const TOP = 40;
/** Arrows leaving a list downward turn this far below it, then a lane apart. */
const EXIT_DROP = 9;
const EXIT_LANE = 7;
/** Binary trees in the memory view: gap between in-order slots, and levels. */
const TREE_GAP = 34;
const LEVEL_GAP = 44;

/** Nesting deeper than this switches back to arrows, so boxes stay readable. */
export const MAX_NEST_DEPTH = 6;
const NEST_PAD = 4;

// ---------------------------------------------------------------------------
// Choosing what to nest
// ---------------------------------------------------------------------------

/** Every value an object holds, including dict keys. */
function valuesOf(obj: HeapObject): Value[] {
  const values: Value[] = [];
  if (obj.kind === "dict") for (const [key] of obj.entries) values.push(key);
  values.push(...slotsOf(obj).values());
  return values;
}

/** References an object holds that could be drawn inside it (not dict keys). */
function nestableChildren(obj: HeapObject): string[] {
  const ids: string[] = [];
  for (const value of slotsOf(obj).values()) if (value.kind === "ref") ids.push(value.id);
  return ids;
}

/**
 * Which objects to draw inside the thing that refers to them. An object is
 * nested when exactly one reference to it exists in this snapshot (from a
 * variable, a field, an item or the return value). Anything referenced twice
 * (aliasing), part of a cycle, or nested deeper than MAX_NEST_DEPTH stays a
 * separate box, because only an arrow can show "these point at the same
 * object".
 */
export function chooseNested(step: Step): Set<string> {
  const incoming = new Map<string, number>();
  const count = (value: Value | undefined) => {
    if (value?.kind === "ref") incoming.set(value.id, (incoming.get(value.id) ?? 0) + 1);
  };
  for (const frame of liveFrames(step)) for (const [, value] of frame.locals) count(value);
  count(step.returnValue);
  for (const obj of Object.values(step.heap)) for (const value of valuesOf(obj)) count(value);

  const nested = new Set<string>();
  const visited = new Set<string>();
  const tryNest = (id: string, depth: number) => {
    const obj = step.heap[id];
    if (!obj || visited.has(id) || incoming.get(id) !== 1 || depth > MAX_NEST_DEPTH) return;
    visited.add(id);
    nested.add(id);
    for (const child of nestableChildren(obj)) tryNest(child, depth + 1);
  };
  // Start from the variables, then from every object that stayed separate,
  // so things inside a shared object can still nest inside it.
  for (const frame of liveFrames(step)) for (const [, value] of frame.locals) if (value.kind === "ref") tryNest(value.id, 1);
  if (step.returnValue?.kind === "ref") tryNest(step.returnValue.id, 1);
  for (const [id, obj] of Object.entries(step.heap)) {
    if (nested.has(id)) continue;
    visited.add(id);
    for (const child of nestableChildren(obj)) tryNest(child, 1);
  }
  return nested;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Shared state for drawing one snapshot. */
interface Ctx {
  step: Step;
  diff: StepDiff;
  nested: ReadonlySet<string>;
  functionKeyword: string;
  /** Index pointers for a list: level 0 is arr[i]; level 1 is grid[i][j]'s j. */
  pointersFor(id: string, level?: 0 | 1): Pointers;
  /** Memory sizes, when they're shown. */
  sizes: StepSizes | null;
}

/** Height of the row of sizes above a list's cells (when sizes are shown). */
const SIZE_H = 12;

/**
 * An object's size for its label: "184 B (room for 16) · total 436 B".
 * Null when sizes are off or the model has no answer for this object.
 */
function sizeLabel(ctx: Ctx, id: string): string | null {
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
function labelWithSize(x: number, y: number, label: string, size: string | null): SVGTextElement {
  return s("text", { class: "seq-label", x, y }, label, size && s("tspan", { class: "mem-size" }, `${label ? " · " : ""}${size}`));
}

const sizedLabelWidth = (label: string, size: string | null) =>
  uiTextWidth(label) + (size ? uiTextWidth(` · ${size}`) * 1.08 : 0);

/**
 * What goes in a value slot: a primitive or a reference dot ("cell"), or in
 * nested mode a whole child shape. Rows and list cells size to their views.
 */
interface View {
  w: number;
  h: number;
  nested: boolean;
  /** Returns the cell element, for plain values (used for animation). */
  draw(x: number, y: number, w: number, h: number, layer: SVGGElement, refs: OutRef[], changed: boolean): SVGGElement | void;
}

/** Mark a list or grid cell, so a value moving between slots can slide (animate.ts). */
function markCell(el: SVGGElement | void, container: string, slot: string, value: Value, cx: number, cy: number): void {
  if (!el) return;
  el.setAttribute("data-cell", `${container}|${slot}`);
  el.setAttribute("data-value", valueKey(value));
  el.setAttribute("data-cx", String(Math.round(cx)));
  el.setAttribute("data-cy", String(Math.round(cy)));
}

function viewOf(value: Value, ctx: Ctx, cellH: number): View {
  if (value.kind === "ref" && ctx.nested.has(value.id) && ctx.step.heap[value.id]) {
    const shape = objectShape(ctx.step.heap[value.id], ctx, true);
    return {
      w: shape.w, h: shape.h, nested: true,
      draw(x, y, _w, _h, layer, refs) {
        shape.draw(x, y, layer, refs);
      },
    };
  }
  return {
    w: cellWidth(value), h: cellH, nested: false,
    draw(x, y, w, h, layer, refs, changed) {
      const { el, dot } = valueCell(value, { x, y, w, h, changed });
      layer.append(el);
      if (dot && value.kind === "ref") refs.push({ from: dot, target: value.id, changed });
      return el;
    },
  };
}

interface TableRow {
  label: string | Value;
  value: Value;
  changed: boolean;
  variant?: string;
}

function labelWidth(label: string | Value): number {
  if (typeof label === "string") return textWidth(label);
  return label.kind === "prim" ? textWidth(label.repr) : 20;
}

function tableShape(
  title: string,
  rows: TableRow[],
  ctx: Ctx,
  opts: { variant: string; isNew?: boolean; emptyText?: string; nested?: boolean; sizeText?: string | null },
): Shape {
  const views = rows.map((row) => viewOf(row.value, ctx, ROW_H - 8));
  const leftW = rows.length ? Math.max(...rows.map((r) => labelWidth(r.label))) : 0;
  const rightW = views.length ? Math.max(...views.map((v) => v.w)) : 0;
  // Plain cells keep their own width rather than stretching to match a wide
  // nested box in the same column.
  const cellsW = Math.max(0, ...views.filter((v) => !v.nested).map((v) => v.w));
  const emptyW = opts.emptyText ? uiTextWidth(opts.emptyText, 12) + 24 : 0;
  // Function and class titles are set in the code font (see styles.css).
  const codeTitle = /\b(function|class)\b/.test(opts.variant);
  const sizeW = opts.sizeText ? uiTextWidth(opts.sizeText, 11.5) * 1.08 + 14 : 0;
  const titleW = (codeTitle ? textWidth(title, 12.5) + 22 : uiTextWidth(title, 12) + 28) + sizeW;
  const w = Math.max(titleW, leftW + rightW + 34, emptyW, opts.nested ? 0 : 120);
  const rowHeights = views.map((v) => Math.max(ROW_H, v.h + 2 * NEST_PAD));
  const bodyH = rows.length ? rowHeights.reduce((a, b) => a + b, 0) + 6 : opts.emptyText ? ROW_H : 0;
  const h = HEADER_H + bodyH;

  return {
    w, h, inY: HEADER_H / 2,
    draw(x, y, layer, refs) {
      const cls = ["box", opts.variant, opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" ");
      const g = s("g", { class: cls });
      g.append(
        s("rect", { class: "box-body", x, y, width: w, height: h, rx: 5 }),
        s("path", { class: "box-header", d: `M${x},${y + HEADER_H} V${y + 5} q0,-5 5,-5 H${x + w - 5} q5,0 5,5 V${y + HEADER_H} z` }),
        s("text", { class: "box-title", x: x + 10, y: y + HEADER_H / 2, "dominant-baseline": "central" }, title),
      );
      if (opts.sizeText) {
        g.append(s("text", { class: "box-size", x: x + w - 9, y: y + HEADER_H / 2, "text-anchor": "end", "dominant-baseline": "central" }, opts.sizeText));
      }
      if (!rows.length && opts.emptyText) {
        g.append(s("text", { class: "box-empty", x: x + 10, y: y + HEADER_H + ROW_H / 2, "dominant-baseline": "central" }, opts.emptyText));
      }
      let rowY = y + HEADER_H + 3;
      rows.forEach((row, i) => {
        const rowH = rowHeights[i];
        const view = views[i];
        // Labels sit level with the first line, even beside a tall nested box.
        const labelY = view.nested ? rowY + NEST_PAD + HEADER_H / 2 : rowY + rowH / 2;
        const rowG = s("g", { class: ["row", row.variant, row.changed && "is-changed"].filter(Boolean).join(" ") });
        if (typeof row.label === "string") {
          rowG.append(s("text", { class: "row-label", x: x + 10, y: labelY, "dominant-baseline": "central" }, row.label));
        } else if (row.label.kind === "prim") {
          const { el } = valueCell(row.label, { x: x + 6, y: labelY - (ROW_H - 8) / 2, w: leftW + 8, h: ROW_H - 8, variant: "key" });
          rowG.append(el);
        } else {
          const { el, dot } = valueCell(row.label, { x: x + 6, y: labelY - (ROW_H - 8) / 2, w: 22, h: ROW_H - 8, variant: "key" });
          rowG.append(el);
          if (dot) refs.push({ from: dot, target: row.label.id, changed: false });
        }
        const cellX = x + w - 8 - rightW;
        if (view.nested) view.draw(cellX, rowY + NEST_PAD, view.w, view.h, rowG, refs, row.changed);
        else view.draw(cellX, rowY + 4, cellsW, ROW_H - 8, rowG, refs, row.changed);
        g.append(rowG);
        rowY += rowH;
      });
      layer.append(g);
    },
  };
}

const isRow = (obj: HeapObject | undefined): obj is SequenceObject =>
  obj?.kind === "list" || obj?.kind === "tuple";

/**
 * In nested mode, a list whose items are all lists nested inside it is drawn
 * as a grid: rows stacked, column numbers on top, row numbers down the side.
 */
function gridRows(obj: SequenceObject, ctx: Ctx): SequenceObject[] | null {
  if (obj.kind === "set" || !obj.items.length) return null;
  const rows: SequenceObject[] = [];
  for (const item of obj.items) {
    const row = item.kind === "ref" && ctx.nested.has(item.id) ? ctx.step.heap[item.id] : undefined;
    if (!isRow(row)) return null;
    rows.push(row);
  }
  return rows;
}

function gridShape(
  obj: SequenceObject,
  rows: SequenceObject[],
  ctx: Ctx,
  opts: { changed: Set<string>; isNew: boolean; pointers: Pointers; nested: boolean },
): Shape {
  const views = rows.map((row) => row.items.map((item) => viewOf(item, ctx, CELL_H)));
  const pad = views.flat().some((v) => v.nested) ? NEST_PAD : 0;
  const cols = Math.max(1, ...rows.map((row) => row.items.length));
  const cellW = Math.max(CELL_MIN_W, ...views.flat().map((v) => v.w + 2 * pad));
  const rowHs = views.map((row) => Math.max(CELL_H, ...row.map((v) => (v.nested ? v.h + 2 * pad : CELL_H))));
  const rowTops = rowHs.map((_, r) => rowHs.slice(0, r).reduce((a, b) => a + b, 0));
  // A grid's column markers only cover real columns: one past the end is
  // nearly always a bound like `cols`, not a position.
  const cols0 = Math.max(1, ...rows.map((row) => row.items.length));
  const columnPointers = ctx.pointersFor(obj.id, 1).filter((p) => p.index < cols0);
  const rowIndexW = textWidth(String(rows.length - 1), 10.5) + 10;
  const pointersW = rowPointersWidth(opts.pointers);
  const truncated = obj.length > obj.items.length;
  const size = sizeLabel(ctx, obj.id);
  const showLabel = !opts.nested || truncated || !!size;
  const label = `${obj.typeName}, ${obj.length} × ${cols}${truncated ? ` (first ${obj.items.length} rows)` : ""}`;
  const labelH = showLabel ? LABEL_H : 2;
  const cellsY = labelH + INDEX_H;
  const gridH = rowHs.reduce((a, b) => a + b, 0);
  const w = Math.max(rowIndexW + cols * cellW + pointersW, showLabel ? sizedLabelWidth(label, size) + 8 : 0);
  const h = cellsY + gridH + (columnPointers.length ? POINTER_H : 4);

  return {
    w, h, inY: cellsY + CELL_H / 2,
    draw(x, y, layer, refs) {
      const g = s("g", { class: ["seq", "grid", obj.kind, opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" ") });
      if (showLabel) g.append(labelWithSize(x, y + 11, label, size));
      const x0 = x + rowIndexW;
      const top = y + cellsY;
      for (let c = 0; c < cols; c++) {
        g.append(s("text", { class: "index", x: x0 + c * cellW + cellW / 2, y: y + labelH + 9, "text-anchor": "middle" }, String(c)));
      }
      rows.forEach((row, r) => {
        const ry = top + rowTops[r];
        g.append(s("text", { class: "index", x: x0 - 6, y: ry + CELL_H / 2, "text-anchor": "end", "dominant-baseline": "central" }, String(r)));
        const rowChanged = ctx.diff.changedSlots.get(row.id) ?? new Set<string>();
        const replaced = opts.changed.has(String(r));
        if (!row.items.length) {
          g.append(s("g", { class: "cell is-empty" }, s("rect", { x: x0, y: ry, width: cellW, height: CELL_H, rx: 3 })));
        }
        views[r].forEach((view, c) => {
          const cx = x0 + c * cellW;
          const changed = replaced || rowChanged.has(String(c));
          if (view.nested) {
            g.append(s("g", { class: ["cell", "is-holder", changed && "is-changed"].filter(Boolean).join(" ") },
              s("rect", { x: cx, y: ry, width: cellW, height: rowHs[r], rx: 3 })));
            view.draw(cx + pad, ry + pad, view.w, view.h, g, refs, changed);
          } else {
            markCell(view.draw(cx, ry, cellW, CELL_H, g, refs, changed), row.id, String(c), row.items[c], c * cellW, 0);
          }
        });
      });
      // grid[i][j]: i marks a row, j a column, and their cell gets an outline.
      const rowMid = (r: number) => top + rowTops[r] + CELL_H / 2;
      const flip = { key: `ptr:${obj.id}`, originX: x, originY: y };
      if (opts.pointers.length) g.append(rowPointerMarkers(opts.pointers, rowMid, x0 + cols * cellW, rows.length, flip));
      if (columnPointers.length) g.append(pointerMarkers(columnPointers, (c) => x0 + c * cellW, cellW, top + gridH, cols, flip));
      const r = opts.pointers.find((p) => p.index >= 0 && p.index < rows.length);
      const c = columnPointers.find((p) => p.index >= 0 && p.index < (rows[r?.index ?? 0]?.items.length ?? 0));
      if (r && c) {
        g.append(s("rect", { class: "grid-focus", x: x0 + c.index * cellW - 2, y: top + rowTops[r.index] - 2, width: cellW + 4, height: rowHs[r.index] + 4, rx: 4 }));
      }
      layer.append(g);
    },
  };
}

function sequenceShape(
  obj: SequenceObject,
  ctx: Ctx,
  opts: { changed: Set<string>; isNew: boolean; pointers: Pointers; nested: boolean },
): Shape {
  const rows = gridRows(obj, ctx);
  if (rows) return gridShape(obj, rows, ctx, opts);
  const hasIndices = obj.kind !== "set";
  const truncated = obj.length > obj.items.length;
  const views = obj.items.map((item) => viewOf(item, ctx, CELL_H));
  const anyNested = views.some((v) => v.nested);
  const pad = anyNested ? NEST_PAD : 0;
  // With sizes on, each cell says what its item costs, above its index.
  const cellSizes = ctx.sizes && obj.items.length
    ? obj.items.map((item) => { const n = ctx.sizes!.cell(item, obj); return n === null ? "" : formatBytes(n); })
    : null;
  const sizeH = cellSizes ? SIZE_H : 0;
  const cellW = Math.max(CELL_MIN_W, ...views.map((v) => v.w + 2 * pad), ...(cellSizes ?? []).map((t) => uiTextWidth(t, 9.5) + 8));
  const cellH = Math.max(CELL_H, ...views.map((v) => (v.nested ? v.h + 2 * pad : CELL_H)));
  const count = Math.max(obj.items.length, 1) + (truncated ? 1 : 0);
  const size = sizeLabel(ctx, obj.id);
  // Inside another box, the type label is left out to save room (unless
  // it carries a size).
  const showLabel = !opts.nested || truncated || !!size;
  const label = truncated ? `${obj.typeName}, first ${obj.items.length} of ${obj.length}` : obj.typeName;
  const labelH = showLabel ? LABEL_H : 2;
  const hasPointers = opts.pointers.length > 0;
  const w = Math.max(count * cellW, showLabel ? sizedLabelWidth(label, size) + 8 : 0);
  const cellsY = labelH + sizeH + (hasIndices ? INDEX_H : 0);
  const h = cellsY + cellH + (hasPointers ? POINTER_H : 0);

  return {
    w, h, inY: cellsY + Math.min(cellH, CELL_H) / 2,
    draw(x, y, layer, refs) {
      const g = s("g", { class: ["seq", obj.kind, opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" ") });
      if (showLabel) g.append(labelWithSize(x, y + 11, label, size));
      if (!obj.items.length) {
        g.append(s("g", { class: "cell is-empty" },
          s("rect", { x, y: y + cellsY, width: cellW, height: CELL_H, rx: 3 }),
          s("text", { class: "value v-none", x: x + cellW / 2, y: y + cellsY + CELL_H / 2, "text-anchor": "middle", "dominant-baseline": "central" }, "∅")));
      }
      obj.items.forEach((_item, i) => {
        const cx = x + i * cellW;
        const changed = opts.changed.has(String(i));
        if (cellSizes?.[i]) {
          g.append(s("text", { class: "cell-size", x: cx + cellW / 2, y: y + labelH + 9, "text-anchor": "middle" }, cellSizes[i]));
        }
        if (hasIndices) {
          g.append(s("text", { class: "index", x: cx + cellW / 2, y: y + labelH + sizeH + 9, "text-anchor": "middle" }, String(i)));
        }
        const view = views[i];
        const before = refs.length;
        if (view.nested) {
          // A cell frame with the nested object inside it.
          g.append(s("g", { class: ["cell", "is-holder", changed && "is-changed"].filter(Boolean).join(" ") },
            s("rect", { x: cx, y: y + cellsY, width: cellW, height: cellH, rx: 3 })));
          view.draw(cx + pad, y + cellsY + pad, view.w, view.h, g, refs, changed);
        } else {
          markCell(view.draw(cx, y + cellsY, cellW, cellH, g, refs, changed), obj.id, String(i), obj.items[i], cx - x, 0);
          // A list cell's arrow leaves downward, not through its neighbors.
          for (let k = before; k < refs.length; k++) refs[k].down = true;
        }
      });
      if (truncated) {
        const cx = x + obj.items.length * cellW;
        g.append(s("text", { class: "value v-none", x: cx + cellW / 2, y: y + cellsY + cellH / 2, "text-anchor": "middle", "dominant-baseline": "central" }, "…"));
      }
      if (hasPointers) {
        g.append(pointerMarkers(opts.pointers, (i) => x + i * cellW, cellW, y + cellsY + cellH, obj.items.length,
          { key: `ptr:${obj.id}`, originX: x, originY: y }));
      }
      layer.append(g);
    },
  };
}

function objectShape(obj: HeapObject, ctx: Ctx, nested = false): Shape {
  const changed = ctx.diff.changedSlots.get(obj.id) ?? new Set<string>();
  const isNew = ctx.diff.newObjects.has(obj.id);
  switch (obj.kind) {
    case "list":
    case "tuple":
    case "set":
      return sequenceShape(obj, ctx, { changed, isNew, pointers: ctx.pointersFor(obj.id), nested });
    case "dict":
      return tableShape(obj.typeName, obj.entries.map(([key, value]) => ({ label: key, value, changed: changed.has(valueKey(key)) })),
        ctx, { variant: "dict", isNew, emptyText: "empty", nested, sizeText: sizeLabel(ctx, obj.id) });
    case "object":
      return tableShape(obj.typeName, obj.fields.map(([name, value]) => ({ label: name, value, changed: changed.has(name) })),
        ctx, { variant: "instance", isNew, emptyText: "no fields", nested, sizeText: sizeLabel(ctx, obj.id) });
    case "function": {
      const title = obj.builtin ? `builtin ${obj.name}` : `${ctx.functionKeyword} ${obj.name}(${obj.params.join(", ")})`;
      return tableShape(title, obj.fields.map(([name, value]) => ({ label: name, value, changed: changed.has(name) })),
        ctx, { variant: "function", isNew, nested, sizeText: sizeLabel(ctx, obj.id) });
    }
    case "class":
      return tableShape(`class ${obj.name}`, [], ctx, { variant: "class", isNew, nested, sizeText: sizeLabel(ctx, obj.id) });
    case "opaque":
      return tableShape(obj.typeName, [{ label: "", value: { kind: "prim", type: "repr", repr: obj.repr }, changed: changed.has("*") }],
        ctx, { variant: "opaque", isNew, nested, sizeText: sizeLabel(ctx, obj.id) });
  }
}

function frameShape(frame: Frame, ctx: Ctx, isActive: boolean): Shape {
  const { step, diff } = ctx;
  const rows: TableRow[] = frame.locals.map(([name, value]) => ({
    label: name, value, changed: diff.changedLocals.has(localKey(frame.id, name)),
  }));
  if (isActive && step.event === "return" && step.returnValue && frame.func !== "Global") {
    rows.push({ label: "returns", value: step.returnValue, changed: true, variant: "return-row" });
  }
  if (isActive && step.event === "yield" && step.returnValue) {
    rows.push({ label: "yields", value: step.returnValue, changed: true, variant: "return-row" });
  }
  // A paused generator or async function: off the stack, variables kept.
  const paused = frame.state === "suspended";
  const title = frame.func === "Global" ? "Global" : `${frame.func}()${paused ? `, paused at line ${frame.line}` : ""}`;
  // A frame's size: what its variables keep alive.
  const holds = ctx.sizes ? ctx.sizes.frame(frame) : 0;
  return tableShape(title, rows, ctx, {
    variant: ["frame", isActive && "is-active", paused && "is-suspended"].filter(Boolean).join(" "),
    isNew: diff.newFrames.has(frame.id),
    emptyText: "no variables yet",
    sizeText: ctx.sizes && holds > 0 ? `holds ${formatBytes(holds, ctx.sizes.approximate)}` : null,
  });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function renderMemory(
  trace: Trace,
  stepIndex: number,
  diff: StepDiff,
  layout: MemoryLayout = { positions: new Map() },
): SVGSVGElement {
  const step = trace.steps[stepIndex];
  const svg = s("svg", { class: "memory-svg", xmlns: "http://www.w3.org/2000/svg" });
  svg.append(arrowMarkers());
  const boxLayer = s("g", { class: "boxes" });
  const arrowLayer = s("g", { class: "arrows" });
  svg.append(boxLayer, arrowLayer);

  const nested = layout.mode === "nested" ? chooseNested(step) : new Set<string>();

  // Graphs are drawn as one box, in place of the dict or list that holds
  // them (or, for graphs of objects, in place of all the node objects).
  const graphs = graphBoxes(trace, stepIndex);
  const graphAlias = new Map<string, string>();
  for (const box of graphs.values()) {
    nested.delete(box.graph.hostId);
    if (!box.graph.objectNodes) continue;
    for (const member of box.graph.members) {
      nested.delete(member);
      // Arrows to any node (or its neighbor list) go to the graph's box.
      if (member !== box.graph.hostId) graphAlias.set(member, box.graph.hostId);
    }
  }
  const outgoing = (id: string): Value[] => (graphs.has(id) ? [] : valuesOf(step.heap[id]));

  // Index pointers (i, j, lo, hi...) belong to the variable that holds a list.
  const pointerOwner = new Map<string, { name: string; frame: Frame }>();
  for (const frame of liveFrames(step)) {
    for (const [name, value] of frame.locals) if (value.kind === "ref" && !pointerOwner.has(value.id)) pointerOwner.set(value.id, { name, frame });
  }
  // The running frame's names win over paused frames and callers.
  for (const frame of step.stack) {
    for (const [name, value] of frame.locals) if (value.kind === "ref") pointerOwner.set(value.id, { name, frame });
  }
  const ctx: Ctx = {
    step,
    diff,
    sizes: layout.sizes ? stepSizes(step, layout.sizes) : null,
    nested,
    functionKeyword: trace.language === "python" ? "def" : "function",
    pointersFor(id, level = 0) {
      const owner = pointerOwner.get(id);
      if (!owner) return [];
      const changedNames = new Set(owner.frame.locals.map(([n]) => n).filter((n) => diff.changedLocals.has(localKey(owner.frame.id, n))));
      const name = level === 1 ? `${owner.name}[]` : owner.name;
      return pointersFor(name, trace.indexNames, new Map(owner.frame.locals), changedNames);
    },
  };

  // References that leave a group of nested boxes: where its arrows go.
  const exits = (values: Value[], out: string[] = []): string[] => {
    for (const value of values) {
      if (value.kind !== "ref" || !step.heap[value.id]) continue;
      if (nested.has(value.id)) exits(outgoing(value.id), out);
      else out.push(graphAlias.get(value.id) ?? value.id);
    }
    return out;
  };

  // Binary trees (arrows mode) are laid out top-down as one block: each node
  // in its in-order slot, at the height of its depth. Found the same way as
  // in the loop history, so `viz: tree` hints apply here too.
  const blocks = findTreeBlocks(trace, step, layout.mode === "nested");
  const blockOf = new Map<string, TreeBlock>();
  for (const block of blocks) for (const id of block.nodes.keys()) blockOf.set(id, block);

  // 1. Breadth-first walk from the stack assigns each separate box a column.
  //    Nested objects aren't boxes of their own: their outgoing arrows count
  //    as coming from the box they're drawn in.
  const depth = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = [];
  const enqueue = (id: string, d: number) => {
    if (depth.has(id)) return;
    // A tree's nodes all go in the column of the first one reached.
    for (const member of blockOf.get(id)?.inOrder ?? [id]) {
      if (depth.has(member)) continue;
      depth.set(member, d);
      order.push(member);
      queue.push(member);
    }
  };
  const roots = liveFrames(step).flatMap((frame) => frame.locals.map(([, value]) => value));
  if (step.returnValue) roots.push(step.returnValue);
  for (const id of exits(roots)) enqueue(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of exits(outgoing(id))) enqueue(child, depth.get(id)! + 1);
  }

  // 2. Measure everything, then size the columns.
  const shapes = new Map<string, Shape>();
  for (const id of order) {
    const box = graphs.get(id);
    shapes.set(id, box ? graphShape(box, step.heap[id], diff.newObjects.has(id), graphSize(box, ctx)) : objectShape(step.heap[id], ctx));
  }

  // The call stack, then paused frames under it.
  const frames = liveFrames(step);
  const frameShapes = frames.map((frame, i) => frameShape(frame, ctx, i === step.stack.length - 1));
  const framesW = Math.max(160, ...frameShapes.map((f) => f.w));
  for (const block of blocks) measureBlock(block, shapes);
  const columnW: number[] = [];
  for (const id of order) {
    const d = depth.get(id)!;
    columnW[d] = Math.max(columnW[d] ?? 0, blockOf.get(id)?.w ?? shapes.get(id)!.w);
  }
  const columnX: number[] = [];
  let cursorX = MARGIN + framesW + COLUMN_GAP;
  for (let d = 0; d < columnW.length; d++) {
    columnX[d] = cursorX;
    cursorX += (columnW[d] ?? 0) + COLUMN_GAP;
  }

  // 3. Place and draw. Frames first, then objects in BFS order so a parent
  //    is always placed before its children and can pull them level with it.
  const refs: OutRef[] = [];
  const preferredY = new Map<string, number>();

  // Boxes the person dragged stay exactly where they were put. Everything
  // else is placed automatically, moving down past anything already there,
  // so a new box is never hidden under another one.
  const frameKeys = frames.map((frame, index) =>
    frame.state === "suspended" ? nodeKey.paused(frame.id) : nodeKey.frame(index, frame.func));
  const obstacles: Rect[] = [];
  frameShapes.forEach((shape, index) => {
    const moved = layout.positions.get(frameKeys[index]);
    if (moved) obstacles.push({ ...moved, w: shape.w, h: shape.h });
  });
  for (const id of order) {
    const moved = layout.positions.get(nodeKey.object(id));
    if (moved) obstacles.push({ ...moved, w: shapes.get(id)!.w, h: shapes.get(id)!.h });
  }

  // Each box goes in its own group, so the viewport can find and drag it.
  const rects = new Map<string, Rect & { inY: number }>();
  let raised: SVGGElement | null = null;
  const drawNode = (key: string, shape: Shape, x: number, y: number) => {
    const g = s("g", { class: "node", "data-node-key": key, "data-flip": key, "data-x": x, "data-y": y });
    const isMoved = layout.positions.has(key);
    if (isMoved) g.classList.add("is-moved");
    // An invisible backing, so a press anywhere on the box (even between its
    // index numbers and cells) grabs the box instead of panning the canvas.
    g.append(s("rect", { class: "node-hit", x: x - 2, y: y - 2, width: shape.w + 4, height: shape.h + 4, fill: "transparent" }));
    const before = refs.length;
    shape.draw(x, y, g, refs);
    for (let i = before; i < refs.length; i++) refs[i].source = key;
    // Arrows leaving list cells downward turn under the box like the teeth
    // of a comb: the leftmost cell turns highest, so they stay in order.
    const down = refs.slice(before).filter((r) => r.down).sort((a, b) => a.from.x - b.from.x);
    down.forEach((ref, rank) => { ref.exitDownY = y + shape.h + EXIT_DROP + rank * EXIT_LANE; });
    // Line each target up with where its arrow arrives.
    for (let i = before; i < refs.length; i++) {
      const ref = refs[i];
      if (!preferredY.has(ref.target)) preferredY.set(ref.target, ref.exitDownY ?? ref.from.y);
    }
    boxLayer.append(g);
    if (key === layout.raise) raised = g;
    const rect = { x, y, w: shape.w, h: shape.h, inY: shape.inY };
    rects.set(key, rect);
    // Keep the turns under a list clear of the next box down.
    const below = down.length ? EXIT_DROP + (down.length - 1) * EXIT_LANE + 6 : 0;
    if (!isMoved) obstacles.push({ ...rect, h: rect.h + below });
    return below;
  };

  let frameY = TOP;
  frameShapes.forEach((shape, index) => {
    const key = frameKeys[index];
    const moved = layout.positions.get(key);
    if (moved) {
      drawNode(key, shape, moved.x, moved.y);
      return;
    }
    const y = findFreeY(MARGIN, shape.w, shape.h, frameY, obstacles, STACK_GAP);
    const below = drawNode(key, shape, MARGIN, y);
    frameY = y + shape.h + below + STACK_GAP;
  });

  const columnCursor: number[] = columnW.map(() => TOP);
  for (const id of order) {
    const d = depth.get(id)!;
    const shape = shapes.get(id)!;
    const key = nodeKey.object(id);
    const moved = layout.positions.get(key);
    if (moved) {
      drawNode(key, shape, moved.x, moved.y);
      continue;
    }
    const block = blockOf.get(id);
    if (block) {
      // The first node reached places the whole tree; every node then goes
      // to its slot in the block.
      if (!block.origin) {
        const want = preferredY.has(block.root) ? preferredY.get(block.root)! - shapes.get(block.root)!.inY : TOP;
        const y = findFreeY(columnX[d], block.w, block.h, Math.max(columnCursor[d], want), obstacles, STACK_GAP);
        block.origin = { x: columnX[d], y };
        columnCursor[d] = y + block.h + STACK_GAP;
      }
      const slot = block.nodes.get(id)!;
      drawNode(key, shape,
        block.origin.x + slot.index * (block.slotW + TREE_GAP) + Math.round((block.slotW - shape.w) / 2),
        block.origin.y + slot.depth * block.levelH);
      continue;
    }
    const want = preferredY.has(id) ? preferredY.get(id)! - shape.inY : TOP;
    const y = findFreeY(columnX[d], shape.w, shape.h, Math.max(columnCursor[d], want), obstacles, STACK_GAP);
    const below = drawNode(key, shape, columnX[d], y);
    columnCursor[d] = y + shape.h + below + STACK_GAP;
  }
  // Boxes the person placed sit on top of automatically placed ones, and the
  // box being dragged right now is on top of everything.
  for (const g of [...boxLayer.querySelectorAll(".node.is-moved")]) boxLayer.append(g);
  if (raised) boxLayer.append(raised);

  // 4. Route the arrows through the gaps between boxes (see route.ts).
  const edges = refs
    .map((ref) => ({ ref, source: rects.get(ref.source ?? ""), target: rects.get(nodeKey.object(graphAlias.get(ref.target) ?? ref.target)) }))
    .filter((e): e is { ref: OutRef; source: Rect & { inY: number }; target: Rect & { inY: number } } => !!e.source && !!e.target);
  const idOf = (key: string | undefined) => (key?.startsWith("obj:") ? key.slice(4) : "");
  const routes = routeEdges(
    edges.map(({ ref, source, target }) => {
      const block = blockOf.get(ref.target);
      const sourceId = idOf(ref.source);
      // An arrow to a node of a graph lands level with that node.
      const host = graphAlias.get(ref.target) ?? ref.target;
      const center = graphs.get(host)?.picture.centers.get(ref.target);
      const entryY = center && graphs.get(host)!.graph.objectNodes ? target.y + GRAPH_BODY_Y + center.y : target.y + target.inY;
      const base = { from: ref.from, exitDownY: ref.exitDownY, source, target, entryY };
      if (!block?.origin) return base;
      // Parent to child inside a tree: drop from the parent to the child's top.
      const parent = block.nodes.get(sourceId);
      if (parent && blockOf.get(sourceId) === block && parent.children.includes(ref.target)) {
        return { ...base, tree: block.nodes.get(ref.target)!.index < parent.index ? "left" as const : "right" as const };
      }
      // From outside, to the left of the tree: come down beside the tree and
      // in from above, so the arrow doesn't run through the node's neighbors.
      if (source.x + source.w + 20 <= block.origin.x) return { ...base, enterTopFrom: block.origin.x };
      return base;
    }),
    [...rects.values()],
  );
  let maxX = 0;
  let maxY = 0;
  for (const rect of rects.values()) {
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  routes.forEach((points, i) => {
    const { ref } = edges[i];
    for (const p of points) {
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    arrowLayer.append(s("path", {
      d: roundedPath(points),
      class: ref.changed ? "ref-arrow is-changed" : "ref-arrow",
      "marker-end": "url(#arrow-ref)",
      "data-from": ref.source,
      "data-to": nodeKey.object(graphAlias.get(ref.target) ?? ref.target),
    }));
  });

  const width = Math.max(maxX + MARGIN, MARGIN * 2 + framesW, cursorX - COLUMN_GAP + MARGIN);
  const height = maxY + MARGIN;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.setProperty("--font-size", `${FONT}px`);
  svg.style.setProperty("--small-size", `${SMALL}px`);
  return svg;
}

/**
 * Highlight one box's connections: its arrows (in and out) and the boxes at
 * their other ends. Everything else dims. Pass null to clear.
 */
export function applyFocus(svg: SVGSVGElement | null, key: string | null): void {
  if (!svg) return;
  for (const el of svg.querySelectorAll(".is-focus, .is-related")) el.classList.remove("is-focus", "is-related");
  const node = key ? svg.querySelector(`.node[data-node-key="${CSS.escape(key)}"]`) : null;
  svg.classList.toggle("has-focus", !!node);
  if (!node || !key) return;
  node.classList.add("is-focus");
  for (const arrow of svg.querySelectorAll<SVGPathElement>(".ref-arrow")) {
    const { from, to } = arrow.dataset;
    if (from !== key && to !== key) continue;
    arrow.classList.add("is-focus");
    const other = from === key ? to : from;
    svg.querySelector(`.node[data-node-key="${CSS.escape(other ?? "")}"]`)?.classList.add("is-related");
  }
}

// ---------------------------------------------------------------------------
// Graphs
// ---------------------------------------------------------------------------

interface GraphBox {
  graph: GraphData;
  overlay: GraphOverlay;
  picture: GraphPicture;
}

/** Where a graph's picture starts inside its box. */
const GRAPH_BODY_Y = HEADER_H + 4;

/** The graphs at a step, by the heap id each one is drawn in place of. */
function graphBoxes(trace: Trace, stepIndex: number): Map<string, GraphBox> {
  const step = trace.steps[stepIndex];
  const before = trace.steps[stepIndex - 1];
  const prev = new Map((before ? graphsAt(trace, before) : []).map((graph) => [graph.id, {
    graph, overlay: graphOverlay(trace, graph, stepScopes(before), before.heap),
  }]));
  const boxes = new Map<string, GraphBox>();
  for (const graph of graphsAt(trace, step)) {
    const overlay = graphOverlay(trace, graph, stepScopes(step), step.heap);
    const picture = graphPicture(graph, layoutFor(trace, graph), overlay, {
      flipKey: `gptr:${graph.id}`, prev: before ? prev.get(graph.id) ?? null : null,
      legendOverlays: [overlay, ...legendOverlaysFor(trace, graph)],
    });
    boxes.set(graph.hostId, { graph, overlay, picture });
  }
  return boxes;
}

/** A graph's size: its container (and everything in it), or all its node objects. */
function graphSize(box: GraphBox, ctx: Ctx): string | null {
  if (!ctx.sizes) return null;
  if (!box.graph.objectNodes) return sizeLabel(ctx, box.graph.hostId);
  const nodes = [...box.graph.nodes.keys()].map((id) => ({ kind: "ref" as const, id }));
  return `total ${formatBytes(ctx.sizes.of(nodes), ctx.sizes.approximate)}`;
}

function graphShape(box: GraphBox, obj: HeapObject, isNew: boolean, size: string | null): Shape {
  const { graph, picture } = box;
  const kind = `${graph.directed ? "directed" : "undirected"} graph, ${graph.nodes.size} node${graph.nodes.size === 1 ? "" : "s"}`;
  const title = graph.objectNodes ? `${graph.name} objects: ${kind}` : `${obj.typeName}: ${kind}`;
  const sizeW = size ? uiTextWidth(size, 11.5) * 1.08 + 14 : 0;
  const w = Math.max(picture.w + 16, uiTextWidth(title, 12) + 28 + sizeW);
  const h = GRAPH_BODY_Y + picture.h + 4;
  return {
    w, h, inY: HEADER_H / 2,
    draw(x, y, layer) {
      const g = s("g", { class: ["box", "graph-box", isNew && "is-new"].filter(Boolean).join(" ") });
      g.append(
        s("rect", { class: "box-body", x, y, width: w, height: h, rx: 5 }),
        s("path", { class: "box-header", d: `M${x},${y + HEADER_H} V${y + 5} q0,-5 5,-5 H${x + w - 5} q5,0 5,5 V${y + HEADER_H} z` }),
        s("text", { class: "box-title", x: x + 10, y: y + HEADER_H / 2, "dominant-baseline": "central" }, title),
      );
      if (size) g.append(s("text", { class: "box-size", x: x + w - 9, y: y + HEADER_H / 2, "text-anchor": "end", "dominant-baseline": "central" }, size));
      picture.draw(x + Math.round((w - picture.w) / 2), y + GRAPH_BODY_Y, g);
      layer.append(g);
    },
  };
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

interface TreeBlock {
  root: string;
  /** Node id -> in-order index, depth, and its child node ids. */
  nodes: Map<string, { index: number; depth: number; children: string[] }>;
  inOrder: string[];
  slotW: number;
  levelH: number;
  w: number;
  h: number;
  origin?: { x: number; y: number };
}

/** Binary trees in this step with at least two nodes, each one block. */
function findTreeBlocks(trace: Trace, step: Step, nestedMode: boolean): TreeBlock[] {
  if (nestedMode) return []; // nested mode draws trees as boxes in boxes
  const row = { locals: liveFrames(step).flatMap((frame) => frame.locals), heap: step.heap };
  const track = findLinkedTrack([row], trace.viz?.linked);
  if (track?.shape !== "tree") return [];
  const state = linkedRow(track, row);
  const depths = treeDepths(state);
  const blocks: TreeBlock[] = [];
  const placed = new Set<string>();
  for (const [id] of state.nodes) {
    if (depths.get(id) !== 0 || placed.has(id)) continue;
    const block: TreeBlock = { root: id, nodes: new Map(), inOrder: [], slotW: 0, levelH: 0, w: 0, h: 0 };
    const visit = (nodeId: string | null, depth: number) => {
      if (!nodeId || placed.has(nodeId) || !state.nodes.has(nodeId)) return;
      placed.add(nodeId);
      const [left, right] = state.nodes.get(nodeId)!.links;
      visit(left, depth + 1);
      block.nodes.set(nodeId, { index: block.inOrder.length, depth, children: [left, right].filter((c): c is string => !!c) });
      block.inOrder.push(nodeId);
      visit(right, depth + 1);
    };
    visit(id, 0);
    if (block.inOrder.length >= 2) blocks.push(block);
  }
  return blocks;
}

function measureBlock(block: TreeBlock, shapes: Map<string, Shape>): void {
  const sizes = block.inOrder.map((id) => shapes.get(id)!);
  block.slotW = Math.max(...sizes.map((shape) => shape.w));
  block.levelH = Math.max(...sizes.map((shape) => shape.h)) + LEVEL_GAP;
  const levels = Math.max(...[...block.nodes.values()].map((n) => n.depth)) + 1;
  block.w = block.inOrder.length * (block.slotW + TREE_GAP) - TREE_GAP;
  block.h = levels * block.levelH - LEVEL_GAP;
}
