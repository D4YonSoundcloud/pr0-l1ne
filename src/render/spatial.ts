/**
 * A uniform grid of rectangles, for asking "which boxes are near here?"
 * without looking at every box. Placing a box (findFreeY) and routing an
 * arrow (route.ts) each ask which boxes something overlaps; with every box
 * looked at each time, a drawing of n boxes costs n² checks, and a long
 * list or a deep recursion has thousands. The grid files each box under
 * every square cell it touches, so a question looks only at the cells it
 * covers.
 *
 * Answers come in the order the boxes were added, each once, so whatever
 * works through them finds the same thing it would have found going
 * through the whole list.
 */
import type { Rect } from "./route";

/** A cell's side, in diagram units: a few boxes wide, so a cell lists a few boxes. */
const CELL = 200;

export class RectGrid<T extends Rect = Rect> {
  private readonly cells = new Map<number, number[]>();
  /** Every box, in the order added. */
  readonly items: T[] = [];
  /** Which question last saw each box (so each comes back once). */
  private seen: number[] = [];
  private asked = 0;

  constructor(rects: Iterable<T> = []) {
    for (const r of rects) this.add(r);
  }

  get length(): number {
    return this.items.length;
  }

  add(rect: T): void {
    const index = this.items.length;
    this.items.push(rect);
    this.seen.push(0);
    const [x0, y0, x1, y1] = span(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        const list = this.cells.get(key);
        if (list) list.push(index);
        else this.cells.set(key, [index]);
      }
  }

  /**
   * The boxes that may touch the area from (x1, y1) to (x2, y2): every box
   * that does, and perhaps a few near it (callers check exactly). In the
   * order they were added.
   */
  near(x1: number, y1: number, x2: number, y2: number): T[] {
    const [cx0, cy0, cx1, cy1] = span(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
    // An area wider than the grid itself: every box (cheaper than visiting empty cells).
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.cells.size) return this.items.slice();
    const stamp = ++this.asked;
    const found: number[] = [];
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cy = cy0; cy <= cy1; cy++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const i of list) {
          if (this.seen[i] === stamp) continue;
          this.seen[i] = stamp;
          found.push(i);
        }
      }
    found.sort((a, b) => a - b);
    return found.map((i) => this.items[i]);
  }
}

function span(x1: number, y1: number, x2: number, y2: number): [number, number, number, number] {
  return [Math.floor(x1 / CELL), Math.floor(y1 / CELL), Math.floor(x2 / CELL), Math.floor(y2 / CELL)];
}

/** One number for a cell (good for ±10^6 cells each way, far past any drawing). */
const cellKey = (cx: number, cy: number) => (cx + 1_048_576) * 2_097_152 + (cy + 1_048_576);
