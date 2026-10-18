/**
 * A paint list (paint.ts) as PixiJS objects, ready to draw on a 2D canvas.
 *
 * Shapes in a row share one Graphics (fewer objects to draw); text is Text,
 * whose textures PixiJS shares between equal strings in equal styles, so a
 * loop history full of the same small numbers stays cheap. Every group the
 * animation can move (data-flip, data-cell) or the person can drag
 * (data-node-key) gets its own Container; other groups are flattened into
 * their parent.
 */
import { CanvasTextMetrics, Container, fontStringFromTextStyle, Graphics, Text, TextStyle } from "pixi.js";
import type { FillPaint, Geometry, Paint, PaintGroup, PaintShape, PaintText, StrokePaint, TextRun } from "./paint";
import { dash, flatten, type PathCommand } from "./path";

export interface BuiltScene {
  root: Container;
  /** Each keyed group's container. */
  layers: Map<PaintGroup, Container>;
  /** The flash drawn over each changed cell, to fade out (see motion.ts). */
  flashes: Container[];
}

export interface BuildOptions {
  /** Text is rasterized at this many pixels per diagram unit. */
  resolution: number;
  /** Draw the changed-cell flash overlays. */
  flash: boolean;
}

/** Corners at least this round are traced as arcs (see traceGeometry). */
const ROUND_EXACTLY = 6;

/** A rounded rectangle as path commands (for dashing its outline, or exact round corners). */
function rectPath(x: number, y: number, w: number, h: number, r: number): PathCommand[] {
  if (r <= 0) {
    return [
      { op: "M", x, y },
      { op: "L", x: x + w, y },
      { op: "L", x: x + w, y: y + h },
      { op: "L", x, y: y + h },
      { op: "Z" },
    ];
  }
  const k = r * 0.5523; // control-point distance for a quarter circle
  return [
    { op: "M", x: x + r, y },
    { op: "L", x: x + w - r, y },
    { op: "C", c1x: x + w - r + k, c1y: y, c2x: x + w, c2y: y + r - k, x: x + w, y: y + r },
    { op: "L", x: x + w, y: y + h - r },
    { op: "C", c1x: x + w, c1y: y + h - r + k, c2x: x + w - r + k, c2y: y + h, x: x + w - r, y: y + h },
    { op: "L", x: x + r, y: y + h },
    { op: "C", c1x: x + r - k, c1y: y + h, c2x: x, c2y: y + h - r + k, x, y: y + h - r },
    { op: "L", x, y: y + r },
    { op: "C", c1x: x, c1y: y + r - k, c2x: x + r - k, c2y: y, x: x + r, y },
    { op: "Z" },
  ];
}

function tracePath(g: Graphics, commands: PathCommand[]): void {
  for (const c of commands) {
    switch (c.op) {
      case "M":
        g.moveTo(c.x, c.y);
        break;
      case "L":
        g.lineTo(c.x, c.y);
        break;
      case "Q":
        g.quadraticCurveTo(c.cx, c.cy, c.x, c.y);
        break;
      case "C":
        g.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, c.x, c.y);
        break;
      case "Z":
        g.closePath();
        break;
    }
  }
}

function traceGeometry(g: Graphics, geometry: Geometry): void {
  if (geometry.type === "rect") {
    const { x, y, w, h, r } = geometry;
    // PixiJS rounds corners with quadratic curves, which looks right for a
    // small radius but squarish for a big one (a pill): trace those as
    // circular arcs, like SVG.
    if (r >= ROUND_EXACTLY) tracePath(g, rectPath(x, y, w, h, r));
    else if (r > 0) g.roundRect(x, y, w, h, r);
    else g.rect(x, y, w, h);
  } else if (geometry.type === "circle") g.circle(geometry.cx, geometry.cy, geometry.r);
  else tracePath(g, geometry.commands);
}

