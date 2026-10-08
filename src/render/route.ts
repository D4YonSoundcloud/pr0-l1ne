/**
 * Arrow routing and box placement for the memory view. Pure geometry: no
 * DOM, so it's unit-tested directly (route.test.ts).
 *
 * Arrows are orthogonal (horizontal and vertical segments with rounded
 * corners) and travel through the empty gaps between columns of boxes, so
 * they never cut across a box in the automatic layout:
 *
 *   forward      ●──────┐            target is to the right: run along the
 *                       └──▶ [T]     source row, turn in the gap just left
 *                                    of the target, enter its left edge
 *
 *   u-turn       ●────┐              target is in the same column (above,
 *          [T] ◀──────┘              below, or itself): turn in the gap
 *                                    to the right, enter its right edge
 *
 *   corridor     ┌───────────────┐   target is in an earlier column: go
 *          [T] ◀─┘   [ boxes ]   ●   over (or under) every box in between
 *
 * Each vertical segment gets its own lane in its gap, so arrows that share a
 * gap run side by side instead of on top of each other. Lanes are ordered to
 * reduce crossings.
 */

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface EdgeInput {
  /** Where the arrow starts (a reference dot inside the source box). */
  from: Point;
  /**
   * Leave downward first and turn at this y (used for list cells, so their
   * arrows don't run through the neighboring cells).
   */
  exitDownY?: number;
  /** Parent to child in a tree drawn top-down: drop into the child's top. */
  tree?: "left" | "right";
  /**
   * The target is inside a tree that starts at this x: come down the gap
   * left of the tree, then in from above the target.
   */
  enterTopFrom?: number;
  source: Rect;
  target: Rect;
  /** Where on the target's height the arrow should arrive, before spreading. */
  entryY: number;
}

const LANE = 7;           // space between parallel lanes
const GAP_PAD = 14;       // distance from a box edge to the first lane
const MIN_GAP = 20;       // a target must be this far right to count as "forward"
const CORRIDOR_PAD = 12;  // distance from boxes to a corridor
const SPREAD = 6;         // space between arrowheads arriving at the same side
const TOP_GAP = 14;       // how far above a tree node an arrow from outside turns in

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Do two rectangles overlap, with `pad` of breathing room? */
export function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < right(b) + pad && b.x < right(a) + pad && a.y < bottom(b) + pad && b.y < bottom(a) + pad;
}

/** Does an axis-aligned segment pass through the inside of a box? */
export function crosses(a: Point, b: Point, box: Rect, inset = 2): boolean {
  const x1 = box.x + inset, x2 = right(box) - inset, y1 = box.y + inset, y2 = bottom(box) - inset;
  if (x1 >= x2 || y1 >= y2) return false;
  const [lx, hx] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
  const [ly, hy] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
  return lx < x2 && hx > x1 && ly < y2 && hy > y1;
}

/**
 * The first y at or below `y` where a box of this size fits without
 * touching any obstacle. Moves down past whatever is in the way, so a new
 * box is never hidden under an existing one.
 */
