/**
 * From a drawing to a paint list: what the canvas renderer draws.
 *
 * The canvas renderer doesn't lay anything out itself. It takes the very
 * drawing that render/memory.ts and render/loopView.ts lay out (drawing.ts:
 * marks, the SVG elements they mean; SVG elements work too), reads each
 * element's computed style (styles.ts), and turns it into plain shapes and
 * text with their colors resolved. This keeps one
 * layout for both renderers: they can't drift apart, and the SVG renderer
 * and SVG export stay exact. Turning the paint list into PixiJS objects is
 * pixiScene.ts's job; this file has no PixiJS in it, so it's tested in jsdom.
 *
 * Supported, because the drawings use them: <g>, <rect>, <circle>, <line>,
 * <path> (with marker-end arrowheads from <defs>), <text> with <tspan>s,
 * and <title> tooltips. Groups keep the data-* attributes the animation
 * and dragging work from.
 */
import type { DrawingNode } from "../drawing";
import { parseColor, type Rgba } from "./color";
import { endDirection, type PathCommand, parsePath, pathBounds } from "./path";
import type { ComputedPaint, StyleSource } from "./styles";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StrokePaint {
  color: number;
  alpha: number;
  width: number;
  /** stroke-dasharray; empty for a solid line. */
  dash: number[];
  dashOffset: number;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
}

export interface FillPaint {
  color: number;
  alpha: number;
}

export type Geometry =
  | { type: "rect"; x: number; y: number; w: number; h: number; r: number }
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "path"; commands: PathCommand[] };

export interface PaintShape {
  kind: "shape";
  geometry: Geometry;
  fill: FillPaint | null;
  stroke: StrokePaint | null;
  /** The cell's changed-value flash (styles.css, @keyframes mark) plays on it. */
  flash: boolean;
}

export interface FontSpec {
  family: string;
  size: number;
  weight: string;
  style: string;
  letterSpacing: number;
}

export interface TextRun {
  text: string;
  /** Extra space before the run (a <tspan dx>). */
  dx: number;
  font: FontSpec;
  fill: FillPaint | null;
  /** A halo drawn under the text (paint-order: stroke). */
  stroke: StrokePaint | null;
}

export interface PaintText {
  kind: "text";
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  /** dominant-baseline: where y sits on the text. */
  baseline: "alphabetic" | "central" | "middle" | "hanging";
  runs: TextRun[];
  alpha: number;
}

export interface PaintGroup {
  kind: "group";
  /** Multiplies everything inside (CSS opacity). */
  alpha: number;
  children: PaintItem[];
  /** A box the person can drag (data-node-key). */
  nodeKey?: string;
  /** Where its top-left corner is, in diagram units (data-x / data-y): for dragging. */
  at?: { x: number; y: number };
  /** Animation identity (data-flip), and where it is (see render/animate.ts). */
  flip?: string;
  /** A value in a container's slot (data-cell), for a swap's slide. */
  cell?: { key: string; value: string; cx: number; cy: number };
  /** Don't fade in when new (data-no-fade). */
  noFade?: boolean;
  /** Its <title>: shown as a tooltip when the pointer is over it. */
  title?: string;
  /** Its classes (for the few animations that depend on them: the output card). */
  classes: string;
  /** Around everything drawn in it, in diagram units; null when it draws nothing. */
  bounds: Rect | null;
  /** A row of the loop history, with its vertical extent (data-top / data-bottom). */
  current?: { top: number; bottom: number };
  /**
   * Drawn as its own layer, so its opacity can be animated on its own: each
   * thing in the memory drawing's arrows layer (the printed-output dimming
   * fades them, see motion in canvasRenderers.ts).
   */
  layer?: boolean;
  /** Its parent group's classes ("boxes", "arrows"...): the dimming picks by them. */
  parentClasses: string;
}

export type PaintItem = PaintShape | PaintText | PaintGroup;

export interface Paint {
  width: number;
  height: number;
  root: PaintGroup;
  /** The SVG's own classes (memory-svg has-output output-in ...). */
  classes: string;
}

const num = (el: DrawingNode, name: string, fallback = 0) => {
  const v = Number.parseFloat(el.getAttribute(name) ?? "");
  return Number.isFinite(v) ? v : fallback;
};

const CAPS = new Set(["butt", "round", "square"]);
const JOINS = new Set(["miter", "round", "bevel"]);

