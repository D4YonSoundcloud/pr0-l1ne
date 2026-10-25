/**
 * The shapes of a graph's edges, in pixels, for render/graphView.ts. Pure
 * geometry: no DOM, so it's unit-tested directly (graphEdges.test.ts).
 *
 * How an edge is drawn depends on the graph's edge style (a hint option,
 * trace/graph.ts) and its layout (trace/graphLayout.ts):
 *
 *   auto      straight; through its bends as a smooth curve when the layout
 *             gave it some (a long edge in layers, or one bent around a node)
 *   curved    every edge a gentle arc, or a smooth curve through its bends
 *   straight  every edge a straight line, bends ignored
 *   angled    horizontal and vertical lines with rounded corners. In layers:
 *             down out of a node, across in the gap between two layers, and
 *             down into the next; edges sharing a gap get separate tracks
 *             so they don't run on top of each other. Otherwise: an L, the
 *             way round that passes fewer nodes.
 *
 * Repeated edges and two-way pairs are offset sideways (lanes), and a
 * self-loop is a loop off the node's right side. Each shape comes with a
 * polyline along it (`samples`), which placeLabels uses to put weight labels
 * where they don't cover a node or another label.
 */
import { roundedPath } from "./route";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeShape {
  d: string;
  /** Points along the edge, start to end. */
  samples: Point[];
}

const r = (v: number) => Math.round(v * 100) / 100;

/** Where a line from a node's center toward (dx, dy) leaves its outline. */
export function exitDistance(size: Size, dx: number, dy: number): number {
  const len = Math.hypot(dx, dy) || 1;
  const ux = Math.abs(dx / len);
  const uy = Math.abs(dy / len);
  const hw = size.w / 2 + 2;
  const hh = size.h / 2 + 2;
  return Math.min(ux > 1e-6 ? hw / ux : Number.POSITIVE_INFINITY, uy > 1e-6 ? hh / uy : Number.POSITIVE_INFINITY);
}

function quadSamples(a: Point, c: Point, b: Point, n = 12): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  });
}

function cubicSamples(a: Point, c1: Point, c2: Point, b: Point, n = 10): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return {
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    };
  });
}

/**
 * An edge from a to b: straight, bowed sideways by `offset`, or through
 * `bends` as a smooth curve. Cut where it leaves each node's outline.
 */
