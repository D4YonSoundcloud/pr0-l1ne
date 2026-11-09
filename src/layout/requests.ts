/**
 * What the page asks the layout (layout/session.ts) to draw, and what comes
 * back: plain data, to cross to the layout worker and back. A request is in
 * two parts: what to show (the step, the window's own settings: the
 * controllers say) and how the window is looking at it (the zoom's level,
 * boxes dragged, the rows in view: the renderer says).
 */
import { type ArrowStyle, arrowStyle } from "../render/arrowStyle";
import { type Spacing, spacing } from "../render/spacing";
import type { FitParams } from "../render/viewport";
import type { MemoryMode } from "../scene/memoryScene";
import type { Point } from "../scene/renderer";
import type { SizeModel } from "../trace/memory";

/**
 * How the page lays things out, set in its panels: the Layout panel's
 * spacing (render/spacing.ts) and the Style panel's arrows
 * (render/arrowStyle.ts). The layout reads them where it runs, so they go
 * with every request.
 */
export interface Look {
  spacing: Spacing;
  arrows: ArrowStyle;
}

/** The page's look now. */
export const currentLook = (): Look => ({ spacing: { ...spacing }, arrows: { ...arrowStyle } });

/** What the memory window shows (MemoryController). */
export interface MemoryShow {
  look: Look;
  step: number;
  mode: MemoryMode;
  sizes: SizeModel | null;
  output: boolean;
  dimForOutput: boolean;
  tall: boolean;
  /** Summaries and clusters the person opened, by key. */
  expanded: string[];
  /** Show all: nothing summarized (every node of a big tree or list, every call). */
  all?: boolean;
}

/** How the memory window looks at it (MemoryRenderer.layoutView). */
export interface MemoryView {
  /** Boxes the person dragged: top-left corners, in diagram units. */
  positions: [string, Point][];
  /** The box being dragged, drawn on top. */
  raise: string | null;
  simpleArrows: boolean;
  /** The level of detail to build at (lod.ts buildAt). */
  level: number;
  /** How many nodes of one run to draw before summarizing (scene/summaries.ts detailBudget). */
  budget: number;
  /** Laid out in full, from scratch, at full detail (to save it): the window's kept boxes are left alone. */
  full?: boolean;
}

/** A tab over the loop history: a loop to pick, or all of them together. */
export interface LoopTab {
  text: string;
  selected: boolean;
  /** What picking it picks (a loop's id, or ALL_LOOPS). */
  pick: string;
  title?: string;
}

/** What the loop window shows (LoopController). */
export interface LoopShow {
  look: Look;
  step: number;
  /** The loop picked in the tabs (ALL_LOOPS: nested loops together), or null for the innermost running. */
  selected: string | null;
  mode: "stacked" | "animated";
  hideQuiet: boolean;
  sizes: SizeModel | null;
  tall: boolean;
  /** Folds and clusters the person opened, by key. */
  expanded: string[];
}

/** How the loop window looks at it (LoopRenderer.layoutView). */
export interface LoopView {
  vertical: boolean;
  /** The part of the drawing in view, in diagram units: rows outside it aren't drawn. Absent: all of them. */
  visible?: { top: number; bottom: number };
  /** What the level to build at goes by (viewport.ts levelForFit). */
  fit: FitParams;
  /** How many cells to draw before folding rows (scene/loopSummaries.ts loopDetailBudget). */
  budget: number;
  full?: boolean;
}

/** A memory drawing laid out, and what the window needs to know about it. */
export interface MemoryLaidOut<D> {
  drawing: D;
  /** A SQL step's tables. */
  sql: boolean;
  /** The detail budget it was made with (none for SQL). */
  detailBudget?: number;
  /** Each summary's box (by key) and the structure it opens. */
  summaryKeys: [string, string][];
  /** Everything the program holds at this step, each object counted once, when sizes are shown (trace/memory.ts). */
  total?: { program: number; approximate: boolean };
}

/** A loop drawing laid out (or why there's none), and the window's tabs. */
export interface LoopLaidOut<D> {
  /** Null: nothing to draw; `message` says why. */
  drawing: D | null;
  message: string;
  sql: boolean;
  /** The cell budget it was folded with (none for SQL, or animated). */
  cellBudget?: number;
  /** Animated mode (one live row), which animates from step to step. */
  live: boolean;
  /** The rows drawn (to lay out the same again in full, to save). */
  visible?: { top: number; bottom: number };
  tabs: LoopTab[];
}
