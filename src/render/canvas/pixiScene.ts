/**
 * A paint list (paint.ts) as PixiJS objects, ready to draw on a 2D canvas.
 *
 * Shapes in a row share one Graphics (fewer objects to draw); text is Text,
 * whose textures PixiJS shares between equal strings in equal styles, so a
 * loop history full of the same small numbers stays cheap. Every group the
 * animation can move (data-flip, data-cell) or the person can drag
 * (data-node-key) gets its own Container; other groups are flattened into
 * their parent. Those containers are kept from one build to the next when
 * what they draw hasn't changed (SceneCache, below).
 */
import { CanvasTextMetrics, Container, fontStringFromTextStyle, Graphics, Text, TextStyle } from "pixi.js";
import type {
  FillPaint,
  Geometry,
  Paint,
  PaintGroup,
  PaintItem,
  PaintShape,
  PaintText,
  StrokePaint,
  TextRun,
} from "./paint";
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

/*
 * Keeping objects between steps. Most of a drawing is the same from one
 * step to the next: the boxes that didn't change, the loop rows already
 * drawn. Building their Graphics and Text again, and throwing the old ones
 * away, is most of what a step costs. So each keyed group (a box, a row, a
 * cell, an arrow) is drawn into a body container, remembered by a
 * signature of what it draws, measured from its own top-left corner. When
 * the next drawing has a group with the same signature, its body is moved
 * over, shifted to where the group is now: same picture, nothing rebuilt.
 *
 *   layer (fresh each build: the animation moves and fades it)
 *     body (kept: the Graphics and Text, offset by where it was built)
 *
 * A changed cell's flash overlay is kept with its body too, and starts
 * again from the top when the body is used again.
 */

/** A keyed group's body, kept for the next build. */
interface Entry {
  sig: string;
  body: Container;
  /** The group's layer (where its body is now). */
  layer: Container;
  /** The group's top-left corner when its body was built, in the body's own units. */
  built: { x: number; y: number };
  /** The keyed groups inside it, in drawing order. */
  nested: Entry[];
  /** Its own flash overlays (not its keyed groups'). */
  overlays: Container[];
}

/** What one build keeps for the next. Pass the same cache to every build of a window. */
export class SceneCache {
  entries = new Map<string, Entry[]>();
  resolution = 0;
  /**
   * Signatures of groups whose paint was kept (paint.ts PaintCache): the
   * same children, so the same signature, without working it out again.
   * One for builds with the flash, one without.
   */
  readonly sigs = [new WeakMap<PaintItem[], string>(), new WeakMap<PaintItem[], string>()];

  /** Forget everything (the objects were destroyed, or fonts changed). */
  clear(): void {
    this.entries.clear();
  }
}

/** Rounded for signatures: closer than this draws the same. */
const q = (v: number) => Math.round(v * 100) / 100;

const fillSig = (f: FillPaint | null) => (f ? `${f.color}/${f.alpha}` : "-");
const strokeSig = (s: StrokePaint | null) =>
  s ? `${s.color}/${s.alpha}/${s.width}/${s.dash.join(",")}/${s.dashOffset}/${s.cap}/${s.join}` : "-";

function geometrySig(g: Geometry, ox: number, oy: number): string {
  if (g.type === "rect") return `R${q(g.x - ox)},${q(g.y - oy)},${q(g.w)},${q(g.h)},${q(g.r)}`;
  if (g.type === "circle") return `C${q(g.cx - ox)},${q(g.cy - oy)},${q(g.r)}`;
  let out = "P";
  for (const c of g.commands) {
    switch (c.op) {
      case "M":
      case "L":
        out += `${c.op}${q(c.x - ox)},${q(c.y - oy)}`;
        break;
      case "Q":
        out += `Q${q(c.cx - ox)},${q(c.cy - oy)},${q(c.x - ox)},${q(c.y - oy)}`;
        break;
      case "C":
        out += `C${q(c.c1x - ox)},${q(c.c1y - oy)},${q(c.c2x - ox)},${q(c.c2y - oy)},${q(c.x - ox)},${q(c.y - oy)}`;
        break;
      case "Z":
        out += "Z";
        break;
    }
  }
  return out;
}

function textSig(t: PaintText, ox: number, oy: number): string {
  let out = `T${q(t.x - ox)},${q(t.y - oy)},${t.anchor},${t.baseline},${t.alpha}`;
  for (const r of t.runs) {
    const f = r.font;
    out += `[${r.text.length}:${r.text}|${r.dx}|${f.family}|${f.size}|${f.weight}|${f.style}|${f.letterSpacing}|${fillSig(r.fill)}|${strokeSig(r.stroke)}]`;
  }
  return out;
}

/** Where a keyed group is measured from. */
const originOf = (g: PaintGroup) => ({ x: g.bounds?.x ?? 0, y: g.bounds?.y ?? 0 });