export function edgePath(
  a: Point,
  b: Point,
  bends: Point[],
  fromSize: Size,
  toSize: Size,
  offset: number,
  arrow: boolean,
): EdgeShape {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  if (!bends.length) {
    const startCut = exitDistance(fromSize, dx, dy);
    const endCut = exitDistance(toSize, -dx, -dy) + (arrow ? 1 : 0);
    const s = {
      x: a.x + (dx / len) * startCut + nx * offset * 0.5,
      y: a.y + (dy / len) * startCut + ny * offset * 0.5,
    };
    const e = { x: b.x - (dx / len) * endCut + nx * offset * 0.5, y: b.y - (dy / len) * endCut + ny * offset * 0.5 };
    if (!offset) return { d: `M${r(s.x)},${r(s.y)} L${r(e.x)},${r(e.y)}`, samples: [s, e] };
    const c = { x: (a.x + b.x) / 2 + nx * offset * 1.6, y: (a.y + b.y) / 2 + ny * offset * 1.6 };
    return { d: `M${r(s.x)},${r(s.y)} Q${r(c.x)},${r(c.y)} ${r(e.x)},${r(e.y)}`, samples: quadSamples(s, c, e) };
  }
  // Through the bends, shifted sideways for a lane.
  const inner = bends.map((p) => ({ x: p.x + nx * offset, y: p.y + ny * offset }));
  const first = inner[0];
  const last = inner[inner.length - 1];
  const out = { x: first.x - a.x, y: first.y - a.y };
  const into = { x: b.x - last.x, y: b.y - last.y };
  const outLen = Math.hypot(out.x, out.y) || 1;
  const intoLen = Math.hypot(into.x, into.y) || 1;
  const startCut = exitDistance(fromSize, out.x, out.y);
  const endCut = exitDistance(toSize, -into.x, -into.y) + (arrow ? 1 : 0);
  const points = [
    { x: a.x + (out.x / outLen) * startCut, y: a.y + (out.y / outLen) * startCut },
    ...inner,
    { x: b.x - (into.x / intoLen) * endCut, y: b.y - (into.y / intoLen) * endCut },
  ];
  // Catmull-Rom through the points, as cubic Béziers.
  let d = `M${r(points[0].x)},${r(points[0].y)}`;
  const samples: Point[] = [points[0]];
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p2.x)},${r(p2.y)}`;
    samples.push(...cubicSamples(p1, c1, c2, p2).slice(1));
  }
  return { d, samples };
}

/** How far a "curved" edge with no bends arcs, in pixels: a little, more for longer edges. */
export function arcOffset(a: Point, b: Point): number {
  return Math.min(26, Math.max(10, Math.hypot(b.x - a.x, b.y - a.y) * 0.12));
}

/** A self-loop: out of the node's right side and back in, further out for each extra one. */
export function selfLoop(c: Point, size: Size, lane: number): EdgeShape {
  const right = c.x + size.w / 2;
  const reach = 26 + lane * 12;
  const spread = 16 + lane * 6;
  const s = { x: right, y: c.y - 6 };
  const c1 = { x: right + reach, y: c.y - spread };
  const c2 = { x: right + reach, y: c.y + spread };
  const e = { x: right + 1, y: c.y + 6 };
  return {
    d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${e.x},${e.y}`,
    samples: cubicSamples(s, c1, c2, e),
  };
}

// ---------------------------------------------------------------------------
// Right angles
// ---------------------------------------------------------------------------

/** Does a horizontal or vertical segment pass through a rectangle (shrunk by `inset`)? */
function segmentHits(a: Point, b: Point, box: Rect, inset = 1): boolean {
  const [x1, x2] = [box.x + inset, box.x + box.w - inset];
  const [y1, y2] = [box.y + inset, box.y + box.h - inset];
  const [lx, hx] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
  const [ly, hy] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
  return lx < x2 && hx > x1 && ly < y2 && hy > y1;
}

/** Does a straight segment (any direction) pass through a rectangle? */
function lineHits(a: Point, b: Point, box: Rect): boolean {
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h) return true;
  }
  return false;
}

/**
 * An angled edge between two nodes not in layers: an L. Across first (out
 * of the side, into the top or bottom) or down first (out of the top or
 * bottom, into the side), whichever passes fewer of the other nodes; ties
 * go across first. If both run into a node, a straight line when that's
 * clear. Nearly level or nearly in line: a straight line.
 */
