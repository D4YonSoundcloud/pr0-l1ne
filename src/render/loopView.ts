/**
 * The loop view: one row per iteration, stacked, with arrows for changes.
 *
 *   before   arr  [5][2][4][1]      i = 0
 *                     ╲╱             <- a swap draws crossing arrows
 *   #1       arr  [2][5][4][1]      i = 0   j = 1
 *                  ^j
 *
 * Only containers and scalars that change during the loop are shown (plus
 * anything used as an index), so unrelated variables stay out of the way.
 */
import { valueKey } from "../trace/diff";
import { findLinkedTrack, linkedRow, linkedSignature, treeDepths, type LinkedRow, type LinkedTrack } from "../trace/linked";
import type { LoopHistory, LoopRow } from "../trace/loopHistory";
import { findGraphs, graphOverlay, graphSignature, layoutFor, legendOverlaysFor, type GraphData, type GraphOverlay, type Scope } from "../trace/graph";
import { graphPicture, type GraphPicture } from "./graphView";
import type { HeapObject, SequenceObject, Trace, Value } from "../trace/types";
import {
  CELL_H, CELL_MIN_W, INDEX_H, POINTER_H, arrowMarkers, cellWidth, changeArrow, pointerMarkers, pointersFor,
  rowPointerMarkers, rowPointersWidth, s, textWidth, uiTextWidth, valueCell,
} from "./draw";

const MARGIN = 20;
const GUTTER_W = 64;
const SCALARS_GAP = 28;   // space between the last container and "i = 2  j = 0"
const ROW_GAP = 34;
const BAND_H = 30;
const CONTAINER_GAP = 44;
const MAX_ROWS = 120;
// Linked track (see trace/linked.ts)
const SLOT_W = 18;        // a node's link slot
const NODE_GAP = 30;      // room between nodes for a straight arrow
const ARC_TOP = 30;       // room above the cells for links that arc over
const ARC_BOTTOM = 26;    // ...and below, for a second link field
const LEVEL_H = CELL_H + 34; // one level of a tree drawn top-down

type ContainerObject = Extract<HeapObject, { kind: "list" | "tuple" | "set" | "dict" }>;

interface Cell { key: string; label: string; value: Value }

function isContainer(obj: HeapObject | undefined): obj is ContainerObject {
  return !!obj && (obj.kind === "list" || obj.kind === "tuple" || obj.kind === "set" || obj.kind === "dict");
}

function cellsOf(obj: ContainerObject): Cell[] {
  switch (obj.kind) {
    case "dict":
      return obj.entries.map(([key, value]) => ({
        key: valueKey(key), label: key.kind === "prim" ? key.repr : "•", value,
      }));
    case "set":
      return obj.items.map((value) => ({ key: valueKey(value), label: "", value }));
    default:
      return obj.items.map((value, index) => ({ key: String(index), label: String(index), value }));
  }
}

function containerIn(row: LoopRow, name: string): ContainerObject | undefined {
  const value = row.frame.locals.find(([n]) => n === name)?.[1];
  if (value?.kind !== "ref") return undefined;
  const obj = row.heap[value.id];
  return isContainer(obj) ? obj : undefined;
}

/** Changes whenever the container or a list directly inside it changes. */
function signature(row: LoopRow, name: string): string {
  const obj = containerIn(row, name);
  if (!obj) return "";
  return obj.id + "|" + cellsOf(obj).map((c) => {
    const inner = c.value.kind === "ref" ? row.heap[c.value.id] : undefined;
    const deep = isContainer(inner) ? `[${cellsOf(inner).map((ic) => valueKey(ic.value)).join(",")}]` : "";
    return c.key + "=" + valueKey(c.value) + deep;
  }).join(",");
}

type Sequence = SequenceObject;

/** A list of lists in this row, as its rows; null if it isn't one. */
function gridIn(row: LoopRow, name: string): Sequence[] | null {
  const obj = containerIn(row, name);
  if (!obj || (obj.kind !== "list" && obj.kind !== "tuple") || !obj.items.length) return null;
  const rows: Sequence[] = [];
  for (const item of obj.items) {
    const inner = item.kind === "ref" ? row.heap[item.id] : undefined;
    if (inner?.kind !== "list" && inner?.kind !== "tuple") return null;
    rows.push(inner);
  }
  return rows;
}

function scalarIn(row: LoopRow, name: string): Value | undefined {
  const value = row.frame.locals.find(([n]) => n === name)?.[1];
  return value?.kind === "prim" ? value : undefined;
}

