/**
 * How the canvas looks: colors, line weights, the background of each window
 * (color and grid), and how each window animates between steps.
 *
 * Everything visual is a CSS custom property, so applying a change is just
 * setting variables: nothing is re-rendered, and a change shows up the
 * moment you make it. The diagram colors are set on the canvas element, so
 * they don't leak into the toolbar or the editor. Each window's background
 * is set on that window, so the memory view and the loop history can
 * differ. Easing and duration aren't CSS: main.ts reads them when it
 * animates a step (see render/animate.ts).
 */

export type GridStyle = "lines" | "dots" | "none";

/** One canvas window: its background, and how it animates. */
export interface PaneStyle {
  background: string;
  grid: GridStyle;
  gridColor: string;
  /** Size of one grid square at 100% zoom, in pixels. */
  gridSize: number;
  /** A CSS easing function: "linear", "cubic-bezier(...)", ... */
  easing: string;
  /** Milliseconds; 0 turns animation off for this window. */
  duration: number;
}

export interface Appearance {
  /** The preset this started from, or "custom" once something's changed. */
  theme: string;
  memory: PaneStyle;
  loop: PaneStyle;
  /** Color variables, by key (see COLOR_FIELDS). */
  colors: Record<string, string>;
  /** Multiplies every arrow and edge's thickness. */
  arrowWidth: number;
  /** Outline thickness of boxes and cells, in pixels. */
  borderWidth: number;
  /** Corner radius of cells, in pixels. */
  cellRadius: number;
  /** Font for code inside the diagrams (monospace only: layout assumes it). */
  font: string;
  /** Changed cells flash briefly when they turn yellow. */
  flash: boolean;
}

export interface ColorField {
  key: string;
  /** The CSS custom property it sets. */
  cssVar: string;
  label: string;
  group: "Boxes and cells" | "Values" | "Marks" | "Graphs" | "Text on the background";
}

export const COLOR_FIELDS: ColorField[] = [
  { key: "ink", cssVar: "--ink", label: "Lines and text", group: "Boxes and cells" },
  { key: "inkSoft", cssVar: "--ink-soft", label: "Secondary text", group: "Boxes and cells" },
  { key: "inkFaint", cssVar: "--ink-faint", label: "Faint text, empty cells", group: "Boxes and cells" },
  { key: "cell", cssVar: "--cell", label: "Cell and box fill", group: "Boxes and cells" },
  { key: "cellAlt", cssVar: "--cell-alt", label: "Tuples, frame titles", group: "Boxes and cells" },
  { key: "header", cssVar: "--header", label: "Box titles", group: "Boxes and cells" },
  { key: "headerCode", cssVar: "--header-code", label: "Function and class titles", group: "Boxes and cells" },
  { key: "num", cssVar: "--v-num", label: "Numbers", group: "Values" },
  { key: "str", cssVar: "--v-str", label: "Strings", group: "Values" },
  { key: "const", cssVar: "--v-const", label: "True, False, None, null", group: "Values" },
  { key: "highlight", cssVar: "--highlight", label: "Changed (highlighter)", group: "Marks" },
  { key: "redpen", cssVar: "--redpen", label: "Change arrows (red pen)", group: "Marks" },
  { key: "ballpoint", cssVar: "--ballpoint", label: "References and pointers", group: "Marks" },
  { key: "mem", cssVar: "--mem", label: "Memory sizes", group: "Marks" },
  { key: "visited", cssVar: "--visited", label: "Visited nodes", group: "Graphs" },
  { key: "frontier", cssVar: "--frontier", label: "Waiting nodes (queue)", group: "Graphs" },
  { key: "tree", cssVar: "--tree", label: "Search tree edges", group: "Graphs" },
  { key: "path", cssVar: "--path", label: "Paths", group: "Graphs" },
  { key: "paperInk", cssVar: "--paper-ink", label: "Names and labels", group: "Text on the background" },
  { key: "paperInkSoft", cssVar: "--paper-ink-soft", label: "Secondary labels", group: "Text on the background" },
  { key: "paperInkFaint", cssVar: "--paper-ink-faint", label: "Index numbers", group: "Text on the background" },
];

