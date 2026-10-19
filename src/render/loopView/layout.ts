/** The whole loop view as a drawing: the plan's rows, top to bottom, with the bands between them. */
import type { LoopScene } from "../../scene/loopScene";
import { arrowMarkers, s } from "../draw";
import type { Mark } from "../drawing";
import { drawGap, drawHeader, drawQuietBand } from "./bands";
import { planLoop } from "./plan";
import { type DrawnRow, drawRow } from "./row";
import { type LoopViewOptions, MARGIN, ROW_GAP } from "./shared";

/** Lay out a loop scene as a drawing (drawing.ts). */
export function loopDrawing(scene: LoopScene, options: LoopViewOptions = {}): Mark {
  const plan = planLoop(scene, options);
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
    rowLayer.append(drawRow(row, index, y, { plan, scene, arrowLayer, prevDrawn, afterGap }));
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
