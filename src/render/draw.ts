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

export const FONT = 13; // value text size, px
export const SMALL = 11; // index numbers and labels
export const CELL_H = 30;
export const CELL_MIN_W = 34;
export const REF_W = 34; // a cell that holds a reference dot
export const ROW_H = 32; // a row in a frame or object table
export const HEADER_H = 26; // title bar of a frame or object
export const LABEL_H = 18; // small label above a list
export const INDEX_H = 14; // index numbers above list cells
export const POINTER_H = 24; // room under a list for i / j markers
export const STRIP_H = 22; // a long list's color strip, above its cells
export const STRIP_MAX_W = 480;

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
    case "str": // Python
    case "bytes":
    case "string": // JavaScript
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
    default: // "key" (unquoted object keys), "getter", "symbol", ...
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
  g.append(
    s(
      "text",
      { class: `value ${primClass(value)}`, x: cx, y: cy, "text-anchor": "middle", "dominant-baseline": "central" },
      value.repr,
    ),
  );
  return { el: g };
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

export function arrowMarkers(): SVGDefsElement {
  const marker = (id: string, cls: string) =>
    s(
      "marker",
      { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
      s("path", { d: "M0,1 L10,5 L0,9 z", class: cls }),
    );
  // Graph edges come in several thicknesses: their arrowheads are sized in
  // diagram units so a thick edge doesn't get a huge one.
  const fixed = (id: string, cls: string) =>
    s(
      "marker",
      {
        id,
        viewBox: "0 0 10 10",
        refX: 8,
        refY: 5,
        markerWidth: 11,
        markerHeight: 11,
        markerUnits: "userSpaceOnUse",
        orient: "auto-start-reverse",
      },
      s("path", { d: "M0,1 L10,5 L0,9 z", class: cls }),
    );
  return s(
    "defs",
    {},
    marker("arrow-ref", "arrowhead-ref"),
    marker("arrow-change", "arrowhead-change"),
    fixed("arrow-graph", "arrowhead-graph"),
    fixed("arrow-tree", "arrowhead-tree"),
    fixed("arrow-path", "arrowhead-path"),
  );
}

/** A "this changed" arrow between two stacked rows of the loop view. */
export function changeArrow(from: { x: number; y: number }, to: { x: number; y: number }): SVGPathElement {
  const dy = to.y - from.y;
  const d =
    from.x === to.x
      ? `M${from.x},${from.y} L${to.x},${to.y}`
      : `M${from.x},${from.y} C${from.x},${from.y + dy * 0.6} ${to.x},${to.y - dy * 0.6} ${to.x},${to.y}`;
  return s("path", { d, class: "change-arrow", "marker-end": "url(#arrow-change)" });
}

/** Little upward markers under list cells for index variables like i and j. */
/** For animation (render/animate.ts): a key prefix, and the origin positions are relative to. */
export interface FlipInfo {
  key: string;
  originX: number;
  originY: number;
}

const flipAttrs = (flip: FlipInfo | undefined, name: string, x: number, y: number) =>
  flip
    ? {
        "data-flip": `${flip.key}:${name}`,
        "data-x": Math.round(x - flip.originX),
        "data-y": Math.round(y - flip.originY),
      }
    : {};

export function pointerMarkers(
  pointers: { name: string; index: number; changed: boolean }[],
  cellX: (index: number) => number,
  cellW: number,
  y: number,
  length: number,
  flip?: FlipInfo,
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
    const label = names.map((n) => n.name).join(", ");
    g.append(
      s(
        "g",
        { class: cls, ...flipAttrs(flip, label, cx, y) },
        s("path", { d: `M${cx - 5},${y + 9} L${cx},${y + 3} L${cx + 5},${y + 9} z` }),
        s("text", { x: cx, y: y + 20, "text-anchor": "middle" }, names.map((n) => n.name).join(", ")),
      ),
    );
  }
  return g;
}

/**
 * Names that conventionally hold an index. They're drawn as pointers on any
 * container the code indexes, even when they aren't used as a subscript
 * themselves (binary search uses lo and hi, but only indexes nums[mid]).
 */
