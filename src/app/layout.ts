/**
 * The page's layout on a wide screen: where the three windows (the code,
 * memory and loop history; for SQL, the code, Tables and Query steps) go,
 * and how big they are.
 *
 *   Stacked        the code on one side; memory over loop history on the other
 *   Side by side   the code, memory and loop history in three columns
 *
 * The dividers between windows can be dragged, moved with the arrow keys and
 * reset with a double-click, and their positions are remembered (for each
 * layout). The ⇄ button swaps the code and the canvas sides.
 *
 * Each window can be minimized (it folds to a thin bar with its name, and
 * the others take its room) or maximized (the other two fold to bars).
 * Clicking a bar opens its window again. One window always stays open.
 *
 * styles.css, "Wide screens", reads what this sets: CSS variables for the
 * grid tracks, and classes on the windows. Phones have their own layout
 * (mobileViews.ts), which ignores all of this.
 */
import type { Setting, Settings } from "../settings";

type Value<T> = T | (() => T);
const resolve = <T>(value: Value<T>): T => (typeof value === "function" ? (value as () => T)() : value);

export interface DividerOptions {
  /** Which way it moves: "x" (a vertical bar, dragged sideways) or "y". Can change (see reload). */
  axis: Value<"x" | "y">;
  /** The element whose size the divider splits. */
  container: HTMLElement;
  min: number;
  max: number;
  initial: Value<number>;
  /** Where the position is remembered. */
  saved: Value<Setting<number | null>>;
  /** Apply a value (a percentage). */
  apply(value: number): void;
  /**
   * Turn a pointer position (percent along the container) into a value, and
   * say which way arrow keys move it. Defaults suit a value measured from
   * the left or top edge.
   */
  fromPointer?(percent: number): number;
  keyDirection?(): 1 | -1;
}

/** Moves a divider; `reload()` goes back to its saved position (after its axis or setting changes). */
export type DividerMove = ((value: number) => void) & { reload(): void };

/** A draggable, keyboard-operable divider whose position is remembered. */
export function makeDivider(divider: HTMLElement, options: DividerOptions): DividerMove {
  const { container, min, max } = options;
  let value = resolve(options.initial);
  const set = (next: number) => {
    value = Math.round(Math.max(min, Math.min(max, next)));
    options.apply(value);
    divider.setAttribute("aria-valuenow", String(value));
    resolve(options.saved).set(value);
  };
  const reload = () => {
    divider.setAttribute("aria-orientation", resolve(options.axis) === "x" ? "vertical" : "horizontal");
    set(resolve(options.saved).get() || resolve(options.initial));
  };
  reload();

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("is-dragging");
    const move = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const percent =
        resolve(options.axis) === "x"
          ? ((e.clientX - rect.left) / rect.width) * 100
          : ((e.clientY - rect.top) / rect.height) * 100;
      set(options.fromPointer ? options.fromPointer(percent) : percent);
    };
    const stop = () => {
      divider.classList.remove("is-dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", stop);
      divider.removeEventListener("pointercancel", stop);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", stop);
    divider.addEventListener("pointercancel", stop);
  });

  divider.addEventListener("dblclick", () => set(resolve(options.initial)));

  divider.addEventListener("keydown", (event) => {
    const [back, forward] = resolve(options.axis) === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const direction = event.key === back ? -1 : event.key === forward ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation(); // arrow keys elsewhere step through the program
    set(value + direction * 3 * (options.keyDirection?.() ?? 1));
  });

  return Object.assign(set, { reload });
}

// ---------------------------------------------------------------- which windows are open

export type WindowName = "editor" | "memory" | "loop";
export const WINDOWS: readonly WindowName[] = ["editor", "memory", "loop"];
export type LayoutMode = "stacked" | "columns";

const isWindow = (value: string): value is WindowName => (WINDOWS as readonly string[]).includes(value);

/** Saved as "memory,loop". Anything that isn't a window is dropped; all three folded means none. */
export function parseCollapsed(raw: string | null): WindowName[] {
  const names = [...new Set((raw ?? "").split(",").map((v) => v.trim()))].filter(isWindow);
  return names.length >= WINDOWS.length ? [] : WINDOWS.filter((w) => names.includes(w));
}

/** Maximize `name`: the other two fold. */
export const maximize = (name: WindowName): WindowName[] => WINDOWS.filter((w) => w !== name);

/**
 * Minimize `name`. If it was the only window open, the other two open
 * instead: one window always stays open.
 */
export function minimize(collapsed: readonly WindowName[], name: WindowName): WindowName[] {
  const next = WINDOWS.filter((w) => w === name || collapsed.includes(w));
  return next.length === WINDOWS.length ? [name] : next;
}

/** Open `name` again. */
export const expand = (collapsed: readonly WindowName[], name: WindowName): WindowName[] =>
  collapsed.filter((w) => w !== name);