/** Decide which containers and scalars are worth showing for this loop. */
function pickVariables(trace: Trace, rows: LoopRow[], hasTrack: boolean, exclude: Set<string>): { containers: string[]; scalars: string[] } {
  const containerNames: string[] = [];
  const scalarNames: string[] = [];
  for (const row of rows) {
    for (const [name, value] of row.frame.locals) {
      if (value.kind === "ref" && isContainer(row.heap[value.id])) {
        if (!containerNames.includes(name) && !exclude.has(name)) containerNames.push(name);
      } else if (value.kind === "prim" && !scalarNames.includes(name)) {
        scalarNames.push(name);
      }
    }
  }

  const changes = (read: (row: LoopRow) => string) => rows.some((row, i) => i > 0 && read(row) !== read(rows[i - 1]));
  // An indexed list is worth showing even if it never changes, because its
  // pointer markers (i, lo, hi...) move. Dicts and objects don't get pointer
  // markers, so they're only shown when they change.
  const isSequence = (name: string) => rows.some((row) => {
    const kind = containerIn(row, name)?.kind;
    return kind === "list" || kind === "tuple";
  });
  // `viz: show name` always includes it.
  const shown = new Set(trace.viz?.show ?? []);
  let containers = containerNames.filter((name) => shown.has(name) ||
    (trace.indexNames[name] !== undefined && isSequence(name)) || changes((row) => signature(row, name)));
  // With nothing else to show, fall back to every container. A linked track
  // counts as something to show.
  if (!containers.length && !hasTrack) containers = containerNames.slice(0, 4);

  const lastLocals = new Map(rows[rows.length - 1].frame.locals);
  const indexVars = new Set(containers.flatMap((name) => [
    ...pointersFor(name, trace.indexNames, lastLocals),
    ...pointersFor(`${name}[]`, trace.indexNames, lastLocals),
  ].map((p) => p.name)));
  let scalars = scalarNames.filter((name) => shown.has(name) ||
    indexVars.has(name) || changes((row) => { const v = scalarIn(row, name); return v ? valueKey(v) : ""; }));
  if (!scalars.length) scalars = scalarNames.slice(0, 6);
  return { containers, scalars };
}

function scalarText(row: LoopRow, names: string[]): string {
  return names.map((name) => {
    const value = scalarIn(row, name);
    return value?.kind === "prim" ? `${name} = ${value.repr}` : "";
  }).filter(Boolean).join("   ");
}

interface ContainerColumn {
  name: string;
  x: number;        // where cells start
  cellW: number;
  hasPointers: boolean;
  /** Set when this is a list of lists, drawn as a grid. */
  grid?: { rows: number; cols: number; rowIndexW: number; hasColumnPointers: boolean };
  /** Height of the content under the top line of cells. */
  bodyH: number;
}

type Item = { kind: "row"; row: LoopRow; index: number } | { kind: "band"; from: number; to: number };

interface TrackLayout {
  track: LinkedTrack;
  x: number;        // where the first node starts
  valueW: number;   // width of a node's value cell
  nodeW: number;    // value cell plus link slots
}

const EMPTY: Value = { kind: "prim", type: "none", repr: "" };

