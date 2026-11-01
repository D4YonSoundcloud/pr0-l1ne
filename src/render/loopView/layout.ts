/** The whole loop view as a drawing: the plan's rows, top to bottom, with the bands between them. */
import { timed } from "../../perf";
import type { LoopScene } from "../../scene/loopScene";
import { arrowMarkers, s } from "../draw";
import type { Mark } from "../drawing";
import { drawGap, drawHeader, drawQuietBand } from "./bands";
import { type LoopPlan, planLoop } from "./plan";
import { type DrawnRow, drawRow } from "./row";
import { rowKey, sceneKey } from "./rowCache";
import { type LoopViewOptions, MARGIN, ROW_GAP } from "./shared";

/** Lay out a loop scene as a drawing (drawing.ts). */
export function loopDrawing(scene: LoopScene, options: LoopViewOptions = {}): Mark {
  return timed("loop.layout", () => drawLoop(scene, options));
}

function drawLoop(scene: LoopScene, options: LoopViewOptions): Mark {
  const plan = planLoop(scene, options);
  const cache = options.rows;
  cache?.begin(sceneKey(scene, plan, !!options.vertical));
  try {
    return drawRows(scene, options, plan);
  } finally {
    cache?.end();
  }
}

function drawRows(scene: LoopScene, options: LoopViewOptions, plan: LoopPlan): Mark {
  const cache = options.rows;
  const visible = options.visible;
  const { items, hiddenRows, live } = scene;

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

  let prevDrawn: DrawnRow | null = scene.before ? { ...scene.before, y: Number.NaN } : null;
  let afterGap = false;
  for (const item of items) {
    if (item.kind === "header") {
      y += drawHeader(rowLayer, item, y, plan, scene);
      continue;
    }
    if (item.kind === "gap") {
      y += drawGap(rowLayer, item, y, plan);
      afterGap = true;
      continue;
    }
    if (item.kind === "band") {
      y += drawQuietBand(rowLayer, item, y, plan);
      continue;
    }
    const { row, index } = item;
    // Only the rows in view (and the current one, which the window keeps in view) are drawn.
    const inView = !visible || scene.isCurrent(index) || (y + plan.rowH + 4 >= visible.top && y - 6 <= visible.bottom);
    if (inView) {
      const key = cache?.on ? rowKey(scene, plan, row, index, y, prevDrawn, afterGap) : null;
      const kept = key ? cache!.get(key) : undefined;
      if (kept) {
        rowLayer.appendShared(kept.row);
        arrowLayer.appendShared(...kept.arrows);
      } else {
        const arrowsBefore = arrowLayer.childNodes.length;
        const drawn = drawRow(row, index, y, { plan, scene, arrowLayer, prevDrawn, afterGap });
        if (live) scopeToLoop(drawn, row.loop ?? scene.history.info.id);
        rowLayer.append(drawn);
        if (key) cache!.set(key, { row: drawn, arrows: arrowLayer.childNodes.slice(arrowsBefore) as Mark[] });
      }
    }
    prevDrawn = { row, y, index };
    afterGap = false;
    y += plan.rowH + ROW_GAP;
  }

  const width = plan.contentW + MARGIN;
  const height = y - ROW_GAP + MARGIN;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return svg;
}

/**
 * Animated, every loop of a nest has its own live row, and those rows show
 * the same containers. What animates is matched between steps by key
 * (render/animate.ts: `ptr:s`, `s|3`...), so each row's keys get its loop's
 * name in front: otherwise the outer loop's list would be matched with the
 * inner loop's, and slide in from the inner row on every step it runs.
 */
export function scopeToLoop(row: Mark, loop: string): void {
  for (const el of row.querySelectorAll("[data-flip]"))
    el.setAttribute("data-flip", `${loop}/${el.getAttribute("data-flip")}`);
  for (const el of row.querySelectorAll("[data-cell]"))
    el.setAttribute("data-cell", `${loop}/${el.getAttribute("data-cell")}`);
}
