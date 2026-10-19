/**
 * Lists, tuples and sets: a row of cells with index numbers, the pointers
 * (i, j...) under them, a window and a color strip for long lists, and in
 * nested mode a list of lists drawn as a grid.
 */

import { formatBytes } from "../../trace/memory";
import type { HeapObject, SequenceObject } from "../../trace/types";
import {
  CELL_H,
  CELL_MIN_W,
  INDEX_H,
  LABEL_H,
  POINTER_H,
  pointerMarkers,
  rowPointerMarkers,
  rowPointersWidth,
  STRIP_H,
  s,
  stripBar,
  textWidth,
  uiTextWidth,
} from "../draw";
import {
  type Ctx,
  labelWithSize,
  markCell,
  NEST_PAD,
  type Pointers,
  type Shape,
  SIZE_H,
  sizedLabelWidth,
  sizeLabel,
} from "./shapes";

const isRow = (obj: HeapObject | undefined): obj is SequenceObject => obj?.kind === "list" || obj?.kind === "tuple";

/**
 * In nested mode, a list whose items are all lists nested inside it is drawn
 * as a grid: rows stacked, column numbers on top, row numbers down the side.
 */
function gridRows(obj: SequenceObject, ctx: Ctx): SequenceObject[] | null {
  if (obj.kind === "set" || !obj.items.length) return null;
  const rows: SequenceObject[] = [];
  for (const item of obj.items) {
    const row = item.kind === "ref" && ctx.nested.has(item.id) ? ctx.step.heap[item.id] : undefined;
    if (!isRow(row)) return null;
    rows.push(row);
  }
  return rows;
}

function gridShape(
  obj: SequenceObject,
  rows: SequenceObject[],
  ctx: Ctx,
  opts: { changed: Set<string>; isNew: boolean; pointers: Pointers; nested: boolean },
): Shape {
  const views = rows.map((row) => row.items.map((item) => ctx.view(item, CELL_H)));
  const pad = views.flat().some((v) => v.nested) ? NEST_PAD : 0;
  const cols = Math.max(1, ...rows.map((row) => row.items.length));
  const cellW = Math.max(CELL_MIN_W, ...views.flat().map((v) => v.w + 2 * pad));
  const rowHs = views.map((row) => Math.max(CELL_H, ...row.map((v) => (v.nested ? v.h + 2 * pad : CELL_H))));
  const rowTops = rowHs.map((_, r) => rowHs.slice(0, r).reduce((a, b) => a + b, 0));
  // A grid's column markers only cover real columns: one past the end is
  // nearly always a bound like `cols`, not a position.
  const cols0 = Math.max(1, ...rows.map((row) => row.items.length));
  const columnPointers = ctx.pointersFor(obj.id, 1).filter((p) => p.index < cols0);
  const rowIndexW = textWidth(String(rows.length - 1), 10.5) + 10;
  const pointersW = rowPointersWidth(opts.pointers);
  const truncated = obj.length > obj.items.length;
  const size = sizeLabel(ctx, obj.id);
  const showLabel = !opts.nested || truncated || !!size;
  const label = `${obj.typeName}, ${obj.length} × ${cols}${truncated ? ` (first ${obj.items.length} rows)` : ""}`;
  const labelH = showLabel ? LABEL_H : 2;
  const cellsY = labelH + INDEX_H;
  const gridH = rowHs.reduce((a, b) => a + b, 0);
  const w = Math.max(rowIndexW + cols * cellW + pointersW, showLabel ? sizedLabelWidth(label, size) + 8 : 0);
  const h = cellsY + gridH + (columnPointers.length ? POINTER_H : 4);

  return {
    w,
    h,
    inY: cellsY + CELL_H / 2,
    draw(x, y, layer, refs) {
      const g = s("g", {
        class: ["seq", "grid", obj.kind, opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" "),
      });
      if (showLabel) g.append(labelWithSize(x, y + 11, label, size));
      const x0 = x + rowIndexW;
      const top = y + cellsY;
      for (let c = 0; c < cols; c++) {
        g.append(
          s(
            "text",
            { class: "index", x: x0 + c * cellW + cellW / 2, y: y + labelH + 9, "text-anchor": "middle" },
            String(c),
          ),
        );
      }
      rows.forEach((row, r) => {
        const ry = top + rowTops[r];
        g.append(
          s(
            "text",
            { class: "index", x: x0 - 6, y: ry + CELL_H / 2, "text-anchor": "end", "dominant-baseline": "central" },
            String(r),
          ),
        );
        const rowChanged = ctx.diff.changedSlots.get(row.id) ?? new Set<string>();
        const replaced = opts.changed.has(String(r));
        if (!row.items.length) {
          g.append(
            s("g", { class: "cell is-empty" }, s("rect", { x: x0, y: ry, width: cellW, height: CELL_H, rx: 3 })),
          );
        }
        views[r].forEach((view, c) => {
          const cx = x0 + c * cellW;
          const changed = replaced || rowChanged.has(String(c));
          if (view.nested) {
            g.append(
              s(
                "g",
                { class: ["cell", "is-holder", changed && "is-changed"].filter(Boolean).join(" ") },
                s("rect", { x: cx, y: ry, width: cellW, height: rowHs[r], rx: 3 }),
              ),
            );
            view.draw(cx + pad, ry + pad, view.w, view.h, g, refs, changed);
          } else {
            markCell(view.draw(cx, ry, cellW, CELL_H, g, refs, changed), row.id, String(c), row.items[c], c * cellW, 0);
          }
        });
      });
      // grid[i][j]: i marks a row, j a column, and their cell gets an outline.
      const rowMid = (r: number) => top + rowTops[r] + CELL_H / 2;
      const flip = { key: `ptr:${obj.id}`, originX: x, originY: y };
      if (opts.pointers.length)
        g.append(rowPointerMarkers(opts.pointers, rowMid, x0 + cols * cellW, rows.length, flip));
      if (columnPointers.length)
        g.append(pointerMarkers(columnPointers, (c) => x0 + c * cellW, cellW, top + gridH, cols, flip));
      // The cell this step works on: from the code's own grid[a][b] on the
      // line that ran (or runs next). Only if the code never indexes the
      // grid by name, a guess: the first row and column pointers.
      let focus = ctx.gridFocus(obj.id, { rows: rows.length, cols: (r) => rows[r]?.items.length ?? 0 });
      if (focus === null) {
        const r = opts.pointers.find((p) => p.index >= 0 && p.index < rows.length);
        const c = columnPointers.find((p) => p.index >= 0 && p.index < (rows[r?.index ?? 0]?.items.length ?? 0));
        focus = r && c ? { row: r.index, col: c.index } : "none";
      }
      if (focus !== "none") {
        g.append(
          s("rect", {
            class: "grid-focus",
            x: x0 + focus.col * cellW - 2,
            y: top + rowTops[focus.row] - 2,
            width: cellW + 4,
            height: rowHs[focus.row] + 4,
            rx: 4,
          }),
        );
      }
      layer.append(g);
    },
  };
}

