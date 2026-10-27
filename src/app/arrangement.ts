/**
 * Where the three windows (the code, memory and loop history) go on a wide
 * screen, as a small tree: a row or column of windows, where one place can
 * hold a pair of windows split the other way.
 *
 *   a row of three            code | memory | loop
 *   a window beside a pair    code | (memory over loop)
 *   a column of three, or a window over a pair (a row of two)...
 *
 * Any arrangement of three windows is one of these. Dragging a window
 * (docking.ts) takes it out of the tree and puts it back beside another
 * window, at an edge of the page, or in another window's place. Everything
 * here is pure: tracks() turns an arrangement into CSS grid tracks and
 * placements, and windowRects() into the rectangles they'd give, which is
 * where the drag's preview box goes.
 */

export type WindowName = "editor" | "memory" | "loop";
export const WINDOWS: readonly WindowName[] = ["editor", "memory", "loop"];
export const isWindow = (value: unknown): value is WindowName => (WINDOWS as readonly unknown[]).includes(value);

/** A row lays its parts out left to right; a column, top to bottom. */
export type Dir = "row" | "column";
export interface Pair {
  dir: Dir;
  a: WindowName;
  b: WindowName;
}
export type Item = WindowName | Pair;

export interface Arrangement {
  dir: Dir;
  /** Three windows, or a window and a pair (split the other way), in order. */
  items: Item[];
  /** Each item's share of the room, as grid fr weights. */
  weights: number[];
  /** A pair's first window's share of the pair, in percent. */
  pairSplit: number;
}

export type Side = "left" | "right" | "top" | "bottom";
/** Where a dragged window goes: beside a window, in its place (center), or along an edge of the page. */
export type DropTarget = { window: WindowName; side: Side | "center" } | { edge: Side };

/** A folded window's bar, in pixels: the width of a column, or the height of a row. */
export const BAR = 32;
/** A divider's thickness, in pixels. */
export const DIVIDER = 6;

export const isPair = (item: Item): item is Pair => typeof item !== "string";
const other = (dir: Dir): Dir => (dir === "row" ? "column" : "row");
const members = (item: Item): WindowName[] => (isPair(item) ? [item.a, item.b] : [item]);

/** The windows in reading order. */
export const order = (a: Arrangement): WindowName[] => a.items.flatMap(members);

/** The item a window is in, and where. */
function locate(a: Arrangement, w: WindowName): { index: number; inPair: "a" | "b" | null } {
  const index = a.items.findIndex((item) => members(item).includes(w));
  const item = a.items[index];
  return { index, inPair: isPair(item) ? (item.a === w ? "a" : "b") : null };
}

// ---------------------------------------------------------------- sizes and presets

/** The usual sizes for an arrangement's shape: the code gets a little more room. */
export function defaultSizes(a: Pick<Arrangement, "dir" | "items">): Pick<Arrangement, "weights" | "pairSplit"> {
  const weight = (item: Item) => {
    if (a.items.length === 3) return item === "editor" ? 38 : 31;
    if (isPair(item)) return item.a === "editor" || item.b === "editor" ? 62 : 60;
    return item === "editor" ? 40 : 38;
  };
  const pair = a.items.find(isPair);
  // Memory over loop history gets a little more of the height, as it always has.
  const pairSplit = pair && pair.dir === "column" && pair.a === "memory" ? 55 : 50;
  return { weights: a.items.map(weight), pairSplit };
}

const withDefaults = (a: Pick<Arrangement, "dir" | "items">): Arrangement => ({ ...a, ...defaultSizes(a) });

/** The code beside memory over loop history (the default). `end`: the code on the right. */
export function stackedPreset(end = false): Arrangement {
  const a = withDefaults({ dir: "row", items: ["editor", { dir: "column", a: "memory", b: "loop" }] });
  return end ? mirror(a) : a;
}

/** The code, memory and loop history side by side. `end`: the code on the right. */
export function columnsPreset(end = false): Arrangement {
  const items: WindowName[] = end ? ["memory", "loop", "editor"] : ["editor", "memory", "loop"];
  return withDefaults({ dir: "row", items });
}

