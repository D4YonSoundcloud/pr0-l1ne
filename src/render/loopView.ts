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

import { type Cell, cellsOf, containerIn, evaluatedHeader, gridIn, type LoopScene, scalarIn } from "../scene/loopScene";
import { valueKey } from "../trace/diff";
import type { GraphOverlay } from "../trace/graph";
import { type LinkedRow, type LinkedTrack, treeDepths } from "../trace/linked";
import type { LoopRow } from "../trace/loopHistory";
import { formatBytes } from "../trace/memory";
import { type Mark, toSvg } from "./drawing";
import { type GraphPicture, graphPicture } from "./graphView";

/**
 * A name to the left of a row's content, with its size under it when sizes
 * are shown (in their own color), so storage growth reads down the rows.
 */
function nameLabel(g: Mark, x: number, midY: number, name: string, size: string | null): void {
  g.append(
    s(
      "text",
      { class: "container-name", x, y: size ? midY - 7 : midY, "text-anchor": "end", "dominant-baseline": "central" },
      name,
    ),
  );
  if (size)
    g.append(
      s("text", { class: "loop-size", x, y: midY + 8, "text-anchor": "end", "dominant-baseline": "central" }, size),
    );
}

import type { Value } from "../trace/types";
import {
  arrowMarkers,
  CELL_H,
  CELL_MIN_W,
  cellWidth,
  changeArrow,
  INDEX_H,
  POINTER_H,
  pointerMarkers,
  rowPointerMarkers,
  rowPointersWidth,
  STRIP_H,
  s,
  stripBar,
  textWidth,
  uiTextWidth,
  valueCell,
} from "./draw";

const MARGIN = 20;
const GUTTER_W = 64;
const SCALARS_GAP = 28; // space between the last container and "i = 2  j = 0"
const ROW_GAP = 34;
const BAND_H = 30;
const CONTAINER_GAP = 44;
// Linked track (see trace/linked.ts)
const SLOT_W = 18; // a node's link slot
const NODE_GAP = 30; // room between nodes for a straight arrow
const ARC_TOP = 30; // room above the cells for links that arc over
const ARC_BOTTOM = 26; // ...and below, for a second link field
const LEVEL_H = CELL_H + 34; // one level of a tree drawn top-down

function scalarText(row: LoopRow, names: string[]): string {
  return names
    .map((name) => {
      const value = scalarIn(row, name);
      return value?.kind === "prim" ? `${name} = ${value.repr}` : "";
    })
    .filter(Boolean)
    .join("   ");
}

interface ContainerColumn {
  name: string;
  x: number; // where cells start
  cellW: number;
  hasPointers: boolean;
  /** Set when this is a list of lists, drawn as a grid. */
  grid?: { rows: number; cols: number; rowIndexW: number; hasColumnPointers: boolean };
  /** Height of the content under the top line of cells. */
  bodyH: number;
  /** Width of the widest row of cells. */
  cellsW?: number;
  /** Some row is a long list of numbers: a color strip of all of it goes above the cells. */
  strip?: boolean;
  /** Stacked vertically (LoopViewOptions.vertical): its top within the row. */
  dy?: number;
}

/** Indent per level of nesting, in the row labels' gutter. */
const INDENT = 16;

interface TrackLayout {
  track: LinkedTrack;
  x: number; // where the first node starts
  valueW: number; // width of a node's value cell
  nodeW: number; // value cell plus link slots
  /**
   * One above another: separate lists (chains of linked nodes) each on its
   * own line. Each node's line and column; without it, one line in
   * `track.order`'s columns.
   */
  places?: Map<string, { line: number; column: number }>;
  lines?: number;
  /** From one line's cells to the next's. */
  lineStep?: number;
}

const EMPTY: Value = { kind: "prim", type: "none", repr: "" };