export function sequenceShape(
  obj: SequenceObject,
  ctx: Ctx,
  opts: { changed: Set<string>; isNew: boolean; pointers: Pointers; nested: boolean },
): Shape {
  const rows = gridRows(obj, ctx);
  if (rows) return gridShape(obj, rows, ctx, opts);
  const hasIndices = obj.kind !== "set";
  // A long list shows a window of its items (following its index
  // variables), with a strip of the whole list above when it holds numbers.
  const offset = obj.offset ?? 0;
  const before = offset > 0;
  const truncated = obj.length > offset + obj.items.length;
  const strip = obj.strip && obj.length > obj.items.length ? obj.strip : null;
  const stripH = strip ? STRIP_H : 0;
  const views = obj.items.map((item) => ctx.view(item, CELL_H));
  const anyNested = views.some((v) => v.nested);
  const pad = anyNested ? NEST_PAD : 0;
  // With sizes on, each cell says what its item costs, above its index.
  const cellSizes =
    ctx.sizes && obj.items.length
      ? obj.items.map((item) => {
          const n = ctx.sizes!.cell(item, obj);
          return n === null ? "" : formatBytes(n);
        })
      : null;
  const sizeH = cellSizes ? SIZE_H : 0;
  const cellW = Math.max(
    CELL_MIN_W,
    ...views.map((v) => v.w + 2 * pad),
    ...(cellSizes ?? []).map((t) => uiTextWidth(t, 9.5) + 8),
  );
  const cellH = Math.max(CELL_H, ...views.map((v) => (v.nested ? v.h + 2 * pad : CELL_H)));
  const count = Math.max(obj.items.length, 1) + (truncated ? 1 : 0) + (before ? 1 : 0);
  const firstX = before ? cellW : 0;
  const size = sizeLabel(ctx, obj.id);
  // Inside another box, the type label is left out to save room (unless
  // it carries a size).
  const showLabel = !opts.nested || truncated || before || !!size;
  const label = before
    ? `${obj.typeName}, items ${offset}–${offset + obj.items.length - 1} of ${obj.length}`
    : truncated
      ? `${obj.typeName}, first ${obj.items.length} of ${obj.length}`
      : obj.typeName;
  const labelH = showLabel ? LABEL_H : 2;
  const hasPointers = opts.pointers.length > 0;
  const w = Math.max(count * cellW, showLabel ? sizedLabelWidth(label, size) + 8 : 0);
  const cellsY = labelH + stripH + sizeH + (hasIndices ? INDEX_H : 0);
  const h = cellsY + cellH + (hasPointers ? POINTER_H : 0);

  return {
    w,
    h,
    inY: cellsY + Math.min(cellH, CELL_H) / 2,
    draw(x, y, layer, refs) {
      const g = s("g", {
        class: ["seq", obj.kind, opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" "),
      });
      if (showLabel) g.append(labelWithSize(x, y + 11, label, size));
      if (strip) {
        g.append(
          stripBar(
            {
              ...strip,
              length: obj.length,
              window: { start: offset, count: obj.items.length },
              pointers: opts.pointers,
            },
            x,
            y + labelH,
            count * cellW,
            `strip:${obj.id}`,
          ),
        );
      }
      if (before) {
        g.append(
          s(
            "text",
            {
              class: "value v-none",
              x: x + cellW / 2,
              y: y + cellsY + cellH / 2,
              "text-anchor": "middle",
              "dominant-baseline": "central",
            },
            "…",
          ),
        );
      }
      if (!obj.items.length) {
        g.append(
          s(
            "g",
            { class: "cell is-empty" },
            s("rect", { x, y: y + cellsY, width: cellW, height: CELL_H, rx: 3 }),
            s(
              "text",
              {
                class: "value v-none",
                x: x + cellW / 2,
                y: y + cellsY + CELL_H / 2,
                "text-anchor": "middle",
                "dominant-baseline": "central",
              },
              "∅",
            ),
          ),
        );
      }
      obj.items.forEach((_item, i) => {
        const cx = x + firstX + i * cellW;
        const slot = String(offset + i);
        const changed = opts.changed.has(slot);
        if (cellSizes?.[i]) {
          g.append(
            s(
              "text",
              { class: "cell-size", x: cx + cellW / 2, y: y + labelH + stripH + 9, "text-anchor": "middle" },
              cellSizes[i],
            ),
          );
        }
        if (hasIndices) {
          g.append(
            s(
              "text",
              { class: "index", x: cx + cellW / 2, y: y + labelH + stripH + sizeH + 9, "text-anchor": "middle" },
              slot,
            ),
          );
        }
        const view = views[i];
        const before = refs.length;
        if (view.nested) {
          // A cell frame with the nested object inside it.
          g.append(
            s(
              "g",
              { class: ["cell", "is-holder", changed && "is-changed"].filter(Boolean).join(" ") },
              s("rect", { x: cx, y: y + cellsY, width: cellW, height: cellH, rx: 3 }),
            ),
          );
          view.draw(cx + pad, y + cellsY + pad, view.w, view.h, g, refs, changed);
        } else {
          markCell(view.draw(cx, y + cellsY, cellW, cellH, g, refs, changed), obj.id, slot, obj.items[i], cx - x, 0);
          // A list cell's arrow leaves downward, not through its neighbors.
          for (let k = before; k < refs.length; k++) refs[k].down = true;
        }
      });
      if (truncated) {
        const cx = x + firstX + obj.items.length * cellW;
        g.append(
          s(
            "text",
            {
              class: "value v-none",
              x: cx + cellW / 2,
              y: y + cellsY + cellH / 2,
              "text-anchor": "middle",
              "dominant-baseline": "central",
            },
            "…",
          ),
        );
      }
      if (hasPointers) {
        const shown = opts.pointers.map((p) => ({ ...p, index: p.index - offset }));
        g.append(
          pointerMarkers(shown, (i) => x + firstX + i * cellW, cellW, y + cellsY + cellH, obj.items.length, {
            key: `ptr:${obj.id}`,
            originX: x,
            originY: y,
          }),
        );
      }
      layer.append(g);
    },
  };
}