/** Is this a row of all three (the toolbar's Side by side)? */
export const isColumns = (a: Arrangement): boolean => a.dir === "row" && a.items.length === 3;
/** Is the code the last thing in a row (the right-hand side)? */
export const editorAtEnd = (a: Arrangement): boolean =>
  a.dir === "row" && members(a.items[a.items.length - 1]).includes("editor") && a.items.length > 1;

/** The same arrangement back to front (the ⇄ button), sizes and all. */
export function mirror(a: Arrangement): Arrangement {
  return { ...a, items: [...a.items].reverse(), weights: [...a.weights].reverse() };
}

/**
 * The code to the other side of the page (the ⇄ button): from the start of
 * the row (or column) to its end, or back, with the other windows keeping
 * their order. With the code in the middle, the page is mirrored.
 */
export function swapSides(a: Arrangement): Arrangement {
  const at = a.items.findIndex((item) => members(item).includes("editor"));
  const last = a.items.length - 1;
  if (at !== 0 && at !== last) return mirror(a);
  const move = <T>(list: T[]) => (at === 0 ? [...list.slice(1), list[0]] : [list[last], ...list.slice(0, last)]);
  return { ...a, items: move(a.items), weights: move(a.weights) };
}

/**
 * The arrangement from settings saved before windows could be moved: the
 * layout (stacked or side by side), which side the code was on, and the
 * dividers' positions.
 */
export function legacyArrangement(saved: {
  columns: boolean;
  swapped: boolean;
  split: number | null;
  canvasSplit: number | null;
  columnSplit: number | null;
}): Arrangement {
  const split = clampShare(saved.split ?? 40);
  let a: Arrangement;
  if (saved.columns) {
    const memoryShare = clampShare(saved.columnSplit ?? 50) / 100;
    a = { ...columnsPreset(), weights: [split, (100 - split) * memoryShare, (100 - split) * (1 - memoryShare)] };
  } else {
    a = { ...stackedPreset(), weights: [split, 100 - split], pairSplit: clampShare(saved.canvasSplit ?? 55) };
  }
  return saved.swapped ? swapSides(a) : a;
}

const clampShare = (n: number) => Math.min(85, Math.max(15, Number.isFinite(n) ? n : 50));

// ---------------------------------------------------------------- reading saved arrangements

/** An arrangement from saved JSON, or null if it isn't a valid one. */
export function parseArrangement(json: string | null): Arrangement | null {
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<Record<keyof Arrangement, unknown>>;
  if (r.dir !== "row" && r.dir !== "column") return null;
  if (!Array.isArray(r.items)) return null;
  const items: Item[] = [];
  for (const item of r.items) {
    if (isWindow(item)) items.push(item);
    else if (typeof item === "object" && item !== null) {
      const p = item as Partial<Pair>;
      if (p.dir !== other(r.dir) || !isWindow(p.a) || !isWindow(p.b)) return null;
      items.push({ dir: p.dir, a: p.a, b: p.b });
    } else return null;
  }
  const windows = items.flatMap(members);
  const shapeOk =
    (items.length === 3 && items.every((i) => !isPair(i))) || (items.length === 2 && items.filter(isPair).length === 1);
  if (!shapeOk || windows.length !== 3 || new Set(windows).size !== 3) return null;
  const defaults = defaultSizes({ dir: r.dir, items });
  const weights =
    Array.isArray(r.weights) &&
    r.weights.length === items.length &&
    r.weights.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)
      ? (r.weights as number[]).map((w) => Math.round(w * 100) / 100)
      : defaults.weights;
  const pairSplit = typeof r.pairSplit === "number" ? clampShare(r.pairSplit) : defaults.pairSplit;
  return { dir: r.dir, items, weights, pairSplit };
}

// ---------------------------------------------------------------- moving windows

