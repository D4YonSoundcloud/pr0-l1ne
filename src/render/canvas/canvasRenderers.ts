/**
 * The Canvas 2D renderers: the memory and loop windows drawn with PixiJS on
 * a plain 2D canvas (PixiJS's "canvas" renderer, no WebGL), behind the same
 * renderer contract as the SVG ones (scene/renderer.ts).
 *
 * They share the SVG renderers' layout: each step, render/memory.ts or
 * render/loopView.ts lays out a drawing (drawing.ts: the SVG elements it
 * means, as plain marks). The SVG renderer makes it SVG; here paint.ts reads
 * it (with its styles from the real CSS, styles.ts) into shapes and text,
 * and pixiScene.ts turns those into PixiJS objects, with no DOM in between.
 * So the two renderers draw the same picture, and what's different is only
 * how it reaches the screen: one canvas the size of the window, redrawn
 * when something moves, instead of thousands of elements for the browser
 * to style, lay out and paint. From one step to the next, each window keeps
 * the paint (PaintCache) and the PixiJS objects (SceneCache) of whatever
 * didn't change, so a step builds only what did.
 *
 * The viewport (viewport.ts) is the same too: it tells the canvas where the
 * view is (ViewSurface) instead of moving an SVG with CSS. Things the SVG
 * renderer gets from the DOM are done here by hand: which box is under the
 * pointer (from the paint list's bounds), hover highlights (the same
 * applyFocus, then a redraw), tooltips, and the step animation (the same
 * plan as animate.ts, played with tweens, motion.ts).
 *
 * This module imports PixiJS, so main.ts loads it only when the person
 * picks the canvas renderer.
 */
import { autoDetectRenderer, type Container, Container as PixiContainer, type Renderer as PixiRenderer } from "pixi.js";
// PixiJS builds some of its code with new Function(), which the app's
// Content-Security-Policy doesn't allow (public/_headers): this swaps in
// versions that don't.
import "pixi.js/unsafe-eval";
import { prefersReducedMotion } from "../../appearance";
import type { LoopScene } from "../../scene/loopScene";
import type { MemoryScene } from "../../scene/memoryScene";
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
} from "../../scene/renderer";
import { type Animatable, DEFAULT_EASING, ENTER_SLIDE, plan, type Snapshot, snapshot } from "../animate";
import { type Mark, toSvg } from "../drawing";
import { standaloneSvg } from "../export";
import { loopDrawing } from "../loopView";
import { applyFocus, memoryDrawing } from "../memory";
import { type View, Viewport } from "../viewport";
import { easing, Tweens } from "./motion";
import { groups, type Paint, PaintCache, type PaintGroup, paintDrawing, type Rect } from "./paint";
import { type BuiltScene, buildScene, forgetFonts, SceneCache } from "./pixiScene";
import { ProbeStyles, type StyleProbe } from "./styles";

/** How the canvas renderers read styles (tests give their own: jsdom can't resolve the app's CSS). */
export interface CanvasOptions {
  styles?(host: Element): StyleProbe;
}

const STILL: StepStyle = { duration: 0, easing: "linear", enter: { fade: false, slide: false } };

/** Room around a box or row before it counts as off screen (text can stick out of a box's shapes). */
const CULL_MARGIN = 60;
/** Text is drawn sharper when zoomed in, in steps (1×, 2×, 3×), once the zoom settles. */
const TEXT_SETTLE_MS = 160;

const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const overlaps = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/** "mark 450ms ease-out" (the --flash variable): how long, and how. */
function parseAnimation(value: string): { duration: number; easing: string } | null {
  if (!value || value === "none") return null;
  const time = /(-?[\d.]+)(ms|s)\b/.exec(value);
  if (!time) return null;
  const duration = Number(time[1]) * (time[2] === "s" ? 1000 : 1);
  const ease = /(cubic-bezier\([^)]*\)|ease-in-out|ease-in|ease-out|ease|linear)/.exec(value)?.[1] ?? "ease";
  return duration > 0 ? { duration, easing: ease } : null;
}