/** One row of the linked track: nodes in fixed columns, links as arrows. */
function drawTrack(
  g: SVGGElement,
  arrowLayer: SVGGElement,
  layout: TrackLayout,
  state: LinkedRow,
  prev: LinkedRow | null,
  cellsY: number,
): void {
  const { track, valueW, nodeW } = layout;
  const columnX = (index: number) => layout.x + index * (nodeW + NODE_GAP);
  const midY = cellsY + CELL_H / 2;
  const trackG = s("g", { class: "linked-track" });
  g.append(s("text", { class: "container-name", x: layout.x - 8, y: midY, "text-anchor": "end", "dominant-baseline": "central" }, track.typeName));

  track.order.forEach((id, column) => {
    const node = state.nodes.get(id);
    if (!node) return; // not reachable in this row
    const before = prev?.nodes.get(id);
    const nx = columnX(column);
    const nodeG = s("g", {
      class: ["linked-node", prev && !before && "is-new"].filter(Boolean).join(" "),
      "data-flip": `lnode:${id}`, "data-x": nx, "data-y": 0,
    });
    const valueChanged = !!before && valueKey(before.value ?? EMPTY) !== valueKey(node.value ?? EMPTY);
    nodeG.append(valueCell(node.value ?? EMPTY, { x: nx, y: cellsY, w: valueW, changed: valueChanged }).el);

    node.links.forEach((target, k) => {
      const sx = nx + valueW + k * SLOT_W;
      const linkChanged = !!before && before.links[k] !== target;
      nodeG.append(s("g", { class: ["cell", "link-slot", linkChanged && "is-changed"].filter(Boolean).join(" ") },
        s("rect", { x: sx, y: cellsY, width: SLOT_W, height: CELL_H, rx: 3 })));
      if (target === null) {
        // null / None: a slash through the slot.
        nodeG.append(s("line", { class: "null-slash", x1: sx + 4, y1: cellsY + CELL_H - 5, x2: sx + SLOT_W - 4, y2: cellsY + 5 }));
        return;
      }
      const cx = sx + SLOT_W / 2;
      nodeG.append(s("circle", { class: "ref-dot", cx, cy: midY, r: 3.5 }));
      const tColumn = track.order.indexOf(target);
      const tx = columnX(tColumn);
      const span = Math.abs(tColumn - column);
      let d: string;
      if (track.links.length === 1 && tColumn === column + 1) {
        d = `M${cx},${midY} L${tx - 2},${midY}`;
      } else if (k === 0) {
        // Over the top, into the top of the target's value cell.
        const top = cellsY - Math.min(ARC_TOP - 6, 12 + span * 4);
        const ex = tColumn === column ? tx + valueW / 2 - 6 : tx + valueW / 2;
        d = `M${cx},${cellsY} C${cx},${top} ${ex},${top} ${ex},${cellsY - 2}`;
      } else {
        // A second link (e.g. right) goes underneath.
        const bottom = cellsY + CELL_H + Math.min(ARC_BOTTOM + POINTER_H - 6, 14 + span * 4);
        // Land left of center, clear of the pointer markers under the node.
        const ex = tx + Math.min(8, valueW / 4);
        d = `M${cx},${cellsY + CELL_H} C${cx},${bottom} ${ex},${bottom} ${ex},${cellsY + CELL_H + 2}`;
      }
      arrowLayer.append(s("path", {
        d,
        class: ["link-arrow", linkChanged && "is-changed"].filter(Boolean).join(" "),
        "marker-end": linkChanged ? "url(#arrow-change)" : "url(#arrow-ref)",
      }));
    });
    trackG.append(nodeG);
  });

  // Variables that point at nodes, as markers under the node they point at.
  const pointers = state.pointers.map((p) => {
    const was = prev?.pointers.find((q) => q.name === p.name);
    return { ...p, changed: !!prev && was?.index !== p.index };
  });
  if (pointers.length) {
    trackG.append(pointerMarkers(pointers, columnX, valueW, cellsY + CELL_H, track.order.length, { key: "tptr", originX: 0, originY: cellsY }));
  }
  g.append(trackG);
}

/** One row's list of lists, as a grid, with i/j pointers and changes. */
function drawGrid(
  g: SVGGElement,
  column: ContainerColumn,
  row: LoopRow,
  prevRow: LoopRow | null,
  cellsY: number,
  labelsY: number,
  trace: Trace,
  changedNames: Set<string>,
): void {
  const grid = gridIn(row, column.name);
  const before = prevRow ? gridIn(prevRow, column.name) : null;
  const { cellW } = column;
  const containerG = s("g", { class: "loop-container grid" });
  const cols = Math.max(1, ...(grid ?? []).map((r) => r.items.length));
  for (let c = 0; c < cols; c++) {
    containerG.append(s("text", { class: "index", x: column.x + c * cellW + cellW / 2, y: labelsY + 9, "text-anchor": "middle" }, String(c)));
  }
  (grid ?? []).forEach((r, ri) => {
    const ry = cellsY + ri * CELL_H;
    containerG.append(s("text", { class: "index", x: column.x - 6, y: ry + CELL_H / 2, "text-anchor": "end", "dominant-baseline": "central" }, String(ri)));
    if (!r.items.length) {
      containerG.append(s("g", { class: "cell is-empty" }, s("rect", { x: column.x, y: ry, width: cellW, height: CELL_H, rx: 3 })));
    }
    r.items.forEach((item, ci) => {
      const old = before?.[ri]?.items[ci];
      const changed = !!before && (!old || valueKey(old) !== valueKey(item));
      const { el } = valueCell(item, { x: column.x + ci * cellW, y: ry, w: cellW, changed });
      markCell(el, `${column.name}#${ri}`, String(ci), item, ci * cellW);
      containerG.append(el);
    });
  });
  // grid[i][j]: i marks a row (right side), j a column (underneath), and
  // the cell where they meet gets an outline.
  const locals = new Map(row.frame.locals);
  const rowPointers = pointersFor(column.name, trace.indexNames, locals, changedNames);
  // Only real columns: one past the end is nearly always a bound like `cols`.
  const colPointers = pointersFor(`${column.name}[]`, trace.indexNames, locals, changedNames).filter((p) => p.index < cols);
  const rowsCount = grid?.length ?? 0;
  const flip = { key: `ptr:${column.name}`, originX: 0, originY: cellsY };
  if (rowPointers.length) {
    containerG.append(rowPointerMarkers(rowPointers, (ri) => cellsY + ri * CELL_H + CELL_H / 2, column.x + cols * cellW, rowsCount, flip));
  }
  if (colPointers.length) {
    containerG.append(pointerMarkers(colPointers, (ci) => column.x + ci * cellW, cellW, cellsY + rowsCount * CELL_H, cols, flip));
  }
  const ri = rowPointers.find((p) => p.index >= 0 && p.index < rowsCount);
  const ci = colPointers.find((p) => ri && p.index >= 0 && p.index < (grid?.[ri.index].items.length ?? 0));
  if (ri && ci) {
    containerG.append(s("rect", { class: "grid-focus", x: column.x + ci.index * cellW - 2, y: cellsY + ri.index * CELL_H - 2, width: cellW + 4, height: CELL_H + 4, rx: 4 }));
  }
  g.append(containerG);
}

