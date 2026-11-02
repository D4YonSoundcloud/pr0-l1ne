/**
 * The SVG renderers: the memory and loop windows drawn as SVG, behind the
 * renderer contract (scene/renderer.ts). Each lays its scene out with
 * render/memory.ts or render/loopView.ts, in a pannable, zoomable window
 * (viewport.ts) that animates from one step to the next (animate.ts). The
 * SVG isn't made anew each step: the window's SvgPatcher (patch.ts) changes
 * the one on screen into the new drawing, touching only what differs.
 *
 * Everything that depends on the drawing being SVG stays here: dragging a
 * box by its <g data-node-key>, highlighting a hovered box's arrows,
 * keeping the running row in view by its data-top / data-bottom.
 */

import { timed } from "../perf";
import type {
  Hit,
  LoopRenderer,
  LoopWindowScene,
  MemoryRenderer,
  MemoryRendererEvents,
  MemoryWindowScene,
  Point,
  RendererEvents,
  RendererFactory,
  RendererStyle,
  StepStyle,
  ViewportChange,
} from "../scene/renderer";
import { detailBudget, summaryBoxes } from "../scene/summaries";
import { ProbeStyles } from "./canvas/styles";
import type { Mark } from "./drawing";
import { standaloneSvg } from "./export";
import { atLevel, builtAt, type Lod, landmarksIn, SIMPLE_ARROWS_FROM, setLodClass } from "./lod";
import { loopDrawing } from "./loopView";
import { RowCache, RowsInView } from "./loopView/rowCache";
import { applyFocus, memoryDrawing } from "./memory";
import { BoxCache } from "./memoryView/boxCache";
import { SvgPatcher } from "./patch";
import { sqlPipelineDrawing, sqlTableDrawing } from "./sqlView";
import { Viewport } from "./viewport";

/** How long the zoom must rest before a window lays its drawing out again for a new level (see levelChanged). */
const RELAYOUT_AFTER = 160;
const STILL: StepStyle = { duration: 0, easing: "linear", enter: { fade: false, slide: false } };

/** What both SVG windows share: the viewport, and how they're styled and moved. */
abstract class SvgWindow {
  protected readonly view: Viewport;
  protected step: StepStyle = STILL;
  /** The SVG on screen, and the drawing it shows. */
  protected readonly patcher = new SvgPatcher();

  constructor(
    protected readonly el: HTMLElement,
    label: string,
    events: RendererEvents,
    onNodeMove?: (key: string, position: Point, done: boolean) => void,
  ) {
    this.view = new Viewport(el, {
      label,
      onNodeMove,
      onAutoFitChange: (state) => {
        events.onAutoFitChange?.(state);
        this.levelChanged(this.view.lod);
      },
      onNodeClick: (key) => this.nodeClicked(key),
      controls: events.controls,
      // The level of detail is a class on the layer the SVG is in: CSS hides and simplifies (lod.ts),
      // and what it hides is left out of the page altogether.
      onMove: () => this.viewMoved(),
      onLod: (lod) => {
        setLodClass(this.view.contentLayer, lod);
        if (this.full) this.view.updateContent(() => this.patcher.show(atLevel(this.full!, lod)), 0);
        this.levelChanged(lod);
      },
    });
    setLodClass(this.view.contentLayer, this.view.lod);
  }

  /** The zoom crossed into another level of detail (lod.ts), or Auto-fit was turned on or off. */
  protected levelChanged(_lod: Lod): void {}

  /** A box was clicked (pressed and let go without dragging). */
  protected nodeClicked(_key: string): void {}

  /** The view moved (panned, zoomed). Called from the viewport's constructor too, before fields are set. */
  protected viewMoved(): void {}

  /**
   * The drawing on screen, as laid out: drawn again at another level of
   * detail without laying it out again, down to the level it was built at
   * (lod.ts buildAt). For more detail than that, it's laid out again.
   */
  protected full: Mark | null = null;

  /** Zoomed in past the detail the drawing on screen was built with: it must be laid out again. */
  protected get needsDetail(): boolean {
    return !!this.full && this.view.lod < builtAt(this.full);
  }

  /** Show a drawing (animating from the last), at the level of detail the zoom calls for. */
  protected showDrawing(drawing: Mark, duration: number, easing: string, enter: StepStyle["enter"]): void {
    this.full = drawing;
    // The level it was built at (lod.ts buildAt), to see from outside (tests, the browser's inspector).
    this.el.dataset.builtLod = String(builtAt(drawing));
    this.view.updateContent(
      () => timed("svg.patch", () => this.patcher.show(atLevel(drawing, this.view.lod))),
      duration,
      easing,
      enter,
    );
    this.view.setLandmarks(landmarksIn(drawing));
  }

