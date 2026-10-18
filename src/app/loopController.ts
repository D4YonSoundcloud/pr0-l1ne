/**
 * Loop history: each pass of the loop that's running, one row per pass
 * (render/loopView.ts), in its own pannable window. Tabs pick which loop
 * when there are several (or all of a function's nested loops together).
 * Its toolbar picks stacked rows or one animated row, hiding variables that
 * don't change, and stacking containers vertically.
 */
import { renderLoopHistory } from "../render/loopView";
import { Viewport } from "../render/viewport";
import { loopScene } from "../scene/loopScene";
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
import { storedAutoFit } from "./autoFit";
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
  settings: Pick<Settings, "loopMode" | "loopVertical" | "autoFit">;
  els: LoopElements;
  /** The memory size model to draw, or null (MemoryController.sizes). */
  sizes(): SizeModel | null;
  /** How to animate the step being drawn (StyleController.animationFor). */
  animation(): PaneAnimation;
  /** Redraw the whole step; `updateMarks` false keeps the editor's marks. */
  redraw(updateMarks: boolean): void;
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

export class LoopController {
  readonly view: Viewport;
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

    this.view = new Viewport(els.loop, {
      label: "Loop history",
      onAutoFitChange: (state) => settings.autoFit("loop").set(JSON.stringify(state)),
    });
    this.view.setAutoFit(storedAutoFit(settings.autoFit("loop")), false);

    els.hideQuiet.addEventListener("change", () => {
      this.hideQuiet = els.hideQuiet.checked;
      options.redraw(true);
    });
    els.loopVertical.checked = this.vertical;
    els.loopVertical.addEventListener("change", () => {
      this.vertical = els.loopVertical.checked;
      settings.loopVertical.set(this.vertical);
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
    this.view.restartAutoFit();
  }

  /** Nothing to show yet. */
  showEmpty(): void {
    this.view.setContent(null);
    this.options.els.loopTabs.replaceChildren();
  }

  /** Draw the loop history and its tabs for the step on screen. */
  render(): void {
    const { trace, stepIndex } = this.options.app.get();
    if (!trace?.steps.length) return;
    const { els } = this.options;
    // Nested loops are drawn together unless one loop is picked (animated
    // mode always shows one: the live state of a single loop).
    const { contexts } = availableLoops(trace, stepIndex);
    const together = this.mode === "stacked" && nestedLoopsAt(trace, stepIndex).length > 0;
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
              "Every loop in this function, together: each pass of an inner loop under the pass of the loop around it",
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
      const live = this.mode === "animated" ? liveRows(trace, stepIndex, history) : undefined;
      const animation = this.options.animation();
      this.view.setContent(
        renderLoopHistory(loopScene(trace, history, { hideQuiet: this.hideQuiet, live, sizes: this.options.sizes() }), {
          vertical: this.vertical,
        }),
        "",
        live ? animation.duration : 0,
        animation.easing,
        animation.enter,
      );
      // As you step, keep the iteration that's running in view.
      const current = els.loop.querySelector(".loop-row.is-current");
      if (current)
        this.view.reveal(Number(current.getAttribute("data-top")), Number(current.getAttribute("data-bottom")));
    } else {
      this.view.setContent(
        null,
        "When your code enters a loop, each iteration is stacked here so you can compare them.",
      );
    }
  }
}