/** Do two arrangements put the windows in the same places (sizes aside)? */
export const samePlaces = (x: Arrangement, y: Arrangement): boolean =>
  JSON.stringify([x.dir, x.items]) === JSON.stringify([y.dir, y.items]);

/** Two windows trade places; everything keeps its size. */
export function swapWindows(a: Arrangement, x: WindowName, y: WindowName): Arrangement {
  const swap = (w: WindowName): WindowName => (w === x ? y : w === y ? x : w);
  const items = a.items.map((item) => (isPair(item) ? { ...item, a: swap(item.a), b: swap(item.b) } : swap(item)));
  return { ...a, items };
}

const dirOf = (side: Side): Dir => (side === "left" || side === "right" ? "row" : "column");
const before = (side: Side) => side === "left" || side === "top";

/**
 * Move a window: beside another (on one of its sides), in its place (the
 * two swap), or along a whole edge of the page. Sizes go back to the usual
 * ones for the new shape, except for a swap.
 */
export function moveWindow(a: Arrangement, dragged: WindowName, target: DropTarget): Arrangement {
  if ("window" in target && target.window === dragged) return a;
  if ("window" in target && target.side === "center") return swapWindows(a, dragged, target.window);

  // The other two, as they'd be without the dragged window: a split of two.
  const rest = remaining(a, dragged);
  const side = "edge" in target ? target.edge : (target.side as Side);
  const dir = dirOf(side);

  let next: Pick<Arrangement, "dir" | "items">;
  if ("edge" in target) {
    // Along a whole edge: the dragged window, then the other two together.
    if (rest.dir === dir) next = { dir, items: before(side) ? [dragged, ...rest.items] : [...rest.items, dragged] };
    else {
      const pair: Pair = { dir: rest.dir, a: rest.items[0], b: rest.items[1] };
      next = { dir, items: before(side) ? [dragged, pair] : [pair, dragged] };
    }
  } else if (rest.dir === dir) {
    // Beside a window in the same direction: a line of three.
    const at = rest.items.indexOf(target.window);
    const items: Item[] = [...rest.items];
    items.splice(before(side) ? at : at + 1, 0, dragged);
    next = { dir, items };
  } else {
    // Across: the target and the dragged window become a pair.
    const pair: Pair = before(side) ? { dir, a: dragged, b: target.window } : { dir, a: target.window, b: dragged };
    next = { dir: rest.dir, items: rest.items.map((w) => (w === target.window ? pair : w)) };
  }
  return withDefaults(next);
}

/** The arrangement of the other two windows once one is taken out. */
function remaining(a: Arrangement, out: WindowName): { dir: Dir; items: [WindowName, WindowName] } {
  const { index, inPair } = locate(a, out);
  if (inPair) {
    // Out of a pair: its partner takes the pair's place in the line.
    const pair = a.items[index] as Pair;
    const partner = inPair === "a" ? pair.b : pair.a;
    const items = a.items.map((item, i) => (i === index ? partner : (item as WindowName)));
    return { dir: a.dir, items: items as [WindowName, WindowName] };
  }
  const left = a.items.filter((_, i) => i !== index);
  if (left.length === 1) {
    // Beside a pair: the pair is what's left.
    const pair = left[0] as Pair;
    return { dir: pair.dir, items: [pair.a, pair.b] };
  }
  return { dir: a.dir, items: left as [WindowName, WindowName] };
}

// ---------------------------------------------------------------- grid tracks

/** A grid track: fixed pixels, or a share of what's left. */
export type Track = { px: number } | { fr: number };
/** Grid lines, 1-based, end exclusive: [start, end). */
export interface Place {
  column: [number, number];
  row: [number, number];
}

export interface DividerTrack {
  place: Place;
  /** "x": an upright bar, dragged sideways. */
  axis: "x" | "y";
  /** Something to resize: both sides open. */
  active: boolean;
  /** What it resizes: the two root items either side of it, or the pair. */
  between: { root: number } | "pair";
}

