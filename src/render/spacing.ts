/**
 * The memory and loop views' spacing: how far apart boxes, columns, rows
 * and arrows are. The Layout panel (spacingPanel.ts) changes these while
 * you watch.
 *
 * The values the layout uses are the current ones here. Each layout module
 * keeps its own named copies (LANE in route.ts, ROW_GAP in
 * loopView/shared.ts...) and refreshes them from here whenever they change
 * (onSpacingChange), so the layout code reads the same as with fixed
 * constants. Changing spacing doesn't redraw anything by itself: the app
 * redraws the step afterwards (app/spacingController.ts).
 *
 * No DOM here: the panel and the saved layouts are elsewhere.
 */

export type SpacingGroup = "arrows" | "boxes" | "loop";

export interface SpacingField {
  key: SpacingKey;
  group: SpacingGroup;
  label: string;
  /** What it does, in the person's terms (shown under the slider). */
  help: string;
  min: number;
  max: number;
  step: number;
}

/** The default spacing: the layout as it was designed. */
export const DEFAULT_SPACING = {
  // Arrows in the memory view (route.ts)
  lane: 7,
  gapPad: 14,
  forwardGap: 20,
  corridorPad: 12,
  spread: 6,
  topGap: 14,
  behindCost: 300,
  // Boxes in the memory view (memoryView/layout.ts, memoryView/trees.ts)
  columnGap: 64,
  busyColumnGap: 96,
  busyAfter: 4,
  stackGap: 22,
  memoryMargin: 24,
  memoryTop: 28,
  exitDrop: 9,
  exitLane: 7,
  treeGap: 34,
  treeLevelGap: 44,
  // The loop history (loopView/shared.ts)
  rowGap: 34,
  containerGap: 44,
  scalarsGap: 28,
  laneGap: 16,
  indent: 16,
  nodeGap: 30,
  arcTop: 30,
  arcBottom: 26,
  loopLevelGap: 34,
  loopMargin: 20,
} as const;

export type SpacingKey = keyof typeof DEFAULT_SPACING;
export type Spacing = Record<SpacingKey, number>;

/**
 * Every setting, in the panel's order. The ranges are what the layout
 * handles: below a minimum, arrows or labels start to collide.
 */
export const SPACING_FIELDS: SpacingField[] = [
  {
    key: "lane",
    group: "arrows",
    label: "Lane spacing",
    help: "Between arrows running side by side in the same gap.",
    min: 2,
    max: 20,
    step: 1,
  },
  {
    key: "gapPad",
    group: "arrows",
    label: "Lane inset",
    help: "From a box's edge to the first arrow lane beside it.",
    min: 4,
    max: 40,
    step: 1,
  },
  {
    key: "forwardGap",
    group: "arrows",
    label: "Forward distance",
    help: "How far right a target must be for an arrow to go straight to it, instead of looping around.",
    min: 0,
    max: 80,
    step: 1,
  },
  {
    key: "corridorPad",
    group: "arrows",
    label: "Clearance",
    help: "Between boxes and an arrow that goes over or under them.",
    min: 4,
    max: 40,
    step: 1,
  },
  {
    key: "spread",
    group: "arrows",
    label: "Arrowhead spacing",
    help: "Between arrowheads arriving at the same side of a box.",
    min: 0,
    max: 16,
    step: 1,
  },
  {
    key: "topGap",
    group: "arrows",
    label: "Tree turn-in",
    help: "How far above a tree node an arrow from outside the tree turns in.",
    min: 6,
    max: 40,
    step: 1,
  },
  {
    key: "behindCost",
    group: "arrows",
    label: "Go around",
    help: "How much longer, in pixels, an arrow will be to go around a box instead of straight behind it. 0: always behind.",
    min: 0,
    max: 2000,
    step: 50,
  },
  {
    key: "columnGap",
    group: "boxes",
    label: "Column gap",
    help: "Between columns of boxes.",
    min: 24,
    max: 200,
    step: 2,
  },
  {
    key: "busyColumnGap",
    group: "boxes",
    label: "Busy column gap",
    help: "Between columns with many arrows running through the gap.",
    min: 24,
    max: 240,
    step: 2,
  },
  {
    key: "busyAfter",
    group: "boxes",
    label: "Busy after",
    help: "How many arrows a gap holds before it gets the busy width.",
    min: 0,
    max: 20,
    step: 1,
  },
  {
    key: "stackGap",
    group: "boxes",
    label: "Box spacing",
    help: "Between boxes one above another in a column.",
    min: 4,
    max: 80,
    step: 1,
  },
  {
    key: "memoryMargin",
    group: "boxes",
    label: "Margin",
    help: "Around the whole drawing.",
    min: 0,
    max: 80,
    step: 1,
  },
  {
    key: "memoryTop",
    group: "boxes",
    label: "Room above",
    help: "Above the boxes, for arrows that go over the top.",
    min: 8,
    max: 80,
    step: 1,
  },
  {
    key: "exitDrop",
    group: "boxes",
    label: "List arrow drop",
    help: "How far below a list its cells' arrows turn.",
    min: 4,
    max: 30,
    step: 1,
  },
  {
    key: "exitLane",
    group: "boxes",
    label: "List arrow lanes",
    help: "Between the arrows leaving one list.",
    min: 2,
    max: 20,
    step: 1,
  },
  {
    key: "treeGap",
    group: "boxes",
    label: "Tree node spacing",
    help: "Between neighboring nodes of a binary tree (never less than the lane inset, for the arrows between them).",
    min: 14,
    max: 100,
    step: 1,
  },
  {
    key: "treeLevelGap",
    group: "boxes",
    label: "Tree level spacing",
    help: "Between a tree's levels.",
    min: 16,
    max: 120,
    step: 1,
  },
  {
    key: "rowGap",
    group: "loop",
    label: "Row spacing",
    help: "Between one pass of a loop and the next.",
    min: 8,
    max: 100,
    step: 1,
  },
  {
    key: "containerGap",
    group: "loop",
    label: "Container spacing",
    help: "Between the lists, dicts and other containers in a row.",
    min: 12,
    max: 120,
    step: 1,
  },
  {
    key: "scalarsGap",
    group: "loop",
    label: "Variables gap",
    help: "Between the last container and the row's variables (i = 2  j = 0).",
    min: 8,
    max: 80,
    step: 1,
  },
  {
    key: "laneGap",
    group: "loop",
    label: "Stacked spacing",
    help: "Between containers stacked one above another (One per line).",
    min: 4,
    max: 60,
    step: 1,
  },
  {
    key: "indent",
    group: "loop",
    label: "Nested indent",
    help: "How far an inner loop's row labels are indented.",
    min: 0,
    max: 48,
    step: 1,
  },
  {
    key: "nodeGap",
    group: "loop",
    label: "Linked node spacing",
    help: "Between the nodes of a linked list, room for the arrow between them.",
    min: 16,
    max: 80,
    step: 1,
  },
  {
    key: "arcTop",
    group: "loop",
    label: "Room for arcs above",
    help: "Above a linked list, for links that arc over the nodes.",
    min: 12,
    max: 80,
    step: 1,
  },
  {
    key: "arcBottom",
    group: "loop",
    label: "Room for arcs below",
    help: "Below a linked list, for a second set of links.",
    min: 12,
    max: 80,
    step: 1,
  },
  {
    key: "loopLevelGap",
    group: "loop",
    label: "Tree level spacing",
    help: "Between the levels of a tree in a row.",
    min: 12,
    max: 100,
    step: 1,
  },
  {
    key: "loopMargin",
    group: "loop",
    label: "Margin",
    help: "Around the whole drawing.",
    min: 0,
    max: 80,
    step: 1,
  },
];

