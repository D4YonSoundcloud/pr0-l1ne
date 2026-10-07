/**
 * Low-level SVG drawing shared by the memory view and the loop view.
 *
 * Everything is measured arithmetically instead of with getBBox(), because
 * all text inside cells uses a monospace font (each character is 0.6em wide).
 * That keeps layout fast, deterministic, and testable outside a browser.
 */
import type { PrimValue, Value } from "../trace/types";

const NS = "http://www.w3.org/2000/svg";

type AttrValue = string | number | null | undefined | false;
type Child = SVGElement | string | null | undefined | false;

/** Create an SVG element: s("rect", { x: 0, class: "cell" }, ...children) */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const FONT = 13;            // value text size, px
export const SMALL = 11;           // index numbers and labels
export const CELL_H = 30;
export const CELL_MIN_W = 34;
export const REF_W = 34;           // a cell that holds a reference dot
export const ROW_H = 32;           // a row in a frame or object table
export const HEADER_H = 26;        // title bar of a frame or object
export const LABEL_H = 18;         // small label above a list
export const INDEX_H = 14;         // index numbers above list cells
export const POINTER_H = 24;       // room under a list for i / j markers

/** Width of monospace text. */
export const textWidth = (text: string, size = FONT) => text.length * size * 0.6;

/** Approximate width of text set in the proportional UI font. */
export const uiTextWidth = (text: string, size = SMALL) => text.length * size * 0.56;