export interface Tracks {
  columns: Track[];
  rows: Track[];
  windows: Record<WindowName, Place>;
  /** The page's two dividers, in order. */
  dividers: [DividerTrack, DividerTrack];
  /** Does this window's folded bar stand upright (in a column)? */
  upright: Record<WindowName, boolean>;
}

export const trackCss = (tracks: Track[]): string =>
  tracks.map((t) => ("px" in t ? `${t.px}px` : `minmax(0, ${t.fr}fr)`)).join(" ");
export const placeCss = (p: Place, rowOffset = 0) => ({
  column: `${p.column[0]} / ${p.column[1]}`,
  row: `${p.row[0] + rowOffset} / ${p.row[1] + rowOffset}`,
});

/**
 * The grid for an arrangement, with some windows folded to bars. Laid out
 * along the root's direction (the main axis) and across it: a line of three
 * has one cross track; a window beside a pair has three (the pair's two and
 * the divider between them), which the single window spans.
 */
export function tracks(a: Arrangement, folded: readonly WindowName[]): Tracks {
  const isFolded = (w: WindowName) => folded.includes(w);
  const itemFolded = (item: Item) => members(item).every(isFolded);
  const pair = a.items.find(isPair);

  // Along the main axis: each item, with a divider between neighbors.
  const main: Track[] = [];
  a.items.forEach((item, i) => {
    if (i > 0) main.push({ px: itemFolded(a.items[i - 1]) || itemFolded(item) ? 0 : DIVIDER });
    main.push(itemFolded(item) ? { px: BAR } : { fr: a.weights[i] });
  });

  // Across: a pair's two windows and its divider.
  let cross: Track[] = [{ fr: 1 }];
  if (pair) {
    const [fa, fb] = [isFolded(pair.a), isFolded(pair.b)];
    if (fa && fb) cross = [{ fr: 1 }, { px: 0 }, { fr: 1 }];
    else
      cross = [
        fa ? { px: BAR } : { fr: a.pairSplit },
        { px: fa || fb ? 0 : DIVIDER },
        fb ? { px: BAR } : { fr: 100 - a.pairSplit },
      ];
  }

  // Places in (main, cross) terms, then turned into columns and rows.
  const crossAll: [number, number] = [1, cross.length + 1];
  const placed = new Map<WindowName, { main: [number, number]; cross: [number, number] }>();
  const dividers: {
    main: [number, number];
    cross: [number, number];
    along: "main" | "cross";
    between: DividerTrack["between"];
    active: boolean;
  }[] = [];
  a.items.forEach((item, i) => {
    const m: [number, number] = [2 * i + 1, 2 * i + 2];
    if (i > 0)
      dividers.push({
        main: [2 * i, 2 * i + 1],
        cross: crossAll,
        along: "main",
        between: { root: i - 1 },
        active: (main[2 * i - 1] as { px: number }).px > 0,
      });
    if (isPair(item)) {
      placed.set(item.a, { main: m, cross: [1, 2] });
      placed.set(item.b, { main: m, cross: [3, 4] });
      dividers.push({
        main: m,
        cross: [2, 3],
        along: "cross",
        between: "pair",
        active: (cross[1] as { px: number }).px > 0,
      });
    } else placed.set(item, { main: m, cross: crossAll });
  });
  // dividers in page order: the first root divider, then the second (or the pair's)
  dividers.sort((x, y) => (x.between === "pair" ? 1 : 0) - (y.between === "pair" ? 1 : 0));

  const row = a.dir === "row";
  const toPlace = (p: { main: [number, number]; cross: [number, number] }): Place =>
    row ? { column: p.main, row: p.cross } : { column: p.cross, row: p.main };

  const windows = Object.fromEntries(WINDOWS.map((w) => [w, toPlace(placed.get(w)!)])) as Record<WindowName, Place>;
  const dividerTracks = dividers.map((d) => ({
    place: toPlace(d),
    // A divider along the main axis of a row stands upright.
    axis: (d.along === "main") === row ? "x" : "y",
    active: d.active,
    between: d.between,
  })) as [DividerTrack, DividerTrack];

  // A folded window's bar stands upright when the track that folded is a column.
  const upright = {} as Record<WindowName, boolean>;
  for (const w of WINDOWS) {
    const { index, inPair } = locate(a, w);
    const foldsMain = !inPair || itemFolded(a.items[index]);
    upright[w] = foldsMain ? row : !row;
  }
  return {
    columns: row ? main : cross,
    rows: row ? cross : main,
    windows,
    dividers: dividerTracks,
    upright,
  };
}

