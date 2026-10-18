/**
 * The SVG renderers: the memory and loop windows drawn as SVG, behind the
 * renderer contract (scene/renderer.ts). Each draws its scene with
 * render/memory.ts or render/loopView.ts, in a pannable, zoomable window
 * (viewport.ts) that animates from one step to the next (animate.ts).
 *
 * Everything that depends on the drawing being SVG stays here: dragging a
 * box by its <g data-node-key>, highlighting a hovered box's arrows,
 * keeping the running row in view by its data-top / data-bottom.
 */
import type { LoopScene } from "../scene/loopScene";
import type { MemoryScene } from "../scene/memoryScene";
import type {
  Hit,
  LoopRenderer,
  MemoryRenderer,
  MemoryRendererEvents,
  Point,
  RendererEvents,
  RendererFactory,
  RendererStyle,
  StepStyle,
  ViewportChange,
} from "../scene/renderer";
import { ProbeStyles } from "./canvas/styles";
import { standaloneSvg } from "./export";
import { renderLoopHistory } from "./loopView";
import { applyFocus, renderMemory } from "./memory";
import { Viewport } from "./viewport";

const STILL: StepStyle = { duration: 0, easing: "linear", enter: { fade: false, slide: false } };

/** What both SVG windows share: the viewport, and how they're styled and moved. */
abstract class SvgWindow {
  protected readonly view: Viewport;
  protected step: StepStyle = STILL;

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
    });
  }

  showMessage(text: string): void {
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
    // connect to. The SVG is redrawn on every step, so the focus is re-applied.
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

  render(scene: MemoryScene, _previous: MemoryScene | null): void {
    const { duration, easing, enter } = this.step;
    this.view.setContent(
      renderMemory(scene, { positions: this.positions, raise: this.dragging }),
      "",
      duration,
      easing,
      enter,
    );
    this.refreshFocus();
  }

  private refreshFocus(): void {
    applyFocus(this.el.querySelector<SVGSVGElement>(".memory-svg"), this.dragging ?? this.hovered);
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

  render(scene: LoopScene, _previous: LoopScene | null): void {
    const { duration, easing, enter } = this.step;
    // Only animated mode (one live row) animates; stacked rows just appear.
    this.view.setContent(
      renderLoopHistory(scene, { vertical: this.vertical }),
      "",
      scene.live ? duration : 0,
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
