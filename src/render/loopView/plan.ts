/**
 * The loop view's plan: where everything goes in a row. Every row shares
 * it, so cells line up down the rows: the gutter for row labels, each
 * container's column (or the graph's, or the linked track's), where the
 * variables go, and how tall a row is. Laid out side by side, or one above
 * another (LoopViewOptions.vertical).
 */
import { cellsOf, containerIn, gridIn, type LoopScene } from "../../scene/loopScene";
import type { GraphOverlay } from "../../trace/graph";
import { treeDepths } from "../../trace/linked";
import type { LoopRow } from "../../trace/loopHistory";
import {
  CELL_H,
  CELL_MIN_W,
  cellWidth,
  INDEX_H,
  POINTER_H,
  REGION_H,
  rowPointersWidth,
  STRIP_H,
  textWidth,
  uiTextWidth,
} from "../draw";
import { type GraphPicture, graphPicture } from "../graphView";
import {
  ARC_BOTTOM,
  ARC_TOP,
  CONTAINER_GAP,
  type ContainerColumn,
  GUTTER_W,
  INDENT,
  LANE_GAP,
  LEVEL_H,
  type LoopViewOptions,
  MARGIN,
  NODE_GAP,
  SCALARS_GAP,
  SLOT_W,
  scalarText,
  type TrackLayout,
} from "./shared";

export interface GraphLane {
  x: number;
  layout: NonNullable<LoopScene["graph"]>["layout"];
  overlays: GraphOverlay[];
  h: number;
}

export interface LoopPlan {
  /** Row labels: "#3", or with every loop together, the loop's variable and its pass ("j #3"). */
  labelOf(row: LoopRow): string;
  /** How far a row's label is indented: by how deeply its loop is nested. */
  indentOf(row: LoopRow): number;
  /** The row labels' column. */
  gutter: number;
  columns: ContainerColumn[];
  graph: GraphLane | null;
  track: TrackLayout | null;
  isTree: boolean;
  /** Lanes one above another. */
  vertical: boolean;
  /** Where the variables (and loop headers) start. */
  scalarsX: number;
  /** Where everything ends. */
  contentW: number;
  /** Space above the cells in a row: index labels, strips, arcs. */
  rowTop: number;
  rowH: number;
  /** Where the graph and the linked track start, below a row's top. */
  graphTop: number;
  trackTop: number;
  /** Where a container's cells start, below a row's top. */
  cellsTop(column: ContainerColumn): number;
}

/** Plan a loop scene's rows. */
export function planLoop(scene: LoopScene, options: LoopViewOptions): LoopPlan {
  const { rows, all, containers, scalars } = scene;
  const firstGraph = scene.graph?.first;
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
  let graphLayout: GraphLane | null = null;
  if (scene.graph && firstGraph) {
    const { layout, overlays } = scene.graph;
    const sample: GraphPicture = graphPicture(firstGraph, layout, overlays[0], {
      flipKey: "g",
      legendOverlays: overlays,
      tall: scene.tall,
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
  // The variables, then `viz: watch` values and failed `viz: check`s, each 22 apart.
  const extrasW = (row: LoopRow) =>
    [
      ...scene.watches(row).map((w) => `${w.text} = ${w.value}`),
      ...scene.failedChecks(row).map((c) => `✗ ${c}`),
    ].reduce((w, text) => w + 22 + text.length * 12.5 * 0.6, 0);
  const scalarsW = Math.max(0, ...all.map((row) => scalarText(row, scalars).length * 12.5 * 0.6 + extrasW(row)));
  // Loop headers sit beside the cells, in the scalars' column, so change
  // arrows between rows never cross them.
  const headersW = Math.max(0, ...rows.map((row) => textWidth(scene.header(row), 12.5)));
  const contentW = scalarsX + Math.max(scalarsW, headersW);
  // Space above the cells: index labels, or arcs for links that jump over
  // nodes. Below: whatever is tallest (a grid, a tree, pointer markers).
  const isTree = track?.shape === "tree";
  const stripTop = columns.some((c) => c.strip) ? STRIP_H : 0;
  // Labeled regions (viz: region): a row for their labels, above the index numbers.
  const regionTop = columns.some((c) => scene.regionLabels(c.name)) ? REGION_H : 0;
  const rowTop = (track && !isTree ? ARC_TOP : INDEX_H + regionTop) + stripTop;
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
        const top =
          INDEX_H + (lane.column!.strip ? STRIP_H : 0) + (scene.regionLabels(lane.column!.name) ? REGION_H : 0);
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

  return {
    labelOf,
    indentOf,
    gutter: GUTTER,
    columns,
    graph: graphLayout,
    track: trackLayout,
    isTree,
    vertical,
    scalarsX,
    contentW,
    rowTop,
    rowH,
    graphTop,
    trackTop,
    cellsTop,
  };
}