  showMessage(text: string): void {
    this.full = null;
    this.patcher.reset();
    this.view.setContent(null, text);
  }

  setViewport(change: ViewportChange): void {
    if (change.autoFit) this.view.setAutoFit(change.autoFit, false);
    if (change.refit) this.view.restartAutoFit();
    if (change.pan || change.zoom !== undefined) this.view.moveTo(change.pan, change.zoom);
  }

  hitTest(x: number, y: number): Hit | null {
    const at = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
    if (!at || !this.el.contains(at)) return null;
    const key = at.closest<SVGGElement>(".node")?.dataset.nodeKey;
    return key ? { kind: "box", key } : { kind: "background" };
  }

  setAppearance(style: RendererStyle): void {
    if (style.step) this.step = style.step;
    if (style.zoom) this.view.setZoomAnimation(style.zoom.duration, style.zoom.easing);
    if (style.gridSize !== undefined) this.view.setGridSize(style.gridSize);
  }

  addControl(label: string, title: string, onClick: () => void): HTMLButtonElement {
    return this.view.addControl(label, title, onClick);
  }

  get viewport(): { pan: Point; zoom: number } {
    return this.view.view;
  }

  toSVG(): string | null {
    const svg = this.el.querySelector<SVGSVGElement>(".viewport-layer > svg");
    if (!svg) return null;
    // Styles read with animations stopped (see export.ts), through a probe
    // made for this export: the look may have changed since the last one.
    const styles = new ProbeStyles(this.el);
    try {
      return standaloneSvg(svg, styles, getComputedStyle(this.el).backgroundColor);
    } finally {
      styles.dispose();
    }
  }

  dispose(): void {
    this.view.dispose();
  }
}

export class SvgMemoryRenderer extends SvgWindow implements MemoryRenderer {
  /** Where the person has dragged boxes, by scene key. */
  private readonly positions = new Map<string, Point>();
  /** Boxes kept from step to step, drawn again only when they change (memoryView/boxCache.ts). */
  private readonly boxes = new BoxCache();
  private dragging: string | null = null;
  private hovered: string | null = null;
  private readonly listening = new AbortController();

  /** Were the arrows on screen laid out simply (zoomed out, lod.ts SIMPLE_ARROWS_FROM)? */
  private simpleArrows = false;
  private readonly onLayoutChange?: () => void;

  constructor(el: HTMLElement, events: MemoryRendererEvents) {
    super(el, "Memory diagram", events, (key, position, done) => {
      this.positions.set(key, position);
      this.dragging = done ? null : key;
      events.onLayoutChange?.();
    });
    this.onLayoutChange = events.onLayoutChange;
    this.onExpand = events.onExpand;
    // Hovering a box (or dragging it) highlights its arrows and the boxes they
    // connect to. The focus is part of each step's drawing too (see render()).
    const signal = this.listening.signal;
    el.addEventListener(
      "pointerover",
      (event) => {
        const key = (event.target as Element).closest<SVGGElement>(".node")?.dataset.nodeKey ?? null;
        if (key === this.hovered) return;
        this.hovered = key;
        this.refreshFocus();
      },
      { signal },
    );
    el.addEventListener(
      "pointerleave",
      () => {
        this.hovered = null;
        this.refreshFocus();
      },
      { signal },
    );
  }

  get hasMovedBoxes(): boolean {
    return this.positions.size > 0;
  }

  get movedBoxes(): ReadonlyMap<string, Point> {
    return this.positions;
  }

  moveBoxes(positions: ReadonlyMap<string, Point>): void {
    this.positions.clear();
    for (const [key, at] of positions) this.positions.set(key, { ...at });
  }

  resetLayout(): void {
    this.positions.clear();
  }

  render(scene: MemoryWindowScene, _previous: MemoryWindowScene | null): void {
    this.simpleArrows = this.view.lod >= SIMPLE_ARROWS_FROM;
    this.budgetDrawn = "kind" in scene ? undefined : scene.detailBudget;
    this.summaryKeys = "kind" in scene ? new Map() : summaryBoxes(scene);
    const { duration, easing, enter } = this.step;
    const drawing =
      "kind" in scene
        ? sqlTableDrawing(scene)
        : memoryDrawing(scene, {
            positions: this.positions,
            raise: this.dragging,
            boxes: this.boxes,
            simpleArrows: this.simpleArrows,
            level: this.view.lod,
          });
    // The focus is part of the drawing, so the patch carries it over.
    applyFocus(drawing, this.dragging ?? this.hovered);
    this.showDrawing(drawing, duration, easing, enter);
  }

