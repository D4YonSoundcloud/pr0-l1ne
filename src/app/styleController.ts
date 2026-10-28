/**
 * How the canvas looks: the Style panel (stylePanel.ts) and the appearance
 * it edits (appearance.ts), applied as CSS variables, live, and saved. Also
 * how each window animates a step, which comes from the same settings.
 */
import { type Appearance, applyAppearance, parseAppearance } from "../appearance";
import { setArrowStyle } from "../render/arrowStyle";
import type { Renderer, StepStyle } from "../scene/renderer";
import type { Settings } from "../settings";
import { type RenderingChoice, StylePanel } from "../stylePanel";
import type { StepAnimation } from "./playbackController";
import type { AppStore } from "./state";

export type Pane = "memory" | "loop";

/** What the Style panel changes on a window's renderer (scene/renderer.ts). */
export type StyledView = Pick<Renderer<unknown>, "setAppearance">;

/** How a window animates the step being drawn (the renderer's StepStyle). */
export type PaneAnimation = StepStyle;

export interface StyleOptions {
  app: AppStore;
  settings: Pick<Settings, "appearance">;
  /** The panel goes in the editor pane; the style applies to the canvas and its two sections. */
  els: {
    editorPane: HTMLElement;
    style: HTMLButtonElement;
    canvas: HTMLElement;
    memorySection: HTMLElement;
    loopSection: HTMLElement;
  };
  views: Record<Pane, StyledView>;
  /** How the step being drawn should animate (PlaybackController.animation). */
  animation(): StepAnimation;
  /** Replay the step on screen, to preview a change. */
  replay(): void;
  /** Draw the step again (no animation): for changes CSS alone can't make, like how arrows are colored. */
  redraw?(): void;
  /** The panel opened: close the other panels. */
  onOpen(): void;
  /** The panel's Rendering choice (SVG or Canvas 2D). */
  rendering?: RenderingChoice;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export class StyleController {
  readonly panel: StylePanel;
  private appearance: Appearance;
  private saveTimer = 0;
  private readonly setTimer: (callback: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  constructor(private readonly options: StyleOptions) {
    this.setTimer = options.setTimeout ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => window.clearTimeout(id));
    this.appearance = parseAppearance(options.settings.appearance.get());
    this.set(this.appearance);
    this.panel = new StylePanel({
      host: options.els.editorPane,
      button: options.els.style,
      get: () => this.appearance,
      set: (next) => this.set(next),
      replay: () => options.replay(),
      onOpen: () => options.onOpen(),
      rendering: options.rendering,
    });
  }

  get(): Appearance {
    return this.appearance;
  }

  /** Apply an appearance now, and save it once changes pause (dragging a slider sends many). */
  set(next: Appearance): void {
    const { els, views, settings } = this.options;
    const options = this.options;
    this.appearance = next;
    // How arrows are colored changes the drawing itself, not only its CSS.
    const redraw = setArrowStyle({ mode: next.arrowMode, legend: next.arrowLegend, labels: next.arrowLabels });
    if (redraw && this.panel) options.redraw?.();
    applyAppearance(next, { canvas: els.canvas, memory: els.memorySection, loop: els.loopSection }, (pane, size) =>
      views[pane].setAppearance({ gridSize: size }),
    );
    // Auto-fit glides with each window's step animation.
    views.memory.setAppearance({ zoom: { duration: next.memory.duration, easing: next.memory.easing } });
    views.loop.setAppearance({ zoom: { duration: next.loop.duration, easing: next.loop.easing } });
    this.clearTimer(this.saveTimer);
    this.saveTimer = this.setTimer(() => settings.appearance.set(JSON.stringify(next)), 250);
  }

  close(): void {
    this.panel.toggle(false);
  }

  /**
   * How a window animates the step being drawn: its own easing and duration
   * (from the Style panel), shortened while playing so an animation always
   * ends before the next step starts. Duration 0 means no animation.
   */
  animationFor(pane: Pane): PaneAnimation {
    const { duration, easing, enterFade, enterSlide } = this.appearance[pane];
    const enter = { fade: enterFade, slide: enterSlide };
    const animation = this.options.animation();
    if (!animation) return { duration: 0, easing, enter };
    const cap = animation.playing ? (0.75 * 1000) / this.options.app.get().speed : Number.POSITIVE_INFINITY;
    return { duration: Math.round(Math.min(duration, cap)), easing, enter };
  }
}