/** One row of the linked track: nodes in fixed columns, links as arrows. */
function drawTrack(
  g: Mark,
  arrowLayer: Mark,
  layout: TrackLayout,
  state: LinkedRow,
  prev: LinkedRow | null,
  cellsY: number,
  size: string | null,
): void {
  const { track, valueW, nodeW } = layout;
  const columnX = (index: number) => layout.x + index * (nodeW + NODE_GAP);
  const placeOf = (id: string) => layout.places?.get(id) ?? { line: 0, column: track.order.indexOf(id) };
  const lineStep = layout.lineStep ?? 0;
  const firstCellsY = cellsY;
  const trackG = s("g", { class: "linked-track" });
  // One name for every line, at their middle.
  nameLabel(
    g,
    layout.x - 8,
    firstCellsY + (((layout.lines ?? 1) - 1) * lineStep) / 2 + CELL_H / 2,
    track.typeName,
    size,
  );

  track.order.forEach((id) => {
    const node = state.nodes.get(id);
    if (!node) return; // not reachable in this row
    const { line, column } = placeOf(id);
    const cellsY = firstCellsY + line * lineStep;
    const midY = cellsY + CELL_H / 2;
    const before = prev?.nodes.get(id);
    const nx = columnX(column);
    const nodeG = s("g", {
      class: ["linked-node", prev && !before && "is-new"].filter(Boolean).join(" "),
      "data-flip": `lnode:${id}`,
      "data-x": nx,
      "data-y": line * lineStep,
    });
    const valueChanged = !!before && valueKey(before.value ?? EMPTY) !== valueKey(node.value ?? EMPTY);
    nodeG.append(valueCell(node.value ?? EMPTY, { x: nx, y: cellsY, w: valueW, changed: valueChanged }).el);

    node.links.forEach((target, k) => {
      const sx = nx + valueW + k * SLOT_W;
      const linkChanged = !!before && before.links[k] !== target;
      nodeG.append(
        s(
          "g",
          { class: ["cell", "link-slot", linkChanged && "is-changed"].filter(Boolean).join(" ") },
          s("rect", { x: sx, y: cellsY, width: SLOT_W, height: CELL_H, rx: 3 }),
        ),
      );
      if (target === null) {
        // null / None: a slash through the slot.
        nodeG.append(
          s("line", { class: "null-slash", x1: sx + 4, y1: cellsY + CELL_H - 5, x2: sx + SLOT_W - 4, y2: cellsY + 5 }),
        );
        return;
      }
      const cx = sx + SLOT_W / 2;
      nodeG.append(s("circle", { class: "ref-dot", cx, cy: midY, r: 3.5 }));
      const tColumn = placeOf(target).column;
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
      arrowLayer.append(
        s("path", {
          d,
          class: ["link-arrow", linkChanged && "is-changed"].filter(Boolean).join(" "),
          "marker-end": linkChanged ? "url(#arrow-change)" : "url(#arrow-ref)",
        }),
      );
    });
    trackG.append(nodeG);
  });

  // Variables that point at nodes, as markers under the node they point at.
  const pointers = state.pointers.map((p) => {
    const was = prev?.pointers.find((q) => q.name === p.name);
    return { ...p, changed: !!prev && was?.index !== p.index };
  });
  // Under each line, the markers for its nodes (pointers carry track.order columns).
  for (let line = 0; line < (layout.lines ?? 1); line++) {
    const here = pointers.flatMap((p) => {
      const id = track.order[p.index];
      if (id === undefined) return line === 0 && !layout.places ? [p] : []; // past the end
      const place = placeOf(id);
      return place.line === line ? [{ ...p, index: place.column }] : [];
    });
    if (!here.length) continue;
    const y = firstCellsY + line * lineStep;
    const count = layout.places
      ? Math.max(...[...layout.places.values()].filter((p) => p.line === line).map((p) => p.column)) + 1
      : track.order.length;
    trackG.append(
      pointerMarkers(here, columnX, valueW, y + CELL_H, count, { key: `tptr${line}`, originX: 0, originY: y }),
    );
  }
  g.append(trackG);
}

