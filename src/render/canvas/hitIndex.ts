/**
 * Finding what's under the pointer on the canvas, without looking at every
 * group of the drawing on every pointer move. The canvas has no elements
 * for the browser to hit-test, so the canvas renderer finds the box under
 * the pointer (to drag it, highlight its arrows, show its tooltip) from the
 * paint list's bounds. Looking through every group each move costs
 * milliseconds on a drawing of thousands of boxes, and a move asks two or
 * three times. So the groups that can be found (with a box's key, or a
 * tooltip) are put once per paint into a grid of square cells, each listing
 * the groups that reach it, and a point looks only in its own cell.
 *
 * What's found is what a walk through the groups in drawing order would
 * find last (the topmost): each group keeps its place in that order.
 */
import { groups, type PaintGroup, type Rect } from "./paint";

/** A grid cell's side, in diagram units: about a box's size, so a cell lists a few groups. */
const CELL = 256;
/** A group bigger than this many cells each way goes in a list of its own instead (a frame, a big grid). */
const MAX_SPAN = 64;

interface Entry {
  group: PaintGroup;
  bounds: Rect;
  /** Its place in drawing order: higher draws later, on top. */
  order: number;
}

const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

export class HitIndex {
  private readonly cells = new Map<number, Entry[]>();
  /** Groups too big for the grid: looked at for every point. */
  private readonly big: Entry[] = [];

  /** Index the groups of a paint list that `wanted` keeps. */
  constructor(root: PaintGroup, wanted: (group: PaintGroup) => boolean) {
    let order = 0;
    for (const group of groups(root)) {
      order++;
      if (!group.bounds || !wanted(group)) continue;
      const entry = { group, bounds: group.bounds, order };
      const x0 = Math.floor(group.bounds.x / CELL);
      const y0 = Math.floor(group.bounds.y / CELL);
      const x1 = Math.floor((group.bounds.x + group.bounds.w) / CELL);
      const y1 = Math.floor((group.bounds.y + group.bounds.h) / CELL);
      if (x1 - x0 > MAX_SPAN || y1 - y0 > MAX_SPAN) {
        this.big.push(entry);
        continue;
      }
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          const key = cellKey(cx, cy);
          const list = this.cells.get(key);
          if (list) list.push(entry);
          else this.cells.set(key, [entry]);
        }
    }
  }

  /** The topmost group containing the point (diagram units) that `accept` takes, or null. */
  at(x: number, y: number, accept: (group: PaintGroup) => boolean = () => true): PaintGroup | null {
    let best: Entry | null = null;
    const look = (list: Entry[] | undefined) => {
      if (!list) return;
      for (const e of list)
        if ((!best || e.order > best.order) && contains(e.bounds, x, y) && accept(e.group)) best = e;
    };
    look(this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))));
    look(this.big);
    return (best as Entry | null)?.group ?? null;
  }
}

/** One number for a cell (cells reach about ±10^6 each way, far past any drawing). */
const cellKey = (cx: number, cy: number) => (cx + 1_048_576) * 2_097_152 + (cy + 1_048_576);