export function findFreeY(x: number, w: number, h: number, y: number, obstacles: Rect[], gap: number): number {
  let candidate = y;
  for (let guard = 0; guard < 500; guard++) {
    const box = { x, y: candidate, w, h };
    const hit = obstacles.filter((o) => overlaps(box, o, gap / 2));
    if (!hit.length) return candidate;
    candidate = Math.max(...hit.map(bottom)) + gap;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Kind = "straight" | "forward" | "uturn" | "corridor" | "around" | "tree" | "top";

interface Plan {
  index: number;
  edge: EdgeInput;
  kind: Kind;
  side: "left" | "right";
  entryY: number;
  /** Lane channels this edge needs, and the lane x/y once assigned. */
  inLane?: { key: string; x?: number };
  outLane?: { key: string; x?: number };
  corridor?: { top: boolean; level: number; y?: number };
}

/** Right edge of the column a box is in: boxes that share its x. */
function columnRight(box: Rect, boxes: Rect[]): number {
  let r = right(box);
  for (const b of boxes) if (Math.abs(b.x - box.x) < 1) r = Math.max(r, right(b));
  return r;
}

/** Every route as a list of points; segments alternate horizontal/vertical. */
export function routeEdges(input: EdgeInput[], boxes: Rect[]): Point[][] {
  // An arrow that leaves downward is routed from the point where it turns;
  // the drop out of the cell is added back at the end.
  const edges = input.map((e) => (e.exitDownY === undefined ? e : { ...e, from: { x: e.from.x, y: e.exitDownY } }));
  const plans: Plan[] = edges.map((edge, index) => {
    const { source: S, target: T } = edge;
    const exitX = right(S);
    if (edge.tree && T.y > bottom(S)) return { index, edge, kind: "tree", side: "left", entryY: T.y };
    if (edge.enterTopFrom !== undefined) {
      // Arrive through the gap above the target's level.
      return { index, edge, kind: "top", side: "left", entryY: T.y - TOP_GAP };
    }
    if (T.x >= exitX + MIN_GAP) {
      return { index, edge, kind: "forward", side: "left", entryY: edge.entryY };
    }
    if (right(T) >= S.x - 1) {
      // Same column (or overlapping it): turn around in the gap on the right.
      const outRight = columnRight(S, boxes);
      if (right(T) + 10 > outRight + GAP_PAD) {
        return { index, edge, kind: "around", side: "left", entryY: edge.entryY };
      }
      return { index, edge, kind: "uturn", side: "right", entryY: edge.entryY };
    }
    return { index, edge, kind: "corridor", side: "right", entryY: edge.entryY };
  });

  spreadEntries(plans);

  // A forward arrow that's already level with its target needs no turns.
  for (const p of plans) {
    if (p.kind === "forward" && Math.abs(p.edge.from.y - p.entryY) < 1.5) {
      p.kind = "straight";
      p.entryY = p.edge.from.y;
    }
  }

  assignLanes(plans, boxes);
  return plans.map((plan, i) => {
    const points = buildPoints(plan);
    return input[i].exitDownY === undefined ? points : [input[i].from, ...points];
  });
}

/**
 * Arrows arriving at the same side of the same box get separate arrowheads,
 * ordered by where they come from so they don't cross on the way in. If one
 * of them is already level with the target, it stays straight.
 */
function spreadEntries(plans: Plan[]): void {
  const groups = new Map<string, Plan[]>();
  for (const p of plans) {
    if (p.kind === "tree" || p.kind === "top") continue;
    const t = p.edge.target;
    const key = `${t.x},${t.y},${p.side}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.edge.from.y - b.edge.from.y || a.index - b.index);
    const t = group[0].edge.target;
    const room = Math.max(0, Math.min(t.h - 10, 24));
    const step = Math.min(SPREAD, room / (group.length - 1));
    const base = group[0].entryY;
    const offsets = group.map((_, i) => (i - (group.length - 1) / 2) * step);
    // Keep an already-level arrow straight by shifting everything.
    const level = group.findIndex((p) => Math.abs(p.edge.from.y - base) < 1.5);
    const shift = level >= 0 && Math.abs(offsets[level]) <= room / 2 ? -offsets[level] : 0;
    group.forEach((p, i) => { p.entryY = base + offsets[i] + shift; });
  }
}

/** Vertical extent of the segment an edge runs along a lane. */
function laneSpan(p: Plan): [number, number] {
  const a = p.edge.from.y;
  const b = p.kind === "corridor" ? p.corridor?.y ?? p.entryY : p.entryY;
  return a < b ? [a, b] : [b, a];
}

const inside = (y: number, [lo, hi]: [number, number]) => y > lo + 0.5 && y < hi - 0.5;

function assignLanes(plans: Plan[], boxes: Rect[]): void {
  // Forward arrows: lanes in the gap left of the target, counted leftwards.
  const forward = new Map<string, Plan[]>();
  for (const p of plans) {
    if (p.kind !== "forward" && p.kind !== "top") continue;
    // Arrows into a tree share the gap left of the whole tree.
    const key = `R:${Math.round(p.kind === "top" ? p.edge.enterTopFrom! : p.edge.target.x)}`;
    p.inLane = { key };
    forward.set(key, [...(forward.get(key) ?? []), p]);
  }
  for (const group of forward.values()) {
    // Two forward lanes A (left) and B (right) cross when A's exit to the
    // target passes B's lane, or B's way in passes A's lane. Order the lanes
    // to make that rare.
    const cost = (a: Plan, b: Plan) =>
      Number(inside(a.entryY, laneSpan(b))) + Number(inside(b.edge.from.y, laneSpan(a)));
    group.sort((a, b) => cost(a, b) - cost(b, a) || a.edge.from.y - b.edge.from.y);
    const targetX = group[0].kind === "top" ? group[0].edge.enterTopFrom! : group[0].edge.target.x;
    const leftLimit = Math.max(...group.map((p) => right(p.edge.source))) + 8;
    const first = targetX - GAP_PAD;
    const spacing = group.length > 1 ? Math.max(2, Math.min(LANE, (first - leftLimit) / (group.length - 1))) : 0;
    // group[0] is leftmost.
    group.forEach((p, i) => { p.inLane!.x = Math.max(leftLimit, first - (group.length - 1 - i) * spacing); });
  }

  // Lanes in the gap right of a column: u-turns leaving it, and corridor
  // arrows both leaving it and arriving back at it. Shorter spans go nearer
  // the column, so the loops nest instead of crossing.
  const leftChannels = new Map<string, { plan: Plan; lane: "in" | "out"; span: number }[]>();
  const addLeft = (key: string, plan: Plan, lane: "in" | "out", span: number) => {
    leftChannels.set(key, [...(leftChannels.get(key) ?? []), { plan, lane, span }]);
  };
  for (const p of plans) {
    if (p.kind === "uturn" || p.kind === "corridor" || p.kind === "around") {
      const key = `L:${Math.round(columnRight(p.edge.source, boxes))}`;
      p.outLane = { key };
      addLeft(key, p, "out", Math.abs(p.edge.from.y - p.entryY));
    }
  }
  // Corridors: over the boxes in between when there's room, else under.
  const corridorPlans = plans.filter((p) => p.kind === "corridor" || p.kind === "around");
  corridorPlans.sort((a, b) => horizontalSpan(a, boxes) - horizontalSpan(b, boxes));
  const tops = { top: 0, bottom: 0 };
  for (const p of corridorPlans) {
    const [x1, x2] = corridorRange(p, boxes);
    const between = boxes.filter((b) => b.x < x2 && right(b) > x1);
    // With nothing in between (possible once boxes are dragged), run the
    // corridor just past the arrow's own ends instead of at infinity.
    const ends = [p.edge.from.y, p.entryY];
    const minTop = between.length ? Math.min(...between.map((b) => b.y)) : Math.min(...ends);
    const maxBottom = between.length ? Math.max(...between.map(bottom)) : Math.max(...ends);
    const topY = minTop - CORRIDOR_PAD - tops.top * LANE;
    const viaTop = Math.abs(p.edge.from.y - minTop) + Math.abs(p.entryY - minTop);
    const viaBottom = Math.abs(p.edge.from.y - maxBottom) + Math.abs(p.entryY - maxBottom);
    const useTop = p.kind === "corridor" && topY >= 6 && viaTop <= viaBottom;
    if (useTop) {
      p.corridor = { top: true, level: tops.top++, y: topY };
    } else {
      p.corridor = { top: false, level: tops.bottom, y: maxBottom + CORRIDOR_PAD + tops.bottom * LANE };
      tops.bottom++;
    }
    if (p.kind === "corridor") {
      const key = `L:${Math.round(columnRight(p.edge.target, boxes))}`;
      p.inLane = { key };
      addLeft(key, p, "in", Math.abs(p.corridor.y! - p.entryY));
    }
  }
  for (const [key, group] of leftChannels) {
    const base = Number(key.slice(2)) + GAP_PAD;
    group.sort((a, b) => a.span - b.span || a.plan.index - b.plan.index);
    const spacing = group.length > 1 ? Math.min(LANE, 44 / (group.length - 1)) : 0;
    group.forEach(({ plan, lane }, i) => {
      const x = base + i * spacing;
      if (lane === "out") plan.outLane!.x = x;
      else plan.inLane!.x = x;
    });
  }
}

function corridorRange(p: Plan, boxes: Rect[]): [number, number] {
  const out = columnRight(p.edge.source, boxes) + GAP_PAD;
  const inX = p.kind === "around" ? p.edge.target.x - GAP_PAD : columnRight(p.edge.target, boxes) + GAP_PAD;
  return out < inX ? [out, inX] : [inX, out];
}

function horizontalSpan(p: Plan, boxes: Rect[]): number {
  const [a, b] = corridorRange(p, boxes);
  return b - a;
}

function buildPoints(p: Plan): Point[] {
  const { from, target: T } = p.edge;
  switch (p.kind) {
    case "straight":
      return [from, { x: T.x, y: from.y }];
    case "tree": {
      // Out to the right of the parent, down into the gap below it, across,
      // and into the top of the child. Left children use the outer lane and
      // turn lower, so the two never cross.
      const S = p.edge.source;
      const left = p.edge.tree === "left";
      const x = right(S) + (left ? 16 : 8);
      const midY = Math.round((bottom(S) + T.y) / 2) + (left ? 5 : -1);
      const tx = T.x + T.w / 2;
      return [from, { x, y: from.y }, { x, y: midY }, { x: tx, y: midY }, { x: tx, y: T.y }];
    }
    case "top": {
      const x = p.inLane!.x!;
      const tx = T.x + Math.min(16, T.w / 4);
      return [from, { x, y: from.y }, { x, y: p.entryY }, { x: tx, y: p.entryY }, { x: tx, y: T.y }];
    }
    case "forward": {
      const x = p.inLane!.x!;
      return [from, { x, y: from.y }, { x, y: p.entryY }, { x: T.x, y: p.entryY }];
    }
    case "uturn": {
      const x = p.outLane!.x!;
      return [from, { x, y: from.y }, { x, y: p.entryY }, { x: right(T), y: p.entryY }];
    }
    case "corridor": {
      const out = p.outLane!.x!;
      const inX = p.inLane!.x!;
      const cy = p.corridor!.y!;
      return [from, { x: out, y: from.y }, { x: out, y: cy }, { x: inX, y: cy }, { x: inX, y: p.entryY }, { x: right(T), y: p.entryY }];
    }
    case "around": {
      // Rare (only with dragged boxes): leave right, pass under, enter left.
      const out = p.outLane!.x!;
      const cy = p.corridor!.y!;
      const inX = T.x - GAP_PAD;
      return [from, { x: out, y: from.y }, { x: out, y: cy }, { x: inX, y: cy }, { x: inX, y: p.entryY }, { x: T.x, y: p.entryY }];
    }
  }
}

/** An SVG path through the points, with rounded corners. */
export function roundedPath(points: Point[], radius = 6): string {
  // Drop zero-length segments, so corners are real corners.
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5);
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const inPoint = towards(b, a, r);
    const outPoint = towards(b, c, r);
    d += ` L${inPoint.x},${inPoint.y} Q${b.x},${b.y} ${outPoint.x},${outPoint.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}

function towards(from: Point, to: Point, distance: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return {
    x: round(from.x + ((to.x - from.x) / length) * distance),
    y: round(from.y + ((to.y - from.y) / length) * distance),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
