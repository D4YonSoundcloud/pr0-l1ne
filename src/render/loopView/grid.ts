/** A list of lists in a row of the loop view, drawn as a grid. */
import { gridIn, type LoopScene } from "../../scene/loopScene";
import { valueKey } from "../../trace/diff";
import type { LoopRow } from "../../trace/loopHistory";
import { CELL_H, heatCell, pointerMarkers, rowPointerMarkers, s, valueCell } from "../draw";
import type { Mark } from "../drawing";
import { type ContainerColumn, markCell } from "./shared";

/** One row's list of lists, as a grid, with i/j pointers and changes. */
export function drawGrid(
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
  const heat = scene.heat(column.name);
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
      heatCell(el, item, heat);
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