function fillOf(style: ComputedPaint): FillPaint | null {
  const color = parseColor(style.fill);
  if (!color) return null;
  const alpha = color.alpha * style.fillOpacity;
  return alpha > 0 ? { color: color.rgb, alpha } : null;
}

function strokeOf(style: ComputedPaint): StrokePaint | null {
  const color = parseColor(style.stroke);
  if (!color || style.strokeWidth <= 0) return null;
  const alpha = color.alpha * style.strokeOpacity;
  if (alpha <= 0) return null;
  return {
    color: color.rgb,
    alpha,
    width: style.strokeWidth,
    dash: style.dash,
    dashOffset: style.dashOffset,
    cap: (CAPS.has(style.cap) ? style.cap : "butt") as StrokePaint["cap"],
    join: (JOINS.has(style.join) ? style.join : "miter") as StrokePaint["join"],
  };
}

const scaleAlpha = <T extends { alpha: number }>(paint: T | null, by: number): T | null =>
  paint && by < 1 ? { ...paint, alpha: paint.alpha * by } : paint;

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function geometryBounds(g: Geometry, stroke: StrokePaint | null): Rect | null {
  const pad = stroke ? stroke.width / 2 : 0;
  let r: Rect | null;
  if (g.type === "rect") r = { x: g.x, y: g.y, w: g.w, h: g.h };
  else if (g.type === "circle") r = { x: g.cx - g.r, y: g.cy - g.r, w: g.r * 2, h: g.r * 2 };
  else r = pathBounds(g.commands);
  return r && { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

/** Collapse white space as SVG text does (unless white-space: pre). */
function collapse(text: string, pre: boolean): string {
  return pre ? text.replace(/[\n\r\t]/g, " ") : text.replace(/\s+/g, " ");
}

const BASELINES: Record<string, PaintText["baseline"]> = {
  central: "central",
  middle: "middle",
  hanging: "hanging",
  "text-before-edge": "hanging",
};

/** The arrowheads in a drawing's <defs>, by id. */
interface Marker {
  path: PathCommand[];
  refX: number;
  refY: number;
  /** Diagram units per marker unit, before stroke-width scaling. */
  scale: number;
  /** markerUnits="strokeWidth": scaled by the line's width. */
  byStroke: boolean;
  fill: FillPaint | null;
}

function readMarkers(svg: DrawingNode, styles: Map<DrawingNode, ComputedPaint>): Map<string, Marker> {
  const markers = new Map<string, Marker>();
  for (const m of svg.querySelectorAll("marker[id]")) {
    const shape = m.querySelector("path");
    if (!shape) continue;
    const box = (m.getAttribute("viewBox") ?? "0 0 10 10").split(/[\s,]+/).map(Number);
    const vbW = box[2] || 10;
    const style = styles.get(shape);
    markers.set(m.id, {
      path: parsePath(shape.getAttribute("d") ?? ""),
      refX: num(m, "refX"),
      refY: num(m, "refY"),
      scale: num(m, "markerWidth", 3) / vbW,
      byStroke: m.getAttribute("markerUnits") !== "userSpaceOnUse",
      fill: style ? fillOf(style) : null,
    });
  }
  return markers;
}

/** An arrowhead at the end of a path, as its own filled shape. */
function arrowhead(marker: Marker, commands: PathCommand[], strokeWidth: number, alpha: number): PaintShape | null {
  const end = endDirection(commands);
  if (!end || !marker.fill) return null;
  const k = marker.scale * (marker.byStroke ? strokeWidth : 1);
  const cos = Math.cos(end.angle);
  const sin = Math.sin(end.angle);
  // Marker space: (refX, refY) lands on the end point, x along the path.
  const place = (x: number, y: number) => {
    const mx = (x - marker.refX) * k;
    const my = (y - marker.refY) * k;
    return { x: end.x + mx * cos - my * sin, y: end.y + mx * sin + my * cos };
  };
  const out: PathCommand[] = marker.path.map((c) => {
    switch (c.op) {
      case "M":
      case "L":
        return { op: c.op, ...place(c.x, c.y) };
      case "Q": {
        const cp = place(c.cx, c.cy);
        return { op: "Q", cx: cp.x, cy: cp.y, ...place(c.x, c.y) };
      }
      case "C": {
        const a = place(c.c1x, c.c1y);
        const b = place(c.c2x, c.c2y);
        return { op: "C", c1x: a.x, c1y: a.y, c2x: b.x, c2y: b.y, ...place(c.x, c.y) };
      }
      default:
        return c;
    }
  });
  return {
    kind: "shape",
    geometry: { type: "path", commands: out },
    fill: scaleAlpha(marker.fill, alpha),
    stroke: null,
    flash: false,
  };
}

/** The flash plays on a changed cell's box (`.cell.is-changed rect`) when --flash is on. */
const flashes = (el: DrawingNode) => {
  if (el.localName !== "rect") return false;
  const classes = el.parentElement?.getAttribute("class") ?? "";
  return hasClass(classes, "cell") && hasClass(classes, "is-changed");
};

/** Does a class attribute have this class? (Without making a classList for every element.) */
function hasClass(classes: string, name: string): boolean {
  return ` ${classes} `.includes(` ${name} `);
}

/** Turn an SVG drawing into a paint list. */
/** Turn a drawing (drawing.ts: marks, or SVG elements) into a paint list. */
export function paintDrawing(svg: DrawingNode, source: StyleSource): Paint {
  const styles = source.read(svg);
  const markers = readMarkers(svg, styles);
  const flashOn = (source.variable("--flash") || "none") !== "none";

  /**
   * An invisible shape that still catches the pointer (a transparent fill:
   * SVG hit-tests any fill but "none"), set by shape() when it draws
   * nothing. Each box starts with one covering all of it (memory.ts's
   * node-hit), so a press on its label grabs the box, as in SVG.
   */
  let invisible: Rect | null = null;

  const shape = (el: DrawingNode, style: ComputedPaint, alpha: number): PaintShape | null => {
    invisible = null;
    let geometry: Geometry;
    switch (el.localName) {
      case "rect": {
        const w = num(el, "width");
        const h = num(el, "height");
        if (w <= 0 || h <= 0) return null;
        const r = Math.min(style.rx ?? num(el, "rx", num(el, "ry")), w / 2, h / 2);
        geometry = { type: "rect", x: num(el, "x"), y: num(el, "y"), w, h, r: Math.max(0, r) };
        break;
      }
      case "circle": {
        const r = num(el, "r");
        if (r <= 0) return null;
        geometry = { type: "circle", cx: num(el, "cx"), cy: num(el, "cy"), r };
        break;
      }
      case "line":
        geometry = {
          type: "path",
          commands: [
            { op: "M", x: num(el, "x1"), y: num(el, "y1") },
            { op: "L", x: num(el, "x2"), y: num(el, "y2") },
          ],
        };
        break;
      case "path": {
        const commands = parsePath(el.getAttribute("d") ?? "");
        if (!commands.length) return null;
        geometry = { type: "path", commands };
        break;
      }
      default:
        return null;
    }
    // Lines are never filled, whatever the fill says.
    const fill = el.localName === "line" ? null : scaleAlpha(fillOf(style), alpha);
    const stroke = scaleAlpha(strokeOf(style), alpha);
    if (!fill && !stroke) {
      const catches =
        (el.localName !== "line" && style.fill !== "none") || (style.stroke !== "none" && style.strokeWidth > 0);
      if (catches) invisible = geometryBounds(geometry, null);
      return null;
    }
    return { kind: "shape", geometry, fill, stroke, flash: flashOn && flashes(el) && !!fill };
  };

  const text = (el: DrawingNode, style: ComputedPaint, alpha: number): PaintText | null => {
    const runs: TextRun[] = [];
    const pre = style.whiteSpace.startsWith("pre");
    const runOf = (value: string, s: ComputedPaint, dx: number): TextRun => ({
      text: collapse(value, pre),
      dx,
      font: {
        family: s.fontFamily,
        size: s.fontSize,
        weight: s.fontWeight,
        style: s.fontStyle,
        letterSpacing: s.letterSpacing,
      },
      fill: scaleAlpha(fillOf(s), alpha),
      stroke: s.paintOrder.startsWith("stroke") ? scaleAlpha(strokeOf(s), alpha) : null,
    });
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        if (child.textContent) runs.push(runOf(child.textContent, style, 0));
      } else if (child.nodeType === 1 && (child as unknown as DrawingNode).localName === "tspan") {
        const span = child as unknown as DrawingNode;
        const s = styles.get(span) ?? style;
        if (!s.hidden && child.textContent) runs.push(runOf(child.textContent, s, num(span, "dx")));
      }
    }
    if (!pre && runs.length) {
      runs[0].text = runs[0].text.trimStart();
      runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
    }
    const visible = runs.filter((r) => r.text && (r.fill || r.stroke));
    if (!visible.length) return null;
    const anchor = style.textAnchor === "middle" || style.textAnchor === "end" ? style.textAnchor : "start";
    return {
      kind: "text",
      x: num(el, "x"),
      y: num(el, "y"),
      anchor,
      baseline: BASELINES[style.baseline] ?? "alphabetic",
      runs: visible,
      alpha: 1,
    };
  };

  const group = (el: DrawingNode, inherited: number, parentClasses: string, layer = false): PaintGroup => {
    const style = styles.get(el);
    // A group with data-flip / data-cell / a node key is drawn as its own
    // layer, so its opacity is its own; others pass theirs down.
    const own = style?.opacity ?? 1;
    // Read data-* with getAttribute: dataset makes an object for every element.
    const nodeKey = el.getAttribute("data-node-key");
    const flip = el.getAttribute("data-flip");
    const cell = el.getAttribute("data-cell");
    const keyed = layer || flip !== null || cell !== null || nodeKey !== null;
    const passDown = keyed ? 1 : inherited * own;
    const classes = el.getAttribute("class") ?? "";
    const out: PaintGroup = {
      kind: "group",
      alpha: keyed ? inherited * own : 1,
      children: [],
      classes,
      parentClasses,
      bounds: null,
    };
    if (layer) out.layer = true;
    // Everything in the memory drawing's arrows layer can be faded on its own.
    const layered = hasClass(classes, "arrows");
    if (nodeKey) out.nodeKey = nodeKey;
    if (flip) out.flip = flip;
    if (nodeKey || flip) out.at = { x: num(el, "data-x"), y: num(el, "data-y") };
    if (cell)
      out.cell = {
        key: cell,
        value: el.getAttribute("data-value") ?? "",
        cx: num(el, "data-cx"),
        cy: num(el, "data-cy"),
      };
    if (el.hasAttribute("data-no-fade")) out.noFade = true;
    if (el.hasAttribute("data-top")) out.current = { top: num(el, "data-top"), bottom: num(el, "data-bottom") };

    for (const child of el.children) {
      const s = styles.get(child);
      if (child.localName === "title") {
        out.title = child.textContent ?? "";
        continue;
      }
      if (!s || s.hidden || child.localName === "defs") continue;
      if (child.localName === "g") {
        const g = group(child, passDown, classes, layered);
        if (g.children.length) {
          out.children.push(g);
          out.bounds = union(out.bounds, g.bounds);
        }
        continue;
      }
      // Shapes and text: their own opacity, times their groups'. In a
      // layered group, each gets a layer of its own that carries its opacity.
      const alpha = layered ? passDown : passDown * s.opacity;
      if (alpha <= 0 || (layered && s.opacity <= 0)) continue;
      const into: PaintGroup = layered
        ? {
            kind: "group",
            alpha: s.opacity,
            children: [],
            classes: child.getAttribute("class") ?? "",
            parentClasses: classes,
            bounds: null,
            layer: true,
          }
        : out;
      if (child.localName === "text") {
        const t = text(child, s, alpha);
        if (t) into.children.push(t);
      } else {
        const sh = shape(child, s, alpha);
        if (!sh) {
          // Nothing to draw, but it may still be part of what the pointer grabs.
          if (invisible) out.bounds = union(out.bounds, invisible);
          continue;
        }
        into.children.push(sh);
        into.bounds = union(into.bounds, geometryBounds(sh.geometry, sh.stroke));
        const end = child.getAttribute("marker-end");
        const id = end && /url\(#([^)]+)\)/.exec(end)?.[1];
        const marker = id ? markers.get(id) : undefined;
        if (marker && sh.geometry.type === "path") {
          const head = arrowhead(marker, sh.geometry.commands, s.strokeWidth, alpha);
          if (head) into.children.push(head);
        }
      }
      if (into !== out && into.children.length) {
        out.children.push(into);
        out.bounds = union(out.bounds, into.bounds);
      }
    }
    return out;
  };

  const root = group(svg, 1, "");
  return {
    width: num(svg, "width"),
    height: num(svg, "height"),
    root,
    classes: svg.getAttribute("class") ?? "",
  };
}

/** Every group in a paint list, depth first, in drawing order. */
export function* groups(root: PaintGroup): Generator<PaintGroup> {
  yield root;
  for (const child of root.children) if (child.kind === "group") yield* groups(child);
}

export type { Rgba };
