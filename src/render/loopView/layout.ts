/** The whole loop view as a drawing: the plan's rows, top to bottom, with the bands between them. */
import { timed } from "../../perf";
import type { LoopScene } from "../../scene/loopScene";
import { arrowMarkers, s } from "../draw";
import type { Mark } from "../drawing";
import { buildAt } from "../lod";
import { drawFold, drawGap, drawHeader, drawQuietBand } from "./bands";
import { type LoopPlan, planLoop } from "./plan";
import { type DrawnRow, drawRow } from "./row";
import { rowKey, sceneKey } from "./rowCache";
import { BAND_H, type LoopViewOptions, MARGIN, ROW_GAP } from "./shared";

/** Lay out a loop scene as a drawing (drawing.ts). */
export function loopDrawing(scene: LoopScene, options: LoopViewOptions = {}): Mark {
  return timed("loop.layout", () => drawLoop(scene, options));
}

function drawLoop(scene: LoopScene, options: LoopViewOptions): Mark {
  const plan = planLoop(scene, options);
  const level = typeof options.level === "function" ? options.level(loopSize(scene, plan)) : (options.level ?? 0);
  const cache = options.rows;
  cache?.begin(sceneKey(scene, plan, !!options.vertical), level);
  try {
    return buildAt(level, () => drawRows(scene, options, plan));
  } finally {
    cache?.end();
  }
}

/** The drawing's size, without drawing it: what drawRows will make it (layout.test.ts holds them together). */
export function loopSize(scene: LoopScene, plan: LoopPlan): { width: number; height: number } {
  let y = MARGIN;
  if (scene.hiddenRows && !scene.live) y += NOTE_H;
  for (const item of scene.items) {
    if (item.kind === "header") y += scene.info(item.loop) ? BAND_H : 0;
    else if (item.kind === "gap" || item.kind === "band" || item.kind === "fold") y += BAND_H + 6;
    else y += plan.rowH + ROW_GAP;
  }
  return { width: plan.contentW + MARGIN, height: y - ROW_GAP + MARGIN };
}

/** The "earlier iterations not shown" note's height. */
const NOTE_H = 28;

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
    y += NOTE_H;
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
    if (item.kind === "fold") {
      // Rows folded (scene/loopSummaries.ts): no change arrows across it, as across a gap.
      y += drawFold(rowLayer, item, y, plan, scene);
      afterGap = true;
      continue;
    }
    const { row, index } = item;
    // Only the rows in view (and the current one, which the window keeps in view) are drawn.
    const inView = !visible || scene.isCurrent(index) || (y + plan.rowH + 4 >= visible.top && y - 6 <= visible.bottom);
    if (inView) {
      // Drawn from its own top and moved down to y, with its change arrows: the row above is where it is from here.
      const above = prevDrawn ? { ...prevDrawn, y: prevDrawn.y - y } : null;
      const shell = rowShell(scene, row, index, y, plan.rowH);
      // Keyed, so the SVG patcher matches each row with itself, wherever it's moved (patch.ts).
      const arrows = s("g", { class: "row-arrows", "data-key": `arrows:${index}`, transform: `translate(0 ${y})` });
      rowLayer.append(shell);
      arrowLayer.append(arrows);
      const key = cache?.on ? rowKey(scene, plan, row, index, above, afterGap) : null;
      const kept = key ? cache!.get(key) : undefined;
      if (kept) {
        shell.appendShared(kept.row);
        arrows.appendShared(...kept.arrows);
      } else {
        const drawn = drawRow(row, index, 0, { plan, scene, arrowLayer: arrows, prevDrawn: above, afterGap });
        if (live) scopeToLoop(drawn, row.loop ?? scene.history.info.id);
        shell.append(drawn);
        if (key) cache!.set(key, { row: drawn, arrows: [...arrows.childNodes] as Mark[] });
      }
      if (!arrows.childNodes.length) arrows.remove();
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
 * What a row is moved to its place with: its classes (the running row, a
 * failing check) and its extent (data-top / data-bottom, so the viewport
 * can keep it in view without measuring the page), around its body.
 */
function rowShell(scene: LoopScene, row: LoopScene["rows"][number], index: number, y: number, rowH: number): Mark {
  const classes = [
    "loop-row",
    scene.isCurrent(index) && "is-current",
    scene.failedChecks(row).length > 0 && "is-failing",
  ];
  return s("g", {
    class: classes.filter(Boolean).join(" "),
    "data-key": `row:${index}`,
    "data-top": y - 6,
    "data-bottom": y + rowH + 4,
    transform: `translate(0 ${y})`,
  });
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
