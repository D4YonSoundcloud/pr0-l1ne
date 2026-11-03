/**
 * A paint list (paint.ts) as PixiJS objects, ready to draw on a 2D canvas.
 *
 * Shapes in a row are one Graphics (fewer objects to draw), and runs that
 * draw the same, measured from their own corner, share one GraphicsContext
 * (the geometry is built, and on WebGL tessellated, once: a grid's
 * thousands of cells are a few contexts; see SceneCache.contexts). Text is Text,
 * whose textures PixiJS shares between equal strings in equal styles, so a
 * loop history full of the same small numbers stays cheap. Every group the
 * animation can move (data-flip, data-cell) or the person can drag
 * (data-node-key) gets its own Container; other groups are flattened into
 * their parent. Those containers are kept from one build to the next when
 * what they draw hasn't changed (SceneCache, below).
 */
import {
  CanvasTextMetrics,
  Container,
  fontStringFromTextStyle,
  Graphics,
  GraphicsContext,
  Text,
  TextStyle,
} from "pixi.js";
import { perf } from "../../perf";
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
  /** Cells drawn as one (BuildOptions.cells), kept bodies' too: synced with their layers before each frame. */
  batches: CellBatch[];
}

export interface BuildOptions {
  /** Text is rasterized at this many pixels per diagram unit. */
  resolution: number;
  /** Draw the changed-cell flash overlays. */
  flash: boolean;
  /**
   * Draw the rectangles of the cells in each box or row as one, by this
   * (cellMesh.ts: an instanced mesh, on WebGL). Without it, each is a Graphics.
   */
  cells?: (cells: CellRect[], layers: Container[]) => CellBatch & Container;
  /** At least this many cells in a row are drawn as one (BATCH_MIN unless given: tests give fewer). */
  batchMin?: number;
  /**
   * Make the body of each box and row with more than a few things in it a
   * PixiJS render group (WebGL): its draw is kept on the GPU, so moving it
   * (a box that moved, a row shifted down, a new scene it's put in) changes
   * one transform, and nothing in it is batched or uploaded again.
   */
  renderGroups?: boolean;
}

/** A cell's rectangle, drawn with many others (BuildOptions.cells): where it is in its body, and its paint. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  fill: FillPaint | null;
  stroke: StrokePaint | null;
}

/**
 * Many cells drawn as one (BuildOptions.cells). Each cell keeps its own
 * layer (for its text, and for the step animation to slide and fade);
 * `sync` puts where each layer is now, and how faded, into its cell.
 */
export interface CellBatch {
  sync(): void;
}

/**
 * A body with at least this many things drawn in it is a render group
 * (BuildOptions.renderGroups): each is a draw call of its own, which costs
 * more than it saves on smaller ones (a call stack of small frames was
 * slower with them).
 */
export const RENDER_GROUP_MIN = 200;

/**
 * At least this many cells in a row are drawn as one (BuildOptions.cells).
 * Fewer stay Graphics, batched with the shapes around them: a mesh is a
 * draw call of its own, and a few cells' worth isn't worth one.
 */
export const BATCH_MIN = 32;

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

/** What drawShape draws into: a Graphics, or a context Graphics share. */
type Drawable = Graphics | GraphicsContext;