/** The keyed groups directly in a group (looking through the plain groups it flattens). */
function keyedChildren(group: PaintGroup, out: PaintGroup[] = []): PaintGroup[] {
  for (const item of group.children) {
    if (item.kind !== "group") continue;
    if (keyed(item)) out.push(item);
    else keyedChildren(item, out);
  }
  return out;
}

/** Build a paint list as PixiJS objects, reusing what `cache` kept from the last build. */
export function buildScene(paint: Paint, options: BuildOptions, cache: SceneCache = new SceneCache()): BuiltScene {
  const layers = new Map<PaintGroup, Container>();
  const flashes: Container[] = [];
  const root = new Container();
  // Text is drawn at a resolution: kept text at another one won't do.
  if (cache.resolution !== options.resolution) cache.clear();
  cache.resolution = options.resolution;
  const old = cache.entries;
  const kept = new Map<string, Entry[]>();
  /** Bodies taken from the last build, and everything they were in (which can't be taken now). */
  const taken = new Set<Container>();

  // Signatures, memoized: a group's includes its keyed children's.
  const sigs = new Map<PaintGroup, string>();
  const known = cache.sigs[options.flash ? 1 : 0];
  const sigOf = (group: PaintGroup): string => {
    let sig = sigs.get(group) ?? known.get(group.children);
    if (sig !== undefined) return sig;
    const { x, y } = originOf(group);
    sig = itemsSig(group, x, y);
    sigs.set(group, sig);
    known.set(group.children, sig);
    return sig;
  };
  const itemsSig = (group: PaintGroup, ox: number, oy: number): string => {
    let out = "";
    for (const item of group.children) {
      if (item.kind === "shape") {
        const flash = item.flash && options.flash ? "!" : "";
        out += `${geometrySig(item.geometry, ox, oy)}${fillSig(item.fill)}${strokeSig(item.stroke)}${flash};`;
      } else if (item.kind === "text") out += `${textSig(item, ox, oy)};`;
      else if (keyed(item)) {
        const at = originOf(item);
        out += `<${q(at.x - ox)},${q(at.y - oy)}:${sigOf(item)}>`;
      } else out += `{${itemsSig(item, ox, oy)}}`;
    }
    return out;
  };

  const keep = (entry: Entry) => {
    const list = kept.get(entry.sig);
    if (list) list.push(entry);
    else kept.set(entry.sig, [entry]);
  };
  const markTaken = (entry: Entry) => {
    taken.add(entry.body);
    for (const inner of entry.nested) markTaken(inner);
  };
  const take = (sig: string): Entry | null => {
    const list = old.get(sig);
    while (list?.length) {
      const entry = list.pop()!;
      if (taken.has(entry.body)) continue;
      // What it was in can't be kept whole now: one of its parts is gone.
      for (let at = entry.body.parent; at; at = at.parent) taken.add(at);
      markTaken(entry);
      return entry;
    }
    return null;
  };
  /** A kept body is drawn for `group`: its keyed groups' layers are the ones inside it. */
  const adopt = (group: PaintGroup, entry: Entry) => {
    keep(entry);
    for (const overlay of entry.overlays) {
      overlay.alpha = 1;
      flashes.push(overlay);
    }
    keyedChildren(group).forEach((inner, i) => {
      const e = entry.nested[i];
      const layer = e.layer;
      layer.position.set(0, 0);
      layer.alpha = inner.alpha;
      layer.visible = true;
      layers.set(inner, layer);
      adopt(inner, e);
    });
  };

  const add = (group: PaintGroup, into: Container, entry: Pick<Entry, "nested" | "overlays">) => {
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
          entry.overlays.push(overlay);
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
        entry.nested.push(place(item, layer));
        shapes = null;
      } else {
        // Shapes after a plain group must still draw above it: start a new Graphics.
        add(item, into, entry);
        shapes = null;
      }
    }
  };
  /** A keyed group's body in its layer: kept from the last build if it draws the same, or built. */
  const place = (group: PaintGroup, layer: Container): Entry => {
    const sig = sigOf(group);
    const at = originOf(group);
    const reused = take(sig);
    if (reused) {
      layer.addChild(reused.body);
      reused.body.position.set(at.x - reused.built.x, at.y - reused.built.y);
      reused.layer = layer;
      adopt(group, reused);
      return reused;
    }
    const body = new Container();
    layer.addChild(body);
    const entry: Entry = { sig, body, layer, built: at, nested: [], overlays: [] };
    add(group, body, entry);
    keep(entry);
    return entry;
  };

  add(paint.root, root, { nested: [], overlays: [] });
  cache.entries = kept;
  // Each Text listens to its style for changes. These styles are shared and
  // never change, and with thousands of texts on one style, unsubscribing
  // them one by one when the scene is replaced costs more than drawing it
  // (it's a search through every listener, each time). Drop the listeners.
  for (const style of styles.values()) style.removeAllListeners("update");
  return { root, layers, flashes };
}
