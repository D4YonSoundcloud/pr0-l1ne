/**
 * A pannable, zoomable window onto a diagram, used by both canvas sections.
 *
 *   drag the background      pan ("scrub" around the graph paper)
 *   scroll / trackpad        pan
 *   Ctrl/Cmd + scroll, pinch zoom around the pointer
 *   drag a [data-node-key]   move that box (reported through onNodeMove)
 *   + / - / 0 (focused)      zoom in / out / reset
 *
 * The diagram itself is drawn at its natural size; the viewport only applies
 * a CSS transform to it. The graph-paper background moves and scales with
 * the content, so the paper and the drawing feel like one sheet.
 */

import { snapshot, transition as transition_ } from "./animate";

export interface Point { x: number; y: number }

export interface ViewportOptions {
  /** Accessible description, e.g. "Memory diagram". */
  label: string;
  /**
   * Called while a node is dragged, with its new top-left corner in diagram
   * units. `done` is true for the final call, when the pointer is released.
   */
  onNodeMove?(key: string, position: Point, done: boolean): void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const GRID = 24;            // graph-paper square size at 100%
const DRAG_THRESHOLD = 3;   // px before a press becomes a drag
const KEEP_VISIBLE = 60;    // px of content always left on screen when panning

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type Gesture =
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "node"; key: string; startX: number; startY: number; nodeX: number; nodeY: number; moved: boolean }
  | { kind: "pinch"; distance: number; zoom: number; midX: number; midY: number; panX: number; panY: number };

export class Viewport {
  private readonly layer: HTMLDivElement;
  private readonly empty: HTMLParagraphElement;
  private readonly controls: HTMLDivElement;
  private readonly zoomLabel: HTMLButtonElement;
  private x = 0;
  private y = 0;
  private z = 1;
  private contentW = 0;
  private contentH = 0;
  private gesture: Gesture | null = null;
  /** The viewport's size, kept up to date by a ResizeObserver. */
  private viewW = 0;
  private viewH = 0;
  private readonly pointers = new Map<number, Point>();

