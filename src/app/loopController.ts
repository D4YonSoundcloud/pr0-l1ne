/**
 * Loop history: each pass of the loop that's running, one row per pass (for
 * SQL, the statement's stages: scene/sqlScene.ts), built
 * as a scene (scene/loopScene.ts) and drawn by the window's renderer
 * (scene/renderer.ts; SVG today, render/svgRenderers.ts). Tabs pick which loop
 * when there are several (or all of a function's nested loops together).
 * Its toolbar picks stacked rows or one animated row, hiding variables that
 * don't change, and stacking containers vertically.
 */
import { currentLook, type LoopShow, type LoopTab } from "../layout/requests";
import type { LayoutService } from "../layout/service";
import { timed } from "../perf";
import type { LoopRenderer, RendererFactory } from "../scene/renderer";
import type { Settings } from "../settings";
import type { SizeModel } from "../trace/memory";
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
  /** Where the step is laid out (the layout worker, which holds the trace). */
  layout: LayoutService;
}

// Moved to scene/liveRows.ts (the layout worker uses them); here for what imported them from here.
export { liveNestedRows, liveRows } from "../scene/liveRows";

export class LoopController {
  readonly renderer: LoopRenderer;
  private readonly layout: LayoutService;
  /** The window's channel to the layout: its kept rows. */
  private readonly channel: number;
  /** What the window last asked to show, and the rows it drew (to lay it out again in full, to save it). */
  private shown: LoopShow | null = null;
  private visible: { top: number; bottom: number } | undefined;
  /** The step asked for last, drawn (or not, when another replaced it). */
  private drawing: Promise<void> = Promise.resolve();
  /** The loop picked in the tabs (ALL_LOOPS: nested loops together), or null for the innermost running. */
  private selected: string | null = null;
  private hideQuiet: boolean;
  /** Containers one above another instead of side by side. */
  private vertical: boolean;
  private mode: LoopMode;
  /** Folds the person opened, by key (scene/loopSummaries.ts): drawn in full, step after step. */
  private readonly expanded = new Set<string>();
  private readonly foldButton: HTMLButtonElement;

  constructor(private readonly options: LoopOptions) {
    const { els, settings } = options;
    this.hideQuiet = els.hideQuiet.checked;
    this.vertical = settings.loopVertical.get();
    this.mode = settings.loopMode.get();

    this.layout = options.layout;
    this.channel = this.layout.channel();
    this.renderer = options.renderers.loop(els.loop, {
      // The same step for the view now (zoomed in past its detail, scrolled past the rows drawn).
      onRedraw: () => this.render(false),
      fullDrawing: () => {
        const shown = this.shown;
        if (!shown) return Promise.resolve(null);
        const view = this.renderer.layoutView();
        return this.layout
          .loop(this.channel, shown, { ...view, visible: this.visible, full: true })
          .then((laidOut) => laidOut?.drawing ?? null);
      },
      onAutoFitChange: (state) => settings.autoFit("loop").set(JSON.stringify(state)),
      controls: settings.controlsCollapsed("loop"),
      // The zoom settled where the cell budget differs: fold the history again.
      onLayoutChange: () => this.render(),
      // A fold (or a graph's cluster) clicked: drawn in full from now on (until Fold again, or another program).
      onExpand: (key) => {
        this.expanded.add(key);
        this.render();
        this.updateFoldButton();
      },
    });
    this.foldButton = this.renderer.addControl(
      "Fold again",
      "Fold the passes you opened, far from the one running, and the graph clusters you opened, again",
      () => {
        this.expanded.clear();
        this.render();
        this.updateFoldButton();
      },
    );
    this.updateFoldButton();
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

  /** A different program (or language): back to the loop that's running, fitted afresh, everything folded. */
  reset(): void {
    this.selected = null;
    this.expanded.clear();
    this.updateFoldButton();
    this.renderer.setViewport({ refit: true });
  }

  private updateFoldButton(): void {
    this.foldButton.hidden = !this.expanded.size;
  }

  /** Nothing to show yet. */
  showEmpty(): void {
    this.shown = null;
    this.drawing = Promise.resolve();
    this.renderer.showMessage("");
    this.options.els.loopTabs.replaceChildren();
  }

  /**
   * Draw the loop history and its tabs for the step on screen, laid out by
   * the layout (the layout worker). `step` false: the same step again, for
   * the view now (nothing animates, the running row isn't brought into view).
   */
  render(step = true): void {
    const { trace, stepIndex } = this.options.app.get();
    if (!trace?.steps) return;
    const show: LoopShow = {
      look: currentLook(),
      step: stepIndex,
      selected: this.selected,
      mode: this.mode,
      hideQuiet: this.hideQuiet,
      sizes: this.options.sizes(),
      tall: isTall(this.options.els.loop),
      expanded: [...this.expanded],
    };
    this.shown = show;
    const animation = this.options.animation();
    const asked = ++this.asked;
    this.options.els.loop.dataset.drawing = "pending";
    this.drawing = this.layout
      .loop(this.channel, show, this.renderer.layoutView())
      .then((laidOut) => {
        // Replaced by a newer request: the one that replaced it is shown as a step, if this was.
        if (!laidOut) {
          if (step) this.stepReplaced = Math.max(this.stepReplaced, asked);
          return;
        }
        // The trace changed meanwhile.
        if (this.options.app.get().trace !== trace) return;
        // A step replaced by this request (asked after it) is shown as one.
        const replaced = this.stepReplaced > 0 && asked > this.stepReplaced;
        const asStep = step || replaced;
        if (replaced) this.stepReplaced = 0;
        this.visible = laidOut.visible;
        this.showTabs(laidOut.tabs);
        this.renderer.setAppearance({ step: animation });
        timed("loop.render", () => this.renderer.show(laidOut, asStep));
        if (asked === this.asked) this.layAhead(show, trace.steps);
      })
      .catch((error: unknown) => console.error("Loop history:", error))
      .finally(() => {
        // Caught up: what's on screen is the last step asked for (tests wait for it).
        if (asked === this.asked) this.options.els.loop.dataset.drawing = "done";
      });
  }

  /** Requests made, to tell the last one. */
  private asked = 0;

  /** Playing: the next step, laid out while this one's on screen (LayoutService.ahead). */
  private layAhead(show: LoopShow, steps: number): void {
    const { playing, stepIndex } = this.options.app.get();
    if (!playing || show.step !== stepIndex || stepIndex + 1 >= steps) return;
    this.layout.ahead(this.channel, {
      kind: "loop",
      show: { ...show, step: stepIndex + 1 },
      view: this.renderer.layoutView(),
    });
  }

  /** Resolves once the step asked for last is drawn (or replaced). */
  drawn(): Promise<void> {
    return this.drawing;
  }

  /**
   * A step's request replaced before it was laid out (by a redraw for the
   * view), by its number: the request that replaced it is shown as the step.
   */
  private stepReplaced = 0;

  /** The tabs over the history: each loop running here, and all of them together. */
  private showTabs(tabs: LoopTab[]): void {
    this.options.els.loopTabs.replaceChildren(
      ...tabs.map(({ text, selected, pick, title }) => {
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
      }),
    );
  }
}
