/**
 * How a summary is drawn (scene/summaries.ts): what it stands for, in a
 * box marked as a summary (styles.css, "Summaries": a dashed outline), with
 * a line saying it opens when clicked.
 *
 *   a chain's       "480 more Node", and its link out to the node after
 *   a tree's        a triangle with its node count, as a leaf of the tree
 *   recursion's     "fib() × 352", like a frame
 */
import type { Summary } from "../../scene/summaries";
import type { HeapObject } from "../../trace/types";
import { s } from "../draw";
import type { Ctx, Shape } from "./shapes";
import { tableShape } from "./tables";

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} more ${word}${n === 1 ? "" : "s"}`;

/** A summary object's box. */
export function summaryShape(obj: HeapObject, summary: Summary, ctx: Ctx): Shape {
  if (summary.kind === "tree") return triangleShape(summary);
  const rows = obj.kind === "object" ? obj.fields.map(([label, value]) => ({ label, value, changed: false })) : [];
  return tableShape(plural(summary.count, summary.name), rows, ctx, {
    variant: "summary",
    emptyText: "click to show them",
  });
}

/** A summary frame's box: the calls it stands for. */
export function frameSummaryShape(summary: Summary, ctx: Ctx): Shape {
  const n = summary.count.toLocaleString("en-US");
  return tableShape(`${summary.name}() × ${n} more`, [], ctx, {
    variant: "frame summary",
    emptyText: "click to show these calls",
  });
}

/** A folded subtree: a triangle with how many nodes it holds. */
function triangleShape(summary: Summary): Shape {
  const w = 64;
  const h = 52;
  return {
    w,
    h,
    inY: 10,
    draw(x, y, layer) {
      layer.append(
        s(
          "g",
          { class: "summary-tree" },
          s("path", { class: "summary-triangle", d: `M${x + w / 2},${y} L${x + w},${y + h} L${x},${y + h} Z` }),
          s(
            "text",
            {
              class: "summary-count",
              x: x + w / 2,
              y: y + h - 14,
              "text-anchor": "middle",
              "dominant-baseline": "central",
            },
            summary.count.toLocaleString("en-US"),
          ),
        ),
      );
    },
  };
}
