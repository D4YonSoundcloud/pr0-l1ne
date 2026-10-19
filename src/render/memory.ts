/**
 * The memory view: one snapshot of the program.
 *
 *   frames (scopes)      heap, column 0        column 1 ...
 *   ┌ Global ───────┐    list  ┌──┬──┬──┐
 *   │ arr       ● ──┼──▶       │ 5│ 2│ 4│
 *   │ n         4   │          └──┴──┴──┘
 *   └───────────────┘    Node ┌────────┐     Node ┌────────┐
 *   ┌ fact ─────────┐         │ next ●─┼──▶       │ next   │
 *
 * Heap objects are placed in columns by distance from the stack, so a
 * linked list or tree reads left to right. Within a column, each object
 * lines up with the arrow pointing at it when there is room.
 *
 * Every frame and object is drawn in its own <g class="node"> with a stable
 * key (see nodeKey). A box the person has dragged is drawn at its saved
 * position instead of in its column, and arrows connect to wherever boxes
 * ended up.
 *
 * There are two ways to show a reference (MemoryMode):
 *   "arrows"  every object is its own box, and references are arrows.
 *   "nested"  an object that only one thing refers to is drawn inside that
 *             thing ("container in container"). Shared objects and cycles
 *             still need arrows, so they stay separate. See chooseNested.
 *
 * The parts, in memoryView/:
 *   shapes.ts     Shape, View, OutRef and the context (Ctx) they share
 *   tables.ts     frames, dicts, objects, functions, classes: title + rows
 *   sequences.ts  lists, tuples, sets; grids of nested lists
 *   objects.ts    any heap object as a shape; what goes in a value slot
 *   graphs.ts     a graph's box, with its picture (graphView.ts)
 *   trees.ts      binary trees as one block
 *   output.ts     the printed-output card
 *   layout.ts     columns, placement, routing: the whole drawing
 *   focus.ts      hover focus
 *
 * Everything is laid out as a drawing (drawing.ts): marks, not DOM
 * elements. renderMemory() makes it SVG for the SVG renderer; the canvas
 * renderer paints memoryDrawing() directly.
 */
import type { MemoryScene } from "../scene/memoryScene";
import { toSvg } from "./drawing";
import { memoryDrawing } from "./memoryView/layout";
import type { MemoryLayout } from "./memoryView/shapes";

export { applyFocus } from "./memoryView/focus";
export { memoryDrawing } from "./memoryView/layout";
export type { MemoryLayout, Point } from "./memoryView/shapes";

/** The memory view as SVG (for the SVG renderer, and tests): the drawing, made into elements. */
export function renderMemory(scene: MemoryScene, layout: MemoryLayout = { positions: new Map() }): SVGSVGElement {
  return toSvg(memoryDrawing(scene, layout)) as SVGSVGElement;
}