export function angledL(a: Point, b: Point, fromSize: Size, toSize: Size, others: Rect[], arrow: boolean): EdgeShape {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sx = Math.sign(dx) || 1;
  const sy = Math.sign(dy) || 1;
  const end = arrow ? 1 : 0;
  if (Math.abs(dy) < 6) {
    const s = { x: a.x + sx * (fromSize.w / 2 + 2), y: a.y };
    const e = { x: b.x - sx * (toSize.w / 2 + 2 + end), y: a.y };
    return { d: `M${r(s.x)},${r(s.y)} L${r(e.x)},${r(e.y)}`, samples: [s, e] };
  }
  if (Math.abs(dx) < 6) {
    const s = { x: a.x, y: a.y + sy * (fromSize.h / 2 + 2) };
    const e = { x: a.x, y: b.y - sy * (toSize.h / 2 + 2 + end) };
    return { d: `M${r(s.x)},${r(s.y)} L${r(e.x)},${r(e.y)}`, samples: [s, e] };
  }
  const across = [
    { x: a.x + sx * (fromSize.w / 2 + 2), y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y - sy * (toSize.h / 2 + 2 + end) },
  ];
  const down = [
    { x: a.x, y: a.y + sy * (fromSize.h / 2 + 2) },
    { x: a.x, y: b.y },
    { x: b.x - sx * (toSize.w / 2 + 2 + end), y: b.y },
  ];
  const hits = (pts: Point[]) =>
    others.reduce((n, box) => n + Number(segmentHits(pts[0], pts[1], box) || segmentHits(pts[1], pts[2], box)), 0);
  const [hitsAcross, hitsDown] = [hits(across), hits(down)];
  if (hitsAcross && hitsDown) {
    // Both ways round run into a node (in a grid, its corner usually has one): straight across instead.
    const straight = edgePath(a, b, [], fromSize, toSize, 0, arrow);
    const [s0, s1] = straight.samples;
    if (!others.some((box) => lineHits(s0, s1, box))) return straight;
  }
  const pts = hitsDown < hitsAcross ? down : across;
  return {
    d: roundedPath(
      pts.map((p) => ({ x: r(p.x), y: r(p.y) })),
      8,
    ),
    samples: pts,
  };
}

/** One step of a layered angled edge: between two neighboring layers. */
export interface LayerStep {
  /** The edge it belongs to, and which of its steps it is. */
  edge: number;
  step: number;
  /** The gap it crosses: the layer above it. */
  gap: number;
  x1: number;
  x2: number;
}

/**
 * Tracks in each gap between layers, so edges crossing a gap at the same
 * height never overlap: each step that goes sideways gets the first track
 * that's free over its span (greedy interval coloring, left to right).
 * Returns each step's track ("edge:step" -> track) and each gap's count.
 */
export function assignTracks(steps: LayerStep[]): { track: Map<string, number>; count: Map<number, number> } {
  const track = new Map<string, number>();
  const count = new Map<number, number>();
  const byGap = new Map<number, LayerStep[]>();
  for (const step of steps) {
    if (Math.abs(step.x1 - step.x2) < 0.5) continue; // straight down: no track
    byGap.set(step.gap, [...(byGap.get(step.gap) ?? []), step]);
  }
  for (const [gap, list] of byGap) {
    const spans = list
      .map((st) => ({ st, lo: Math.min(st.x1, st.x2), hi: Math.max(st.x1, st.x2) }))
      .sort((p, q) => p.lo - q.lo || p.hi - q.hi || p.st.edge - q.st.edge);
    const ends: number[] = [];
    for (const { st, lo, hi } of spans) {
      let t = ends.findIndex((end) => end < lo - 6);
      if (t < 0) {
        t = ends.length;
        ends.push(hi);
      } else ends[t] = hi;
      track.set(`${st.edge}:${st.step}`, t);
    }
    count.set(gap, ends.length);
  }
  return { track, count };
}

/**
 * A layered angled edge through `points` (node centers and bends, top or
 * bottom first as it runs): each step down (or up) leaves vertically,
 * crosses at its gap's track height `trackY(gap, track)`, and arrives
 * vertically. `layerOf` gives a point's layer.
 */
export function angledLayers(
  points: Point[],
  layerOf: (p: Point) => number,
  fromSize: Size,
  toSize: Size,
  trackY: (gap: number, track: number) => number,
  trackOf: (step: number) => number | undefined,
  arrow: boolean,
): EdgeShape {
  const out: Point[] = [];
  const n = points.length;
  for (let i = 0; i + 1 < n; i++) {
    const p = points[i];
    const q = points[i + 1];
    const dir = Math.sign(q.y - p.y) || 1;
    const start = i === 0 ? { x: p.x, y: p.y + dir * (fromSize.h / 2 + 2) } : p;
    const end = i + 1 === n - 1 ? { x: q.x, y: q.y - dir * (toSize.h / 2 + 2 + (arrow ? 1 : 0)) } : q;
    if (i === 0) out.push(start);
    const t = trackOf(i);
    if (Math.abs(p.x - q.x) >= 0.5 && t !== undefined) {
      const y = trackY(Math.min(layerOf(p), layerOf(q)), t);
      out.push({ x: p.x, y }, { x: q.x, y });
    }
    out.push(end);
  }
  return {
    d: roundedPath(
      out.map((p) => ({ x: r(p.x), y: r(p.y) })),
      8,
    ),
    samples: out,
  };
}