const strokeStyle = (s: StrokePaint, width = s.width) => ({
  width,
  color: s.color,
  alpha: s.alpha,
  cap: s.cap,
  join: s.join,
  alignment: 0.5,
});

/** A dashed outline: the dashes as their own lines, stroked solid. */
function dashedStroke(g: Graphics, geometry: Geometry, stroke: StrokePaint): void {
  const commands =
    geometry.type === "rect"
      ? rectPath(geometry.x, geometry.y, geometry.w, geometry.h, geometry.r)
      : geometry.type === "circle"
        ? rectPath(geometry.cx - geometry.r, geometry.cy - geometry.r, geometry.r * 2, geometry.r * 2, geometry.r)
        : geometry.commands;
  const pieces = dash(flatten(commands, 2), stroke.dash, stroke.dashOffset);
  if (!pieces.length) return;
  for (const piece of pieces) {
    g.moveTo(piece[0].x, piece[0].y);
    for (let i = 1; i < piece.length; i++) g.lineTo(piece[i].x, piece[i].y);
  }
  g.stroke(strokeStyle(stroke));
}

function drawShape(g: Graphics, shape: PaintShape): void {
  const { geometry, fill, stroke } = shape;
  const solid = stroke && !stroke.dash.length;
  // fill() then stroke() straight after it share one path. (A dashed
  // outline is its own path of dashes, drawn after the fill.)
  if (fill || solid) traceGeometry(g, geometry);
  if (fill) g.fill({ color: fill.color, alpha: fill.alpha });
  if (solid) g.stroke(strokeStyle(stroke));
  else if (stroke) dashedStroke(g, geometry, stroke);
}

/**
 * The flash over a changed cell: at its start the box is 55% lighter, and
 * its border twice as thick (styles.css, @keyframes mark). It fades away.
 */
function flashOverlay(shape: PaintShape): Graphics {
  const g = new Graphics();
  traceGeometry(g, shape.geometry);
  g.fill({ color: 0xffffff, alpha: 0.55 });
  if (shape.stroke) {
    traceGeometry(g, shape.geometry);
    g.stroke(strokeStyle(shape.stroke, shape.stroke.width * 2));
  }
  return g;
}

// ------------------------------------------------------------------ text

const styles = new Map<string, TextStyle>();

function textStyle(run: TextRun): TextStyle {
  const fill: FillPaint = run.fill ?? { color: 0, alpha: 0 };
  const key = [
    run.font.family,
    run.font.size,
    run.font.weight,
    run.font.style,
    run.font.letterSpacing,
    fill.color,
    fill.alpha,
    run.stroke ? `${run.stroke.color}/${run.stroke.alpha}/${run.stroke.width}/${run.stroke.join}` : "",
  ].join("|");
  let style = styles.get(key);
  if (!style) {
    style = new TextStyle({
      fontFamily: run.font.family,
      fontSize: run.font.size,
      fontWeight: run.font.weight as TextStyle["fontWeight"],
      fontStyle: run.font.style as TextStyle["fontStyle"],
      letterSpacing: run.font.letterSpacing,
      fill: { color: fill.color, alpha: fill.alpha },
      stroke: run.stroke
        ? { color: run.stroke.color, alpha: run.stroke.alpha, width: run.stroke.width, join: run.stroke.join }
        : undefined,
    });
    styles.set(key, style);
  }
  return style;
}

/** Forget measured fonts (a web font finished loading, so sizes changed). */
export function forgetFonts(): void {
  CanvasTextMetrics.clearMetrics();
  styles.clear();
  emBoxes.clear();
}

const emBoxes = new Map<string, { ascent: number; descent: number }>();
let measurer: CanvasRenderingContext2D | null | undefined;

