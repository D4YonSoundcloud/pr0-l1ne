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
import { ProbeStyles } from "./canvas/styles";
import { standaloneSvg } from "./export";
import { loopDrawing } from "./loopView";
import { applyFocus, memoryDrawing } from "./memory";
import { SvgPatcher } from "./patch";
import { sqlPipelineDrawing, sqlTableDrawing } from "./sqlView";
import { Viewport } from "./viewport";

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
      onAutoFitChange: (state) => events.onAutoFitChange?.(state),
      controls: events.controls,
    });
  }

  showMessage(text: string): void {
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
  private dragging: string | null = null;
  private hovered: string | null = null;
  private readonly listening = new AbortController();

  constructor(el: HTMLElement, events: MemoryRendererEvents) {
    super(el, "Memory diagram", events, (key, position, done) => {
      this.positions.set(key, position);
      this.dragging = done ? null : key;
      events.onLayoutChange?.();
    });
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
    const { duration, easing, enter } = this.step;
    const drawing =
      "kind" in scene
        ? sqlTableDrawing(scene)
        : memoryDrawing(scene, { positions: this.positions, raise: this.dragging });
    // The focus is part of the drawing, so the patch carries it over.
    applyFocus(drawing, this.dragging ?? this.hovered);
    this.view.updateContent(() => timed("svg.patch", () => this.patcher.show(drawing)), duration, easing, enter);
  }

  /** Hovering changed: another box in focus, on screen and in the drawing (so they stay the same). */
  private refreshFocus(): void {
    const key = this.dragging ?? this.hovered;
    applyFocus(this.patcher.current, key);
    applyFocus(this.patcher.element, key);
  }

  override dispose(): void {
    this.listening.abort();
    super.dispose();
  }
}

export class SvgLoopRenderer extends SvgWindow implements LoopRenderer {
  private vertical = false;

  constructor(el: HTMLElement, events: RendererEvents) {
    super(el, "Loop history", events);
  }

  setLayout(layout: { vertical: boolean }): void {
    this.vertical = layout.vertical;
  }

  render(scene: LoopWindowScene, _previous: LoopWindowScene | null): void {
    const { duration, easing, enter } = this.step;
    const sql = "kind" in scene;
    const drawing = sql ? sqlPipelineDrawing(scene) : loopDrawing(scene, { vertical: this.vertical });
    // Only animated mode (one live row) animates; stacked rows (and a SQL statement's stages) just appear.
    this.view.updateContent(
      () => timed("svg.patch", () => this.patcher.show(drawing)),
      !sql && scene.live ? duration : 0,
      easing,
      enter,
    );
    // As you step, keep the iteration that's running in view.
    const current = this.el.querySelector(".loop-row.is-current");
    if (current)
      this.view.reveal(Number(current.getAttribute("data-top")), Number(current.getAttribute("data-bottom")));
  }
}

/** The SVG renderers, for the app's windows. */
export const SVG_RENDERERS: RendererFactory = {
  memory: (el, events) => new SvgMemoryRenderer(el, events),
  loop: (el, events) => new SvgLoopRenderer(el, events),
};
