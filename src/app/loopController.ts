/**
 * Loop history: each pass of the loop that's running, one row per pass (for
 * SQL, the statement's stages: scene/sqlScene.ts), built
 * as a scene (scene/loopScene.ts) and drawn by the window's renderer
 * (scene/renderer.ts; SVG today, render/svgRenderers.ts). Tabs pick which loop
 * when there are several (or all of a function's nested loops together).
 * Its toolbar picks stacked rows or one animated row, hiding variables that
 * don't change, and stacking containers vertically.
 */
import { type LiveRow, loopScene } from "../scene/loopScene";
import type { LoopRenderer, LoopWindowScene, RendererFactory } from "../scene/renderer";
import { sqlPipelineScene } from "../scene/sqlScene";
import type { Settings } from "../settings";
import {
  ALL_LOOPS,
  availableLoops,
  buildLoopHistory,
  buildNestedHistory,
  type LoopHistory,
  type LoopRow,
  nestedLoopsAt,
} from "../trace/loopHistory";
import type { SizeModel } from "../trace/memory";
import { liveFrames, type Trace } from "../trace/types";
import { isTall, storedAutoFit } from "./autoFit";
import type { AppStore } from "./state";
import type { PaneAnimation } from "./styleController";

export type LoopMode = "stacked" | "animated";

export interface LoopElements {
  loop: HTMLElement;
  loopTabs: HTMLElement;
  hideQuiet: HTMLInputElement;
  loopVertical: HTMLInputElement;
  loopStacked: HTMLButtonElement;
  loopAnimated: HTMLButtonElement;
}

export interface LoopOptions {
  app: AppStore;
  settings: Pick<Settings, "loopMode" | "loopVertical" | "autoFit" | "controlsCollapsed">;
  els: LoopElements;
  /** The memory size model to draw, or null (MemoryController.sizes). */
  sizes(): SizeModel | null;
  /** How to animate the step being drawn (StyleController.animationFor). */
  animation(): PaneAnimation;
  /** Redraw the whole step; `updateMarks` false keeps the editor's marks. */
  redraw(updateMarks: boolean): void;
  /** What draws the window (main.ts picks: SVG today). */
  renderers: Pick<RendererFactory, "loop">;
}

/** The loop's live state at a step, and at the step before, for animated mode. */
export function liveRows(t: Trace, index: number, history: LoopHistory): { prev: LoopRow; current: LoopRow } {
  const { frame: frameId, loop, instance } = history.context;
  const at = (i: number): LoopRow | null => {
    const step = t.steps[i];
    const context = step?.loops.find((c) => c.frame === frameId && c.loop === loop && c.instance === instance);
    const frame = step && liveFrames(step).find((f) => f.id === frameId);
    return context && frame ? { iteration: context.iteration, stepIndex: i, frame, heap: step.heap } : null;
  };
  const current = at(index) ?? history.rows[history.rows.length - 1];
  return { prev: at(index - 1) ?? current, current };
}

/**
 * Animated mode with every loop together: a live row for each loop of the
 * nest, outermost first, so an inner loop runs under the loop around it
 * instead of replacing it. A loop that isn't running at this step (an inner
 * one between runs, or one that has finished) shows how it last was.
 */
export function liveNestedRows(t: Trace, index: number, history: LoopHistory): LiveRow[] {
  const frameId = history.context.frame;
  // Each loop of the nest once, outermost first, in the order they first ran.
  const levels: { loop: string; depth: number }[] = [];
  for (const row of history.rows) {
    if (row.loop !== undefined && !levels.some((l) => l.loop === row.loop))
      levels.push({ loop: row.loop, depth: row.depth ?? 0 });
  }
  levels.sort((a, b) => a.depth - b.depth);
  const step = t.steps[index];
  const here = step?.loops.filter((c) => c.frame === frameId) ?? [];
  const frameAt = (i: number) => {
    const at = t.steps[i];
    return at ? liveFrames(at).find((f) => f.id === frameId) : undefined;
  };
  const out: LiveRow[] = [];
  for (const level of levels) {
    const ctx = here.find((c) => c.loop === level.loop);
    const frame = frameAt(index);
    if (ctx && frame) {
      const current: LoopRow = {
        iteration: ctx.iteration,
        stepIndex: index,
        frame,
        heap: step.heap,
        loop: ctx.loop,
        instance: ctx.instance,
        depth: level.depth,
      };
      const before = t.steps[index - 1]?.loops.find(
        (c) => c.frame === frameId && c.loop === ctx.loop && c.instance === ctx.instance,
      );
      const beforeFrame = frameAt(index - 1);
      const prev: LoopRow =
        before && beforeFrame
          ? {
              ...current,
              iteration: before.iteration,
              stepIndex: index - 1,
              frame: beforeFrame,
              heap: t.steps[index - 1].heap,
            }
          : current;
      out.push({ prev, current });
      continue;
    }
    const last = [...history.rows].reverse().find((row) => row.loop === level.loop);
    if (last) out.push({ prev: last, current: last, done: true });
  }
  return out;
}