/** What both canvas windows share: the canvas, its viewport, and drawing a paint list there. */
abstract class CanvasWindow {
  protected readonly view: Viewport;
  readonly canvas: HTMLCanvasElement;
  protected readonly styles: StyleProbe;
  /** Resolves once PixiJS can draw; rejects if it can't start here. */
  readonly ready: Promise<void>;
  protected step: StepStyle = STILL;
  /** The drawing on screen (drawing.ts: the layout, as marks), and what it was painted into. */
  protected drawing: Mark | null = null;
  protected paint: Paint | null = null;
  private pixi: PixiRenderer | null = null;
  private readonly stage: Container = new PixiContainer();
  private built: BuiltScene | null = null;
  /** What's kept of the scene from one build to the next (pixiScene.ts), and of the paint (paint.ts). */
  private readonly kept = new SceneCache();
  private readonly keptPaint = new PaintCache();
  /** Boxes and rows that can be skipped when they're out of view. */
  private cullable: { layer: Container; bounds: Rect }[] = [];
  private at: View = { x: 0, y: 0, z: 1 };
  protected readonly tweens: Tweens;
  private frame: number | null = null;
  private textScale = 1;
  private textTimer = 0;
  /** The inline styles the Style panel sets up the page: when they change, styles are read again. */
  private looks = "";
  private disposed = false;
  private readonly listening = new AbortController();
  private resizes: ResizeObserver | null = null;
  private tooltip = "";

  constructor(
    protected readonly el: HTMLElement,
    label: string,
    events: RendererEvents,
    options: CanvasOptions,
    onNodeMove?: (key: string, position: Point, done: boolean) => void,
  ) {
    this.view = new Viewport(el, {
      label,
      onNodeMove,
      onAutoFitChange: (state) => events.onAutoFitChange?.(state),
      surface: {
        onView: (view) => {
          this.at = view;
          this.requestDraw();
          this.settleText();
        },
        nodeAt: (x, y) => {
          const node = this.nodeAt(x, y);
          return node?.at && node.nodeKey ? { key: node.nodeKey, x: node.at.x, y: node.at.y } : null;
        },
      },
    });
    el.classList.add("is-canvas");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "viewport-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.view.contentLayer.after(this.canvas);
    this.styles = options.styles?.(this.view.contentLayer) ?? new ProbeStyles(this.view.contentLayer);
    this.tweens = new Tweens(() => this.drawNow());

    const signal = this.listening.signal;
    el.addEventListener("pointermove", (e) => this.showTooltip(e.clientX, e.clientY), { signal });
    if (typeof ResizeObserver === "function") {
      this.resizes = new ResizeObserver(() => this.resize());
      this.resizes.observe(el);
    }
    // A web font arriving changes how wide text is: measure and draw it again.
    document.fonts?.addEventListener(
      "loadingdone",
      () => {
        forgetFonts();
        this.kept.clear();
        this.repaint();
      },
      { signal },
    );
    this.ready = this.start();
    // Nobody may be waiting on it; a failure is reported through `ready`.
    this.ready.catch(() => {});
  }

  private async start(): Promise<void> {
    const pixi = await autoDetectRenderer({
      preference: ["canvas"],
      canvas: this.canvas,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      width: Math.max(1, this.el.clientWidth),
      height: Math.max(1, this.el.clientHeight),
    });
    if (this.disposed) {
      pixi.destroy();
      return;
    }
    this.pixi = pixi;
    this.resize();
  }

  private resize(): void {
    if (!this.pixi) return;
    const w = Math.max(1, this.el.clientWidth);
    const h = Math.max(1, this.el.clientHeight);
    const resolution = window.devicePixelRatio || 1;
    if (this.pixi.width !== w || this.pixi.height !== h || this.pixi.resolution !== resolution) {
      this.pixi.resize(w, h, resolution);
    }
    this.drawNow();
  }

  // -- drawing ---------------------------------------------------------------

