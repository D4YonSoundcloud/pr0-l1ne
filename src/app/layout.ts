/**
 * The page's layout: the divider between the editor and the canvas, the one
 * between the memory view and loop history, and swapping the editor and
 * canvas sides. Each divider can be dragged, moved with the arrow keys and
 * reset with a double-click, and its position is remembered.
 */
import type { Setting, Settings } from "../settings";

export interface DividerOptions {
  axis: "x" | "y";
  /** The element whose size the divider splits. */
  container: HTMLElement;
  min: number;
  max: number;
  initial: number;
  /** Where the position is remembered. */
  saved: Setting<number | null>;
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

/** A draggable, keyboard-operable divider whose position is remembered. Returns a function that moves it. */
export function makeDivider(divider: HTMLElement, options: DividerOptions): (value: number) => void {
  const { axis, container, min, max, initial, saved } = options;
  let value = initial;
  const set = (next: number) => {
    value = Math.round(Math.max(min, Math.min(max, next)));
    options.apply(value);
    divider.setAttribute("aria-valuenow", String(value));
    saved.set(value);
  };
  set(saved.get() || initial);

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("is-dragging");
    const move = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const percent =
        axis === "x" ? ((e.clientX - rect.left) / rect.width) * 100 : ((e.clientY - rect.top) / rect.height) * 100;
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

  divider.addEventListener("dblclick", () => set(initial));

  divider.addEventListener("keydown", (event) => {
    const [back, forward] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const direction = event.key === back ? -1 : event.key === forward ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation(); // arrow keys elsewhere step through the program
    set(value + direction * 3 * (options.keyDirection?.() ?? 1));
  });

  return set;
}

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
}

export class LayoutController {
  private swapped: boolean;

  constructor(
    private readonly els: LayoutElements,
    private readonly settings: Pick<Settings, "split" | "canvasSplit" | "swapped">,
  ) {
    this.swapped = settings.swapped.get();

    // The editor/canvas split. The value is always the editor's share of the
    // width, whichever side it's on.
    makeDivider(els.divider, {
      axis: "x",
      container: els.workspace,
      min: 20,
      max: 75,
      initial: 40,
      saved: settings.split,
      apply: (value) => els.workspace.style.setProperty("--split", `${value}%`),
      // Dragging or pressing arrows moves the divider itself, so which way the
      // editor grows depends on which side it's on.
      fromPointer: (percent) => (this.swapped ? 100 - percent : percent),
      keyDirection: () => (this.swapped ? -1 : 1),
    });

    // The memory / loop history split inside the canvas. The value is the
    // memory section's share of the height.
    makeDivider(els.canvasDivider, {
      axis: "y",
      container: els.canvas,
      min: 15,
      max: 85,
      initial: 55,
      saved: settings.canvasSplit,
      apply: (value) => els.canvas.style.setProperty("--canvas-split", `${value}%`),
    });

    this.setSwapped(this.swapped);
    els.swap.addEventListener("click", () => this.toggleSwapped());
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
  }
}
