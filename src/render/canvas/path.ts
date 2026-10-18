/**
 * SVG path data for the canvas renderer: parsed into absolute moves, lines,
 * and curves; flattened into polylines for dashed strokes (Pixi draws solid
 * lines only); and the direction a path ends in, for its arrowhead.
 */

export type PathCommand =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | { op: "Q"; cx: number; cy: number; x: number; y: number }
  | { op: "C"; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { op: "Z" };

export interface Point {
  x: number;
  y: number;
}

const TOKENS = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Parse a path's `d`. Arcs (A), which PR0L1NE never draws, become straight lines. */
export function parsePath(d: string): PathCommand[] {
  const tokens = d.match(TOKENS) ?? [];
  const out: PathCommand[] = [];
  let i = 0;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let command = "";
  // The last control point, for S and T (smooth curves).
  let lastC: Point | null = null;
  let lastQ: Point | null = null;
  const num = () => Number(tokens[i++]);
  const isNumber = (t: string | undefined) => t !== undefined && !/^[A-Za-z]$/.test(t);

  while (i < tokens.length) {
    if (!isNumber(tokens[i])) command = tokens[i++];
    else if (!command) break; // numbers before any command: not a path
    const rel = command === command.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (command.toUpperCase()) {
      case "M": {
        x = ox + num();
        y = oy + num();
        startX = x;
        startY = y;
        out.push({ op: "M", x, y });
        // Further pairs after a move are lines.
        command = rel ? "l" : "L";
        lastC = lastQ = null;
        break;
      }
      case "L":
        x = ox + num();
        y = oy + num();
        out.push({ op: "L", x, y });
        lastC = lastQ = null;
        break;
      case "H":
        x = ox + num();
        out.push({ op: "L", x, y });
        lastC = lastQ = null;
        break;
      case "V":
        y = oy + num();
        out.push({ op: "L", x, y });
        lastC = lastQ = null;
        break;
      case "C": {
        const c1x = ox + num();
        const c1y = oy + num();
        const c2x = ox + num();
        const c2y = oy + num();
        x = ox + num();
        y = oy + num();
        out.push({ op: "C", c1x, c1y, c2x, c2y, x, y });
        lastC = { x: c2x, y: c2y };
        lastQ = null;
        break;
      }
      case "S": {
        const c1x = lastC ? 2 * x - lastC.x : x;
        const c1y = lastC ? 2 * y - lastC.y : y;
        const c2x = ox + num();
        const c2y = oy + num();
        x = ox + num();
        y = oy + num();
        out.push({ op: "C", c1x, c1y, c2x, c2y, x, y });
        lastC = { x: c2x, y: c2y };
        lastQ = null;
        break;
      }
      case "Q": {
        const cx = ox + num();
        const cy = oy + num();
        x = ox + num();
        y = oy + num();
        out.push({ op: "Q", cx, cy, x, y });
        lastQ = { x: cx, y: cy };
        lastC = null;
        break;
      }
      case "T": {
        const cx: number = lastQ ? 2 * x - lastQ.x : x;
        const cy: number = lastQ ? 2 * y - lastQ.y : y;
        x = ox + num();
        y = oy + num();
        out.push({ op: "Q", cx, cy, x, y });
        lastQ = { x: cx, y: cy };
        lastC = null;
        break;
      }
      case "A": {
        i += 5; // rx ry rotation large-arc sweep
        x = ox + num();
        y = oy + num();
        out.push({ op: "L", x, y });
        lastC = lastQ = null;
        break;
      }
      case "Z":
        out.push({ op: "Z" });
        x = startX;
        y = startY;
        lastC = lastQ = null;
        // Z takes no numbers: a number after it starts an implicit line? Not in SVG; stop on junk.
        if (isNumber(tokens[i])) return out;
        break;
      default:
        return out;
    }
    if (out.length && Number.isNaN(x + y)) return out.slice(0, -1);
  }
  return out;
}

/** A path as polylines (one per subpath), with curves cut into short straight pieces. */
export function flatten(commands: PathCommand[], step = 4): { points: Point[]; closed: boolean }[] {
  const lines: { points: Point[]; closed: boolean }[] = [];
  let current: Point[] = [];
  let at: Point = { x: 0, y: 0 };
  const finish = (closed: boolean) => {
    if (current.length > 1) lines.push({ points: current, closed });
    current = [];
  };
  for (const c of commands) {
    switch (c.op) {
      case "M":
        finish(false);
        at = { x: c.x, y: c.y };
        current = [at];
        break;
      case "L":
        if (!current.length) current = [at];
        at = { x: c.x, y: c.y };
        current.push(at);
        break;
      case "Q":
      case "C": {
        if (!current.length) current = [at];
        const from = at;
        const length = Math.hypot(c.x - from.x, c.y - from.y) + (c.op === "Q" ? 0 : 1);
        const pieces = Math.max(4, Math.min(64, Math.ceil(length / step)));
        for (let k = 1; k <= pieces; k++) current.push(curvePoint(from, c, k / pieces));
        at = { x: c.x, y: c.y };
        break;
      }
      case "Z":
        if (current.length) {
          const start = current[0];
          if (at.x !== start.x || at.y !== start.y) current.push(start);
          at = start;
          finish(true);
        }
        break;
    }
  }
  finish(false);
  return lines;
}

function curvePoint(from: Point, c: Extract<PathCommand, { op: "Q" | "C" }>, t: number): Point {
  const u = 1 - t;
  if (c.op === "Q") {
    return {
      x: u * u * from.x + 2 * u * t * c.cx + t * t * c.x,
      y: u * u * from.y + 2 * u * t * c.cy + t * t * c.y,
    };
  }
  return {
    x: u * u * u * from.x + 3 * u * u * t * c.c1x + 3 * u * t * t * c.c2x + t * t * t * c.x,
    y: u * u * u * from.y + 3 * u * u * t * c.c1y + 3 * u * t * t * c.c2y + t * t * t * c.y,
  };
}

/**
 * Cut polylines into dashes: `pattern` is a stroke-dasharray (on, off, ...),
 * restarting on each subpath as SVG does. Returns the "on" pieces.
 */
export function dash(lines: { points: Point[] }[], pattern: number[], offset = 0): Point[][] {
  const clean = pattern.filter((n) => Number.isFinite(n) && n >= 0);
  // An odd-length pattern repeats to make it even, as in SVG.
  const dashes = clean.length % 2 ? [...clean, ...clean] : clean;
  const total = dashes.reduce((a, b) => a + b, 0);
  if (!dashes.length || total <= 0) return lines.map((l) => l.points);
  const out: Point[][] = [];
  for (const { points } of lines) {
    // Where in the pattern we start.
    let index = 0;
    let left = dashes[0];
    let skip = ((offset % total) + total) % total;
    while (skip > 0) {
      if (skip >= left) {
        skip -= left;
        index = (index + 1) % dashes.length;
        left = dashes[index];
      } else {
        left -= skip;
        skip = 0;
      }
    }
    let piece: Point[] | null = index % 2 === 0 ? [points[0]] : null;
    for (let k = 1; k < points.length; k++) {
      let a = points[k - 1];
      const b = points[k];
      let segment = Math.hypot(b.x - a.x, b.y - a.y);
      while (segment > 0) {
        const take = Math.min(left, segment);
        const t = take / segment;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (piece) piece.push(p);
        segment -= take;
        left -= take;
        a = p;
        if (left <= 1e-9) {
          if (piece) {
            if (piece.length > 1) out.push(piece);
            piece = null;
          } else piece = [p];
          index = (index + 1) % dashes.length;
          left = dashes[index];
          // A zero-length gap or dash: keep going from the same point.
        }
      }
    }
    if (piece && piece.length > 1) out.push(piece);
  }
  return out;
}

/** Where a path ends and the direction it's heading there (radians), for marker-end. */
export function endDirection(commands: PathCommand[]): { x: number; y: number; angle: number } | null {
  let at: Point | null = null;
  let before: Point | null = null;
  let start: Point | null = null;
  for (const c of commands) {
    switch (c.op) {
      case "M":
        start = at = { x: c.x, y: c.y };
        before = null;
        break;
      case "L":
        before = at;
        at = { x: c.x, y: c.y };
        break;
      case "Q":
        // The tangent at the end of a curve points from its last control point.
        before = c.cx === c.x && c.cy === c.y ? at : { x: c.cx, y: c.cy };
        at = { x: c.x, y: c.y };
        break;
      case "C":
        before =
          c.c2x === c.x && c.c2y === c.y
            ? c.c1x === c.x && c.c1y === c.y
              ? at
              : { x: c.c1x, y: c.c1y }
            : { x: c.c2x, y: c.c2y };
        at = { x: c.x, y: c.y };
        break;
      case "Z":
        before = at;
        at = start;
        break;
    }
  }
  if (!at || !before || (before.x === at.x && before.y === at.y)) return at ? { ...at, angle: 0 } : null;
  return { x: at.x, y: at.y, angle: Math.atan2(at.y - before.y, at.x - before.x) };
}

/** The box around a path's points and control points. */
export function pathBounds(commands: PathCommand[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const c of commands) {
    if (c.op === "Z") continue;
    add(c.x, c.y);
    if (c.op === "Q") add(c.cx, c.cy);
    if (c.op === "C") {
      add(c.c1x, c.c1y);
      add(c.c2x, c.c2y);
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}