  /** Draw on the next frame (many view changes in one frame draw once). */
  private requestDraw(): void {
    if (this.frame !== null || typeof requestAnimationFrame !== "function") return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.drawNow();
    });
  }

  /** Draw the picture where the view is now. */
  protected drawNow(): void {
    if (!this.pixi || this.disposed) return;
    const { x, y, z } = this.at;
    this.stage.position.set(x, y);
    this.stage.scale.set(z);
    // Skip boxes and rows that are out of the window.
    const visible: Rect = {
      x: -x / z - CULL_MARGIN,
      y: -y / z - CULL_MARGIN,
      w: this.pixi.width / z + CULL_MARGIN * 2,
      h: this.pixi.height / z + CULL_MARGIN * 2,
    };
    for (const c of this.cullable) {
      // A box sliding in from elsewhere may be off its final place: keep it drawn.
      const moving = c.layer.x !== 0 || c.layer.y !== 0;
      c.layer.visible = moving || overlaps(c.bounds, visible);
    }
    this.pixi.render({ container: this.stage });
  }

  /**
   * Draw an SVG drawing. `motion`: animate from the drawing before (the
   * step changed); null: just show it (a hover, a redraw for new styles).
   */
  protected show(drawing: Mark, motion: StepStyle | null): void {
    const before = motion && motion.duration > 0 && this.drawing ? snapshot(this.drawing) : null;
    this.checkLooks();
    this.drawing = drawing;
    this.paint = paintDrawing(drawing, this.styles, this.keptPaint);
    const effects = motion !== null && !prefersReducedMotion() && !this.el.classList.contains("is-dragging-node");
    this.build(effects);
    this.view.setDrawn({ width: this.paint.width, height: this.paint.height });
    if (before && motion) this.animate(before, motion);
    if (effects) this.playEffects();
    this.drawNow();
  }

  /** Paint the drawing on screen again (styles or fonts changed, or a hover), without animating. */
  protected repaint(): void {
    if (!this.drawing) return;
    this.checkLooks();
    this.paint = paintDrawing(this.drawing, this.styles, this.keptPaint);
    this.build(false);
    this.drawNow();
  }

  private build(flash: boolean): void {
    if (!this.paint) return;
    this.tweens.clear();
    const old = this.built;
    this.built = buildScene(
      this.paint,
      {
        resolution: (window.devicePixelRatio || 1) * this.textScale,
        flash: flash && !!parseAnimation(this.styles.variable("--flash")),
      },
      this.kept,
    );
    this.stage.removeChildren();
    this.stage.addChild(this.built.root);
    old?.root.destroy({ children: true });
    this.cullable = [];
    for (const [group, layer] of this.built.layers) {
      if ((group.nodeKey || group.current) && group.bounds) this.cullable.push({ layer, bounds: group.bounds });
    }
  }

  /** Has the Style panel (or anything) changed the inline styles the drawing's CSS reads? */
  private checkLooks(): boolean {
    let looks = document.documentElement.className;
    for (let at = this.el.parentElement; at; at = at.parentElement) looks += `|${at.getAttribute("style") ?? ""}`;
    if (looks === this.looks) return false;
    this.looks = looks;
    this.styles.clear();
    this.keptPaint.clear();
    return true;
  }

  /** The step animation: the same plan as the SVG renderer's (animate.ts), as tweens. */
  private animate(before: Snapshot, motion: StepStyle): void {
    if (!this.built || !this.paint) return;
    const layers = this.built.layers;
    const items: Animatable<Container>[] = [];
    for (const group of groups(this.paint.root)) {
      const layer = layers.get(group);
      if (!layer || !(group.flip || group.cell)) continue;
      const item: Animatable<Container> = { el: layer };
      if (group.flip) item.flip = { key: group.flip, x: group.at?.x ?? 0, y: group.at?.y ?? 0, noFade: !!group.noFade };
      if (group.cell) item.cell = group.cell;
      items.push(item);
    }
    const ease = easing(motion.easing || DEFAULT_EASING);
    for (const move of plan(before, items)) {
      const layer = move.el;
      if (move.kind === "slide") {
        const { dx, dy } = move;
        this.tweens.add({
          duration: motion.duration,
          ease,
          apply: (p) => layer.position.set(dx * (1 - p), dy * (1 - p)),
        });
        continue;
      }
      if (motion.enter.fade) {
        const alpha = layer.alpha;
        this.tweens.add({
          duration: motion.duration * 0.6,
          ease: easing("ease-out"),
          apply: (p) => (layer.alpha = alpha * p),
        });
      }
      if (motion.enter.slide) {
        this.tweens.add({ duration: motion.duration, ease, apply: (p) => (layer.x = -ENTER_SLIDE * (1 - p)) });
      }
    }
  }

  /** Effects that play when a drawing appears, whatever the step animation (the changed-cell flash). */
  protected playEffects(): void {
    const flash = parseAnimation(this.styles.variable("--flash"));
    if (!flash || !this.built) return;
    const ease = easing(flash.easing);
    for (const overlay of this.built.flashes) {
      this.tweens.add({ duration: flash.duration, ease, apply: (p) => (overlay.alpha = 1 - p) });
    }
  }

  /** Each keyed group's layer (for subclasses' own effects). */
  protected layerOf(group: PaintGroup): Container | undefined {
    return this.built?.layers.get(group);
  }

  // -- the pointer ---------------------------------------------------------------

  /** A point in the page, in diagram units. */
  private toDiagram(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return { x: (clientX - rect.left - this.at.x) / this.at.z, y: (clientY - rect.top - this.at.y) / this.at.z };
  }

  /** The topmost draggable box under a point. */
  protected nodeAt(clientX: number, clientY: number): PaintGroup | null {
    if (!this.paint) return null;
    const { x, y } = this.toDiagram(clientX, clientY);
    let found: PaintGroup | null = null;
    for (const group of groups(this.paint.root)) {
      if (group.nodeKey && group.bounds && contains(group.bounds, x, y)) found = group;
    }
    return found;
  }

  private showTooltip(clientX: number, clientY: number): void {
    if (!this.paint) return;
    const { x, y } = this.toDiagram(clientX, clientY);
    let title = "";
    for (const group of groups(this.paint.root)) {
      if (group.title && group.bounds && contains(group.bounds, x, y)) title = group.title;
    }
    if (title === this.tooltip) return;
    this.tooltip = title;
    if (title) this.canvas.title = title;
    else this.canvas.removeAttribute("title");
  }

  /** Once zooming settles, draw text at a resolution that's sharp at that zoom. */
  private settleText(): void {
    const scale = this.at.z <= 1 ? 1 : this.at.z <= 2 ? 2 : 3;
    window.clearTimeout(this.textTimer);
    if (scale === this.textScale) return;
    this.textTimer = window.setTimeout(() => {
      this.textScale = scale;
      if (!this.paint) return;
      this.build(false);
      this.drawNow();
    }, TEXT_SETTLE_MS);
  }

  // -- the contract -------------------------------------------------------------

  showMessage(text: string): void {
    this.tweens.clear();
    this.drawing = null;
    this.paint = null;
    this.stage.removeChildren();
    this.built?.root.destroy({ children: true });
    this.built = null;
    this.kept.clear();
    this.keptPaint.clear();
    this.cullable = [];
    this.view.setDrawn(null, text);
    this.drawNow();
  }

  setViewport(change: ViewportChange): void {
    if (change.autoFit) this.view.setAutoFit(change.autoFit, false);
    if (change.refit) this.view.restartAutoFit();
    if (change.pan || change.zoom !== undefined) this.view.moveTo(change.pan, change.zoom);
  }

  get viewport(): { pan: Point; zoom: number } {
    return this.view.view;
  }

  hitTest(x: number, y: number): Hit | null {
    const rect = this.el.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const node = this.nodeAt(x, y);
    return node?.nodeKey ? { kind: "box", key: node.nodeKey } : { kind: "background" };
  }

  setAppearance(style: RendererStyle): void {
    if (style.step) this.step = style.step;
    if (style.zoom) this.view.setZoomAnimation(style.zoom.duration, style.zoom.easing);
    if (style.gridSize !== undefined) this.view.setGridSize(style.gridSize);
    // The Style panel calls this on every change: if the look changed, redraw in it.
    if ((style.zoom || style.gridSize !== undefined) && this.checkLooks()) this.repaint();
  }

  addControl(label: string, title: string, onClick: () => void): HTMLButtonElement {
    return this.view.addControl(label, title, onClick);
  }

  toSVG(): string | null {
    if (!this.drawing) return null;
    return standaloneSvg(toSvg(this.drawing) as SVGSVGElement, this.styles, getComputedStyle(this.el).backgroundColor);
  }

  dispose(): void {
    this.disposed = true;
    this.tweens.clear();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    window.clearTimeout(this.textTimer);
    this.listening.abort();
    this.resizes?.disconnect();
    this.styles.dispose();
    this.built?.root.destroy({ children: true });
    this.kept.clear();
    this.pixi?.destroy();
    this.pixi = null;
    this.el.classList.remove("is-canvas");
    this.view.dispose();
  }
}

