/**
 * Moving windows by dragging them by their headers, from anywhere that
 * isn't one of the header's own controls (a wide screen only).
 *
 * While a window is dragged, a preview box glides to where it would go if
 * dropped there: beside the window under the pointer (on its nearest side),
 * in that window's place from its middle (the two swap), or along a whole
 * edge of the page near the page's edges. Dropping moves it there, and the
 * windows glide to their new places. Esc, or dropping back on the window
 * itself, leaves everything where it was.
 *
 * From the keyboard: focus a window's grip and press an arrow key to move
 * the window to that edge of the page.
 *
 * What goes where is worked out in arrangement.ts; the layout controller
 * (layout.ts) applies it.
 */
import {
  type Arrangement,
  type DropTarget,
  describeTarget,
  dropTargetAt,
  moveWindow,
  type Rect,
  type Side,
  samePlaces,
  WINDOWS,
  type WindowName,
  windowRects,
} from "./arrangement";
import type { LayoutController } from "./layout";

export interface DockingOptions {
  layout: Pick<LayoutController, "arrangement" | "collapsed" | "setArrangement" | "windows">;
  /** Said to screen readers after a move. */
  announce?(text: string): void;
  /** No gliding (prefers-reduced-motion). */
  reducedMotion?(): boolean;
  /** Is the page laid out for a wide screen? Phones have their own layout (mobileViews.ts). */
  wide?(): boolean;
}

/** How far the pointer moves before a press becomes a drag, in pixels. */
const DRAG_START = 4;
/**
 * How far it moves before the drag goes anywhere: a header is near the
 * page's edges, and the first few pixels of a drag mustn't count as
 * "along that edge".
 */
const ARM = 24;
const GLIDE_MS = 240;
const GLIDE_EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";

/** What in a header is a control of its own, not somewhere to drag the window from. */
const CONTROLS = "button, input, select, textarea, a, label, [role='tab'], [role='tablist'] > *, .tools-menu";

const KEY_EDGES: Record<string, Side> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" };

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height });

/** The smallest rectangle around all of these. */
function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

export class WindowDocking {
  /** The box showing where the window would go. */
  readonly preview: HTMLElement;
  /** The window's name, following the pointer. */
  private readonly ghost: HTMLElement;
  private drag: {
    window: WindowName;
    pointerId: number;
    start: { x: number; y: number };
    started: boolean;
    /** Far enough from the press to go somewhere. */
    armed: boolean;
    rects: Record<WindowName, Rect>;
    area: Rect;
    target: DropTarget | null;
    next: Arrangement | null;
    handle: HTMLElement;
  } | null = null;

