/**
 * The page's layout on a wide screen: where the three windows (the code,
 * memory and loop history; for SQL, the code, Tables and Query steps) go,
 * and how big they are.
 *
 * Where they go is an arrangement (arrangement.ts): a row or column of the
 * three, or one window beside a pair of the others. Windows are moved by
 * dragging them by their headers (docking.ts). The toolbar's layout button
 * switches between the two usual arrangements (the code beside memory over
 * loop history, or all three side by side), and ⇄ mirrors the page.
 *
 * The two dividers between windows can be dragged, moved with the arrow
 * keys and reset with a double-click. Each window can be minimized (it
 * folds to a thin bar with its name, and the others take its room) or
 * maximized (the other two fold to bars). Clicking a bar opens its window
 * again. One window always stays open. All of it is remembered.
 *
 * The windows sit straight in the workspace's grid (the canvas wrappers
 * are `display: contents` on a wide screen). styles.css, "Wide screens",
 * reads what this sets: the grid's tracks and each window's place as CSS
 * variables, and classes on the windows. Phones have their own layout
 * (mobileViews.ts), which ignores all of this.
 */
import type { Settings } from "../settings";
import {
  type Arrangement,
  columnsPreset,
  type DividerTrack,
  defaultSizes,
  editorAtEnd,
  type Item,
  isColumns,
  isPair,
  isWindow,
  legacyArrangement,
  order,
  parseArrangement,
  placeCss,
  stackedPreset,
  swapSides,
  type Tracks,
  trackCss,
  tracks,
  WINDOWS,
  type WindowName,
} from "./arrangement";

export { BAR, DIVIDER, WINDOWS, type WindowName } from "./arrangement";

// ---------------------------------------------------------------- which windows are open

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

// ---------------------------------------------------------------- the controller

export interface LayoutElements {
  workspace: HTMLElement;
  editorPane: HTMLElement;
  canvasPane: HTMLElement;
  /** The page's two dividers: the first and second boundary between windows. */
  divider: HTMLElement;
  canvas: HTMLElement;
  canvasDivider: HTMLElement;
  swap: HTMLButtonElement;
  /** The usual two arrangements: stacked, or side by side. */
  layoutMode: HTMLButtonElement;
  memorySection: HTMLElement;
  loopSection: HTMLElement;
  /** Covers the memory window while Python or PostgreSQL downloads. */
  loadingCard?: HTMLElement;
}

type LayoutSettings = Pick<
  Settings,
  "split" | "canvasSplit" | "columnSplit" | "swapped" | "layoutMode" | "collapsed" | "arrangement"
>;

/** Each window's buttons: data-window="memory" and data-action="maximize" | "minimize" | "expand". */
const ACTIONS = ["maximize", "minimize", "expand"] as const;
type Action = (typeof ACTIONS)[number];

/** The workspace's first grid row is the banner's (it spans the page when shown). */
const BANNER_ROWS = 1;
/** A divider can't make either side smaller than this share of the two. */
const MIN_SHARE = 0.1;

export class LayoutController {
  private arrangementNow: Arrangement;
  private folded: WindowName[];
  private current!: Tracks;

  constructor(
    private readonly els: LayoutElements,
    private readonly settings: LayoutSettings,
    /** Told when the windows change size (the drawings refit). */
    private readonly onResize: () => void = () => {},
  ) {
    this.arrangementNow =
      parseArrangement(settings.arrangement.get()) ??
      legacyArrangement({
        columns: settings.layoutMode.get() === "columns",
        swapped: settings.swapped.get(),
        split: settings.split.get(),
        canvasSplit: settings.canvasSplit.get(),
        columnSplit: settings.columnSplit.get(),
      });
    this.folded = parseCollapsed(settings.collapsed.get());

    for (const [index, divider] of [els.divider, els.canvasDivider].entries()) this.makeDivider(divider, index);

    els.swap.addEventListener("click", () => this.toggleSwapped());
    els.layoutMode.addEventListener("click", () => {
      const end = editorAtEnd(this.arrangementNow);
      this.setArrangement(isColumns(this.arrangementNow) ? stackedPreset(end) : columnsPreset(end));
    });
    // The windows' own buttons, and their bars.
    for (const button of els.workspace.querySelectorAll<HTMLButtonElement>("button[data-window][data-action]")) {
      button.addEventListener("click", () => {
        const name = button.dataset.window ?? "";
        const action = button.dataset.action as Action;
        if (isWindow(name) && ACTIONS.includes(action)) this.act(name, action);
      });
    }
    this.apply();
  }

