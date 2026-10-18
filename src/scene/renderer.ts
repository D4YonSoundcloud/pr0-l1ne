/**
 * The renderer contract: how the app talks to whatever draws a window.
 *
 * Each window (memory, loop history) has one renderer. The controllers
 * (app/memoryController.ts, app/loopController.ts) build a scene for the
 * step on screen (memoryScene.ts, loopScene.ts) and hand it over; the
 * renderer owns everything about drawing it: layout, the picture, its
 * animation, panning and zooming, boxes the person has dragged, and what
 * hovering shows. Nothing outside src/render/ touches the drawing itself.
 *
 * Today's renderers draw SVG (render/svgRenderers.ts). A canvas, WebGL or
 * WebGPU renderer implements the same interfaces, and the rest of the app
 * doesn't change. See docs/how-it-works.md, "Scenes and renderers".
 */

import type { LoopScene } from "./loopScene";
import type { MemoryScene } from "./memoryScene";

export interface Point {
  x: number;
  y: number;
}

/**
 * Auto-fit keeps the whole diagram in view as it changes from step to step.
 *   "out"   only ever zooms out: once a step needed a wide view, it's kept.
 *   "both"  zooms in again when the diagram gets smaller: always a snug fit.
 */
export interface AutoFit {
  on: boolean;
  mode: "out" | "both";
}

/** Where a window looks, and how it follows the drawing. Every field is optional: only what's given changes. */
export interface ViewportChange {
  /** The drawing's offset in the window, in pixels, and its zoom (1 = 100%). */
  pan?: Point;
  zoom?: number;
  autoFit?: AutoFit;
  /** Forget what Auto-fit has fitted so far, and fit the next drawing afresh (a new program). */
  refit?: boolean;
}

/** How a step animates in. */
export interface StepStyle {
  /** In milliseconds; 0: no animation. */
  duration: number;
  easing: string;
  /** New things fade in, or slide in from where they first appear. */
  enter: { fade: boolean; slide: boolean };
}

/** How a window looks and moves (the Style panel's settings). Only what's given changes. */
export interface RendererStyle {
  /** The next step's animation. */
  step?: StepStyle;
  /** How refits (Auto-fit) glide. */
  zoom?: { duration: number; easing: string };
  /** The graph-paper square's size at 100%, in pixels. */
  gridSize?: number;
}

/** What's at a point in the window: a box (by its scene key), or the paper. */
export type Hit = { kind: "box"; key: string } | { kind: "background" };

export interface Renderer<S> {
  /**
   * Draw a scene. `previous` is the scene drawn before (null for the
   * first), so a renderer can animate what changed.
   */
  render(scene: S, previous: S | null): void;
  /** Draw nothing, and say why ("" for a blank window). */
  showMessage(text: string): void;
  setViewport(change: ViewportChange): void;
  /** What's under a point, in the page's (client) coordinates; null if it's outside the window. */
  hitTest(x: number, y: number): Hit | null;
  setAppearance(style: RendererStyle): void;
  /** A button in the window's own toolbar (beside zoom and Auto-fit). */
  addControl(label: string, title: string, onClick: () => void): HTMLButtonElement;
  /** Stop listening and let go of the window's element. */
  dispose(): void;
}

/** Told to the app as the person works in a window. */
export interface RendererEvents {
  /** Auto-fit was turned on or off, or its mode changed (to remember it). */
  onAutoFitChange?(state: AutoFit): void;
}

export interface MemoryRendererEvents extends RendererEvents {
  /** A box was dragged, or the layout reset: the step needs drawing again. */
  onLayoutChange?(): void;
}

/** The memory window: boxes can be dragged, and hovering one highlights its arrows. */
export interface MemoryRenderer extends Renderer<MemoryScene> {
  /** Put every dragged box back in its automatic place. */
  resetLayout(): void;
  /** Has the person dragged any box? */
  readonly hasMovedBoxes: boolean;
}

/** The loop history window. */
export interface LoopRenderer extends Renderer<LoopScene> {
  /** Each container on its own line, one above another, instead of side by side. */
  setLayout(layout: { vertical: boolean }): void;
}

/** Makes a window's renderer, in its element. */
export interface RendererFactory {
  memory(el: HTMLElement, events: MemoryRendererEvents): MemoryRenderer;
  loop(el: HTMLElement, events: RendererEvents): LoopRenderer;
}