/** The font's em box above and below the baseline, as SVG's dominant-baseline uses it. */
function emBox(font: string, size: number): { ascent: number; descent: number } {
  let box = emBoxes.get(font);
  if (!box) {
    if (measurer === undefined) measurer = document.createElement("canvas").getContext("2d");
    box = { ascent: size * 0.8, descent: size * 0.2 };
    if (measurer) {
      measurer.font = font;
      const m = measurer.measureText("M");
      if (m.fontBoundingBoxAscent !== undefined && m.fontBoundingBoxAscent + m.fontBoundingBoxDescent > 0) {
        box = { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
      }
    }
    emBoxes.set(font, box);
  }
  return box;
}

const fontString = (style: TextStyle) => fontStringFromTextStyle(style);

function drawText(container: Container, t: PaintText, resolution: number): void {
  // Lay the runs out left to right, then place them by the anchor.
  const pieces = t.runs.map((run) => {
    const style = textStyle(run);
    // Snapped to whole pixels: a text texture drawn between pixels is blurred.
    const text = new Text({ text: run.text, style, resolution, roundPixels: true });
    const font = fontString(style);
    const halfStroke = run.stroke ? run.stroke.width / 2 : 0;
    const advance = CanvasTextMetrics.measureText(run.text, style).width - halfStroke * 2;
    return { text, run, font, halfStroke, advance, pixiAscent: CanvasTextMetrics.measureFont(font).ascent };
  });
  const total = pieces.reduce((sum, p) => sum + p.run.dx + p.advance, 0);
  let x = t.anchor === "middle" ? t.x - total / 2 : t.anchor === "end" ? t.x - total : t.x;
  for (const p of pieces) {
    x += p.run.dx;
    const { ascent, descent } = emBox(p.font, p.run.font.size);
    // Where the alphabetic baseline sits, from SVG's dominant-baseline.
    const baseline =
      t.baseline === "central"
        ? t.y + (ascent - descent) / 2
        : t.baseline === "middle"
          ? t.y + p.run.font.size * 0.25
          : t.baseline === "hanging"
            ? t.y + ascent * 0.8
            : t.y;
    p.text.x = x - p.halfStroke;
    p.text.y = baseline - p.pixiAscent - p.halfStroke;
    if (t.alpha < 1) p.text.alpha = t.alpha;
    container.addChild(p.text);
    x += p.advance;
  }
}

// ------------------------------------------------------------------ scene

const keyed = (g: PaintGroup) => !!(g.flip || g.cell || g.nodeKey || g.layer || g.current);

/** Build a paint list as PixiJS objects. */
export function buildScene(paint: Paint, options: BuildOptions): BuiltScene {
  const layers = new Map<PaintGroup, Container>();
  const flashes: Container[] = [];
  const root = new Container();

  const add = (group: PaintGroup, into: Container) => {
    let shapes: Graphics | null = null;
    for (const item of group.children) {
      if (item.kind === "shape") {
        if (!shapes) {
          shapes = new Graphics();
          into.addChild(shapes);
        }
        drawShape(shapes, item);
        if (item.flash && options.flash) {
          const overlay = flashOverlay(item);
          into.addChild(overlay);
          flashes.push(overlay);
          shapes = null; // later shapes go above the flash
        }
      } else if (item.kind === "text") {
        drawText(into, item, options.resolution);
        shapes = null;
      } else if (keyed(item)) {
        const layer = new Container();
        if (item.alpha < 1) layer.alpha = item.alpha;
        layers.set(item, layer);
        into.addChild(layer);
        add(item, layer);
        shapes = null;
      } else {
        // Shapes after a plain group must still draw above it: start a new Graphics.
        add(item, into);
        shapes = null;
      }
    }
  };
  add(paint.root, root);
  // Each Text listens to its style for changes. These styles are shared and
  // never change, and with thousands of texts on one style, unsubscribing
  // them one by one when the scene is replaced costs more than drawing it
  // (it's a search through every listener, each time). Drop the listeners.
  for (const style of styles.values()) style.removeAllListeners("update");
  return { root, layers, flashes };
}