export const SPACING_GROUPS: { key: SpacingGroup; title: string }[] = [
  { key: "arrows", title: "Memory view: arrows" },
  { key: "boxes", title: "Memory view: boxes" },
  { key: "loop", title: "Loop history" },
];

const FIELDS = new Map(SPACING_FIELDS.map((f) => [f.key, f]));

/** A value within its field's range (and on its step), or the default if it isn't a number. */
export function clampSpacing(key: SpacingKey, value: unknown): number {
  const field = FIELDS.get(key)!;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SPACING[key];
  const stepped = Math.round((value - field.min) / field.step) * field.step + field.min;
  return Math.min(field.max, Math.max(field.min, Math.round(stepped * 1000) / 1000));
}

/** Read spacing from saved JSON (or an object). Anything missing or invalid is the default. */
export function parseSpacing(raw: unknown): Spacing {
  let values: unknown = raw;
  if (typeof raw === "string") {
    try {
      values = JSON.parse(raw);
    } catch {
      values = null;
    }
  }
  const from = (typeof values === "object" && values !== null ? values : {}) as Record<string, unknown>;
  const out = {} as Spacing;
  for (const field of SPACING_FIELDS) out[field.key] = clampSpacing(field.key, from[field.key]);
  return out;
}

export const defaultSpacing = (): Spacing => ({ ...DEFAULT_SPACING });

export function sameSpacing(a: Spacing, b: Spacing): boolean {
  return SPACING_FIELDS.every((f) => a[f.key] === b[f.key]);
}

/** The settings that differ from the defaults (what a saved layout needs to store). */
export function changedFromDefault(s: Spacing): Partial<Spacing> {
  const out: Partial<Spacing> = {};
  for (const f of SPACING_FIELDS) if (s[f.key] !== DEFAULT_SPACING[f.key]) out[f.key] = s[f.key];
  return out;
}

// ---------------------------------------------------------------- the current spacing

const current: Spacing = defaultSpacing();
const listeners: (() => void)[] = [];

/** The spacing the layout uses now. Read-only: change it with setSpacing. */
export const spacing: Readonly<Spacing> = current;

/** Use this spacing from now on (values are clamped to their ranges). */
export function setSpacing(next: Partial<Spacing>): void {
  for (const field of SPACING_FIELDS)
    current[field.key] = clampSpacing(field.key, next[field.key] ?? DEFAULT_SPACING[field.key]);
  for (const listener of listeners) listener();
}

/** Call `refresh` now and whenever the spacing changes (the layout modules' named copies). */
export function onSpacingChange(refresh: () => void): void {
  listeners.push(refresh);
  refresh();
}