/**
 * One row of a binary tree, drawn top-down: x is the node's in-order column
 * (the same in every row), y is its depth.
 */
function drawTree(
  g: SVGGElement,
  layout: TrackLayout,
  state: LinkedRow,
  prev: LinkedRow | null,
  cellsY: number,
): void {
  const { track, valueW, nodeW } = layout;
  const depths = treeDepths(state);
  const columnX = (index: number) => layout.x + index * (nodeW + NODE_GAP);
  const nodeY = (id: string) => cellsY + (depths.get(id) ?? 0) * LEVEL_H;
  const trackG = s("g", { class: "linked-track tree" });
  // Edges go behind the nodes and labels, so labels stay readable.
  const edgesG = s("g", { class: "tree-edges" });
  g.append(edgesG);
  g.append(s("text", { class: "container-name", x: layout.x - 8, y: cellsY + CELL_H / 2, "text-anchor": "end", "dominant-baseline": "central" }, track.typeName));

  track.order.forEach((id, column) => {
    const node = state.nodes.get(id);
    if (!node) return;
    const before = prev?.nodes.get(id);
    const nx = columnX(column);
    const ny = nodeY(id);
    const nodeG = s("g", {
      class: ["linked-node", prev && !before && "is-new"].filter(Boolean).join(" "),
      "data-flip": `lnode:${id}`, "data-x": nx, "data-y": ny - cellsY,
    });
    const valueChanged = !!before && valueKey(before.value ?? EMPTY) !== valueKey(node.value ?? EMPTY);
    nodeG.append(valueCell(node.value ?? EMPTY, { x: nx, y: ny, w: valueW, changed: valueChanged }).el);
    node.links.forEach((target, k) => {
      const sx = nx + valueW + k * SLOT_W;
      const linkChanged = !!before && before.links[k] !== target;
      nodeG.append(s("g", { class: ["cell", "link-slot", linkChanged && "is-changed"].filter(Boolean).join(" ") },
        s("rect", { x: sx, y: ny, width: SLOT_W, height: CELL_H, rx: 3 })));
      if (target === null) {
        nodeG.append(s("line", { class: "null-slash", x1: sx + 4, y1: ny + CELL_H - 5, x2: sx + SLOT_W - 4, y2: ny + 5 }));
        return;
      }
      nodeG.append(s("circle", { class: "ref-dot", cx: sx + SLOT_W / 2, cy: ny + CELL_H / 2, r: 3.5 }));
      // From the bottom of the slot down to the top of the child.
      const tx = columnX(track.order.indexOf(target)) + valueW / 2;
      const ty = nodeY(target);
      const from = { x: sx + SLOT_W / 2, y: ny + CELL_H };
      const d = ty > from.y
        ? `M${from.x},${from.y} C${from.x},${from.y + 18} ${tx},${ty - 18} ${tx},${ty - 2}`
        : `M${from.x},${from.y} C${from.x},${from.y + 30} ${tx},${ty - 30} ${tx},${ty - 2}`;
      edgesG.append(s("path", {
        d,
        class: ["link-arrow", linkChanged && "is-changed"].filter(Boolean).join(" "),
        "marker-end": linkChanged ? "url(#arrow-change)" : "url(#arrow-ref)",
      }));
    });
    trackG.append(nodeG);
  });

  // Pointer markers under the node they point at, at that node's depth.
  const byDepth = new Map<number, { name: string; index: number; changed: boolean }[]>();
  for (const p of state.pointers) {
    const depth = depths.get(track.order[p.index]) ?? 0;
    const was = prev?.pointers.find((q) => q.name === p.name);
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), { ...p, changed: !!prev && was?.index !== p.index }]);
  }
  for (const [depth, pointers] of byDepth) {
    trackG.append(pointerMarkers(pointers, columnX, valueW, cellsY + depth * LEVEL_H + CELL_H, track.order.length,
      { key: "tptr", originX: 0, originY: cellsY }));
  }
  g.append(trackG);
}