/** Is `name` the only window open? */
export const isMaximized = (collapsed: readonly WindowName[], name: WindowName): boolean =>
  collapsed.length === WINDOWS.length - 1 && !collapsed.includes(name);

/** A folded window's bar, in pixels: the width of a column, or the height of a row. */
export const BAR = 32;
/** A divider's thickness, in pixels. */
export const DIVIDER = 6;

export interface Tracks {
  /** The workspace's columns: the code, its divider, and the canvas (in page order). */
  workspace: string;
  /** The canvas's tracks, memory / divider / loop history: rows when stacked, columns side by side. */
  canvas: string;
  /** Which divider can be used (the others are folded away). */
  divider: boolean;
  canvasDivider: boolean;
  /** Does this window's bar stand upright (in a column), or lie across (in a row)? */
  upright: Record<WindowName, boolean>;
}

/**
 * The grid for a layout: where each window goes and how big it is. Sizes
 * come from CSS variables, --split (the code's share of the width) and
 * --canvas-split (memory's share of the canvas), which the dividers set.
 */
export function layoutTracks(mode: LayoutMode, collapsed: readonly WindowName[], swapped: boolean): Tracks {
  const folded = (w: WindowName) => collapsed.includes(w);
  const canvasFolded = folded("memory") && folded("loop");
  const columns = mode === "columns";

  // The canvas: memory, a divider, loop history.
  let canvas: string;
  if (canvasFolded) canvas = columns ? `${BAR}px 0 ${BAR}px` : "minmax(0, 1fr) 0 minmax(0, 1fr)";
  else if (folded("memory")) canvas = `${BAR}px 0 minmax(0, 1fr)`;
  else if (folded("loop")) canvas = `minmax(0, 1fr) 0 ${BAR}px`;
  else canvas = `minmax(0, var(--canvas-split)) ${DIVIDER}px minmax(0, 1fr)`;

  // The workspace: the code, a divider, the canvas.
  const canvasBars = columns ? 2 * BAR : BAR;
  let code: string;
  let rest: string;
  let gap = `${DIVIDER}px`;
  if (folded("editor")) [code, rest, gap] = [`${BAR}px`, "minmax(0, 1fr)", "0"];
  else if (canvasFolded) [code, rest, gap] = ["minmax(0, 1fr)", `${canvasBars}px`, "0"];
  else [code, rest] = ["minmax(0, var(--split))", "minmax(0, 1fr)"];
  const workspace = (swapped ? [rest, gap, code] : [code, gap, rest]).join(" ");

  const upright = columns || canvasFolded;
  return {
    workspace,
    canvas,
    divider: !folded("editor") && !canvasFolded,
    canvasDivider: !folded("memory") && !folded("loop"),
    upright: { editor: true, memory: upright, loop: upright },
  };
}

// ---------------------------------------------------------------- the controller

export interface LayoutElements {
  workspace: HTMLElement;
  editorPane: HTMLElement;
  canvasPane: HTMLElement;
  /** Between the editor and the canvas. */
  divider: HTMLElement;
  canvas: HTMLElement;
  /** Between the memory view and loop history. */
  canvasDivider: HTMLElement;
  swap: HTMLButtonElement;
  /** Stacked, or side by side. */
  layoutMode: HTMLButtonElement;
  memorySection: HTMLElement;
  loopSection: HTMLElement;
}

type LayoutSettings = Pick<Settings, "split" | "canvasSplit" | "columnSplit" | "swapped" | "layoutMode" | "collapsed">;

/** Each window's buttons: data-window="memory" and data-action="maximize" | "minimize" | "expand". */
const ACTIONS = ["maximize", "minimize", "expand"] as const;
type Action = (typeof ACTIONS)[number];

export class LayoutController {
  private swapped: boolean;
  private modeNow: LayoutMode;
  private folded: WindowName[];
  private readonly canvasDivider: DividerMove;

