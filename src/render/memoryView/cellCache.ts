/**
 * Cells kept inside a box, one level down from boxCache.ts. A box is kept
 * whole only when nothing it shows changed; a 60 × 60 grid with one cell
 * written is drawn again, all 3,600 cells of it, though 3,599 look exactly
 * as they did. So a plain cell (a value, not a nested object) is kept by
 * everything its marks are made from: its container and slot, its value,
 * its place and size, and the heatmap range coloring it. A cell drawn the
 * same is then the same marks (Mark.appendShared), which the SVG patcher
 * and the canvas skip at once, as they do kept boxes.
 *
 * A cell that changed this step is always drawn afresh: its flash plays
 * when it appears (render/patch.ts playsOnArrival).
 */
import type { Mark } from "../drawing";
import type { OutRef } from "./shapes";

interface Kept {
  marks: Mark[];
  /** The arrows leaving it (a reference cell's dot), as drawn. */
  refs: OutRef[];
}

export class CellCache {
  private kept = new Map<string, Kept>();
  private next = new Map<string, Kept>();
  stats = { drawn: 0, kept: 0 };

  /** A layout begins: cells not used in it are forgotten after it. */
  begin(): void {
    this.next = new Map();
    this.stats = { drawn: 0, kept: 0 };
  }

  end(): void {
    this.kept = this.next;
    this.next = new Map();
  }

  /** Forget every kept cell (what they're drawn from changed: spacing, fonts). */
  clear(): void {
    this.kept.clear();
    this.next.clear();
  }

  /** While a box is drawn, the keys of the cells it drew (boxCache.ts keeps them with the box). */
  private recording: string[] | null = null;

  /** Draw something, and say which cells it drew. */
  record(draw: () => void): string[] {
    const outer = this.recording;
    const keys: string[] = [];
    this.recording = keys;
    try {
      draw();
    } finally {
      this.recording = outer;
    }
    outer?.push(...keys);
    return keys;
  }

  /** A box kept whole uses its cells again without drawing them: keep them for the next drawing. */
  touch(keys: string[]): void {
    for (const key of keys) {
      const kept = this.kept.get(key);
      if (kept && !this.next.has(key)) this.next.set(key, kept);
    }
  }

  /**
   * A cell into `g`: its kept marks if one was drawn with this key, else
   * `draw()` (which appends it to `g`, and its arrow to `refs`), kept. A
   * null key (a cell that changed) is always drawn.
   */
  cell(key: string | null, g: Mark, refs: OutRef[], draw: () => void): void {
    // Used already in this drawing: drawn again (one mark can't be in two places).
    const used = key !== null && this.next.has(key);
    if (key !== null && !used) this.recording?.push(key);
    const kept = key === null || used ? undefined : this.kept.get(key);
    if (kept) {
      this.next.set(key!, kept);
      g.appendShared(...kept.marks);
      for (const ref of kept.refs) refs.push({ ...ref });
      this.stats.kept++;
      return;
    }
    const start = g.childNodes.length;
    const before = refs.length;
    draw();
    this.stats.drawn++;
    if (key === null || used) return;
    this.next.set(key, {
      marks: g.childNodes.slice(start) as Mark[],
      refs: refs.slice(before).map((r) => ({ ...r })),
    });
  }
}

/** A heatmap range as part of a key. */
export const heatKey = (heat: { min: number; max: number } | null) => (heat ? `${heat.min},${heat.max}` : "-");