export interface LoopViewOptions {
  hideQuiet: boolean;
  /**
   * Animated mode: draw just the live state (`current`), compared with the
   * previous step (`prev`), instead of a row per iteration. What to show and
   * the column widths still come from the full history, so the picture
   * stays steady from step to step.
   */
  live?: { prev: LoopRow; current: LoopRow };
}

/** Mark a cell so a value moving between slots can slide (render/animate.ts). */
function markCell(el: SVGGElement, container: string, slot: string, value: Value, cx: number): void {
  el.setAttribute("data-cell", `${container}|${slot}`);
  el.setAttribute("data-value", valueKey(value));
  el.setAttribute("data-cx", String(Math.round(cx)));
  el.setAttribute("data-cy", "0");
}

/** Graphs found in each loop row, by step and frame: the same for the whole run. */
const graphCache = new WeakMap<Trace, Map<string, GraphData[]>>();

export function renderLoopHistory(trace: Trace, history: LoopHistory, options: LoopViewOptions): SVGSVGElement {
  const { rows } = history;
  const live = options.live;
  // Every row that will be measured; in animated mode, plus the live ones.
  const all = live ? [...rows, live.prev, live.current] : rows;
  // A graph in view (the loop's variables, or globals): drawn in every row
  // with that row's state on it. The first one found wins; hinted ones
  // are found first.
  const scopesOf = (row: LoopRow): Scope[] => {
    const global = trace.steps[row.stepIndex]?.stack[0];
    return global && global.id !== row.frame.id ? [global.locals, row.frame.locals] : [row.frame.locals];
  };
  let cache = graphCache.get(trace);
  if (!cache) graphCache.set(trace, (cache = new Map()));
  const found = all.map((row) => {
    const key = `${row.stepIndex}:${row.frame.id}`;
    let graphs = cache!.get(key);
    if (!graphs) cache!.set(key, (graphs = findGraphs(trace, scopesOf(row), row.heap)));
    return graphs;
  });
  const graphId = found.flat()[0]?.id;
  const graphRows: ({ graph: GraphData; overlay: GraphOverlay } | null)[] = all.map((row, i) => {
    const graph = graphId ? found[i].find((g) => g.id === graphId) : undefined;
    return graph ? { graph, overlay: graphOverlay(trace, graph, scopesOf(row), row.heap) } : null;
  });
  const firstGraph = graphRows.find(Boolean)?.graph;
  // The graph's own container isn't repeated as a row of cells.
  const graphHosts = new Set(graphRows.flatMap((r) => (r ? [r.graph.hostId] : [])));
  const exclude = new Set(all.flatMap((row) => row.frame.locals
    .filter(([, v]) => v.kind === "ref" && graphHosts.has(v.id) && !firstGraph?.objectNodes).map(([name]) => name)));

  let track = findLinkedTrack(all.map((row) => ({ locals: row.frame.locals, heap: row.heap })), trace.viz?.linked);
  if (track && firstGraph?.objectNodes && track.typeName === firstGraph.name) track = null;
  const trackRows: (LinkedRow | null)[] = all.map((row) =>
    track ? linkedRow(track, { locals: row.frame.locals, heap: row.heap }) : null);
  const { containers, scalars } = pickVariables(trace, rows, !!track || !!firstGraph, exclude);

  // Column layout is shared by every row, so cells line up vertically.
  const columns: ContainerColumn[] = [];
  let x = MARGIN + GUTTER_W;
  // The graph goes first, one picture per row, all the same size.
  let graphLayout: { x: number; layout: ReturnType<typeof layoutFor>; overlays: GraphOverlay[]; h: number } | null = null;
  if (firstGraph) {
    const layout = layoutFor(trace, firstGraph);
    const overlays = [...graphRows.flatMap((r) => (r ? [r.overlay] : [])), ...legendOverlaysFor(trace, firstGraph)];
    const sample: GraphPicture = graphPicture(firstGraph, layout, overlays[0], { flipKey: "g", legendOverlays: overlays });
    const labelW = textWidth(firstGraph.name) + 12;
    graphLayout = { x: x + labelW, layout, overlays, h: sample.h };
    x += labelW + sample.w + CONTAINER_GAP;
  }
  for (const name of containers) {
    const labelW = textWidth(name) + 12;
    // A list of lists in every row where it has items: draw it as a grid.
    const present = all.filter((row) => (containerIn(row, name) && cellsOf(containerIn(row, name)!).length));
    if (present.length && present.every((row) => gridIn(row, name))) {
      let cellW = CELL_MIN_W;
      let gridRows = 1;
      let cols = 1;
      let pointersW = 0;
      let hasColumnPointers = false;
      for (const row of present) {
        const grid = gridIn(row, name)!;
        gridRows = Math.max(gridRows, grid.length);
        for (const r of grid) {
          cols = Math.max(cols, r.items.length);
          for (const item of r.items) cellW = Math.max(cellW, cellWidth(item));
        }
        const locals = new Map(row.frame.locals);
        pointersW = Math.max(pointersW, rowPointersWidth(pointersFor(name, trace.indexNames, locals)));
        const widest = Math.max(0, ...grid.map((r) => r.items.length));
        if (pointersFor(`${name}[]`, trace.indexNames, locals).some((p) => p.index < widest)) hasColumnPointers = true;
      }
      const rowIndexW = textWidth(String(gridRows - 1), 10.5) + 10;
      columns.push({
        name, x: x + labelW + rowIndexW, cellW, hasPointers: hasColumnPointers,
        grid: { rows: gridRows, cols, rowIndexW, hasColumnPointers },
        bodyH: gridRows * CELL_H + (hasColumnPointers ? POINTER_H : 6),
      });
      x += labelW + rowIndexW + cols * cellW + pointersW + CONTAINER_GAP;
      continue;
    }
    let cellW = CELL_MIN_W;
    let maxCells = 1;
    let hasPointers = false;
    for (const row of all) {
      const obj = containerIn(row, name);
      if (!obj) continue;
      const cells = cellsOf(obj);
      maxCells = Math.max(maxCells, cells.length);
      for (const cell of cells) cellW = Math.max(cellW, cellWidth(cell.value), textWidth(cell.label, 11) + 10);
      if (pointersFor(name, trace.indexNames, new Map(row.frame.locals)).length) hasPointers = true;
    }
    columns.push({ name, x: x + labelW, cellW, hasPointers, bodyH: CELL_H + (hasPointers ? POINTER_H : 6) });
    x += labelW + maxCells * cellW + CONTAINER_GAP;
  }
  // The linked track goes after the containers, with nodes in fixed columns.
  let trackLayout: TrackLayout | null = null;
  if (track) {
    let valueW = CELL_MIN_W;
    for (const state of trackRows) {
      for (const node of state!.nodes.values()) if (node.value) valueW = Math.max(valueW, cellWidth(node.value));
    }
    const nodeW = valueW + track.links.length * SLOT_W;
    const labelW = textWidth(track.typeName) + 12;
    trackLayout = { track, x: x + labelW, valueW, nodeW };
    x += labelW + track.order.length * (nodeW + NODE_GAP) - NODE_GAP + CONTAINER_GAP;
  }
  const hasContent = columns.length > 0 || !!track || !!firstGraph;

  const scalarsX = hasContent ? x - CONTAINER_GAP + SCALARS_GAP : MARGIN + GUTTER_W;
  const scalarsW = Math.max(0, ...all.map((row) => scalarText(row, scalars).length)) * 12.5 * 0.6;
  const contentW = scalarsX + scalarsW;
  // Space above the cells: index labels, or arcs for links that jump over
  // nodes. Below: whatever is tallest (a grid, a tree, pointer markers).
  const isTree = track?.shape === "tree";
  const rowTop = track && !isTree ? ARC_TOP : INDEX_H;
  const trackPointers = trackRows.some((r) => !!r?.pointers.length);
  let trackBodyH = 0;
  if (track && isTree) {
    const levels = Math.max(1, ...trackRows.map((r) => Math.max(0, ...treeDepths(r!).values()) + 1));
    trackBodyH = (levels - 1) * LEVEL_H + CELL_H + POINTER_H;
  } else if (track) {
    trackBodyH = CELL_H + (trackPointers ? POINTER_H : 6) + (track.links.length > 1 ? ARC_BOTTOM : 0);
  }
  const rowH = Math.max(rowTop + Math.max(CELL_H + 6, trackBodyH, ...columns.map((c) => c.bodyH)), graphLayout?.h ?? 0);

  // Which rows changed something compared with the row before?
  const trackSignature = (i: number) => (trackRows[i] ? linkedSignature(trackRows[i]!) : "");
  const changed = rows.map((row, i) =>
    i === 0 ||
    containers.some((name) => signature(row, name) !== signature(rows[i - 1], name)) ||
    trackSignature(i) !== trackSignature(i - 1) ||
    graphSignature(graphRows[i]?.graph, graphRows[i]?.overlay) !== graphSignature(graphRows[i - 1]?.graph, graphRows[i - 1]?.overlay));

  // Collapse runs of quiet iterations into a single band, but only for loops
  // that mutate data. In a read-only loop (a search, a scan) the moving
  // indices are the story, so every row stays.
  const mutates = changed.some((c, i) => c && i > 0);
  const items: Item[] = [];
  rows.forEach((row, index) => {
    const isLast = index === rows.length - 1;
    if (!options.hideQuiet || !mutates || changed[index] || isLast || !hasContent) {
      items.push({ kind: "row", row, index });
      return;
    }
    const prev = items[items.length - 1];
    if (prev?.kind === "band") prev.to = row.iteration;
    else items.push({ kind: "band", from: row.iteration, to: row.iteration });
  });
  let hiddenRows = 0;
  const rowItems = items.filter((item) => item.kind === "row").length;
  if (rowItems > MAX_ROWS) {
    let toDrop = rowItems - MAX_ROWS;
    while (toDrop > 0 && items.length) {
      const dropped = items.shift()!;
      if (dropped.kind === "row") { toDrop--; hiddenRows++; }
    }
  }

  const svg = s("svg", { class: "loop-svg", xmlns: "http://www.w3.org/2000/svg" });
  svg.append(arrowMarkers());
  const rowLayer = s("g", { class: "loop-rows" });
  const arrowLayer = s("g", { class: "arrows" });
  svg.append(rowLayer, arrowLayer);

  let y = MARGIN;
  if (hiddenRows && !live) {
    rowLayer.append(s("text", { class: "loop-note", x: MARGIN, y: y + 12 }, `${hiddenRows} earlier iterations not shown`));
    y += 28;
  }

  let prevDrawn: { row: LoopRow; y: number; index: number } | null = null;
  if (live) {
    // One row: the live state, compared with the step before it.
    items.length = 0;
    items.push({ kind: "row", row: live.current, index: all.length - 1 });
    prevDrawn = { row: live.prev, y: Number.NaN, index: all.length - 2 };
  }
  for (const item of items) {
    if (item.kind === "band") {
      const text = item.from === item.to ? `#${item.from}: nothing changed` : `#${item.from} to #${item.to}: nothing changed`;
      const textX = MARGIN + GUTTER_W;
      rowLayer.append(s("g", { class: "quiet-band" },
        s("line", { x1: MARGIN, x2: contentW, y1: y + BAND_H / 2, y2: y + BAND_H / 2 }),
        s("rect", { x: textX - 8, y: y + 4, width: uiTextWidth(text, 12.5) + 16, height: BAND_H - 8, rx: 4 }),
        s("text", { x: textX, y: y + BAND_H / 2, "dominant-baseline": "central" }, text)));
      y += BAND_H + 6;
      continue;
    }

    const { row, index } = item;
    const isCurrent = live ? true : history.running && index === rows.length - 1;
    const prevRow = index > 0 ? all[index - 1] : null;
    // data-top / data-bottom: the row's extent, so the viewport can keep it
    // in view without measuring the page.
    const g = s("g", { class: ["loop-row", isCurrent && "is-current"].filter(Boolean).join(" "), "data-top": y - 6, "data-bottom": y + rowH + 4 });
    if (isCurrent) {
      g.append(s("rect", { class: "current-band", x: MARGIN - 8, y: y - 6, width: contentW - MARGIN + 16, height: rowH + 10, rx: 6 }));
    }
    const cellsY = y + rowTop;
    const labelsY = cellsY - INDEX_H;
    const midY = cellsY + CELL_H / 2;
    g.append(s("text", { class: "iteration-label", x: MARGIN, y: midY, "dominant-baseline": "central" },
      row.iteration === 0 ? "before" : `#${row.iteration}`));

    // Scalars to the right of the cells: "i = 2   j = 0", changes emphasized.
    const scalarLine = s("text", { class: "scalars", x: scalarsX, y: midY, "dominant-baseline": "central" });
    let first = true;
    for (const name of scalars) {
      const value = scalarIn(row, name);
      if (value?.kind !== "prim") continue;
      const before = prevRow ? scalarIn(prevRow, name) : undefined;
      const isChanged = !!prevRow && (!before || valueKey(before) !== valueKey(value));
      scalarLine.append(s("tspan", { class: isChanged ? "is-changed" : null, dx: first ? 0 : 22 }, `${name} = ${value.repr}`));
      first = false;
    }
    g.append(scalarLine);
    const changedNames = new Set(scalars.filter((name) => {
      const a = scalarIn(row, name);
      const b = prevRow ? scalarIn(prevRow, name) : undefined;
      return !!prevRow && (!a || !b || valueKey(a) !== valueKey(b));
    }));

    for (const column of columns) {
      const obj = containerIn(row, column.name);
      const nameX = column.x - 8 - (column.grid?.rowIndexW ?? 0);
      g.append(s("text", { class: "container-name", x: nameX, y: midY, "text-anchor": "end", "dominant-baseline": "central" }, column.name));
      if (!obj) continue;
      if (column.grid) {
        drawGrid(g, column, row, prevDrawn?.row ?? null, cellsY, labelsY, trace, changedNames);
        continue;
      }
      const cells = cellsOf(obj);
      const prevObj = prevDrawn ? containerIn(prevDrawn.row, column.name) : undefined;
      const replaced = !!prevObj && prevObj.id !== obj.id;
      const prevCells = prevObj && !replaced ? cellsOf(prevObj) : [];
      const prevByKey = new Map(prevCells.map((c) => [c.key, c]));
      const prevIndexOf = new Map(prevCells.map((c, i) => [c.key, i]));

      const changedKeys = new Set(cells.filter((c) => {
        const p = prevByKey.get(c.key);
        return !!prevObj && (!p || valueKey(p.value) !== valueKey(c.value));
      }).map((c) => c.key));

      const containerG = s("g", { class: ["loop-container", replaced && "is-new"].filter(Boolean).join(" ") });
      if (!cells.length) {
        containerG.append(s("g", { class: "cell is-empty" },
          s("rect", { x: column.x, y: cellsY, width: column.cellW, height: CELL_H, rx: 3 }),
          s("text", { class: "value v-none", x: column.x + column.cellW / 2, y: cellsY + CELL_H / 2, "text-anchor": "middle", "dominant-baseline": "central" }, "∅")));
      }
      cells.forEach((cell, i) => {
        const cx = column.x + i * column.cellW;
        if (cell.label) containerG.append(s("text", { class: "index", x: cx + column.cellW / 2, y: labelsY + 9, "text-anchor": "middle" }, cell.label));
        const { el } = valueCell(cell.value, { x: cx, y: cellsY, w: column.cellW, changed: changedKeys.has(cell.key) });
        markCell(el, column.name, cell.key, cell.value, cx);
        containerG.append(el);
      });
      if (obj.kind !== "dict" && obj.kind !== "set") {
        const pointers = pointersFor(column.name, trace.indexNames, new Map(row.frame.locals), changedNames);
        if (pointers.length) {
          containerG.append(pointerMarkers(pointers, (i) => column.x + i * column.cellW, column.cellW, cellsY + CELL_H, cells.length,
            { key: `ptr:${column.name}`, originX: 0, originY: 0 }));
        }
      }
      g.append(containerG);

      // Change arrows from the previous drawn row. For lists, a value that
      // moved from another changed index (a swap) gets a crossing arrow.
      // (Animated mode has one row: the values slide instead.)
      if (prevDrawn && prevObj && !replaced && !live) {
        const fromY = prevDrawn.y + rowTop + CELL_H + (column.hasPointers ? POINTER_H - 2 : 2);
        const toY = labelsY - 3;
        const used = new Set<string>();
        const prevByValue = (c: Cell) => prevCells.find((p) =>
          p.key !== c.key && changedKeys.has(p.key) && !used.has(p.key) && valueKey(p.value) === valueKey(c.value));
        cells.forEach((cell, i) => {
          if (!changedKeys.has(cell.key)) return;
          const toX = column.x + i * column.cellW + column.cellW / 2;
          const moved = obj.kind === "list" || obj.kind === "tuple" ? prevByValue(cell) : undefined;
          const sourceKey = moved?.key ?? (prevByKey.has(cell.key) ? cell.key : undefined);
          if (sourceKey === undefined) return;
          if (moved) used.add(moved.key);
          const fromX = column.x + prevIndexOf.get(sourceKey)! * column.cellW + column.cellW / 2;
          arrowLayer.append(changeArrow({ x: fromX, y: fromY }, { x: toX, y: toY }));
        });
      }
    }

    if (trackLayout) {
      // Highlights compare with the row drawn just above, like the containers.
      const prevState = prevDrawn ? trackRows[prevDrawn.index] : null;
      if (isTree) drawTree(g, trackLayout, trackRows[index]!, prevState, cellsY);
      else drawTrack(g, arrowLayer, trackLayout, trackRows[index]!, prevState, cellsY);
    }

    const graphRow = graphRows[index];
    if (graphLayout && firstGraph) {
      g.append(s("text", { class: "container-name", x: graphLayout.x - 8, y: midY, "text-anchor": "end", "dominant-baseline": "central" }, firstGraph.name));
      if (graphRow) {
        const prevGraph = prevDrawn ? graphRows[prevDrawn.index] : null;
        graphPicture(graphRow.graph, graphLayout.layout, graphRow.overlay, {
          flipKey: "gptr", prev: prevGraph ?? null, legendOverlays: graphLayout.overlays,
        }).draw(graphLayout.x, y, g);
      }
    }

    rowLayer.append(g);
    prevDrawn = { row, y, index };
    y += rowH + ROW_GAP;
  }

  const width = contentW + MARGIN;
  const height = y - ROW_GAP + MARGIN;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return svg;
}