  /** The windows folded to bars. */
  get collapsed(): readonly WindowName[] {
    return this.folded;
  }

  get arrangement(): Arrangement {
    return this.arrangementNow;
  }

  /** The two usual arrangements' names (the layout button): all three side by side, or not. */
  get mode(): "stacked" | "columns" {
    return isColumns(this.arrangementNow) ? "columns" : "stacked";
  }

  /** Each window's element. */
  get windows(): Record<WindowName, HTMLElement> {
    return { editor: this.els.editorPane, memory: this.els.memorySection, loop: this.els.loopSection };
  }

  /** The code to the other side of the page (⇄). */
  toggleSwapped(): void {
    this.setArrangement(swapSides(this.arrangementNow));
  }

  /** Put the windows somewhere else (and remember it). */
  setArrangement(next: Arrangement): void {
    this.arrangementNow = next;
    this.settings.arrangement.set(JSON.stringify(next));
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

  // ---------------------------------------------------------------- dividers

  /** A divider's share: the first side's part of the two it sits between, 0 to 1. */
  private share(d: DividerTrack): number {
    const a = this.arrangementNow;
    if (d.between === "pair") return a.pairSplit / 100;
    const [x, y] = [a.weights[d.between.root], a.weights[d.between.root + 1]];
    return x / (x + y);
  }

  private setShare(d: DividerTrack, share: number): void {
    const s = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, share));
    const a = this.arrangementNow;
    if (d.between === "pair") {
      this.setArrangement({ ...a, pairSplit: Math.round(s * 1000) / 10 });
      return;
    }
    const i = d.between.root;
    const total = a.weights[i] + a.weights[i + 1];
    const weights = [...a.weights];
    weights[i] = Math.round(total * s * 100) / 100;
    weights[i + 1] = Math.round((total - weights[i]) * 100) / 100;
    this.setArrangement({ ...a, weights });
  }

  /** The two things a divider sits between, as one span along its axis (in page pixels). */
  private span(d: DividerTrack): [number, number] {
    const a = this.arrangementNow;
    const rectOf = (names: WindowName[]) => {
      const rects = names.map((n) => this.windows[n].getBoundingClientRect());
      return {
        start: Math.min(...rects.map((r) => (d.axis === "x" ? r.left : r.top))),
        end: Math.max(...rects.map((r) => (d.axis === "x" ? r.right : r.bottom))),
      };
    };
    const namesOf = (index: number) => {
      const item = a.items[index];
      return isPair(item) ? [item.a, item.b] : [item];
    };
    if (d.between === "pair") {
      const pair = a.items.find(isPair)!;
      return [rectOf([pair.a]).start, rectOf([pair.b]).end];
    }
    return [rectOf(namesOf(d.between.root)).start, rectOf(namesOf(d.between.root + 1)).end];
  }

  /** A divider: dragged, moved with the arrow keys, reset with a double-click. */
  private makeDivider(divider: HTMLElement, index: number): void {
    const track = () => this.current.dividers[index];
    divider.addEventListener("pointerdown", (event) => {
      const d = track();
      if (event.button !== 0 || !d.active) return;
      event.preventDefault();
      divider.setPointerCapture(event.pointerId);
      divider.classList.add("is-dragging");
      const [start, end] = this.span(d);
      const move = (e: PointerEvent) => {
        const at = d.axis === "x" ? e.clientX : e.clientY;
        if (end > start) this.setShare(track(), (at - start) / (end - start));
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
    divider.addEventListener("dblclick", () => {
      const d = track();
      const usual = defaultSizes(this.arrangementNow);
      if (d.between === "pair") this.setShare(d, usual.pairSplit / 100);
      else {
        const [x, y] = [usual.weights[d.between.root], usual.weights[d.between.root + 1]];
        this.setShare(d, x / (x + y));
      }
    });
    divider.addEventListener("keydown", (event) => {
      const d = track();
      const [back, forward] = d.axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      const direction = event.key === back ? -1 : event.key === forward ? 1 : 0;
      if (!direction || !d.active) return;
      event.preventDefault();
      event.stopPropagation(); // arrow keys elsewhere step through the program
      this.setShare(d, this.share(d) + direction * 0.03);
    });
  }

  // ---------------------------------------------------------------- applying it

  private apply(): void {
    const { els } = this;
    const a = this.arrangementNow;
    const t = tracks(a, this.folded);
    this.current = t;
    const ws = els.workspace.style;
    ws.setProperty("--workspace-columns", trackCss(t.columns));
    ws.setProperty("--workspace-rows", `auto ${trackCss(t.rows)}`);
    const placeAt = (el: HTMLElement, place: (typeof t.windows)[WindowName]) => {
      const css = placeCss(place, BANNER_ROWS);
      el.style.setProperty("--grid-column", css.column);
      el.style.setProperty("--grid-row", css.row);
    };
    for (const w of WINDOWS) placeAt(this.windows[w], t.windows[w]);

    // The dividers, in the page's order.
    [els.divider, els.canvasDivider].forEach((divider, i) => {
      const d = t.dividers[i];
      placeAt(divider, d.place);
      divider.setAttribute("aria-orientation", d.axis === "x" ? "vertical" : "horizontal");
      divider.classList.toggle("is-inactive", !d.active);
      divider.tabIndex = d.active ? 0 : -1;
      divider.setAttribute("aria-valuenow", String(Math.round(this.share(d) * 100)));
      divider.setAttribute("aria-label", `Resize ${this.dividerLabel(d)}`);
      // Between memory and loop history, the divider is drawn in the canvas's colors.
      divider.classList.toggle("is-paper", !this.besideEditor(d));
    });

    // While Python downloads, the card covers the memory window (or the loop history's, if memory is folded).
    if (els.loadingCard) {
      const under: WindowName = this.folded.includes("memory") ? "loop" : "memory";
      placeAt(els.loadingCard, t.windows[under]);
    }

    // Tab follows the page: the code before or after the canvas, memory before or after loop history.
    const reading = order(a);
    const editorFirst = reading[0] === "editor";
    const paneOrder = editorFirst
      ? [els.editorPane, els.divider, els.canvasPane]
      : [els.canvasPane, els.divider, els.editorPane];
    if (
      [...els.workspace.children].filter((c) => paneOrder.includes(c as HTMLElement)).some((c, i) => c !== paneOrder[i])
    )
      els.workspace.append(...paneOrder);
    const memoryFirst = reading.indexOf("memory") < reading.indexOf("loop");
    const sectionOrder = memoryFirst
      ? [els.memorySection, els.canvasDivider, els.loopSection]
      : [els.loopSection, els.canvasDivider, els.memorySection];
    if (els.canvas.firstElementChild !== sectionOrder[0]) els.canvas.append(...sectionOrder);

    const columns = isColumns(a);
    // The code on the right: panels that open over it open at its right edge when it's folded.
    els.workspace.classList.toggle("is-swapped", editorAtEnd(a));
    els.workspace.classList.toggle("is-columns", columns);
    els.swap.setAttribute("aria-pressed", String(editorAtEnd(a)));
    els.layoutMode.setAttribute("aria-pressed", String(columns));
    els.layoutMode.title = columns
      ? "Stack memory over loop history, beside the code"
      : "Put the code, memory and loop history side by side";

    for (const name of WINDOWS) {
      const pane = this.windows[name];
      const folded = this.folded.includes(name);
      pane.classList.toggle("is-collapsed", folded);
      pane.classList.toggle("is-upright", t.upright[name]);
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

  /** Is the code on either side of this divider? */
  private besideEditor(d: DividerTrack): boolean {
    const a = this.arrangementNow;
    const has = (item: Item) => (isPair(item) ? item.a === "editor" || item.b === "editor" : item === "editor");
    if (d.between === "pair") return has(a.items.find(isPair)!);
    return has(a.items[d.between.root]) || has(a.items[d.between.root + 1]);
  }

  /** "the code and memory", for a divider's label. */
  private dividerLabel(d: DividerTrack): string {
    const a = this.arrangementNow;
    const names: Record<WindowName, string> = { editor: "the code", memory: "memory", loop: "loop history" };
    const of = (index: number) => {
      const item = a.items[index];
      return isPair(item) ? `${names[item.a]} and ${names[item.b]}` : names[item];
    };
    if (d.between === "pair") {
      const pair = a.items.find(isPair)!;
      return `${names[pair.a]} and ${names[pair.b]}`;
    }
    return `${of(d.between.root)} and ${of(d.between.root + 1)}`;
  }
}