  constructor(
    private readonly els: LayoutElements,
    private readonly settings: LayoutSettings,
    /** Told when the windows change size (the drawings refit). */
    private readonly onResize: () => void = () => {},
  ) {
    this.swapped = settings.swapped.get();
    this.modeNow = settings.layoutMode.get();
    this.folded = parseCollapsed(settings.collapsed.get());

    // The editor/canvas split. The value is always the editor's share of the
    // width, whichever side it's on.
    makeDivider(els.divider, {
      axis: "x",
      container: els.workspace,
      min: 15,
      max: 75,
      initial: 40,
      saved: settings.split,
      apply: (value) => els.workspace.style.setProperty("--split", `${value}%`),
      // Dragging or pressing arrows moves the divider itself, so which way the
      // editor grows depends on which side it's on.
      fromPointer: (percent) => (this.swapped ? 100 - percent : percent),
      keyDirection: () => (this.swapped ? -1 : 1),
    });

    // The memory / loop history split inside the canvas: memory's share of
    // its height (stacked) or width (side by side), remembered for each.
    this.canvasDivider = makeDivider(els.canvasDivider, {
      axis: () => (this.modeNow === "columns" ? "x" : "y"),
      container: els.canvas,
      min: 15,
      max: 85,
      initial: () => (this.modeNow === "columns" ? 50 : 55),
      saved: () => (this.modeNow === "columns" ? settings.columnSplit : settings.canvasSplit),
      apply: (value) => els.canvas.style.setProperty("--canvas-split", `${value}%`),
    });

    els.swap.addEventListener("click", () => this.toggleSwapped());
    els.layoutMode.addEventListener("click", () => this.setMode(this.modeNow === "columns" ? "stacked" : "columns"));
    // The windows' own buttons, and their bars.
    for (const button of els.workspace.querySelectorAll<HTMLButtonElement>("button[data-window][data-action]")) {
      button.addEventListener("click", () => {
        const name = button.dataset.window ?? "";
        const action = button.dataset.action as Action;
        if (isWindow(name) && ACTIONS.includes(action)) this.act(name, action);
      });
    }
    this.setSwapped(this.swapped);
  }

  /** The windows folded to bars. */
  get collapsed(): readonly WindowName[] {
    return this.folded;
  }

  get mode(): LayoutMode {
    return this.modeNow;
  }

  toggleSwapped(): void {
    this.setSwapped(!this.swapped);
  }

  /** Put the canvas on the left (or back on the right). */
  setSwapped(value: boolean): void {
    const { els } = this;
    this.swapped = value;
    this.settings.swapped.set(value);
    // Reorder the DOM, not just the visual order, so Tab moves through the
    // panes in the order they appear.
    const order = value ? [els.canvasPane, els.divider, els.editorPane] : [els.editorPane, els.divider, els.canvasPane];
    if (els.workspace.firstElementChild !== order[0]) els.workspace.append(...order);
    els.workspace.classList.toggle("is-swapped", value);
    els.swap.setAttribute("aria-pressed", String(value));
    this.apply();
  }

  /** Stacked, or side by side. */
  setMode(mode: LayoutMode): void {
    this.modeNow = mode;
    this.settings.layoutMode.set(mode);
    this.canvasDivider.reload();
    this.apply();
  }

  /** Maximize, minimize or open a window again. */
  act(name: WindowName, action: Action): void {
    const { folded } = this;
    if (action === "expand") this.setCollapsed(expand(folded, name));
    else if (action === "minimize") this.setCollapsed(minimize(folded, name));
    // Maximize again: back to all three.
    else this.setCollapsed(isMaximized(folded, name) ? [] : maximize(name));
  }

  setCollapsed(collapsed: readonly WindowName[]): void {
    this.folded = parseCollapsed(collapsed.join(","));
    this.settings.collapsed.set(this.folded.join(","));
    this.apply();
  }

  private apply(): void {
    const { els } = this;
    const tracks = layoutTracks(this.modeNow, this.folded, this.swapped);
    const columns = this.modeNow === "columns";
    els.workspace.style.setProperty("--workspace-columns", tracks.workspace);
    els.canvas.style.setProperty("--canvas-rows", columns ? "minmax(0, 1fr)" : tracks.canvas);
    els.canvas.style.setProperty("--canvas-columns", columns ? tracks.canvas : "minmax(0, 1fr)");
    els.canvas.classList.toggle("is-columns", columns);
    els.workspace.classList.toggle("is-columns", columns);
    els.layoutMode.setAttribute("aria-pressed", String(columns));
    els.layoutMode.title = columns
      ? "Stack memory over loop history, beside the code"
      : "Put the code, memory and loop history side by side";

    for (const [divider, on] of [
      [els.divider, tracks.divider],
      [els.canvasDivider, tracks.canvasDivider],
    ] as const) {
      divider.classList.toggle("is-inactive", !on);
      divider.tabIndex = on ? 0 : -1;
    }

    const panes: Record<WindowName, HTMLElement> = {
      editor: els.editorPane,
      memory: els.memorySection,
      loop: els.loopSection,
    };
    for (const name of WINDOWS) {
      const pane = panes[name];
      const folded = this.folded.includes(name);
      pane.classList.toggle("is-collapsed", folded);
      pane.classList.toggle("is-upright", tracks.upright[name]);
      const max = isMaximized(this.folded, name);
      for (const button of pane.querySelectorAll<HTMLButtonElement>(`button[data-window="${name}"]`)) {
        if (button.dataset.action === "maximize") {
          button.setAttribute("aria-pressed", String(max));
          button.setAttribute("aria-label", max ? "Restore all windows" : "Maximize this window");
          button.title = max ? "Show all three windows again" : "Maximize: fold the other windows to bars";
          button.classList.toggle("is-restore", max);
        }
        if (button.dataset.action === "expand") button.setAttribute("aria-expanded", String(!folded));
      }
    }
    this.onResize();
  }
}
