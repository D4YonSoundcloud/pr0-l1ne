/**
 * The memory view: the step's variables, objects and scopes (for SQL, the
 * tables at the step's stage of a query: scene/sqlScene.ts), built as a scene
 * (scene/memoryScene.ts) and drawn by the window's renderer (scene/renderer.ts;
 * SVG today, render/svgRenderers.ts). Boxes can be dragged (Reset layout puts
 * them back). Its toolbar picks arrows or nested objects, memory sizes and
 * their model, and whether output is shown on the canvas.
 */

import type { LanguageId } from "../languages";
import { currentLook, type MemoryShow } from "../layout/requests";
import { type LayoutService, LocalLayout } from "../layout/service";
import { timed } from "../perf";
import type { MemoryMode } from "../scene/memoryScene";
import type { MemoryRenderer, RendererFactory } from "../scene/renderer";
import type { Settings } from "../settings";
import { formatBytes, SIZE_MODELS, type SizeModel, stepSizes } from "../trace/memory";
import { isTall, storedAutoFit } from "./autoFit";
import type { AppStore } from "./state";
import type { PaneAnimation } from "./styleController";

export interface MemoryElements {
  memory: HTMLElement;
  modeArrows: HTMLButtonElement;
  modeNested: HTMLButtonElement;
  sizes: HTMLButtonElement;
  sizeModel: HTMLSelectElement;
  showOutput: HTMLButtonElement;
  dimOutput: HTMLButtonElement;
  memoryTotal: HTMLElement;
}

export interface MemoryOptions {
  app: AppStore;
  settings: Pick<
    Settings,
    "memoryMode" | "showOutput" | "dimOutput" | "sizes" | "sizeModel" | "autoFit" | "controlsCollapsed"
  >;
  els: MemoryElements;
  /** How to animate the step being drawn (StyleController.animationFor). */
  animation(): PaneAnimation;
  /** Redraw the whole step (sizes and output also change loop history), keeping the editor's marks. */
  redraw(): void;
  /** What draws the window (main.ts picks: SVG today). */
  renderers: Pick<RendererFactory, "memory">;
  /** Where the step is laid out (the layout worker); absent, on the page, from the page's trace (tests). */
  layout?: LayoutService;
}

/** Python has its own real sizes; JavaScript and TypeScript share theirs. */
const sizeFamily = (id: LanguageId) => (id === "python" ? "python" : "javascript");

export class MemoryController {
  readonly renderer: MemoryRenderer;
  private readonly layout: LayoutService;
  /** The window's channel to the layout: its kept boxes. */
  private readonly channel: number;
  /** What the window last asked to show (to lay it out again in full, to save it). */
  private shown: MemoryShow | null = null;
  /** The step asked for last, drawn (or not, when another replaced it). */
  private drawing: Promise<void> = Promise.resolve();
  /** Arrows, or objects drawn inside the thing that refers to them. */
  private mode: MemoryMode;
  private sizesOn: boolean;
  /** On a step that prints, show the output on the canvas... */
  private outputOn: boolean;
  /** ...and dim everything else while it's shown. */
  private dimForOutput: boolean;
  private readonly resetButton: HTMLButtonElement;
  /** Summaries the person opened, by key (scene/summaries.ts): drawn in full, step after step. */
  private readonly expanded = new Set<string>();

  constructor(private readonly options: MemoryOptions) {
    const { els, settings } = options;
    this.mode = settings.memoryMode.get();
    this.sizesOn = settings.sizes.get();
    this.outputOn = settings.showOutput.get();
    this.dimForOutput = settings.dimOutput.get();

    this.layout = options.layout ?? new LocalLayout({}, () => options.app.get().trace);
    this.channel = this.layout.channel();
    this.renderer = options.renderers.memory(els.memory, {
      fullDrawing: () => {
        const shown = this.shown;
        if (!shown) return Promise.resolve(null);
        return this.layout
          .memory(this.channel, shown, { ...this.renderer.layoutView(), full: true })
          .then((laidOut) => laidOut?.drawing ?? null);
      },
      onLayoutChange: () => {
        this.render();
        this.updateResetButton();
      },
      // A summary clicked: what it stands for, drawn in full from now on (until Reset layout).
      onExpand: (key) => {
        this.expanded.add(key);
        this.render();
        this.updateResetButton();
      },
      onAutoFitChange: (state) => settings.autoFit("memory").set(JSON.stringify(state)),
      controls: settings.controlsCollapsed("memory"),
    });
    this.renderer.setViewport({ autoFit: storedAutoFit(settings.autoFit("memory")) });
    this.resetButton = this.renderer.addControl(
      "Reset layout",
      "Put every box back in its automatic position, and summarize what you opened again",
      () => {
        this.renderer.resetLayout();
        this.expanded.clear();
        this.render();
        this.updateResetButton();
      },
    );
    this.updateResetButton();

    els.modeArrows.addEventListener("click", () => this.setMode("arrows"));
    els.modeNested.addEventListener("click", () => this.setMode("nested"));
    els.sizes.addEventListener("click", () => this.setSizes(!this.sizesOn));
    els.showOutput.addEventListener("click", () => {
      this.outputOn = !this.outputOn;
      settings.showOutput.set(this.outputOn);
      this.updateButtons();
      options.redraw();
    });
    els.dimOutput.addEventListener("click", () => {
      this.dimForOutput = !this.dimForOutput;
      settings.dimOutput.set(this.dimForOutput);
      this.updateButtons();
      options.redraw();
    });
    els.sizeModel.addEventListener("change", () => {
      settings.sizeModel(this.family).set(els.sizeModel.value);
      options.redraw();
    });
    this.fillSizeModels();
    this.updateButtons();
    // Another language: its own size models, and a fresh picture.
    options.app.watch(
      (s) => s.language,
      () => {
        this.fillSizeModels();
        this.reset();
      },
    );
  }

