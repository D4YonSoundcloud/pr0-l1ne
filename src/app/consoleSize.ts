/**
 * How tall the Output and Changes panel under the code is: dragged by its
 * top edge (or ↑ ↓ on it, Home and End for the least and most), and
 * remembered. It stays that tall whatever it shows: a long list of changes
 * scrolls. Double-click the edge for the default again.
 */
import type { Settings } from "../settings";

/** The default height, in pixels (styles.css .console). */
export const DEFAULT_CONSOLE_HEIGHT = 132;
/** The least it can be: its tabs and a line or two. */
export const MIN_CONSOLE_HEIGHT = 56;
/** Room left for the code above it, at least. */
const MIN_CODE_HEIGHT = 120;
/** A key press moves it by this much. */
const STEP = 16;

export interface ConsoleSizeOptions {
  settings: Pick<Settings, "consoleHeight">;
  els: { console: HTMLElement; consoleGrip: HTMLElement; editorPane: HTMLElement };
}

export class ConsoleSize {
  private drag: { pointer: number; startY: number; startH: number } | null = null;

  constructor(private readonly options: ConsoleSizeOptions) {
    const grip = options.els.consoleGrip;
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      grip.classList.add("is-dragging");
      this.drag = { pointer: event.pointerId, startY: event.clientY, startH: this.height() };
    });
    grip.addEventListener("pointermove", (event) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointer) return;
      // Up makes it taller: its top edge is what's dragged.
      this.set(drag.startH + (drag.startY - event.clientY), false);
    });
    const end = (event: PointerEvent) => {
      if (!this.drag || event.pointerId !== this.drag.pointer) return;
      this.drag = null;
      grip.classList.remove("is-dragging");
      this.set(this.height(), true);
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", () => this.set(DEFAULT_CONSOLE_HEIGHT, true));
    grip.addEventListener("keydown", (event) => {
      const by: Record<string, number> = { ArrowUp: STEP, ArrowDown: -STEP };
      if (event.key in by) this.set(this.height() + by[event.key], true);
      else if (event.key === "Home") this.set(MIN_CONSOLE_HEIGHT, true);
      else if (event.key === "End") this.set(this.most(), true);
      else return;
      event.preventDefault();
    });
    this.set(options.settings.consoleHeight.get() ?? DEFAULT_CONSOLE_HEIGHT, false);
    // A smaller window can't keep it as tall: fitted again from the height chosen, so it comes back when there's room.
    if (typeof ResizeObserver === "function")
      new ResizeObserver(() => {
        if (!this.drag) this.set(options.settings.consoleHeight.get() ?? DEFAULT_CONSOLE_HEIGHT, false);
      }).observe(options.els.editorPane);
  }

  /** Its height now, in pixels. */
  height(): number {
    const set = Number.parseFloat(this.options.els.console.style.getPropertyValue("--console-height"));
    return Number.isFinite(set) ? set : DEFAULT_CONSOLE_HEIGHT;
  }

  /** The most it can be: the code window's height less room for the code. */
  private most(): number {
    const pane = this.options.els.editorPane.clientHeight;
    return pane > 0 ? Math.max(MIN_CONSOLE_HEIGHT, pane - MIN_CODE_HEIGHT) : Number.POSITIVE_INFINITY;
  }

  /** Make it this tall (within its least and most); `remember` it for the next visit. */
  set(height: number, remember: boolean): void {
    const h = Math.round(Math.max(MIN_CONSOLE_HEIGHT, Math.min(this.most(), height)));
    const { console: panel, consoleGrip: grip } = this.options.els;
    panel.style.setProperty("--console-height", `${h}px`);
    const most = this.most();
    grip.setAttribute("aria-valuenow", String(Number.isFinite(most) ? Math.round((100 * h) / most) : 0));
    grip.setAttribute("aria-valuetext", `${h} pixels tall`);
    if (remember) this.options.settings.consoleHeight.set(h === DEFAULT_CONSOLE_HEIGHT ? null : h);
  }
}