  /**
   * Zoomed across where arrows go simple (or back), or in past the detail
   * the drawing was built with: the step is laid out again, once the zoom
   * settles (a zoom glides through the levels between, and laying out
   * mid-glide would do it for each).
   */
  protected override levelChanged(_lod: Lod): void {
    window.clearTimeout(this.relayoutTimer);
    this.relayoutTimer = window.setTimeout(() => {
      if (!this.full) return;
      // Arrows go simple (or back), or the detail budget changes (summaries).
      const arrows = this.view.lod >= SIMPLE_ARROWS_FROM !== this.simpleArrows;
      if (arrows || this.needsDetail || this.detailBudget() !== this.budgetDrawn) this.onLayoutChange?.();
    }, RELAYOUT_AFTER);
  }
  private relayoutTimer = 0;

  /** The detail budget at the zoom now (scene/summaries.ts): zoomed out, long runs are summarized sooner. */
  detailBudget(): number {
    return detailBudget(this.view.lod, this.view.autoFitState.on);
  }
  /** The budget the scene on screen was made with. */
  private budgetDrawn: number | undefined;
  /** Each summary's box (by key) and the structure it opens. */
  private summaryKeys = new Map<string, string>();
  private readonly onExpand?: (key: string) => void;

  protected override nodeClicked(key: string): void {
    const summary = this.summaryKeys.get(key);
    if (summary) this.onExpand?.(summary);
  }

  /** Hovering changed: another box in focus, on screen and in the drawing (so they stay the same). */
  private refreshFocus(): void {
    const key = this.dragging ?? this.hovered;
    if (this.full) applyFocus(this.full, key);
    applyFocus(this.patcher.current, key);
    applyFocus(this.patcher.element, key);
  }

  override dispose(): void {
    window.clearTimeout(this.relayoutTimer);
    this.listening.abort();
    super.dispose();
  }
}

export class SvgLoopRenderer extends SvgWindow implements LoopRenderer {
  private vertical = false;
  /** Rows kept from step to step (loopView/rowCache.ts), and which are drawn: those in view. */
  private readonly rows = new RowCache();
  private readonly inView = new RowsInView();
  private scene: LoopWindowScene | null = null;
  private redraw = 0;

  constructor(el: HTMLElement, events: RendererEvents) {
    super(el, "Loop history", events);
  }

  setLayout(layout: { vertical: boolean }): void {
    this.vertical = layout.vertical;
  }

  render(scene: LoopWindowScene, _previous: LoopWindowScene | null): void {
    this.scene = scene;
    this.draw(scene, true);
  }

  private draw(scene: LoopWindowScene, step: boolean): void {
    const { duration, easing, enter } = this.step;
    const sql = "kind" in scene;
    const drawing = sql
      ? sqlPipelineDrawing(scene)
      : loopDrawing(scene, {
          vertical: this.vertical,
          rows: this.rows,
          visible: this.inView.next({ autoFit: this.view.autoFitState.on, span: (m) => this.view.visibleSpan(m) }),
          // Built at the level it'll be drawn at: with Auto-fit, where the fit will put it.
          level: (size) => this.view.levelFor(size),
        });
    // Only animated mode (one live row) animates; stacked rows (and a SQL statement's stages) just appear.
    this.showDrawing(drawing, step && !sql && scene.live ? duration : 0, easing, enter);
    if (!step) return;
    // As you step, keep the iteration that's running in view.
    const current = this.el.querySelector(".loop-row.is-current");
    if (current)
      this.view.reveal(Number(current.getAttribute("data-top")), Number(current.getAttribute("data-bottom")));
  }

  /** Zoomed in past the detail the rows were built with: drawn again, once the zoom settles. */
  protected override levelChanged(_lod: Lod): void {
    window.clearTimeout(this.relayoutTimer);
    this.relayoutTimer = window.setTimeout(() => {
      if (this.scene && this.needsDetail) this.draw(this.scene, false);
    }, RELAYOUT_AFTER);
  }
  private relayoutTimer = 0;

  /** Panned or zoomed past the rows drawn: draw the rows now in view (once a frame at most). */
  protected override viewMoved(): void {
    if (
      !this.scene ||
      this.redraw ||
      !this.inView.stale({ autoFit: this.view.autoFitState.on, span: (m) => this.view.visibleSpan(m) })
    )
      return;
    this.redraw = requestAnimationFrame(() => {
      this.redraw = 0;
      if (this.scene) this.draw(this.scene, false);
    });
  }

  override dispose(): void {
    cancelAnimationFrame(this.redraw);
    window.clearTimeout(this.relayoutTimer);
    super.dispose();
  }
}

/** The SVG renderers, for the app's windows. */
export const SVG_RENDERERS: RendererFactory = {
  memory: (el, events) => new SvgMemoryRenderer(el, events),
  loop: (el, events) => new SvgLoopRenderer(el, events),
};