export const EASINGS: { label: string; value: string }[] = [
  { label: "Smooth", value: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
  { label: "Linear", value: "linear" },
  { label: "Ease in and out", value: "cubic-bezier(0.65, 0, 0.35, 1)" },
  { label: "Ease out (fast start)", value: "cubic-bezier(0.16, 1, 0.3, 1)" },
  { label: "Ease in (slow start)", value: "cubic-bezier(0.5, 0, 0.75, 0)" },
  { label: "Overshoot", value: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
  { label: "Snap", value: "cubic-bezier(0.85, 0, 0.15, 1)" },
];

export const FONTS: { label: string; value: string }[] = [
  { label: "IBM Plex Mono", value: `"IBM Plex Mono", ui-monospace, monospace` },
  { label: "System monospace", value: `ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace` },
  { label: "Menlo / Consolas", value: `Menlo, Consolas, "DejaVu Sans Mono", monospace` },
  { label: "Courier", value: `"Courier New", Courier, monospace` },
];

const DEFAULT_EASE = EASINGS[0].value;

const pane = (background: string, gridColor: string, grid: GridStyle = "lines"): PaneStyle => ({
  background, grid, gridColor, gridSize: 24, easing: DEFAULT_EASE, duration: 260,
});

const GRAPH_PAPER: Appearance = {
  theme: "Graph paper",
  memory: pane("#e8edf1", "#d5dde5"),
  loop: pane("#e8edf1", "#d5dde5"),
  colors: {
    ink: "#1d2b45", inkSoft: "#5b6b85", inkFaint: "#93a1b5", cell: "#ffffff", cellAlt: "#f3f6f9",
    header: "#d6e0ea", headerCode: "#e2e7f5", num: "#1d2b45", str: "#8b3a9e", const: "#2e7a57",
    highlight: "#f6d743", redpen: "#c2362f", ballpoint: "#2f6fb0", mem: "#0a7d86",
    visited: "#cde7d8", frontier: "#d9822b", tree: "#2e7a57", path: "#7a4fb5",
    paperInk: "#1d2b45", paperInkSoft: "#5b6b85", paperInkFaint: "#93a1b5",
  },
  arrowWidth: 1,
  borderWidth: 1.25,
  cellRadius: 3,
  font: FONTS[0].value,
  flash: true,
};

/** Starting points. Everything can be changed afterwards. */
export const PRESETS: Appearance[] = [
  GRAPH_PAPER,
  {
    ...GRAPH_PAPER,
    theme: "Whiteboard",
    memory: pane("#ffffff", "#e6e9ee", "none"),
    loop: pane("#ffffff", "#e6e9ee", "none"),
    colors: { ...GRAPH_PAPER.colors, header: "#eef1f5", cellAlt: "#f6f7f9", headerCode: "#eef0f8" },
  },
  {
    ...GRAPH_PAPER,
    theme: "Dot grid",
    memory: pane("#f4f1ea", "#cfc8b8", "dots"),
    loop: pane("#f4f1ea", "#cfc8b8", "dots"),
    colors: { ...GRAPH_PAPER.colors, ink: "#2b2a28", paperInk: "#2b2a28", header: "#e7e0d0", headerCode: "#e9e4f0", cellAlt: "#f7f4ee" },
  },
  {
    ...GRAPH_PAPER,
    theme: "Blueprint",
    memory: pane("#1d4f8f", "#3a6aa8"),
    loop: pane("#1d4f8f", "#3a6aa8"),
    // White lines on blue, like the real thing: boxes are blue too.
    colors: {
      ink: "#ffffff", inkSoft: "#cfe0f5", inkFaint: "#8fb0dc", cell: "#24599c", cellAlt: "#1f5193",
      header: "#2e68b0", headerCode: "#3a62a8", num: "#ffffff", str: "#ffc9ef", const: "#b5f2d0",
      highlight: "#b8860b", redpen: "#ffb199", ballpoint: "#ffffff", mem: "#8ff0f7",
      visited: "#2f7a5a", frontier: "#ffb347", tree: "#9ff0c4", path: "#e3c4ff",
      paperInk: "#ffffff", paperInkSoft: "#cfe0f5", paperInkFaint: "#9fbde3",
    },
    arrowWidth: 1.2,
  },
  {
    ...GRAPH_PAPER,
    theme: "Night",
    memory: pane("#161b29", "#222a3d"),
    loop: pane("#161b29", "#222a3d"),
    colors: {
      ink: "#dfe5f1", inkSoft: "#a3aec4", inkFaint: "#69758f", cell: "#232b40", cellAlt: "#1d2436",
      header: "#2f3953", headerCode: "#333c5c", num: "#e8edf6", str: "#e6a3d9", const: "#7fd1b2",
      highlight: "#8a6d12", redpen: "#ff7a70", ballpoint: "#7fb0ff", mem: "#5fd7df",
      visited: "#24543d", frontier: "#f0a050", tree: "#6fd39e", path: "#b48cf0",
      paperInk: "#e6ebf5", paperInkSoft: "#a3aec4", paperInkFaint: "#69758f",
    },
  },
  {
    ...GRAPH_PAPER,
    theme: "High contrast",
    memory: pane("#ffffff", "#c9c9c9"),
    loop: pane("#ffffff", "#c9c9c9"),
    colors: {
      ink: "#000000", inkSoft: "#222222", inkFaint: "#555555", cell: "#ffffff", cellAlt: "#eeeeee",
      header: "#d9d9d9", headerCode: "#d9dcf0", num: "#000000", str: "#7a0080", const: "#005c2e",
      highlight: "#ffe600", redpen: "#d00000", ballpoint: "#0038d6", mem: "#005f69",
      visited: "#a8e6bf", frontier: "#c45a00", tree: "#00703a", path: "#6a1fc2",
      paperInk: "#000000", paperInkSoft: "#222222", paperInkFaint: "#555555",
    },
    arrowWidth: 1.6,
    borderWidth: 1.75,
  },
];

export const DEFAULT_APPEARANCE: Appearance = GRAPH_PAPER;

export function clone(a: Appearance): Appearance {
  return { ...a, memory: { ...a.memory }, loop: { ...a.loop }, colors: { ...a.colors } };
}

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;

/** Is this something the browser can use as an easing function? */
export function isEasing(value: string): boolean {
  if (/^(linear|ease|ease-in|ease-out|ease-in-out)$/.test(value)) return true;
  const m = /^cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,)]+)\s*\)$/.exec(value);
  if (!m) return false;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return [x1, y1, x2, y2].every(Number.isFinite) && x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1;
}