/** Classes as a set. */
const classSet = (classes: string) => new Set(classes.split(/\s+/).filter(Boolean));

export class CanvasMemoryRenderer extends CanvasWindow implements MemoryRenderer {
  private readonly positions = new Map<string, Point>();
  private dragging: string | null = null;
  private hovered: string | null = null;
  private readonly hovering = new AbortController();

  constructor(el: HTMLElement, events: MemoryRendererEvents, options: CanvasOptions = {}) {
    super(el, "Memory diagram", events, options, (key, position, done) => {
      this.positions.set(key, position);
      this.dragging = done ? null : key;
      events.onLayoutChange?.();
    });
    // Hovering a box highlights its arrows and the boxes they connect to,
    // as in the SVG renderer (memory.ts applyFocus), then draws again.
    const signal = this.hovering.signal;
    el.addEventListener(
      "pointermove",
      (event) => {
        if (event.buttons && !this.dragging) return; // panning: nothing to hover
        const key = this.nodeAt(event.clientX, event.clientY)?.nodeKey ?? null;
        this.canvas.style.cursor = this.dragging ? "grabbing" : key ? "grab" : "";
        if (key === this.hovered) return;
        this.hovered = key;
        this.refreshFocus(true);
      },
      { signal },
    );
    el.addEventListener(
      "pointerleave",
      () => {
        this.canvas.style.cursor = "";
        if (this.hovered === null) return;
        this.hovered = null;
        this.refreshFocus(true);
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
    const drawing = memoryDrawing(scene, { positions: this.positions, raise: this.dragging });
    this.refreshFocus(false, drawing);
    this.show(drawing, this.step);
  }

  /** Highlight the hovered (or dragged) box's arrows; `redraw` to show it now. */
  private refreshFocus(redraw: boolean, drawing = this.drawing): void {
    applyFocus(drawing, this.dragging ?? this.hovered);
    if (redraw) this.repaint();
  }

  /** On top of the flash: the printed-output card's entrance, and the rest of the drawing dimming (styles.css). */
  protected override playEffects(): void {
    super.playEffects();
    if (!this.paint) return;
    // The card pops in whenever it's drawn; the dimming fades only on the
    // steps where it starts (output-in) or ends (output-out).
    const svgClasses = classSet(this.paint.classes);
    const dimIn = svgClasses.has("output-in");
    const dimOut = svgClasses.has("output-out");
    const ms = (name: string, fallback: number) => {
      const v = this.styles.variable(name);
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n * (v.trim().endsWith("s") && !v.trim().endsWith("ms") ? 1000 : 1) : fallback;
    };
    const dimMs = ms("--output-dim-duration", 260);
    const DIM = 0.28; // styles.css: .memory-svg.has-output ... { opacity: 0.28 }
    for (const group of groups(this.paint.root)) {
      const layer = this.layerOf(group);
      if (!layer) continue;
      const own = classSet(group.classes);
      const parent = classSet(group.parentClasses);
      const inBoxes = parent.has("boxes") && own.has("node");
      const inArrows = parent.has("arrows");
      if (own.has("is-output") && own.has("node")) {
        // The card pops in: from --output-from-opacity and --output-from-x.
        const fromAlpha = Number.parseFloat(this.styles.variable("--output-from-opacity") || "0");
        const fromX = Number.parseFloat(this.styles.variable("--output-from-x") || "-8");
        const alpha = layer.alpha;
        const ease = easing("cubic-bezier(0.2, 0.7, 0.2, 1)");
        this.tweens.add({
          duration: ms("--output-duration", 240),
          ease,
          apply: (p) => {
            layer.alpha = alpha * ((Number.isFinite(fromAlpha) ? fromAlpha : 0) * (1 - p) + p);
            layer.x = (Number.isFinite(fromX) ? fromX : -8) * (1 - p);
          },
        });
        continue;
      }
      if (dimMs <= 0) continue;
      const fade = (from: number) => {
        const to = layer.alpha;
        this.tweens.add({
          duration: dimMs,
          ease: easing("ease"),
          apply: (p) => (layer.alpha = from + (to - from) * p),
        });
      };
      if (dimIn) {
        const dims = (inBoxes && !own.has("is-printed")) || (inArrows && !own.has("print-arrow"));
        if (dims) fade(1);
      } else if (dimOut && (inBoxes || inArrows)) fade(DIM);
    }
  }

  override dispose(): void {
    this.hovering.abort();
    super.dispose();
  }
}

export class CanvasLoopRenderer extends CanvasWindow implements LoopRenderer {
  private vertical = false;

  constructor(el: HTMLElement, events: RendererEvents, options: CanvasOptions = {}) {
    super(el, "Loop history", events, options);
  }

  setLayout(layout: { vertical: boolean }): void {
    this.vertical = layout.vertical;
  }

  render(scene: LoopScene, _previous: LoopScene | null): void {
    // Only animated mode (one live row) animates; stacked rows just appear.
    const motion = scene.live ? this.step : { ...this.step, duration: 0 };
    this.show(loopDrawing(scene, { vertical: this.vertical }), motion);
    // As you step, keep the iteration that's running in view.
    const current = this.drawing?.querySelector(".loop-row.is-current");
    if (current)
      this.view.reveal(Number(current.getAttribute("data-top")), Number(current.getAttribute("data-bottom")));
  }
}

/** Canvas 2D renderers for the app's windows. */
export function canvasRenderers(options: CanvasOptions = {}): RendererFactory {
  return {
    memory: (el, events) => new CanvasMemoryRenderer(el, events, options),
    loop: (el, events) => new CanvasLoopRenderer(el, events, options),
  };
}

/** The Canvas 2D renderers, reading the page's CSS. */
export const CANVAS_RENDERERS: RendererFactory = canvasRenderers();