export class LoopController {
  readonly renderer: LoopRenderer;
  /** The scene last drawn, for the renderer to animate from. */
  private drawn: LoopWindowScene | null = null;
  /** The loop picked in the tabs (ALL_LOOPS: nested loops together), or null for the innermost running. */
  private selected: string | null = null;
  private hideQuiet: boolean;
  /** Containers one above another instead of side by side. */
  private vertical: boolean;
  private mode: LoopMode;

  constructor(private readonly options: LoopOptions) {
    const { els, settings } = options;
    this.hideQuiet = els.hideQuiet.checked;
    this.vertical = settings.loopVertical.get();
    this.mode = settings.loopMode.get();

    this.renderer = options.renderers.loop(els.loop, {
      onAutoFitChange: (state) => settings.autoFit("loop").set(JSON.stringify(state)),
      controls: settings.controlsCollapsed("loop"),
    });
    this.renderer.setViewport({ autoFit: storedAutoFit(settings.autoFit("loop")) });
    this.renderer.setLayout({ vertical: this.vertical });

    els.hideQuiet.addEventListener("change", () => {
      this.hideQuiet = els.hideQuiet.checked;
      options.redraw(true);
    });
    els.loopVertical.checked = this.vertical;
    els.loopVertical.addEventListener("change", () => {
      this.vertical = els.loopVertical.checked;
      settings.loopVertical.set(this.vertical);
      this.renderer.setLayout({ vertical: this.vertical });
      options.redraw(true);
    });
    els.loopStacked.addEventListener("click", () => this.setMode("stacked"));
    els.loopAnimated.addEventListener("click", () => this.setMode("animated"));
    this.updateButtons();
    options.app.watch(
      (s) => s.language,
      () => this.reset(),
    );
  }

  setMode(mode: LoopMode): void {
    this.mode = mode;
    this.options.settings.loopMode.set(mode);
    this.updateButtons();
    this.options.redraw(false);
  }

  private updateButtons(): void {
    const { els } = this.options;
    els.loopStacked.setAttribute("aria-pressed", String(this.mode === "stacked"));
    els.loopAnimated.setAttribute("aria-pressed", String(this.mode === "animated"));
  }

  /** A different program (or language): back to the loop that's running, fitted afresh. */
  reset(): void {
    this.selected = null;
    this.renderer.setViewport({ refit: true });
  }

  /** Nothing to show yet. */
  showEmpty(): void {
    this.drawn = null;
    this.renderer.showMessage("");
    this.options.els.loopTabs.replaceChildren();
  }

  /** Draw the loop history and its tabs for the step on screen. */
  render(): void {
    const { trace, stepIndex } = this.options.app.get();
    if (!trace?.steps.length) return;
    const { els } = this.options;
    // SQL: the statement's stages, in the order they run.
    if (trace.sql) {
      els.loopTabs.replaceChildren();
      const scene = sqlPipelineScene(trace, stepIndex);
      if (!scene) return;
      this.renderer.setAppearance({ step: this.options.animation() });
      this.renderer.render(scene, this.drawn);
      this.drawn = scene;
      return;
    }
    // Nested loops are drawn together unless one loop is picked: stacked,
    // each inner pass under the outer pass it's in; animated, each inner
    // loop's live row under the loop around it.
    const { contexts } = availableLoops(trace, stepIndex);
    const together = nestedLoopsAt(trace, stepIndex).length > 0;
    const wantsAll = together && (this.selected === null || this.selected === ALL_LOOPS);
    const history =
      (wantsAll ? buildNestedHistory(trace, stepIndex) : null) ??
      buildLoopHistory(trace, stepIndex, this.selected === ALL_LOOPS ? null : this.selected);
    const tab = (text: string, selected: boolean, pick: string, title = "") => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "loop-tab";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(selected));
      button.textContent = text;
      if (title) button.title = title;
      button.addEventListener("click", () => {
        this.selected = pick;
        this.options.redraw(true);
      });
      return button;
    };
    els.loopTabs.replaceChildren(
      ...(together
        ? [
            tab(
              "All loops",
              !!history?.nested,
              ALL_LOOPS,
              this.mode === "animated"
                ? "Every loop in this function, together: each inner loop running under the loop around it"
                : "Every loop in this function, together: each pass of an inner loop under the pass of the loop around it",
            ),
          ]
        : []),
      ...contexts.map((ctx) => {
        const info = trace.loops.find((loop) => loop.id === ctx.loop);
        return tab(
          `${info?.header ?? ctx.loop}  (line ${info?.line ?? "?"})`,
          !history?.nested && history?.info.id === ctx.loop,
          ctx.loop,
        );
      }),
    );
    if (history?.rows.length) {
      const live =
        this.mode !== "animated"
          ? undefined
          : history.nested
            ? liveNestedRows(trace, stepIndex, history)
            : liveRows(trace, stepIndex, history);
      const scene = loopScene(trace, history, {
        hideQuiet: this.hideQuiet,
        live,
        sizes: this.options.sizes(),
        tall: isTall(this.options.els.loop),
      });
      this.renderer.setAppearance({ step: this.options.animation() });
      this.renderer.render(scene, this.drawn);
      this.drawn = scene;
    } else {
      this.drawn = null;
      this.renderer.showMessage(
        "When your code enters a loop, each iteration is stacked here so you can compare them.",
      );
    }
  }
}
