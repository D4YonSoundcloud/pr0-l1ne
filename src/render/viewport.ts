/**
 * A pannable, zoomable window onto a diagram, used by both canvas sections.
 *
 *   drag the background      pan ("scrub" around the graph paper)
 *   scroll / trackpad        pan
 *   Ctrl/Cmd + scroll, pinch zoom around the pointer
 *   drag a [data-node-key]   move that box (reported through onNodeMove)
 *   + / - / 0 (focused)      zoom in / out / reset
 *   Auto-fit                 refit the diagram on every step (see setContent)
 *
 * The diagram itself is drawn at its natural size; the viewport only applies
 * a CSS transform to it. The graph-paper background moves and scales with
 * the content, so the paper and the drawing feel like one sheet.
 */

import { snapshot, transition as transition_, type Enter } from "./animate";

export interface Point { x: number; y: number }

export interface ViewportOptions {
  /** Accessible description, e.g. "Memory diagram". */
  label: string;
  /**
   * Called while a node is dragged, with its new top-left corner in diagram
   * units. `done` is true for the final call, when the pointer is released.
   */
  onNodeMove?(key: string, position: Point, done: boolean): void;
  /** Called when Auto-fit is turned on or off, or its mode changes. */
  onAutoFitChange?(state: AutoFit): void;
}

/**
 * Auto-fit keeps the whole diagram in view as it changes from step to step.
 *   "out"   only ever zooms out: once a step needed a wide view, it's kept,
 *           so the picture doesn't pump in and out while you step.
 *   "both"  zooms in again when the diagram gets smaller: always a snug fit.
 */