const CONVENTIONAL_POINTERS = [
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
): { name: string; index: number; changed: boolean }[] {
  const out: { name: string; index: number; changed: boolean }[] = [];
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

/**
 * Row pointers for a grid: a small left-pointing marker and the names, just
 * right of the row they point at (grid[i][j] puts i here, j under a column).
 */
export function rowPointerMarkers(
  pointers: { name: string; index: number; changed: boolean }[],
  rowMid: (index: number) => number,
  x: number,
  rows: number,
  flip?: FlipInfo,
): SVGGElement {
  const g = s("g", { class: "pointers row-pointers" });
  const byIndex = new Map<number, { name: string; changed: boolean }[]>();
  for (const p of pointers) {
    if (p.index < 0 || p.index >= rows) continue;
    byIndex.set(p.index, [...(byIndex.get(p.index) ?? []), p]);
  }
  for (const [index, names] of byIndex) {
    const y = rowMid(index);
    const cls = ["pointer", names.some((n) => n.changed) && "is-changed"].filter(Boolean).join(" ");
    const label = names.map((n) => n.name).join(", ");
    g.append(
      s(
        "g",
        { class: cls, ...flipAttrs(flip, `row:${label}`, x, y) },
        s("path", { d: `M${x + 3},${y} L${x + 9},${y - 5} L${x + 9},${y + 5} z` }),
        s("text", { x: x + 12, y, "dominant-baseline": "central" }, names.map((n) => n.name).join(", ")),
      ),
    );
  }
  return g;
}

/** Width needed by rowPointerMarkers for these pointers. */
export function rowPointersWidth(pointers: { name: string; index: number }[]): number {
  if (!pointers.length) return 0;
  const byIndex = new Map<number, string[]>();
  for (const p of pointers) byIndex.set(p.index, [...(byIndex.get(p.index) ?? []), p.name]);
  return 16 + Math.max(...[...byIndex.values()].map((names) => textWidth(names.join(", "), SMALL)));
}

// ---------------------------------------------------------------------------
// The strip: a long list of numbers, all of it, as a band of color
// ---------------------------------------------------------------------------

/** Viridis: dark purple (smallest) to yellow (largest), distinct in grayscale too. */
const RAMP = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

export function rampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [RAMP[i], RAMP[i + 1]];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export interface StripInfo {
  values: number[];
  min: number;
  max: number;
  /** The list's length. */
  length: number;
  /** The cells drawn below: which items they are. */
  window: { start: number; count: number };
  pointers: { name: string; index: number }[];
}

/**
 * A band of color, one slice per sample, left to right across the whole
 * list; a bracket shows where the cells below are, and ticks show the
 * index variables. Drawn at (x, y), up to `room` wide (at most STRIP_MAX_W), STRIP_H tall.
 */
export function stripBar(info: StripInfo, x: number, y: number, room: number, key: string): SVGGElement {
  const { values, min, max, length } = info;
  // An overview: no wider than a glance, even when the cells run on.
  const w = Math.max(120, Math.min(room, STRIP_MAX_W));
  const barY = y + 3;
  const barH = 9;
  const span = max - min || 1;
  const g = s(
    "g",
    { class: "strip", "data-key": key },
    s(
      "title",
      {},
      `All ${length.toLocaleString()} items as colors: darkest is the smallest (${min}), yellow the largest (${max}). The bracket marks the ${info.window.count} cells drawn below.`,
    ),
  );
  const sliceW = w / values.length;
  // Neighbors of the same color share one rectangle.
  let runStart = 0;
  for (let i = 1; i <= values.length; i++) {
    if (i < values.length && values[i] === values[runStart]) continue;
    g.append(
      s("rect", {
        class: "strip-slice",
        x: x + runStart * sliceW,
        y: barY,
        width: (i - runStart) * sliceW + 0.4,
        height: barH,
        fill: rampColor((values[runStart] - min) / span),
      }),
    );
    runStart = i;
  }
  g.append(s("rect", { class: "strip-frame", x, y: barY, width: w, height: barH }));
  // Where the cells are.
  const wx = x + (info.window.start / length) * w;
  const ww = Math.max(3, (info.window.count / length) * w);
  g.append(s("rect", { class: "strip-window", x: wx - 1, y: barY - 2, width: ww + 2, height: barH + 4, rx: 2 }));
  // Index variables, all of them, even outside the cells.
  for (const p of info.pointers) {
    if (p.index < 0 || p.index > length) continue;
    const px = x + ((p.index + 0.5) / length) * w;
    g.append(
      s(
        "path",
        {
          class: "strip-pointer",
          d: `M${px - 3.5},${barY + barH + 7} L${px},${barY + barH + 2} L${px + 3.5},${barY + barH + 7} z`,
        },
        s("title", {}, `${p.name} = ${p.index}`),
      ),
    );
  }
  return g;
}