export function cellWidth(value: Value): number {
  if (value.kind === "ref") return REF_W;
  return Math.max(CELL_MIN_W, textWidth(value.repr) + 16);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function primClass(value: PrimValue): string {
  switch (value.type) {
    case "str":     // Python
    case "bytes":
    case "string":  // JavaScript
      return "v-str";
    case "int":
    case "float":
    case "complex":
    case "number":
    case "bigint":
      return "v-num";
    case "bool":
    case "boolean":
      return "v-bool";
    case "none":
    case "null":
    case "undefined":
      return "v-none";
    default:        // "key" (unquoted object keys), "getter", "symbol", ...
      return "v-other";
  }
}

export interface CellOptions {
  x: number;
  y: number;
  w: number;
  h?: number;
  changed?: boolean;
  variant?: string;
}

/**
 * Draw one value in a box. Returns the group, plus the center of the
 * reference dot when the value is a pointer (so the caller can draw an arrow).
 */
export function valueCell(value: Value, opts: CellOptions): { el: SVGGElement; dot?: { x: number; y: number } } {
  const h = opts.h ?? CELL_H;
  const classes = ["cell", opts.variant, opts.changed && "is-changed"].filter(Boolean).join(" ");
  const g = s("g", { class: classes });
  g.append(s("rect", { x: opts.x, y: opts.y, width: opts.w, height: h, rx: 3 }));
  const cx = opts.x + opts.w / 2;
  const cy = opts.y + h / 2;
  if (value.kind === "ref") {
    g.append(s("circle", { class: "ref-dot", cx, cy, r: 4 }));
    return { el: g, dot: { x: cx, y: cy } };
  }
  g.append(s("text", { class: `value ${primClass(value)}`, x: cx, y: cy, "text-anchor": "middle", "dominant-baseline": "central" }, value.repr));
  return { el: g };
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

export function arrowMarkers(): SVGDefsElement {
  const marker = (id: string, cls: string) =>
    s("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
      s("path", { d: "M0,1 L10,5 L0,9 z", class: cls }));
  return s("defs", {}, marker("arrow-ref", "arrowhead-ref"), marker("arrow-change", "arrowhead-change"));
}

/**
 * A reference arrow. Normally it flows left to right into the target's left
 * edge. When the target is not to the right (a back edge, as in a cycle or a
 * linked list being reversed), it swings out right and enters the target's
 * right edge instead, so it never cuts through the boxes in between.
 */
export function refArrow(
  from: { x: number; y: number },
  target: { x: number; y: number; w: number; inY: number },
  changed = false,
): SVGPathElement {
  const toLeft = { x: target.x - 2, y: target.y + target.inY };
  let d: string;
  if (toLeft.x - from.x > 24) {
    const bend = Math.max(30, (toLeft.x - from.x) * 0.45);
    d = `M${from.x},${from.y} C${from.x + bend},${from.y} ${toLeft.x - bend},${toLeft.y} ${toLeft.x},${toLeft.y}`;
  } else {
    const to = { x: target.x + target.w + 2, y: target.y + target.inY };
    const out = Math.max(from.x, to.x) + 44;
    d = `M${from.x},${from.y} C${out},${from.y} ${out},${to.y} ${to.x},${to.y}`;
  }
  return s("path", { d, class: changed ? "ref-arrow is-changed" : "ref-arrow", "marker-end": "url(#arrow-ref)" });
}

/** A "this changed" arrow between two stacked rows of the loop view. */
export function changeArrow(from: { x: number; y: number }, to: { x: number; y: number }): SVGPathElement {
  const dy = to.y - from.y;
  const d = from.x === to.x
    ? `M${from.x},${from.y} L${to.x},${to.y}`
    : `M${from.x},${from.y} C${from.x},${from.y + dy * 0.6} ${to.x},${to.y - dy * 0.6} ${to.x},${to.y}`;
  return s("path", { d, class: "change-arrow", "marker-end": "url(#arrow-change)" });
}

/** Little upward markers under list cells for index variables like i and j. */
export function pointerMarkers(
  pointers: { name: string; index: number; changed: boolean }[],
  cellX: (index: number) => number,
  cellW: number,
  y: number,
  length: number,
): SVGGElement {
  const g = s("g", { class: "pointers" });
  const byIndex = new Map<number, { name: string; changed: boolean }[]>();
  for (const p of pointers) {
    if (p.index < 0 || p.index > length) continue;
    byIndex.set(p.index, [...(byIndex.get(p.index) ?? []), p]);
  }
  for (const [index, names] of byIndex) {
    const cx = cellX(index) + cellW / 2;
    const outOfRange = index === length;
    const changed = names.some((n) => n.changed);
    const cls = ["pointer", outOfRange && "is-out", changed && "is-changed"].filter(Boolean).join(" ");
    g.append(s("g", { class: cls },
      s("path", { d: `M${cx - 5},${y + 9} L${cx},${y + 3} L${cx + 5},${y + 9} z` }),
      s("text", { x: cx, y: y + 20, "text-anchor": "middle" }, names.map((n) => n.name).join(", "))));
  }
  return g;
}

/**
 * Names that conventionally hold an index. They're drawn as pointers on any
 * container the code indexes, even when they aren't used as a subscript
 * themselves (binary search uses lo and hi, but only indexes nums[mid]).
 */
const CONVENTIONAL_POINTERS = ["lo", "hi", "low", "high", "left", "right", "l", "r", "start", "end", "mid", "slow", "fast"];

/** Resolve index variables for a container: names that hold an int. */
export function pointersFor(
  containerName: string,
  indexNames: Record<string, string[]>,
  locals: Map<string, Value>,
  changedNames: Set<string> = new Set(),
): { name: string; index: number; changed: boolean }[] {
  const out: { name: string; index: number; changed: boolean }[] = [];
  const subscripts = indexNames[containerName];
  if (!subscripts) return out;
  const names = new Set([...subscripts, ...CONVENTIONAL_POINTERS.filter((n) => locals.has(n))]);
  for (const name of names) {
    const value = locals.get(name);
    // Python reports "int"; JavaScript reports "number", which may not be whole.
    const isIndex = value?.kind === "prim" &&
      (value.type === "int" || (value.type === "number" && Number.isInteger(Number(value.repr))));
    if (isIndex) out.push({ name, index: Number(value.repr), changed: changedNames.has(name) });
  }
  return out;
}