function readPane(raw: unknown, fallback: PaneStyle): PaneStyle {
  const p = (raw ?? {}) as Partial<PaneStyle>;
  return {
    background: typeof p.background === "string" && HEX.test(p.background) ? p.background : fallback.background,
    grid: p.grid === "lines" || p.grid === "dots" || p.grid === "none" ? p.grid : fallback.grid,
    gridColor: typeof p.gridColor === "string" && HEX.test(p.gridColor) ? p.gridColor : fallback.gridColor,
    gridSize: Math.round(clamp(p.gridSize, 8, 64, fallback.gridSize)),
    easing: typeof p.easing === "string" && isEasing(p.easing) ? p.easing : fallback.easing,
    duration: Math.round(clamp(p.duration, 0, 1500, fallback.duration)),
  };
}

/**
 * Read saved settings. Anything missing or invalid falls back to the
 * default, so old or hand-edited settings never break the canvas.
 */
export function parseAppearance(json: string | null): Appearance {
  const base = DEFAULT_APPEARANCE;
  let raw: Partial<Appearance> = {};
  try {
    raw = json ? (JSON.parse(json) as Partial<Appearance>) : {};
  } catch {
    raw = {};
  }
  if (typeof raw !== "object" || raw === null) raw = {};
  const colors: Record<string, string> = {};
  for (const field of COLOR_FIELDS) {
    const value = (raw.colors as Record<string, unknown> | undefined)?.[field.key];
    colors[field.key] = typeof value === "string" && HEX.test(value) ? value : base.colors[field.key];
  }
  return {
    theme: typeof raw.theme === "string" ? raw.theme : base.theme,
    memory: readPane(raw.memory, base.memory),
    loop: readPane(raw.loop, base.loop),
    colors,
    arrowWidth: clamp(raw.arrowWidth, 0.5, 3, base.arrowWidth),
    borderWidth: clamp(raw.borderWidth, 0.5, 3, base.borderWidth),
    cellRadius: clamp(raw.cellRadius, 0, 15, base.cellRadius),
    font: FONTS.some((f) => f.value === raw.font) ? raw.font! : base.font,
    flash: typeof raw.flash === "boolean" ? raw.flash : base.flash,
  };
}

/** The background-image for a grid style (the size is set by the viewport). */
export function gridImage(style: GridStyle): string {
  switch (style) {
    case "lines":
      return "linear-gradient(var(--paper-grid) 1px, transparent 1px), linear-gradient(90deg, var(--paper-grid) 1px, transparent 1px)";
    case "dots":
      return "radial-gradient(circle at 1.5px 1.5px, var(--paper-grid) 1.5px, transparent 2px)";
    case "none":
      return "none";
  }
}

/**
 * Apply settings: diagram variables on the canvas, and each window's
 * background on that window. `setGridSize` tells a viewport how big its
 * grid squares are (it scales them with the zoom).
 */
export function applyAppearance(
  a: Appearance,
  targets: { canvas: HTMLElement; memory: HTMLElement; loop: HTMLElement },
  setGridSize: (pane: "memory" | "loop", size: number) => void,
): void {
  const { canvas } = targets;
  for (const field of COLOR_FIELDS) canvas.style.setProperty(field.cssVar, a.colors[field.key]);
  // The divider between the windows sits on the canvas itself.
  canvas.style.setProperty("--paper", a.memory.background);
  canvas.style.setProperty("--arrow-width", String(a.arrowWidth));
  canvas.style.setProperty("--border-width", `${a.borderWidth}px`);
  canvas.style.setProperty("--cell-radius", `${a.cellRadius}px`);
  canvas.style.setProperty("--diagram-font", a.font);
  canvas.style.setProperty("--flash", a.flash ? "mark 450ms ease-out" : "none");
  for (const name of ["memory", "loop"] as const) {
    const el = targets[name];
    const p = a[name];
    el.style.setProperty("--paper", p.background);
    el.style.setProperty("--paper-grid", p.gridColor);
    el.style.setProperty("--grid-image", gridImage(p.grid));
    el.dataset.grid = p.grid;
    setGridSize(name, p.gridSize);
  }
}

export const APPEARANCE_KEY = "algoviz:appearance";