export type AutoFitMode = "out" | "both";
export interface AutoFit { on: boolean; mode: AutoFitMode }

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const GRID = 24;            // default graph-paper square size at 100%
const DRAG_THRESHOLD = 3;   // px before a press becomes a drag
const KEEP_VISIBLE = 60;    // px of content always left on screen when panning

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  /** Size of a grid square at 100% zoom (see setGridSize). */
  private gridSize = GRID;

  private autoFit: AutoFit = { on: false, mode: "out" };
  private readonly autoFitButton: HTMLButtonElement;
  private readonly autoFitMenu: HTMLDivElement;
  /** How a refit animates: the window's step animation (see setZoomAnimation). */
  private zoomAnimation = { duration: 260, easing: "ease" };

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
    this.zoomLabel = this.button("100%", "Reset zoom (0)", () => this.manual(() => this.reset()));
    this.zoomLabel.classList.add("zoom-label");
    // Auto-fit: a toggle, and a menu for how it zooms.
    this.autoFitButton = this.button("Auto-fit", "Auto-fit: keep the whole diagram in view on every step", () => this.setAutoFit({ ...this.autoFit, on: !this.autoFit.on }));
    this.autoFitButton.classList.add("auto-fit");
    this.autoFitButton.setAttribute("aria-pressed", "false");
    const modeButton = this.button("▾", "How Auto-fit zooms", () => this.toggleAutoFitMenu());
    modeButton.classList.add("auto-fit-mode");
    modeButton.setAttribute("aria-haspopup", "true");
    modeButton.setAttribute("aria-expanded", "false");
    this.autoFitMenu = document.createElement("div");
    this.autoFitMenu.className = "auto-fit-menu";
    this.autoFitMenu.setAttribute("role", "menu");
    this.autoFitMenu.hidden = true;
    const choices: [AutoFitMode, string, string][] = [
      ["out", "Zoom out only", "Keeps the widest view the run has needed, so the picture stays steady"],
      ["both", "Zoom in and out", "Always fits snugly: zooms back in when the diagram gets smaller"],
    ];
    for (const [mode, label, detail] of choices) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "auto-fit-choice";
      item.setAttribute("role", "menuitemradio");
      item.dataset.mode = mode;
      item.append(Object.assign(document.createElement("strong"), { textContent: label }), Object.assign(document.createElement("span"), { textContent: detail }));
      item.addEventListener("click", () => {
        this.setAutoFit({ on: true, mode });
        this.toggleAutoFitMenu(false);
      });
      this.autoFitMenu.append(item);
    }
    const autoFitGroup = document.createElement("span");
    autoFitGroup.className = "auto-fit-group";
    autoFitGroup.append(this.autoFitButton, modeButton, this.autoFitMenu);
    this.controls.append(
      autoFitGroup,
      this.button("−", "Zoom out (−)", () => this.manual(() => this.zoomBy(1 / 1.25))),
      this.zoomLabel,
      this.button("+", "Zoom in (+)", () => this.manual(() => this.zoomBy(1.25))),
      this.button("Fit", "Fit the whole diagram in view once", () => this.fit()),
    );
    el.append(this.layer, this.empty, this.controls);
    el.addEventListener("pointerdown", (e) => {
      if (!(e.target as Element).closest(".auto-fit-group")) this.toggleAutoFitMenu(false);
    }, true);

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
        if (this.autoFit.on) this.refit(false);
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
  setContent(content: SVGSVGElement | null, emptyText = "", transition = 0, easing?: string, enter?: Enter): void {
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
    if (before) transition_(before, this.layer, transition, easing, enter);
    if (this.autoFit.on && content) {
      this.refit(!this.snugNext, this.snugNext);
      this.snugNext = false;
    }
  }

  // -- Auto-fit ---------------------------------------------------------------

  get autoFitState(): AutoFit {
    return { ...this.autoFit };
  }

  /** Turn Auto-fit on or off, or change how it zooms. */
  setAutoFit(state: AutoFit, notify = true): void {
    const turnedOn = state.on && !this.autoFit.on;
    const modeChanged = state.mode !== this.autoFit.mode;
    this.autoFit = { ...state };
    this.autoFitButton.setAttribute("aria-pressed", String(state.on));
    this.autoFitButton.classList.toggle("is-on", state.on);
    for (const item of this.autoFitMenu.querySelectorAll<HTMLElement>("[data-mode]")) {
      item.setAttribute("aria-checked", String(item.dataset.mode === state.mode));
    }
    // Turning it on (or changing mode) starts from a snug fit.
    if (state.on && (turnedOn || modeChanged)) this.refit(true, true);
    if (notify) this.options.onAutoFitChange?.(this.autoFitState);
  }

  /**
   * "Zoom out only" remembers the widest view; forget it (a different
   * program), so the next diagram gets a snug fit.
   */
  restartAutoFit(): void {
    this.snugNext = true;
  }
  private snugNext = false;

  /** How refits animate: the window's step animation from the Style panel. */
  setZoomAnimation(duration: number, easing: string): void {
    this.zoomAnimation = { duration, easing };
  }

  private toggleAutoFitMenu(open = this.autoFitMenu.hidden): void {
    this.autoFitMenu.hidden = !open;
    this.autoFitMenu.previousElementSibling?.setAttribute("aria-expanded", String(open));
  }

  /** Manual zooming or panning: the person is in charge now, so Auto-fit stops. */
  private manual(action: () => void): void {
    if (this.autoFit.on) this.setAutoFit({ ...this.autoFit, on: false });
    action();
  }

  /**
   * Fit the diagram for Auto-fit. In "out" mode the zoom never goes back up
   * (unless `snug`, when Auto-fit starts). The view glides there.
   */
  private refit(animate: boolean, snug = false): void {
    if (!this.contentW || !this.contentH) return;
    // "Zoom out only" fits the biggest diagram seen so far, not just this
    // one. Remembering sizes (not a zoom) keeps it right when the window
    // is resized.
    const keep = this.autoFit.mode === "out" && !snug;
    this.fitSize = {
      w: keep ? Math.max(this.fitSize.w, this.contentW) : this.contentW,
      h: keep ? Math.max(this.fitSize.h, this.contentH) : this.contentH,
    };
    const z = this.fitZoom(this.fitSize.w, this.fitSize.h);
    if (z === null) return; // not laid out yet: the ResizeObserver will call again
    const x = Math.max(0, (this.viewW - this.contentW * z) / 2);
    const y = 0;
    if (Math.abs(z - this.z) < 1e-3 && Math.abs(x - this.x) < 0.5 && Math.abs(y - this.y) < 0.5) return;
    const from = { x: this.x, y: this.y, z: this.z };
    this.x = x;
    this.y = y;
    this.z = z;
    this.apply();
    const { duration, easing } = this.zoomAnimation;
    for (const a of this.glides) a.cancel(); // a new fit replaces one still gliding
    this.glides = [];
    if (animate && duration > 0 && !reducedMotion()) this.glide(from, duration, easing);
  }

  /** The biggest diagram "Zoom out only" has had to fit. */
  private fitSize = { w: 0, h: 0 };

  /** The zoom at which a diagram of this size fits (never above 100%), or null before layout. */
  private fitZoom(w = this.contentW, h = this.contentH): number | null {
    if (!this.viewW || !this.viewH) {
      const view = this.el.getBoundingClientRect();
      this.viewW = view.width;
      this.viewH = view.height;
    }
    if (!w || !h || this.viewW < 40 || this.viewH < 40) return null;
    return clamp(Math.min(this.viewW / w, (this.viewH - 8) / h, 1), MIN_ZOOM, 1);
  }

  private glides: Animation[] = [];

  /** Animate the view (and its graph paper) from where it was to where it is now. */
  private glide(from: { x: number; y: number; z: number }, duration: number, easing: string): void {
    const grid = (z: number) => `${this.gridSize * z}px ${this.gridSize * z}px`;
    if (typeof this.layer.animate !== "function") return;
    this.glides = [this.layer.animate(
      [{ transform: `translate(${from.x}px, ${from.y}px) scale(${from.z})` }, { transform: this.layer.style.transform }],
      { duration, easing },
    ), this.el.animate(
      [
        { backgroundSize: grid(from.z), backgroundPosition: `${from.x}px ${from.y}px` },
        { backgroundSize: this.el.style.backgroundSize, backgroundPosition: this.el.style.backgroundPosition },
      ],
      { duration, easing },
    )];
  }

  /**
   * Pan just enough to bring a span of the diagram into view (vertically),
   * given in diagram units. Works from numbers, not by measuring the page,
   * so it doesn't force a layout right after the diagram was redrawn.
   */
  reveal(top: number, bottom: number, padding = 24): void {
    if (this.gesture || !this.viewH || this.autoFit.on) return; // never fight the person's hand, or Auto-fit
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
    const z = this.fitZoom();
    if (z === null) return;
    this.z = z;
    this.x = Math.max(0, (this.viewW - this.contentW * this.z) / 2);
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

  /** Change the background grid's square size (at 100% zoom). */
  setGridSize(size: number): void {
    if (size === this.gridSize) return;
    this.gridSize = size;
    this.apply();
  }

  private apply(): void {
    // Don't let the diagram be panned completely out of sight. Uses the
    // size the ResizeObserver last reported, so it never forces a layout.
    if (this.viewW && this.contentW) {
      this.x = clamp(this.x, KEEP_VISIBLE - this.contentW * this.z, this.viewW - KEEP_VISIBLE);
      this.y = clamp(this.y, KEEP_VISIBLE - this.contentH * this.z, this.viewH - KEEP_VISIBLE);
    }
    this.layer.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.z})`;
    const grid = this.gridSize * this.z;
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
    this.pressMoved = false;
    e.preventDefault(); // no text selection or native image drag
  }

  private pressMoved = false;

  private startPinch(): void {
    this.manual(() => {});
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
      // A real drag of the paper (not just a click) takes over from Auto-fit.
      if (!this.pressMoved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) >= DRAG_THRESHOLD) {
        this.pressMoved = true;
        this.manual(() => {});
      }
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
    this.manual(() => {});
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
      this.manual(action);
    }
  }
}