/** One row's list of lists, as a grid, with i/j pointers and changes. */
function drawGrid(
  g: Mark,
  column: ContainerColumn,
  row: LoopRow,
  prevRow: LoopRow | null,
  cellsY: number,
  labelsY: number,
  scene: LoopScene,
  changedNames: Set<string>,
): void {
  const grid = gridIn(row, column.name);
  const before = prevRow ? gridIn(prevRow, column.name) : null;
  const { cellW } = column;
  const containerG = s("g", { class: "loop-container grid" });
  const cols = Math.max(1, ...(grid ?? []).map((r) => r.items.length));
  for (let c = 0; c < cols; c++) {
    containerG.append(
      s(
        "text",
        { class: "index", x: column.x + c * cellW + cellW / 2, y: labelsY + 9, "text-anchor": "middle" },
        String(c),
      ),
    );
  }
  (grid ?? []).forEach((r, ri) => {
    const ry = cellsY + ri * CELL_H;
    containerG.append(
      s(
        "text",
        { class: "index", x: column.x - 6, y: ry + CELL_H / 2, "text-anchor": "end", "dominant-baseline": "central" },
        String(ri),
      ),
    );
    if (!r.items.length) {
      containerG.append(
        s("g", { class: "cell is-empty" }, s("rect", { x: column.x, y: ry, width: cellW, height: CELL_H, rx: 3 })),
      );
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
  const rowPointers = scene.pointers(row, column.name, changedNames);
  // Only real columns: one past the end is nearly always a bound like `cols`.
  const colPointers = scene.pointers(row, `${column.name}[]`, changedNames).filter((p) => p.index < cols);
  const rowsCount = grid?.length ?? 0;
  const flip = { key: `ptr:${column.name}`, originX: 0, originY: cellsY };
  if (rowPointers.length) {
    containerG.append(
      rowPointerMarkers(
        rowPointers,
        (ri) => cellsY + ri * CELL_H + CELL_H / 2,
        column.x + cols * cellW,
        rowsCount,
        flip,
      ),
    );
  }
  if (colPointers.length) {
    containerG.append(
      pointerMarkers(colPointers, (ci) => column.x + ci * cellW, cellW, cellsY + rowsCount * CELL_H, cols, flip),
    );
  }
  // The cell this row's step works on: from the code's own grid[a][b] on
  // the line that ran (or runs next); a guess only if the code never
  // indexes the grid by this name.
  let focus = scene.gridFocus(row, column.name, { rows: rowsCount, cols: (r) => grid?.[r]?.items.length ?? 0 });
  if (focus === null) {
    const ri = rowPointers.find((p) => p.index >= 0 && p.index < rowsCount);
    const ci = colPointers.find((p) => ri && p.index >= 0 && p.index < (grid?.[ri.index].items.length ?? 0));
    focus = ri && ci ? { row: ri.index, col: ci.index } : "none";
  }
  if (focus !== "none") {
    containerG.append(
      s("rect", {
        class: "grid-focus",
        x: column.x + focus.col * cellW - 2,
        y: cellsY + focus.row * CELL_H - 2,
        width: cellW + 4,
        height: CELL_H + 4,
        rx: 4,
      }),
    );
  }
  g.append(containerG);
}

/**
 * One row of a binary tree, drawn top-down: x is the node's in-order column
 * (the same in every row), y is its depth.
 */
function drawTree(
  g: Mark,
  layout: TrackLayout,
  state: LinkedRow,
  prev: LinkedRow | null,
  cellsY: number,
  size: string | null,
): void {
  const { track, valueW, nodeW } = layout;
  const depths = treeDepths(state);
  const columnX = (index: number) => layout.x + index * (nodeW + NODE_GAP);
  const nodeY = (id: string) => cellsY + (depths.get(id) ?? 0) * LEVEL_H;
  const trackG = s("g", { class: "linked-track tree" });
  // Edges go behind the nodes and labels, so labels stay readable.
  const edgesG = s("g", { class: "tree-edges" });
  g.append(edgesG);
  nameLabel(g, layout.x - 8, cellsY + CELL_H / 2, track.typeName, size);

  track.order.forEach((id, column) => {
    const node = state.nodes.get(id);
    if (!node) return;
    const before = prev?.nodes.get(id);
    const nx = columnX(column);
    const ny = nodeY(id);
    const nodeG = s("g", {
      class: ["linked-node", prev && !before && "is-new"].filter(Boolean).join(" "),
      "data-flip": `lnode:${id}`,
      "data-x": nx,
      "data-y": ny - cellsY,
    });
    const valueChanged = !!before && valueKey(before.value ?? EMPTY) !== valueKey(node.value ?? EMPTY);
    nodeG.append(valueCell(node.value ?? EMPTY, { x: nx, y: ny, w: valueW, changed: valueChanged }).el);
    node.links.forEach((target, k) => {
      const sx = nx + valueW + k * SLOT_W;
      const linkChanged = !!before && before.links[k] !== target;
      nodeG.append(
        s(
          "g",
          { class: ["cell", "link-slot", linkChanged && "is-changed"].filter(Boolean).join(" ") },
          s("rect", { x: sx, y: ny, width: SLOT_W, height: CELL_H, rx: 3 }),
        ),
      );
      if (target === null) {
        nodeG.append(
          s("line", { class: "null-slash", x1: sx + 4, y1: ny + CELL_H - 5, x2: sx + SLOT_W - 4, y2: ny + 5 }),
        );
        return;
      }
      nodeG.append(s("circle", { class: "ref-dot", cx: sx + SLOT_W / 2, cy: ny + CELL_H / 2, r: 3.5 }));
      // From the bottom of the slot down to the top of the child.
      const tx = columnX(track.order.indexOf(target)) + valueW / 2;
      const ty = nodeY(target);
      const from = { x: sx + SLOT_W / 2, y: ny + CELL_H };
      const d =
        ty > from.y
          ? `M${from.x},${from.y} C${from.x},${from.y + 18} ${tx},${ty - 18} ${tx},${ty - 2}`
          : `M${from.x},${from.y} C${from.x},${from.y + 30} ${tx},${ty - 30} ${tx},${ty - 2}`;
      edgesG.append(
        s("path", {
          d,
          class: ["link-arrow", linkChanged && "is-changed"].filter(Boolean).join(" "),
          "marker-end": linkChanged ? "url(#arrow-change)" : "url(#arrow-ref)",
        }),
      );
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
    trackG.append(
      pointerMarkers(pointers, columnX, valueW, cellsY + depth * LEVEL_H + CELL_H, track.order.length, {
        key: "tptr",
        originX: 0,
        originY: cellsY,
      }),
    );
  }
  g.append(trackG);
}

export interface LoopViewOptions {
  /**
   * Each container (and the graph, and the linked list) on its own line,
   * one above another, instead of side by side; the row's label and its
   * variables sit at the middle of the stack.
   */
  vertical?: boolean;
}

const LANE_GAP = 16;

/** Mark a cell so a value moving between slots can slide (render/animate.ts). */
function markCell(el: Mark, container: string, slot: string, value: Value, cx: number): void {
  el.setAttribute("data-cell", `${container}|${slot}`);
  el.setAttribute("data-value", valueKey(value));
  el.setAttribute("data-cx", String(Math.round(cx)));
  el.setAttribute("data-cy", "0");
}

/** The loop history as SVG (for the SVG renderer, and tests): the drawing, made into elements. */
export function renderLoopHistory(scene: LoopScene, options: LoopViewOptions = {}): SVGSVGElement {
  return toSvg(loopDrawing(scene, options)) as SVGSVGElement;
}

/** Lay out a loop scene as a drawing (drawing.ts). */
export function loopDrawing(scene: LoopScene, options: LoopViewOptions = {}): Mark {
  const { rows, all, live, containers, scalars, history } = scene;
  const firstGraph = scene.graph?.first;
  const graphRows = scene.graph?.rows ?? [];
  const track = scene.track?.track ?? null;
  const trackRows = scene.track?.rows ?? [];

  // Row labels: "#3", or with every loop together, the loop's variable and
  // its pass ("j #3"), indented by how deeply the loop is nested.
  const labelOf = (row: LoopRow) => scene.label(row);
  const indentOf = (row: LoopRow) => scene.depth(row) * INDENT;
  const GUTTER = Math.max(GUTTER_W, ...rows.map((row) => indentOf(row) + uiTextWidth(labelOf(row), 13) + 18));

  // Column layout is shared by every row, so cells line up vertically.
  const columns: ContainerColumn[] = [];
  let x = MARGIN + GUTTER;
  // What each row draws, in order, with its name's width and its own width
  // (for laying them out one above another).
  const lanes: {
    labelW: number;
    w: number;
    place: (x: number) => void;
    column?: ContainerColumn;
    kind: "graph" | "column" | "track";
  }[] = [];
  // The graph goes first, one picture per row, all the same size.
  let graphLayout: {
    x: number;
    layout: NonNullable<LoopScene["graph"]>["layout"];
    overlays: GraphOverlay[];
    h: number;
  } | null = null;
  if (scene.graph && firstGraph) {
    const { layout, overlays } = scene.graph;
    const sample: GraphPicture = graphPicture(firstGraph, layout, overlays[0], {
      flipKey: "g",
      legendOverlays: overlays,
    });
    const labelW = textWidth(firstGraph.name) + 12;
    graphLayout = { x: x + labelW, layout, overlays, h: sample.h };
    const g = graphLayout;
    lanes.push({
      kind: "graph",
      labelW,
      w: sample.w,
      place: (lx) => {
        g.x = lx;
      },
    });
    x += labelW + sample.w + CONTAINER_GAP;
  }
  for (const name of containers) {
    const labelW = textWidth(name) + 12;
    // A list of lists in every row where it has items: draw it as a grid.
    const present = all.filter((row) => containerIn(row, name) && cellsOf(containerIn(row, name)!).length);
    if (scene.grids.has(name)) {
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
        pointersW = Math.max(pointersW, rowPointersWidth(scene.pointers(row, name)));
        const widest = Math.max(0, ...grid.map((r) => r.items.length));
        if (scene.pointers(row, `${name}[]`).some((p) => p.index < widest)) hasColumnPointers = true;
      }
      const rowIndexW = textWidth(String(gridRows - 1), 10.5) + 10;
      const column: ContainerColumn = {
        name,
        x: x + labelW + rowIndexW,
        cellW,
        hasPointers: hasColumnPointers,
        grid: { rows: gridRows, cols, rowIndexW, hasColumnPointers },
        bodyH: gridRows * CELL_H + (hasColumnPointers ? POINTER_H : 6),
      };
      columns.push(column);
      lanes.push({
        kind: "column",
        column,
        labelW,
        w: rowIndexW + cols * cellW + pointersW,
        place: (lx) => {
          column.x = lx + rowIndexW;
        },
      });
      x += labelW + rowIndexW + cols * cellW + pointersW + CONTAINER_GAP;
      continue;
    }
    let cellW = CELL_MIN_W;
    let maxCells = 1;
    let hasPointers = false;
    let strip = false;
    for (const row of all) {
      const obj = containerIn(row, name);
      if (!obj) continue;
      const cells = cellsOf(obj);
      maxCells = Math.max(maxCells, cells.length);
      for (const cell of cells) cellW = Math.max(cellW, cellWidth(cell.value), textWidth(cell.label, 11) + 10);
      if (scene.pointers(row, name).length) hasPointers = true;
      if (obj.kind !== "dict" && obj.strip) strip = true;
    }
    const column: ContainerColumn = {
      name,
      x: x + labelW,
      cellW,
      hasPointers,
      bodyH: CELL_H + (hasPointers ? POINTER_H : 6),
      cellsW: maxCells * cellW,
      strip,
    };
    columns.push(column);
    lanes.push({
      kind: "column",
      column,
      labelW,
      w: maxCells * cellW,
      place: (lx) => {
        column.x = lx;
      },
    });
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
    const t = trackLayout;
    let w = track.order.length * (nodeW + NODE_GAP) - NODE_GAP;
    // One above another: separate lists on separate lines.
    if (options.vertical && track.shape === "list") {
      // Over the loop's whole run, not just up to this step, so a node that
      // gets linked in later (a new node, before `curr.next = node`) is on
      // its list's line from the start.
      const chains = scene.track!.chains();
      if (chains.length > 1) {
        t.places = new Map(chains.flatMap((chain, line) => chain.map((id, column) => [id, { line, column }] as const)));
        t.lines = chains.length;
        w = Math.max(...chains.map((c) => c.length)) * (nodeW + NODE_GAP) - NODE_GAP;
      }
    }
    lanes.push({
      kind: "track",
      labelW,
      w,
      place: (lx) => {
        t.x = lx;
      },
    });
    x += labelW + w + CONTAINER_GAP;
  }
  // One above another: everything starts at the same x, after the widest name.
  const vertical = !!options.vertical && (lanes.length > 1 || (trackLayout?.lines ?? 1) > 1);
  if (vertical) {
    const lanesX = MARGIN + GUTTER + Math.max(...lanes.map((l) => l.labelW));
    for (const lane of lanes) lane.place(lanesX);
    x = lanesX + Math.max(...lanes.map((l) => l.w)) + CONTAINER_GAP;
  }
  const { hasContent } = scene;

  const scalarsX = hasContent ? x - CONTAINER_GAP + SCALARS_GAP : MARGIN + GUTTER;
  const scalarsW = Math.max(0, ...all.map((row) => scalarText(row, scalars).length)) * 12.5 * 0.6;
  // Loop headers sit beside the cells, in the scalars' column, so change
  // arrows between rows never cross them.
  const headersW = Math.max(0, ...rows.map((row) => textWidth(scene.header(row), 12.5)));
  const contentW = scalarsX + Math.max(scalarsW, headersW);
  // Space above the cells: index labels, or arcs for links that jump over
  // nodes. Below: whatever is tallest (a grid, a tree, pointer markers).
  const isTree = track?.shape === "tree";
  const stripTop = columns.some((c) => c.strip) ? STRIP_H : 0;
  const rowTop = (track && !isTree ? ARC_TOP : INDEX_H) + stripTop;
  const trackPointers = trackRows.some((r) => !!r?.pointers.length);
  let trackBodyH = 0;
  if (track && isTree) {
    const levels = Math.max(1, ...trackRows.map((r) => Math.max(0, ...treeDepths(r!).values()) + 1));
    trackBodyH = (levels - 1) * LEVEL_H + CELL_H + POINTER_H;
  } else if (track) {
    trackBodyH = CELL_H + (trackPointers ? POINTER_H : 6) + (track.links.length > 1 ? ARC_BOTTOM : 0);
    // Separate lists on separate lines: each line below the last, with room for its arcs.
    const lines = trackLayout?.lines ?? 1;
    if (trackLayout && lines > 1) {
      trackLayout.lineStep = ARC_TOP + trackBodyH + 6;
      trackBodyH += (lines - 1) * trackLayout.lineStep;
    }
  }
  // Where each lane's cells start, below the row's top: the same for all
  // side by side; stacked, each lane below the last.
  let graphTop = 0;
  let trackTop = rowTop;
  let rowH = Math.max(rowTop + Math.max(CELL_H + 6, trackBodyH, ...columns.map((c) => c.bodyH)), graphLayout?.h ?? 0);
  if (vertical) {
    let at = 0;
    for (const lane of lanes) {
      if (lane.kind === "graph") {
        graphTop = at;
        at += graphLayout!.h + LANE_GAP;
      } else if (lane.kind === "column") {
        const top = INDEX_H + (lane.column!.strip ? STRIP_H : 0);
        lane.column!.dy = at + top;
        at += top + lane.column!.bodyH + LANE_GAP;
      } else {
        trackTop = at + (isTree ? INDEX_H : ARC_TOP);
        at += (isTree ? INDEX_H : ARC_TOP) + trackBodyH + LANE_GAP;
      }
    }
    rowH = at - LANE_GAP;
  }
  /** Where a container's cells start, below the row's top. */
  const cellsTop = (column: ContainerColumn) => column.dy ?? rowTop;

  const { items, hiddenRows } = scene;

  const svg = s("svg", { class: "loop-svg", xmlns: "http://www.w3.org/2000/svg" });
  svg.append(arrowMarkers());
  const rowLayer = s("g", { class: "loop-rows" });
  const arrowLayer = s("g", { class: "arrows" });
  svg.append(rowLayer, arrowLayer);

  let y = MARGIN;
  if (hiddenRows && !live) {
    rowLayer.append(
      s("text", { class: "loop-note", x: MARGIN, y: y + 12 }, `${hiddenRows} earlier iterations not shown`),
    );
    y += 28;
  }

  let prevDrawn: { row: LoopRow; y: number; index: number } | null = scene.before
    ? { ...scene.before, y: Number.NaN }
    : null;
  /** The row being drawn follows unrecorded passes: no change arrows across them. */
  let afterGap = false;
  for (const item of items) {
    if (item.kind === "header") {
      const info = scene.info(item.loop);
      if (!info) continue;
      const g = s("g", { class: "loop-header" });
      g.append(
        s("line", {
          class: "loop-header-rule",
          x1: MARGIN + item.depth * INDENT,
          x2: scalarsX - 10,
          y1: y + BAND_H / 2,
          y2: y + BAND_H / 2,
        }),
      );
      const text = s(
        "text",
        { x: scalarsX, y: y + BAND_H / 2, "dominant-baseline": "central" },
        s("tspan", { class: "loop-header-code" }, info.header),
      );
      if (item.call) {
        text.append(
          s("tspan", { class: "loop-header-arrow", dx: 10 }, "→"),
          s("tspan", { class: "loop-header-call", dx: 10 }, evaluatedHeader(info, item.call)),
        );
        g.append(s("title", {}, `This run of the loop on line ${info.line}, with its values as it started`));
      }
      g.append(text);
      rowLayer.append(g);
      y += BAND_H;
      continue;
    }
    if (item.kind === "gap") {
      const count = item.to - item.from + 1;
      const n = item.name ? `${item.name} ` : "";
      const text =
        count === 1
          ? `${n}#${item.from}: 1 pass ran, not recorded`
          : `${n}#${item.from} to #${item.to}: ${count.toLocaleString()} passes like these ran, not recorded`;
      const textX = MARGIN + GUTTER;
      rowLayer.append(
        s(
          "g",
          { class: "quiet-band sampled-band" },
          s(
            "title",
            {},
            "A long loop is sampled: its first passes, passes at round numbers and its last passes are recorded. The passes in between ran, and are counted, but weren't recorded.",
          ),
          s("line", { x1: MARGIN, x2: contentW, y1: y + BAND_H / 2, y2: y + BAND_H / 2 }),
          s("rect", { x: textX - 8, y: y + 4, width: uiTextWidth(text, 12.5) + 16, height: BAND_H - 8, rx: 4 }),
          s("text", { x: textX, y: y + BAND_H / 2, "dominant-baseline": "central" }, text),
        ),
      );
      y += BAND_H + 6;
      afterGap = true;
      continue;
    }
    if (item.kind === "band") {
      const n = item.name ? `${item.name} ` : "";
      const text =
        item.from === item.to
          ? `${n}#${item.from}: nothing changed`
          : `${n}#${item.from} to #${item.to}: nothing changed`;
      const textX = MARGIN + GUTTER;
      rowLayer.append(
        s(
          "g",
          { class: "quiet-band" },
          s("line", { x1: MARGIN, x2: contentW, y1: y + BAND_H / 2, y2: y + BAND_H / 2 }),
          s("rect", { x: textX - 8, y: y + 4, width: uiTextWidth(text, 12.5) + 16, height: BAND_H - 8, rx: 4 }),
          s("text", { x: textX, y: y + BAND_H / 2, "dominant-baseline": "central" }, text),
        ),
      );
      y += BAND_H + 6;
      continue;
    }

    const { row, index } = item;
    const isCurrent = scene.isCurrent(index);
    const prevRow = index > 0 ? all[index - 1] : null;
    // data-top / data-bottom: the row's extent, so the viewport can keep it
    // in view without measuring the page.
    const g = s("g", {
      class: ["loop-row", isCurrent && "is-current"].filter(Boolean).join(" "),
      "data-top": y - 6,
      "data-bottom": y + rowH + 4,
    });
    if (isCurrent) {
      g.append(
        s("rect", {
          class: "current-band",
          x: MARGIN - 8,
          y: y - 6,
          width: contentW - MARGIN + 16,
          height: rowH + 10,
          rx: 6,
        }),
      );
    }
    const cellsY = y + rowTop;
    // The row's label and variables: level with the cells, or stacked, at
    // the middle of the stack.
    const midY = vertical ? y + rowH / 2 : cellsY + CELL_H / 2;
    const indent = indentOf(row);
    // With every loop together, a guide line marks rows of inner loops.
    for (let d = 1; d <= scene.depth(row); d++) {
      const gx = MARGIN + (d - 1) * INDENT + 4;
      g.append(s("line", { class: "nest-guide", x1: gx, x2: gx, y1: y - 8, y2: y + rowH + 8 }));
    }
    g.append(
      s(
        "text",
        {
          class: ["iteration-label", history.nested && (row.depth ?? 0) > 0 && "is-inner"].filter(Boolean).join(" "),
          x: MARGIN + indent,
          y: midY,
          "dominant-baseline": "central",
        },
        labelOf(row),
      ),
    );

    // Scalars to the right of the cells: "i = 2   j = 0", changes emphasized.
    const scalarLine = s("text", { class: "scalars", x: scalarsX, y: midY, "dominant-baseline": "central" });
    let first = true;
    for (const name of scalars) {
      const value = scalarIn(row, name);
      if (value?.kind !== "prim") continue;
      const before = prevRow ? scalarIn(prevRow, name) : undefined;
      const isChanged = !!prevRow && (!before || valueKey(before) !== valueKey(value));
      scalarLine.append(
        s("tspan", { class: isChanged ? "is-changed" : null, dx: first ? 0 : 22 }, `${name} = ${value.repr}`),
      );
      first = false;
    }
    g.append(scalarLine);
    const changedNames = new Set(
      scalars.filter((name) => {
        const a = scalarIn(row, name);
        const b = prevRow ? scalarIn(prevRow, name) : undefined;
        return !!prevRow && (!a || !b || valueKey(a) !== valueKey(b));
      }),
    );

    // This row's sizes come from its own step.
    const sizes = scene.sizes(row);
    const totalOf = (id: string) => {
      const total = sizes?.total(id);
      return sizes && total !== null && total !== undefined ? formatBytes(total, sizes.approximate) : null;
    };

    for (const column of columns) {
      const obj = containerIn(row, column.name);
      const cellsY = y + cellsTop(column);
      const labelsY = cellsY - INDEX_H;
      const nameX = column.x - 8 - (column.grid?.rowIndexW ?? 0);
      nameLabel(g, nameX, cellsY + CELL_H / 2, column.name, obj ? totalOf(obj.id) : null);
      if (!obj) continue;
      if (column.grid) {
        drawGrid(g, column, row, prevDrawn?.row ?? null, cellsY, labelsY, scene, changedNames);
        continue;
      }
      const cells = cellsOf(obj);
      const prevObj = prevDrawn ? containerIn(prevDrawn.row, column.name) : undefined;
      const replaced = !!prevObj && prevObj.id !== obj.id;
      const prevCells = prevObj && !replaced ? cellsOf(prevObj) : [];
      const prevByKey = new Map(prevCells.map((c) => [c.key, c]));
      const prevIndexOf = new Map(prevCells.map((c, i) => [c.key, i]));

      const changedKeys = new Set(
        cells
          .filter((c) => {
            const p = prevByKey.get(c.key);
            return !!prevObj && (!p || valueKey(p.value) !== valueKey(c.value));
          })
          .map((c) => c.key),
      );

      const containerG = s("g", { class: ["loop-container", replaced && "is-new"].filter(Boolean).join(" ") });
      if (!cells.length) {
        containerG.append(
          s(
            "g",
            { class: "cell is-empty" },
            s("rect", { x: column.x, y: cellsY, width: column.cellW, height: CELL_H, rx: 3 }),
            s(
              "text",
              {
                class: "value v-none",
                x: column.x + column.cellW / 2,
                y: cellsY + CELL_H / 2,
                "text-anchor": "middle",
                "dominant-baseline": "central",
              },
              "∅",
            ),
          ),
        );
      }
      cells.forEach((cell, i) => {
        const cx = column.x + i * column.cellW;
        if (cell.label)
          containerG.append(
            s(
              "text",
              { class: "index", x: cx + column.cellW / 2, y: labelsY + 9, "text-anchor": "middle" },
              cell.label,
            ),
          );
        const { el } = valueCell(cell.value, { x: cx, y: cellsY, w: column.cellW, changed: changedKeys.has(cell.key) });
        markCell(el, column.name, cell.key, cell.value, cx);
        containerG.append(el);
      });
      if (obj.kind !== "dict" && obj.kind !== "set") {
        const pointers = scene.pointers(row, column.name, changedNames);
        const offset = obj.offset ?? 0;
        if (pointers.length) {
          const shown = pointers.map((p) => ({ ...p, index: p.index - offset }));
          containerG.append(
            pointerMarkers(shown, (i) => column.x + i * column.cellW, column.cellW, cellsY + CELL_H, cells.length, {
              key: `ptr:${column.name}`,
              originX: 0,
              originY: 0,
            }),
          );
        }
        if (obj.strip && obj.length > obj.items.length) {
          containerG.append(
            stripBar(
              {
                ...obj.strip,
                length: obj.length,
                window: { start: offset, count: obj.items.length },
                pointers,
              },
              column.x,
              labelsY - STRIP_H,
              column.cellsW ?? cells.length * column.cellW,
              `strip:${column.name}`,
            ),
          );
        }
      }
      g.append(containerG);

      // Change arrows from the previous drawn row. For lists, a value that
      // moved from another changed index (a swap) gets a crossing arrow.
      // (Animated mode has one row: the values slide instead. Stacked one
      // above another, an arrow would cross the other lanes: highlights only.)
      if (prevDrawn && prevObj && !replaced && !live && !afterGap && !vertical) {
        const fromY = prevDrawn.y + cellsTop(column) + CELL_H + (column.hasPointers ? POINTER_H - 2 : 2);
        const toY = labelsY - 3 - (column.strip ? STRIP_H : 0);
        const used = new Set<string>();
        const prevByValue = (c: Cell) =>
          prevCells.find(
            (p) =>
              p.key !== c.key && changedKeys.has(p.key) && !used.has(p.key) && valueKey(p.value) === valueKey(c.value),
          );
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
      // The linked structure's size: every node in this row, once.
      const nodes = [...trackRows[index]!.nodes.keys()].map((id) => ({ kind: "ref" as const, id }));
      const trackSize = sizes ? formatBytes(sizes.of(nodes), sizes.approximate) : null;
      if (isTree) drawTree(g, trackLayout, trackRows[index]!, prevState, y + trackTop, trackSize);
      else drawTrack(g, arrowLayer, trackLayout, trackRows[index]!, prevState, y + trackTop, trackSize);
    }

    const graphRow = graphRows[index];
    if (graphLayout && firstGraph) {
      let graphSize: string | null = null;
      if (sizes && graphRow) {
        graphSize = graphRow.graph.objectNodes
          ? formatBytes(
              sizes.of([...graphRow.graph.nodes.keys()].map((id) => ({ kind: "ref" as const, id }))),
              sizes.approximate,
            )
          : totalOf(graphRow.graph.hostId);
      }
      nameLabel(g, graphLayout.x - 8, vertical ? y + graphTop + graphLayout.h / 2 : midY, firstGraph.name, graphSize);
      if (graphRow) {
        const prevGraph = prevDrawn ? graphRows[prevDrawn.index] : null;
        graphPicture(graphRow.graph, graphLayout.layout, graphRow.overlay, {
          flipKey: "gptr",
          prev: prevGraph ?? null,
          legendOverlays: graphLayout.overlays,
        }).draw(graphLayout.x, y + graphTop, g);
      }
    }

    rowLayer.append(g);
    prevDrawn = { row, y, index };
    afterGap = false;
    y += rowH + ROW_GAP;
  }

  const width = contentW + MARGIN;
  const height = y - ROW_GAP + MARGIN;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return svg;
}
