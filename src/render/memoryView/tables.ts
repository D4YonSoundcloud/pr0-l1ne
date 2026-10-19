/**
 * Boxes that are tables: a title bar, then a row per entry with its label on
 * the left and its value on the right. Call frames, dicts, objects,
 * functions and classes are all drawn this way.
 */
import { localKey } from "../../trace/diff";
import { formatBytes } from "../../trace/memory";
import type { Frame, Value } from "../../trace/types";
import { HEADER_H, ROW_H, s, textWidth, uiTextWidth, valueCell } from "../draw";
import { type Ctx, NEST_PAD, type Shape } from "./shapes";

export interface TableRow {
  label: string | Value;
  value: Value;
  changed: boolean;
  variant?: string;
}

function labelWidth(label: string | Value): number {
  if (typeof label === "string") return textWidth(label);
  return label.kind === "prim" ? textWidth(label.repr) : 20;
}

export function tableShape(
  title: string,
  rows: TableRow[],
  ctx: Ctx,
  opts: { variant: string; isNew?: boolean; emptyText?: string; nested?: boolean; sizeText?: string | null },
): Shape {
  const views = rows.map((row) => ctx.view(row.value, ROW_H - 8));
  const leftW = rows.length ? Math.max(...rows.map((r) => labelWidth(r.label))) : 0;
  const rightW = views.length ? Math.max(...views.map((v) => v.w)) : 0;
  // Plain cells keep their own width rather than stretching to match a wide
  // nested box in the same column.
  const cellsW = Math.max(0, ...views.filter((v) => !v.nested).map((v) => v.w));
  const emptyW = opts.emptyText ? uiTextWidth(opts.emptyText, 12) + 24 : 0;
  // Function and class titles are set in the code font (see styles.css).
  const codeTitle = /\b(function|class)\b/.test(opts.variant);
  const sizeW = opts.sizeText ? uiTextWidth(opts.sizeText, 11.5) * 1.08 + 14 : 0;
  const titleW = (codeTitle ? textWidth(title, 12.5) + 22 : uiTextWidth(title, 12) + 28) + sizeW;
  const w = Math.max(titleW, leftW + rightW + 34, emptyW, opts.nested ? 0 : 120);
  const rowHeights = views.map((v) => Math.max(ROW_H, v.h + 2 * NEST_PAD));
  const bodyH = rows.length ? rowHeights.reduce((a, b) => a + b, 0) + 6 : opts.emptyText ? ROW_H : 0;
  const h = HEADER_H + bodyH;

  return {
    w,
    h,
    inY: HEADER_H / 2,
    draw(x, y, layer, refs) {
      const cls = ["box", opts.variant, opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" ");
      const g = s("g", { class: cls });
      g.append(
        s("rect", { class: "box-body", x, y, width: w, height: h, rx: 5 }),
        s("path", {
          class: "box-header",
          d: `M${x},${y + HEADER_H} V${y + 5} q0,-5 5,-5 H${x + w - 5} q5,0 5,5 V${y + HEADER_H} z`,
        }),
        s("text", { class: "box-title", x: x + 10, y: y + HEADER_H / 2, "dominant-baseline": "central" }, title),
      );
      if (opts.sizeText) {
        g.append(
          s(
            "text",
            {
              class: "box-size",
              x: x + w - 9,
              y: y + HEADER_H / 2,
              "text-anchor": "end",
              "dominant-baseline": "central",
            },
            opts.sizeText,
          ),
        );
      }
      if (!rows.length && opts.emptyText) {
        g.append(
          s(
            "text",
            { class: "box-empty", x: x + 10, y: y + HEADER_H + ROW_H / 2, "dominant-baseline": "central" },
            opts.emptyText,
          ),
        );
      }
      let rowY = y + HEADER_H + 3;
      rows.forEach((row, i) => {
        const rowH = rowHeights[i];
        const view = views[i];
        // Labels sit level with the first line, even beside a tall nested box.
        const labelY = view.nested ? rowY + NEST_PAD + HEADER_H / 2 : rowY + rowH / 2;
        const rowG = s("g", { class: ["row", row.variant, row.changed && "is-changed"].filter(Boolean).join(" ") });
        if (typeof row.label === "string") {
          rowG.append(
            s("text", { class: "row-label", x: x + 10, y: labelY, "dominant-baseline": "central" }, row.label),
          );
        } else if (row.label.kind === "prim") {
          const { el } = valueCell(row.label, {
            x: x + 6,
            y: labelY - (ROW_H - 8) / 2,
            w: leftW + 8,
            h: ROW_H - 8,
            variant: "key",
          });
          rowG.append(el);
        } else {
          const { el, dot } = valueCell(row.label, {
            x: x + 6,
            y: labelY - (ROW_H - 8) / 2,
            w: 22,
            h: ROW_H - 8,
            variant: "key",
          });
          rowG.append(el);
          if (dot) refs.push({ from: dot, target: row.label.id, changed: false });
        }
        const cellX = x + w - 8 - rightW;
        if (view.nested) view.draw(cellX, rowY + NEST_PAD, view.w, view.h, rowG, refs, row.changed);
        else view.draw(cellX, rowY + 4, cellsW, ROW_H - 8, rowG, refs, row.changed);
        g.append(rowG);
        rowY += rowH;
      });
      layer.append(g);
    },
  };
}

export function frameShape(frame: Frame, ctx: Ctx, isActive: boolean): Shape {
  const { step, diff } = ctx;
  const rows: TableRow[] = frame.locals.map(([name, value]) => ({
    label: name,
    value,
    changed: diff.changedLocals.has(localKey(frame.id, name)),
  }));
  if (isActive && step.event === "return" && step.returnValue && frame.func !== "Global") {
    rows.push({ label: "returns", value: step.returnValue, changed: true, variant: "return-row" });
  }
  if (isActive && step.event === "yield" && step.returnValue) {
    rows.push({ label: "yields", value: step.returnValue, changed: true, variant: "return-row" });
  }
  // A paused generator or async function: off the stack, variables kept.
  const paused = frame.state === "suspended";
  const title = frame.func === "Global" ? "Global" : `${frame.func}()${paused ? `, paused at line ${frame.line}` : ""}`;
  // A frame's size: what its variables keep alive.
  const holds = ctx.sizes ? ctx.sizes.frame(frame) : 0;
  return tableShape(title, rows, ctx, {
    variant: ["frame", isActive && "is-active", paused && "is-suspended"].filter(Boolean).join(" "),
    isNew: diff.newFrames.has(frame.id),
    emptyText: "no variables yet",
    sizeText: ctx.sizes && holds > 0 ? `holds ${formatBytes(holds, ctx.sizes.approximate)}` : null,
  });
}