  private get family() {
    return sizeFamily(this.options.app.get().language);
  }

  private sizeModel(): SizeModel {
    const choices = SIZE_MODELS[this.family];
    const saved = this.options.settings.sizeModel(this.family).get();
    return choices.find((c) => c.value === saved)?.value ?? choices[0].value;
  }

  /** The model to draw sizes with, or null when sizes are off (loop history uses it too). */
  sizes(): SizeModel | null {
    return this.sizesOn ? this.sizeModel() : null;
  }

  setMode(mode: MemoryMode): void {
    this.mode = mode;
    this.options.settings.memoryMode.set(mode);
    this.updateButtons();
    this.render();
  }

  toggleNested(): void {
    this.setMode(this.mode === "nested" ? "arrows" : "nested");
  }

  setSizes(on: boolean): void {
    this.sizesOn = on;
    this.options.settings.sizes.set(on);
    this.updateButtons();
    this.options.redraw();
  }

  private updateButtons(): void {
    const { els } = this.options;
    els.modeArrows.setAttribute("aria-pressed", String(this.mode === "arrows"));
    els.modeNested.setAttribute("aria-pressed", String(this.mode === "nested"));
    els.sizes.setAttribute("aria-pressed", String(this.sizesOn));
    els.sizeModel.hidden = !this.sizesOn;
    els.showOutput.setAttribute("aria-pressed", String(this.outputOn));
    els.dimOutput.setAttribute("aria-pressed", String(this.dimForOutput));
    els.dimOutput.disabled = !this.outputOn;
  }

  private fillSizeModels(): void {
    const { sizeModel } = this.options.els;
    sizeModel.replaceChildren(
      ...SIZE_MODELS[this.family].map((c) => {
        const option = new Option(c.label, c.value);
        option.title = c.title;
        return option;
      }),
    );
    sizeModel.value = this.sizeModel();
  }

  /** A different program (or language): forget dragged boxes, and fit it afresh. */
  reset(): void {
    this.renderer.resetLayout();
    this.expanded.clear();
    this.updateResetButton();
    this.renderer.setViewport({ refit: true });
  }

  private updateResetButton(): void {
    this.resetButton.hidden = !this.renderer.hasMovedBoxes && !this.expanded.size;
  }

  /** Nothing to show yet. */
  showEmpty(): void {
    this.shown = null;
    this.drawing = Promise.resolve();
    this.renderer.showMessage("Write some code and press Run. Variables, objects and scopes appear here.");
    this.updateTotal();
  }

  /** Draw the step on screen: laid out by the layout (the layout worker), then shown. */
  render(): void {
    const { trace, stepIndex } = this.options.app.get();
    if (!trace?.steps.length) return;
    const show: MemoryShow = {
      look: currentLook(),
      step: stepIndex,
      mode: this.mode,
      sizes: this.sizes(),
      output: this.outputOn,
      dimForOutput: this.dimForOutput,
      tall: isTall(this.options.els.memory),
      expanded: [...this.expanded],
    };
    this.shown = show;
    // How this step animates in, as it is now (the next may be asked for before this one's back).
    const animation = this.options.animation();
    const asked = ++this.asked;
    this.options.els.memory.dataset.drawing = "pending";
    this.drawing = this.layout
      .memory(this.channel, show, this.renderer.layoutView())
      .then((laidOut) => {
        // Replaced by a newer step, or the trace changed meanwhile.
        if (!laidOut || this.options.app.get().trace !== trace) return;
        this.renderer.setAppearance({ step: animation });
        timed("memory.render", () => this.renderer.show(laidOut));
        this.updateTotal();
      })
      .catch((error: unknown) => console.error("Memory window:", error))
      .finally(() => {
        // Caught up: what's on screen is the last step asked for (tests wait for it).
        if (asked === this.asked) this.options.els.memory.dataset.drawing = "done";
      });
  }

  /** Requests made, to tell the last one. */
  private asked = 0;

  /** Resolves once the step asked for last is drawn (or replaced). */
  drawn(): Promise<void> {
    return this.drawing;
  }

  /** "Program: 1.4 KB" in the memory header, for the step on screen. */
  private updateTotal(): void {
    const { memoryTotal } = this.options.els;
    const { trace, stepIndex } = this.options.app.get();
    const model = this.sizes();
    const step = trace?.sql ? undefined : trace?.steps[stepIndex];
    memoryTotal.hidden = !model || !step;
    if (!model || !step) return;
    const sizes = stepSizes(step, model);
    memoryTotal.textContent = `Program: ${formatBytes(sizes.program, sizes.approximate)}`;
    memoryTotal.title = "Everything the program holds at this step, each object counted once";
  }
}