  constructor(readonly el: HTMLElement, private readonly options: ViewportOptions) {
    el.classList.add("viewport");
    el.tabIndex = 0;
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", `${options.label}. Drag to pan, Ctrl or Cmd and scroll to zoom.`);

    this.layer = document.createElement("div");
    this.layer.className = "viewport-layer";
    this.empty = document.createElement("p");
    this.empty.className = "viewport-empty";
    this.empty.hidden = true;

    this.controls = document.createElement("div");
    this.controls.className = "viewport-controls";
    this.zoomLabel = this.button("100%", "Reset zoom (0)", () => this.reset());
    this.zoomLabel.classList.add("zoom-label");
    this.controls.append(
      this.button("−", "Zoom out (−)", () => this.zoomBy(1 / 1.25)),
      this.zoomLabel,
      this.button("+", "Zoom in (+)", () => this.zoomBy(1.25)),
      this.button("Fit", "Fit the whole diagram in view", () => this.fit()),
    );
    el.append(this.layer, this.empty, this.controls);

    el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    el.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    el.addEventListener("keydown", (e) => this.onKey(e));
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(([entry]) => {
        this.viewW = entry.contentRect.width;
        this.viewH = entry.contentRect.height;
      }).observe(el);
    }
    this.apply();
  }

  /** Add a button to the floating controls (e.g. "Reset layout"). */
  addControl(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = this.button(label, title, onClick);
    button.classList.add("wide");
    this.controls.prepend(button);
    return button;
  }

  /**
   * Show a diagram, or an explanation when there's nothing to draw. With a
   * `transition` (ms), things that moved since the last diagram slide from
   * where they were (see animate.ts).
   */
  setContent(content: SVGSVGElement | null, emptyText = "", transition = 0): void {
    const before = transition > 0 && content ? snapshot(this.layer) : null;
    if (content) {
      this.contentW = Number(content.getAttribute("width")) || 0;
      this.contentH = Number(content.getAttribute("height")) || 0;
      this.layer.replaceChildren(content);
    } else {
      this.contentW = this.contentH = 0;
      this.layer.replaceChildren();
    }
    this.empty.textContent = emptyText;
    this.empty.hidden = !!content || !emptyText;
    this.controls.hidden = !content;
    if (before) transition_(before, this.layer, transition);
  }

  /**
   * Pan just enough to bring a span of the diagram into view (vertically),
   * given in diagram units. Works from numbers, not by measuring the page,
   * so it doesn't force a layout right after the diagram was redrawn.
   */
  reveal(top: number, bottom: number, padding = 24): void {
    if (this.gesture || !this.viewH) return; // never fight the person's hand
    const screenTop = this.y + top * this.z;
    const screenBottom = this.y + bottom * this.z;
    if (screenBottom > this.viewH - padding) this.y -= screenBottom - (this.viewH - padding);
    else if (screenTop < padding) this.y += padding - screenTop;
    else return;
    this.apply();
  }

  zoomBy(factor: number, around?: Point): void {
    const view = this.el.getBoundingClientRect();
    const cx = around ? around.x - view.left : view.width / 2;
    const cy = around ? around.y - view.top : view.height / 2;
    const next = clamp(this.z * factor, MIN_ZOOM, MAX_ZOOM);
    // Keep the point under the cursor fixed while zooming.
    this.x = cx - (cx - this.x) * (next / this.z);
    this.y = cy - (cy - this.y) * (next / this.z);
    this.z = next;
    this.apply();
  }

  /** Scale down (never up) so the whole diagram is visible. */
  fit(): void {
    const view = this.el.getBoundingClientRect();
    if (!this.contentW || !this.contentH || !view.width) return;
    this.z = clamp(Math.min(view.width / this.contentW, (view.height - 8) / this.contentH, 1), MIN_ZOOM, 1);
    this.x = Math.max(0, (view.width - this.contentW * this.z) / 2);
    this.y = 0;
    this.apply();
  }

  reset(): void {
    this.x = this.y = 0;
    this.z = 1;
    this.apply();
  }

  // -- internals ---------------------------------------------------------------

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "viewport-button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", onClick);
    return button;
  }

  private apply(): void {
    // Don't let the diagram be panned completely out of sight. Uses the
    // size the ResizeObserver last reported, so it never forces a layout.
    if (this.viewW && this.contentW) {
      this.x = clamp(this.x, KEEP_VISIBLE - this.contentW * this.z, this.viewW - KEEP_VISIBLE);
      this.y = clamp(this.y, KEEP_VISIBLE - this.contentH * this.z, this.viewH - KEEP_VISIBLE);
    }
    this.layer.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.z})`;
    const grid = GRID * this.z;
    this.el.style.backgroundSize = `${grid}px ${grid}px`;
    this.el.style.backgroundPosition = `${this.x}px ${this.y}px`;
    this.zoomLabel.textContent = `${Math.round(this.z * 100)}%`;
  }

  private onPointerDown(e: PointerEvent): void {
    const target = e.target as Element;
    if (target.closest(".viewport-controls") || (e.button !== 0 && e.button !== 1)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.el.setPointerCapture(e.pointerId);

    if (this.pointers.size === 2) {
      this.startPinch();
      return;
    }
    if (this.pointers.size > 2) return;

    const node = e.button === 0 && this.options.onNodeMove ? target.closest<SVGGElement>("[data-node-key]") : null;
    if (node) {
      this.gesture = {
        kind: "node",
        key: node.dataset.nodeKey!,
        startX: e.clientX,
        startY: e.clientY,
        nodeX: Number(node.dataset.x),
        nodeY: Number(node.dataset.y),
        moved: false,
      };
    } else {
      this.gesture = { kind: "pan", startX: e.clientX, startY: e.clientY, panX: this.x, panY: this.y };
      this.el.classList.add("is-panning");
    }
    e.preventDefault(); // no text selection or native image drag
  }

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.gesture = {
      kind: "pinch",
      distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom: this.z,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      panX: this.x,
      panY: this.y,
    };
    this.el.classList.remove("is-panning", "is-dragging-node");
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = this.gesture;
    if (!g) return;

    if (g.kind === "pan") {
      this.x = g.panX + (e.clientX - g.startX);
      this.y = g.panY + (e.clientY - g.startY);
      this.apply();
    } else if (g.kind === "node") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.moved = true;
      this.el.classList.add("is-dragging-node");
      this.options.onNodeMove!(g.key, this.nodePosition(g, dx, dy), false);
    } else if (g.kind === "pinch" && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const next = clamp(g.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / g.distance), MIN_ZOOM, MAX_ZOOM);
      const view = this.el.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - view.left;
      const my = (a.y + b.y) / 2 - view.top;
      const startMx = g.midX - view.left;
      const startMy = g.midY - view.top;
      // Zoom around where the fingers started, and pan with their midpoint.
      this.x = mx - (startMx - g.panX) * (next / g.zoom);
      this.y = my - (startMy - g.panY) * (next / g.zoom);
      this.z = next;
      this.apply();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    const g = this.gesture;
    if (g?.kind === "node" && g.moved) {
      this.options.onNodeMove!(g.key, this.nodePosition(g, e.clientX - g.startX, e.clientY - g.startY), true);
    }
    this.el.classList.remove("is-panning", "is-dragging-node");
    // Lifting one finger of a pinch carries on as a pan with the other.
    const remaining = [...this.pointers.values()][0];
    this.gesture = remaining && g?.kind === "pinch"
      ? { kind: "pan", startX: remaining.x, startY: remaining.y, panX: this.x, panY: this.y }
      : null;
  }

  private nodePosition(g: Extract<Gesture, { kind: "node" }>, dx: number, dy: number): Point {
    // Screen pixels to diagram units, and never off the top or left edge.
    return {
      x: Math.round(Math.max(4, g.nodeX + dx / this.z)),
      y: Math.round(Math.max(4, g.nodeY + dy / this.z)),
    };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.el.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinches also arrive as Ctrl + wheel.
      this.zoomBy(Math.exp(-e.deltaY * unit * 0.0025), { x: e.clientX, y: e.clientY });
      return;
    }
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0]; // Shift + mouse wheel scrolls sideways
    this.x -= dx;
    this.y -= dy;
    this.apply();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target !== this.el || e.ctrlKey || e.metaKey || e.altKey) return;
    const actions: Record<string, () => void> = {
      "+": () => this.zoomBy(1.25),
      "=": () => this.zoomBy(1.25),
      "-": () => this.zoomBy(1 / 1.25),
      "0": () => this.reset(),
    };
    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  }
}
