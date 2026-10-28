/**
 * One row of the loop view: one pass of the loop, with its containers,
 * graph and linked track in the plan's columns, its variables, and change
 * arrows from the row drawn above it.
 */
import { type Cell, cellsOf, containerIn, type LoopScene, scalarIn } from "../../scene/loopScene";
import { valueKey } from "../../trace/diff";
import type { LoopRow } from "../../trace/loopHistory";
import { formatBytes } from "../../trace/memory";
import {
  CELL_H,
  changeArrow,
  INDEX_H,
  POINTER_H,
  pointerMarkers,
  STRIP_H,
  s,
  stripBar,
  valueCell,
  windowBands,
} from "../draw";
import type { Mark } from "../drawing";
import { graphPicture } from "../graphView";
import { drawGrid } from "./grid";
import { drawTrack, drawTree } from "./linked";
import type { LoopPlan } from "./plan";
import { INDENT, MARGIN, markCell, nameLabel } from "./shared";

/** The row drawn before this one: change arrows and highlights compare with it. */
export interface DrawnRow {
  row: LoopRow;
  /** Its top (NaN for the row before the first shown: highlights, but no arrows). */
  y: number;
  index: number;
}

export interface RowContext {
  plan: LoopPlan;
  scene: LoopScene;
  /** Where change arrows go: above every row. */
  arrowLayer: Mark;
  prevDrawn: DrawnRow | null;
  /** The row follows unrecorded passes: no change arrows across them. */
  afterGap: boolean;
}

/** Draw a row with its top at y, as a <g class="loop-row">. */
export function drawRow(row: LoopRow, index: number, y: number, ctx: RowContext): Mark {
  const { plan, scene, arrowLayer, prevDrawn, afterGap } = ctx;
  const { all, live, scalars, history } = scene;
  const { columns, vertical, rowH, rowTop, contentW, scalarsX, cellsTop, isTree, indentOf, labelOf } = plan;
  const trackLayout = plan.track;
  const graphLayout = plan.graph;
  const trackTop = plan.trackTop;
  const graphTop = plan.graphTop;
  const firstGraph = scene.graph?.first;
  const graphRows = scene.graph?.rows ?? [];
  const trackRows = scene.track?.rows ?? [];
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
    // Sliding windows, behind the cells.
    if (obj.kind !== "dict" && obj.kind !== "set") {
      const windows = scene.windows(row, column.name, changedNames);
      if (windows.length) {
        const offset = obj.offset ?? 0;
        const shown = windows.map((w) => ({ ...w, start: w.start - offset, end: w.end - offset }));
        containerG.append(
          windowBands(shown, (i) => column.x + i * column.cellW, column.cellW, cellsY, CELL_H, cells.length, {
            key: `win:${column.name}`,
            originX: 0,
            originY: 0,
          }),
        );
      }
    }
    cells.forEach((cell, i) => {
      const cx = column.x + i * column.cellW;
      if (cell.label)
        containerG.append(
          s("text", { class: "index", x: cx + column.cellW / 2, y: labelsY + 9, "text-anchor": "middle" }, cell.label),
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
        tall: scene.tall,
      }).draw(graphLayout.x, y + graphTop, g);
    }
  }
  return g;
}
