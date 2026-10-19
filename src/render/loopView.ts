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
 *
 * The parts, in loopView/:
 *   shared.ts   spacing, the column and track layouts, names and cells
 *   plan.ts     where everything goes in a row (shared by every row)
 *   row.ts      one row: containers, variables, change arrows
 *   grid.ts     a list of lists, as a grid
 *   linked.ts   a linked list or a binary tree
 *   bands.ts    loop headers, unrecorded passes, passes where nothing changed
 *   layout.ts   the rows top to bottom: the whole drawing
 *
 * Everything is laid out as a drawing (drawing.ts): marks, not DOM
 * elements. renderLoopHistory() makes it SVG for the SVG renderer; the
 * canvas renderer paints loopDrawing() directly.
 */
import type { LoopScene } from "../scene/loopScene";
import { toSvg } from "./drawing";
import { loopDrawing } from "./loopView/layout";
import type { LoopViewOptions } from "./loopView/shared";

export { loopDrawing } from "./loopView/layout";
export type { LoopViewOptions } from "./loopView/shared";

/** The loop history as SVG (for the SVG renderer, and tests): the drawing, made into elements. */
export function renderLoopHistory(scene: LoopScene, options: LoopViewOptions = {}): SVGSVGElement {
  return toSvg(loopDrawing(scene, options)) as SVGSVGElement;
}