function tracePath(g: Drawable, commands: PathCommand[]): void {
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

function traceGeometry(g: Drawable, geometry: Geometry): void {
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
function dashedStroke(g: Drawable, geometry: Geometry, stroke: StrokePaint): void {
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

function drawShape(g: Drawable, shape: PaintShape): void {
  const { geometry, fill, stroke } = shape;
  const solid = stroke && !stroke.dash.length;
  // fill() then stroke() straight after it share one path. (A dashed
  // outline is its own path of dashes, drawn after the fill.)
  if (fill || solid) traceGeometry(g, geometry);
  if (fill) g.fill({ color: fill.color, alpha: fill.alpha });
  if (solid) g.stroke(strokeStyle(stroke));
  else if (stroke) dashedStroke(g, geometry, stroke);
}

/** A geometry moved by (-dx, -dy): drawn from its run's corner, to share its context. */
function shifted(g: Geometry, dx: number, dy: number): Geometry {
  if (g.type === "rect") return { ...g, x: g.x - dx, y: g.y - dy };
  if (g.type === "circle") return { ...g, cx: g.cx - dx, cy: g.cy - dy };
  return {
    type: "path",
    commands: g.commands.map((c): PathCommand => {
      switch (c.op) {
        case "M":
        case "L":
          return { ...c, x: c.x - dx, y: c.y - dy };
        case "Q":
          return { ...c, cx: c.cx - dx, cy: c.cy - dy, x: c.x - dx, y: c.y - dy };
        case "C":
          return { ...c, c1x: c.c1x - dx, c1y: c.c1y - dy, c2x: c.c2x - dx, c2y: c.c2y - dy, x: c.x - dx, y: c.y - dy };
        default:
          return c;
      }
    }),
  };
}

/** A geometry's top-left corner (of its points: enough to measure a run from). */
function cornerOf(g: Geometry): { x: number; y: number } {
  if (g.type === "rect") return { x: g.x, y: g.y };
  if (g.type === "circle") return { x: g.cx - g.r, y: g.cy - g.r };
  let x = Number.POSITIVE_INFINITY;
  let y = Number.POSITIVE_INFINITY;
  for (const c of g.commands) {
    if (c.op === "Z") continue;
    x = Math.min(x, c.x);
    y = Math.min(y, c.y);
  }
  return Number.isFinite(x) ? { x, y } : { x: 0, y: 0 };
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

/**
 * Text measured once. PixiJS measures every Text it makes, for its bounds
 * and again when it draws its texture, and drawText measures each run to
 * place it, all through CanvasTextMetrics.measureText, which keeps the
 * last 1,000 strings. A big drawing has many more, so by the time PixiJS
 * draws a texture its measurement is long gone and it's measured again.
 * This one table, keyed as PixiJS keys it (the text, its style, wrapping),
 * stands in for PixiJS's own, so each string in each style is measured
 * once, until the fonts change (forgetFonts). It starts again past
 * MAX_MEASURED strings, to bound the memory it holds.
 */
export class TextMeasures<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  has(key: string): boolean {
    return this.map.has(key);
  }
  get(key: string): V | undefined {
    return this.map.get(key);
  }
  set(key: string, value: V): this {
    if (this.map.size >= this.max && !this.map.has(key)) this.map.clear();
    this.map.set(key, value);
    return this;
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}
const MAX_MEASURED = 50_000;
export const textMeasures = new TextMeasures<unknown>(MAX_MEASURED);
/** PixiJS's own table (CanvasTextMetrics._measurementCache, a private static), replaced: canvas/pixiText.test.ts checks it's still there. */
const metrics = CanvasTextMetrics as unknown as { _measurementCache?: unknown };
if ("_measurementCache" in metrics) metrics._measurementCache = textMeasures;

/** Forget measured fonts (a web font finished loading, so sizes changed). */
export function forgetFonts(): void {
  CanvasTextMetrics.clearMetrics();
  // PixiJS forgets the fonts, not the strings measured in them.
  textMeasures.clear();
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

function drawText(container: Container, t: PaintText, resolution: number, ox = 0, oy = 0): void {
  // Lay the runs out left to right, then place them by the anchor.
  const pieces = t.runs.map((run) => {
    const style = textStyle(run);
    const font = fontString(style);
    // Snapped to whole pixels: a text texture drawn between pixels is blurred.
    const text = new Text({ text: run.text, style, resolution, roundPixels: true });
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
    p.text.x = ox + x - p.halfStroke;
    p.text.y = oy + baseline - p.pixiAscent - p.halfStroke;
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
  /** The shared contexts its own Graphics draw (not its keyed groups'): SceneCache.contexts. */
  contexts: string[];
  /** Its own cell batches (not its keyed groups'): BuildOptions.cells. */
  batches: CellBatch[];
}

/**
 * A context many Graphics draw: drawn once, before any Graphics draws it,
 * and never changed after. Each Graphics listens to its context for changes
 * ("update") and for its GPU data being let go ("unload"); with hundreds of
 * Graphics on one context, letting each go searches all the others'
 * listeners (quadratic: tens of ms for a big grid's scene). Neither can
 * happen here (nothing changes it; PixiJS doesn't collect it, and it's
 * destroyed only once no scene draws it), so Graphics don't listen.
 */
class SharedContext extends GraphicsContext {
  constructor() {
    super();
    this.autoGarbageCollect = false;
  }
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter's own signature
  override on(event: any, fn: any, context?: any): this {
    if ((event === "update" || event === "unload") && context instanceof Graphics) return this;
    return super.on(event, fn, context);
  }
  // biome-ignore lint/suspicious/noExplicitAny: EventEmitter's own signature
  override off(event: any, fn?: any, context?: any, once?: boolean): this {
    if ((event === "update" || event === "unload") && context instanceof Graphics) return this;
    return super.off(event, fn, context, once);
  }
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
  /**
   * Shared geometry: a GraphicsContext for each run of shapes drawn (by
   * what it draws, from its own corner). Each build notes the contexts its
   * scene draws (its new Graphics', and its kept bodies', Entry.contexts);
   * the next build destroys the rest (their GPU buffers with them).
   */
  readonly contexts = new Map<string, GraphicsContext>();
  /** The contexts the build under way draws. */
  private used = new Set<string>();

  /** Forget everything (the objects were destroyed, or fonts changed). */
  clear(): void {
    this.entries.clear();
  }

  /** A Graphics drawing a run of shapes: its context shared with every other run that draws the same. */
  graphicsFor(key: string, draw: (context: GraphicsContext) => void): Graphics {
    if (perf.noShare) {
      // Measuring what sharing saves: a Graphics with geometry of its own, as before.
      const g = new Graphics();
      draw(g.context);
      return g;
    }
    let context = this.contexts.get(key);
    if (!context) {
      context = new SharedContext();
      draw(context);
      this.contexts.set(key, context);
    }
    this.used.add(key);
    return new Graphics(context);
  }

  /**
   * A build begins: contexts the last build's scene didn't draw are
   * destroyed. Only the scene before that drew them, and it's been let go
   * of by now (a window destroys its old scene once the new one is in).
   */
  beginBuild(): void {
    for (const [key, context] of this.contexts) {
      if (this.used.has(key)) continue;
      this.contexts.delete(key);
      context.destroy();
    }
    this.used = new Set();
  }

  /** A kept body is drawn again: the contexts it draws are still used. */
  stillUsed(keys: readonly string[]): void {
    for (const key of keys) this.used.add(key);
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

/**
 * A cell drawn with the others in its body (BuildOptions.cells): a value
 * in a slot (data-cell) that's a plain rectangle, filled or outlined with a
 * solid line, and its text. Its rectangle is the shape returned.
 */
function batchedCell(group: PaintGroup): PaintShape | null {
  if (!group.cell || group.nodeKey || group.layer || group.current || group.flip) return null;
  const [first, ...rest] = group.children;
  if (first?.kind !== "shape" || first.geometry.type !== "rect") return null;
  if (!first.fill && !first.stroke) return null;
  if (first.stroke?.dash.length) return null;
  for (const item of rest) if (item.kind !== "text") return null;
  return first;
}

/** How many PixiJS objects draw in a container (to the RENDER_GROUP_MIN), not counting containers. */
function drawsAtLeast(c: Container, n: number): boolean {
  let count = 0;
  const walk = (at: Container): boolean => {
    for (const child of at.children) {
      if (child.children.length) {
        if (walk(child)) return true;
      } else if (++count >= n) return true;
    }
    return false;
  };
  return walk(c);
}

/** Build a paint list as PixiJS objects, reusing what `cache` kept from the last build. */
export function buildScene(paint: Paint, options: BuildOptions, cache: SceneCache = new SceneCache()): BuiltScene {
  const layers = new Map<PaintGroup, Container>();
  const flashes: Container[] = [];
  const batches: CellBatch[] = [];
  const root = new Container();
  // Text is drawn at a resolution: kept text at another one won't do.
  if (cache.resolution !== options.resolution) cache.clear();
  cache.resolution = options.resolution;
  const old = cache.entries;
  cache.beginBuild();
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
    // Its children are in its own units (moved by its offset): measured from its corner in those.
    sig = itemsSig(group, x - (group.offset?.x ?? 0), y - (group.offset?.y ?? 0));
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
      } else out += `{${itemsSig(item, ox - (item.offset?.x ?? 0), oy - (item.offset?.y ?? 0))}}`;
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
    cache.stillUsed(entry.contexts);
    batches.push(...entry.batches);
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

  /**
   * A run of shapes as one Graphics, at the run's corner, drawing a context
   * shared with every run that draws the same from its own corner.
   */
  const addRun = (run: PaintShape[], into: Container, contexts: string[], ox: number, oy: number) => {
    let x = Number.POSITIVE_INFINITY;
    let y = Number.POSITIVE_INFINITY;
    for (const shape of run) {
      const g = shape.geometry;
      x = Math.min(x, g.type === "rect" ? g.x : g.type === "circle" ? g.cx - g.r : cornerOf(g).x);
      y = Math.min(y, g.type === "rect" ? g.y : g.type === "circle" ? g.cy - g.r : cornerOf(g).y);
    }
    let key = "";
    for (const shape of run)
      key += `${geometrySig(shape.geometry, x, y)}${fillSig(shape.fill)}${strokeSig(shape.stroke)};`;
    const g = cache.graphicsFor(key, (context) => {
      for (const shape of run) drawShape(context, { ...shape, geometry: shifted(shape.geometry, x, y) });
    });
    contexts.push(key);
    g.position.set(ox + x, oy + y);
    into.addChild(g);
  };

  /**
   * Draw a group's children into `into`, (ox, oy) from where `into` is:
   * the offsets of the moved groups it's flattened through (PaintGroup.offset).
   */
  const add = (
    group: PaintGroup,
    into: Container,
    entry: Pick<Entry, "nested" | "overlays" | "contexts" | "batches">,
    ox = 0,
    oy = 0,
    from = 0,
  ) => {
    let run: PaintShape[] = [];
    const endRun = () => {
      if (run.length) {
        addRun(run, into, entry.contexts, ox, oy);
        // Shapes drawn here go above the cells before them: the next cells are another batch.
        pending.delete(into);
      }
      run = [];
    };
    for (let i = from; i < group.children.length; i++) {
      const item = group.children[i];
      if (item.kind === "shape") {
        run.push(item);
        if (item.flash && options.flash) {
          endRun(); // later shapes go above the flash
          const overlay = flashOverlay(item);
          overlay.position.set(ox, oy);
          into.addChild(overlay);
          flashes.push(overlay);
          entry.overlays.push(overlay);
        }
      } else if (item.kind === "text") {
        endRun();
        drawText(into, item, options.resolution, ox, oy);
      } else if (keyed(item)) {
        endRun();
        const rect = options.cells ? batchedCell(item) : null;
        if (rect) {
          // Its rectangle drawn with the other cells here, at the first one's place; its layer holds its text.
          let batch = pending.get(into);
          if (!batch) {
            const holder = new Container();
            into.addChild(holder);
            batch = { holder, cells: [], layers: [], entry };
            pending.set(into, batch);
            open.push(batch);
          }
          const g = rect.geometry as Extract<Geometry, { type: "rect" }>;
          const dx = ox + (item.offset?.x ?? 0);
          const dy = oy + (item.offset?.y ?? 0);
          const layer = new Container();
          if (item.alpha < 1) layer.alpha = item.alpha;
          layers.set(item, layer);
          into.addChild(layer);
          batch.cells.push({ x: dx + g.x, y: dy + g.y, w: g.w, h: g.h, r: g.r, fill: rect.fill, stroke: rect.stroke });
          batch.layers.push(layer);
          entry.nested.push(place(item, layer, ox, oy, rect));
          continue;
        }
        pending.delete(into);
        const layer = new Container();
        if (item.alpha < 1) layer.alpha = item.alpha;
        layers.set(item, layer);
        into.addChild(layer);
        entry.nested.push(place(item, layer, ox, oy));
      } else {
        // Shapes after a plain group must still draw above it: a new run.
        endRun();
        add(item, into, entry, ox + (item.offset?.x ?? 0), oy + (item.offset?.y ?? 0));
      }
    }
    endRun();
  };
  /** Cells being gathered into one batch, by the container they're drawn in (BuildOptions.cells). */
  interface Gathering {
    holder: Container;
    cells: CellRect[];
    layers: Container[];
    entry: Pick<Entry, "batches" | "contexts">;
  }
  const pending = new Map<Container, Gathering>();
  const open: Gathering[] = [];
  /**
   * A keyed group's body in its layer: kept from the last build if it draws
   * the same, or built. (ox, oy): where its parent's units are, from the
   * layer's (moved groups flattened above it). The body carries it, never
   * the layer, which the step animation moves.
   */
  const place = (group: PaintGroup, layer: Container, ox = 0, oy = 0, batched: PaintShape | null = null): Entry => {
    // A batched cell's body draws all but its rectangle: another body than the same cell drawn whole.
    const sig = batched ? `I${sigOf(group)}` : sigOf(group);
    const at = originOf(group);
    const reused = take(sig);
    if (reused) {
      layer.addChild(reused.body);
      reused.body.position.set(ox + at.x - reused.built.x, oy + at.y - reused.built.y);
      reused.layer = layer;
      adopt(group, reused);
      return reused;
    }
    const body = new Container();
    layer.addChild(body);
    const entry: Entry = { sig, body, layer, built: at, nested: [], overlays: [], contexts: [], batches: [] };
    body.position.set(ox, oy);
    const gx = group.offset?.x ?? 0;
    const gy = group.offset?.y ?? 0;
    if (batched) {
      // Its rectangle is in the batch; its flash still goes over it, under its text.
      if (batched.flash && options.flash) {
        const overlay = flashOverlay(batched);
        overlay.position.set(gx, gy);
        body.addChild(overlay);
        flashes.push(overlay);
        entry.overlays.push(overlay);
      }
      add(group, body, entry, gx, gy, 1);
    } else add(group, body, entry, gx, gy);
    if (options.renderGroups && (group.nodeKey || group.current) && drawsAtLeast(body, RENDER_GROUP_MIN))
      body.isRenderGroup = true;
    keep(entry);
    return entry;
  };

  add(paint.root, root, { nested: [], overlays: [], contexts: [], batches: [] });
  // Each batch of cells is made once all its cells are known, where its first cell is.
  for (const batch of open) {
    if (batch.cells.length < (options.batchMin ?? BATCH_MIN)) {
      // Too few: each rectangle a Graphics under its cell's text, in its layer (so it slides with it).
      batch.cells.forEach((c, i) => {
        const shape: PaintShape = {
          kind: "shape",
          geometry: { type: "rect", x: c.x, y: c.y, w: c.w, h: c.h, r: c.r },
          fill: c.fill,
          stroke: c.stroke,
          flash: false,
        };
        const layer = batch.layers[i];
        addRun([shape], layer, batch.entry.contexts, 0, 0);
        layer.addChildAt(layer.children[layer.children.length - 1], 0);
      });
      batch.holder.parent?.removeChild(batch.holder);
      batch.holder.destroy();
      continue;
    }
    const mesh = options.cells!(batch.cells, batch.layers);
    batch.holder.addChild(mesh);
    batch.entry.batches.push(mesh);
    batches.push(mesh);
  }
  cache.entries = kept;
  // Each Text listens to its style for changes. These styles are shared and
  // never change, and with thousands of texts on one style, unsubscribing
  // them one by one when the scene is replaced costs more than drawing it
  // (it's a search through every listener, each time). Drop the listeners.
  for (const style of styles.values()) style.removeAllListeners("update");
  return { root, layers, flashes, batches };
}