  constructor(private readonly options: DockingOptions) {
    const doc = options.layout.windows.editor.ownerDocument;
    this.preview = doc.createElement("div");
    this.preview.className = "dock-preview";
    this.preview.hidden = true;
    this.preview.setAttribute("aria-hidden", "true");
    this.preview.append(doc.createElement("span"));
    this.ghost = doc.createElement("div");
    this.ghost.className = "dock-ghost";
    this.ghost.hidden = true;
    this.ghost.setAttribute("aria-hidden", "true");
    doc.body.append(this.preview, this.ghost);

    for (const name of WINDOWS) {
      for (const handle of options.layout.windows[name].querySelectorAll<HTMLElement>(`[data-dock="${name}"]`)) {
        handle.addEventListener("pointerdown", (e) => this.press(name, handle, e));
        handle.addEventListener("pointermove", (e) => this.move(e));
        handle.addEventListener("pointerup", (e) => this.release(e));
        handle.addEventListener("pointercancel", () => this.cancel());
        handle.addEventListener("lostpointercapture", () => this.cancel());
      }
      // The grip moves it from the keyboard.
      for (const grip of options.layout.windows[name].querySelectorAll<HTMLElement>(".window-grip"))
        grip.addEventListener("keydown", (e) => this.key(name, e));
    }
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.drag?.started) {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      }
    });
  }

  /** A window's name as its header shows it ("Memory", or "Tables" for SQL). */
  private nameOf(w: WindowName): string {
    const el = this.options.layout.windows[w].querySelector("[data-dock-name]");
    return el?.textContent?.trim() || w;
  }

  private names(): Record<WindowName, string> {
    return Object.fromEntries(WINDOWS.map((w) => [w, this.nameOf(w)])) as Record<WindowName, string>;
  }

  private wide(): boolean {
    return this.options.wide?.() ?? true;
  }

  // ---------------------------------------------------------------- the pointer

  private press(window: WindowName, handle: HTMLElement, e: PointerEvent): void {
    if (e.button !== 0 || !this.wide() || this.options.layout.collapsed.includes(window)) return;
    // The header's own buttons, menus and checkboxes work as usual: anywhere else on it (the grip too) drags.
    const control = (e.target as Element | null)?.closest?.(CONTROLS);
    if (control && handle.contains(control) && !control.classList.contains("window-grip")) return;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    this.drag = {
      window,
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      started: false,
      armed: false,
      rects: {} as Record<WindowName, Rect>,
      area: { x: 0, y: 0, width: 0, height: 0 },
      target: null,
      next: null,
      handle,
    };
  }

  private begin(): void {
    const drag = this.drag!;
    const { windows } = this.options.layout;
    for (const w of WINDOWS) drag.rects[w] = toRect(windows[w].getBoundingClientRect());
    drag.area = union(WINDOWS.map((w) => drag.rects[w]));
    drag.started = true;
    windows[drag.window].classList.add("is-being-moved");
    windows.editor.ownerDocument.body.classList.add("is-docking");
    this.ghost.textContent = this.nameOf(drag.window);
    this.ghost.hidden = false;
    // The preview starts on the window itself, then glides wherever it would go.
    this.place(drag.rects[drag.window], false, "");
    this.preview.hidden = false;
  }

  private move(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) < DRAG_START) return;
      this.begin();
    }
    this.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`;
    if (Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) >= ARM) drag.armed = true;
    const { arrangement, collapsed } = this.options.layout;
    const target = !drag.armed
      ? null
      : dropTargetAt({ x: e.clientX, y: e.clientY }, drag.rects, drag.area, drag.window);
    const next = target ? moveWindow(arrangement, drag.window, target) : null;
    if (!target || !next || samePlaces(next, arrangement)) {
      drag.target = null;
      drag.next = null;
      this.place(drag.rects[drag.window], false, "");
      return;
    }
    drag.target = target;
    drag.next = next;
    const folded = collapsed.filter((w) => w !== drag.window);
    this.place(windowRects(next, folded, drag.area)[drag.window], true, describeTarget(target, this.names()));
  }

  private release(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { target, next, window } = drag;
    this.finish();
    if (drag.started && target && next) this.go(window, next, target);
  }

  private cancel(): void {
    if (this.drag) this.finish();
  }

  private finish(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    const { windows } = this.options.layout;
    windows[drag.window].classList.remove("is-being-moved");
    windows.editor.ownerDocument.body.classList.remove("is-docking");
    this.ghost.hidden = true;
    this.preview.hidden = true;
    this.preview.classList.remove("is-target");
  }

  /** Move the preview box (it glides there: styles.css). */
  private place(r: Rect, isTarget: boolean, label: string): void {
    const s = this.preview.style;
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    this.preview.classList.toggle("is-target", isTarget);
    this.preview.firstElementChild!.textContent = label;
  }

  // ---------------------------------------------------------------- the keyboard

  private key(window: WindowName, e: KeyboardEvent): void {
    const edge = KEY_EDGES[e.key];
    if (!edge || !this.wide()) return;
    e.preventDefault();
    e.stopPropagation(); // arrow keys elsewhere step through the program
    const { arrangement } = this.options.layout;
    const target: DropTarget = { edge };
    const next = moveWindow(arrangement, window, target);
    if (samePlaces(next, arrangement)) {
      this.options.announce?.(`${this.nameOf(window)} is already along the ${edge} edge.`);
      return;
    }
    this.go(window, next, target);
  }

  // ---------------------------------------------------------------- moving

  /** Put the windows in their new places, gliding each from where it was. */
  private go(window: WindowName, next: Arrangement, target: DropTarget): void {
    const { layout } = this.options;
    const before = Object.fromEntries(WINDOWS.map((w) => [w, layout.windows[w].getBoundingClientRect()]));
    layout.setArrangement(next);
    this.options.announce?.(`${this.nameOf(window)} moved ${describeTarget(target, this.names())}.`);
    if (this.options.reducedMotion?.()) return;
    for (const w of WINDOWS) {
      const el = layout.windows[w];
      const [from, to] = [before[w], el.getBoundingClientRect()];
      if (!to.width || !to.height || typeof el.animate !== "function") continue;
      const [dx, dy] = [from.left - to.left, from.top - to.top];
      const [sx, sy] = [from.width / to.width, from.height / to.height];
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      el.animate(
        [
          { transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transformOrigin: "0 0", transform: "none" },
        ],
        { duration: GLIDE_MS, easing: GLIDE_EASE },
      );
    }
  }
}