/**
 * The same, for layers that run left to right: computed with x and y
 * swapped, then swapped back, so each step leaves a node sideways and
 * crosses its gap (between two columns) at its track.
 */
export function angledLayersSideways(
  points: Point[],
  layerOf: (p: Point) => number,
  fromSize: Size,
  toSize: Size,
  trackX: (gap: number, track: number) => number,
  trackOf: (step: number) => number | undefined,
  arrow: boolean,
): EdgeShape {
  const swap = (p: Point) => ({ x: p.y, y: p.x });
  const swapped = points.map(swap);
  const shape = angledLayers(
    swapped,
    (p) => layerOf(points[swapped.indexOf(p)]),
    { w: fromSize.h, h: fromSize.w },
    { w: toSize.h, h: toSize.w },
    trackX,
    trackOf,
    arrow,
  );
  const samples = shape.samples.map(swap);
  return {
    d: roundedPath(
      samples.map((p) => ({ x: r(p.x), y: r(p.y) })),
      8,
    ),
    samples,
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface LabelRequest {
  text: string;
  /** Its width and height, in pixels. */
  w: number;
  h: number;
  samples: Point[];
}

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** The point `t` of the way along a polyline (by length), and the direction there. */
function along(samples: Point[], t: number): { at: Point; dir: Point } {
  const lengths = samples.slice(1).map((p, i) => Math.hypot(p.x - samples[i].x, p.y - samples[i].y));
  let left = lengths.reduce((s, l) => s + l, 0) * t;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const k = lengths[i] ? Math.min(1, left / lengths[i]) : 0;
      const [p, q] = [samples[i], samples[i + 1]];
      const len = lengths[i] || 1;
      return {
        at: { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k },
        dir: { x: (q.x - p.x) / len, y: (q.y - p.y) / len },
      };
    }
    left -= lengths[i];
  }
  return { at: samples[0], dir: { x: 1, y: 0 } };
}

/**
 * Where each label goes (its center): on its edge, halfway along if that's
 * clear, else nearby along the edge or just beside it, avoiding nodes
 * (`obstacles`) and the labels placed before it. If nowhere is clear, the
 * place it covers least.
 */
export function placeLabels(requests: LabelRequest[], obstacles: Rect[]): Point[] {
  const placed: Rect[] = [];
  const fractions = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];
  return requests.map((req) => {
    let best: { at: Point; cost: number } | null = null;
    for (const t of fractions) {
      const { at, dir } = along(req.samples, t);
      for (const side of [0, 1, -1]) {
        // Beside the edge: off to its side, far enough for the label to clear it.
        const reach = side * (Math.abs(dir.x) * (req.h / 2 + 3) + Math.abs(dir.y) * (req.w / 2 + 3));
        const c = { x: at.x - dir.y * reach, y: at.y + dir.x * reach };
        const box = { x: c.x - req.w / 2, y: c.y - req.h / 2, w: req.w, h: req.h };
        const cost = [...obstacles, ...placed].reduce((sum, o) => sum + overlap(box, o), 0) + (side ? 0.5 : 0);
        if (!best || cost < best.cost) best = { at: c, cost };
        if (cost < 1) break;
      }
      if (best && best.cost < 1) break;
    }
    const at = best!.at;
    placed.push({ x: at.x - req.w / 2 - 2, y: at.y - req.h / 2 - 2, w: req.w + 4, h: req.h + 4 });
    return { x: r(at.x), y: r(at.y) };
  });
}