/** Sizes of a list of tracks in `total` pixels: fixed ones first, the rest shared by weight. */
export function solveTracks(list: Track[], total: number): number[] {
  const fixed = list.reduce((sum, t) => sum + ("px" in t ? t.px : 0), 0);
  const weight = list.reduce((sum, t) => sum + ("fr" in t ? t.fr : 0), 0);
  const free = Math.max(0, total - fixed);
  return list.map((t) => ("px" in t ? t.px : weight ? (free * t.fr) / weight : 0));
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where each window would be in `area`, the same as the grid puts it. */
export function windowRects(a: Arrangement, folded: readonly WindowName[], area: Rect): Record<WindowName, Rect> {
  const t = tracks(a, folded);
  const edges = (list: Track[], start: number, total: number) => {
    const sizes = solveTracks(list, total);
    const lines = [start];
    for (const s of sizes) lines.push(lines[lines.length - 1] + s);
    return lines;
  };
  const xs = edges(t.columns, area.x, area.width);
  const ys = edges(t.rows, area.y, area.height);
  const out = {} as Record<WindowName, Rect>;
  for (const w of WINDOWS) {
    const p = t.windows[w];
    out[w] = {
      x: xs[p.column[0] - 1],
      y: ys[p.row[0] - 1],
      width: xs[p.column[1] - 1] - xs[p.column[0] - 1],
      height: ys[p.row[1] - 1] - ys[p.row[0] - 1],
    };
  }
  return out;
}

// ---------------------------------------------------------------- where a drop goes

/** How close to the page's edge counts as "along that edge", in pixels. */
export const EDGE_ZONE = 28;
/** The middle of a window (this share of each side) means "swap places". */
const CENTER = 0.3;

/**
 * Where a window dragged to `point` would go: along an edge of the page when
 * the pointer is near one, else beside the window under it (on its nearest
 * side), or in its place from its middle. Null over the dragged window itself.
 */
export function dropTargetAt(
  point: { x: number; y: number },
  rects: Record<WindowName, Rect>,
  area: Rect,
  dragged: WindowName,
): DropTarget | null {
  const near = {
    left: point.x - area.x,
    right: area.x + area.width - point.x,
    top: point.y - area.y,
    bottom: area.y + area.height - point.y,
  };
  const edge = (Object.keys(near) as Side[]).reduce((best, side) => (near[side] < near[best] ? side : best), "left");
  if (near[edge] < EDGE_ZONE) return { edge };

  const over = WINDOWS.find((w) => {
    const r = rects[w];
    return point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
  });
  if (!over || over === dragged) return null;
  const r = rects[over];
  const u = (point.x - r.x) / r.width;
  const v = (point.y - r.y) / r.height;
  if (Math.abs(u - 0.5) < CENTER / 2 + 0.05 && Math.abs(v - 0.5) < CENTER / 2 + 0.05)
    return { window: over, side: "center" };
  const sides: Record<Side, number> = { left: u, right: 1 - u, top: v, bottom: 1 - v };
  const side = (Object.keys(sides) as Side[]).reduce((best, s) => (sides[s] < sides[best] ? s : best), "left");
  return { window: over, side };
}

/** Words for where a window went (for screen readers). */
export function describeTarget(target: DropTarget, names: Record<WindowName, string>): string {
  if ("edge" in target) return `along the ${target.edge} edge`;
  if (target.side === "center") return `in place of ${names[target.window]}`;
  const where = { left: "left of", right: "right of", top: "above", bottom: "below" }[target.side];
  return `${where} ${names[target.window]}`;
}
