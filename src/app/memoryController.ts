/**
 * The memory view: the step's variables, objects and scopes, built as a scene
 * (scene/memoryScene.ts) and drawn by the window's renderer (scene/renderer.ts;
 * SVG today, render/svgRenderers.ts). Boxes can be dragged (Reset layout puts
 * them back). Its toolbar picks arrows or nested objects, memory sizes and
 * their model, and whether output is shown on the canvas.
 */
import type { LanguageId } from "../languages";
import { type MemoryMode, type MemoryScene, memoryScene } from "../scene/memoryScene";
import type { MemoryRenderer, RendererFactory } from "../scene/renderer";
import type { Settings } from "../settings";
import { diffSteps } from "../trace/diff";
import { formatBytes, SIZE_MODELS, type SizeModel, stepSizes } from "../trace/memory";
import { storedAutoFit } from "./autoFit";
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
  settings: Pick<Settings, "memoryMode" | "showOutput" | "dimOutput" | "sizes" | "sizeModel" | "autoFit">;
  els: MemoryElements;
  /** How to animate the step being drawn (StyleController.animationFor). */
  animation(): PaneAnimation;
  /** Redraw the whole step (sizes and output also change loop history), keeping the editor's marks. */
  redraw(): void;
  /** What draws the window (main.ts picks: SVG today). */
  renderers: Pick<RendererFactory, "memory">;
}

/** Python has its own real sizes; JavaScript and TypeScript share theirs. */
const sizeFamily = (id: LanguageId) => (id === "python" ? "python" : "javascript");

export class MemoryController {
  readonly renderer: MemoryRenderer;
  /** The scene last drawn, for the renderer to animate from. */
  private drawn: MemoryScene | null = null;
  /** Arrows, or objects drawn inside the thing that refers to them. */
  private mode: MemoryMode;
  private sizesOn: boolean;
  /** On a step that prints, show the output on the canvas... */
  private outputOn: boolean;
  /** ...and dim everything else while it's shown. */
  private dimForOutput: boolean;
  private readonly resetButton: HTMLButtonElement;

  constructor(private readonly options: MemoryOptions) {
    const { els, settings } = options;
    this.mode = settings.memoryMode.get();
    this.sizesOn = settings.sizes.get();
    this.outputOn = settings.showOutput.get();
    this.dimForOutput = settings.dimOutput.get();

    this.renderer = options.renderers.memory(els.memory, {
      onLayoutChange: () => {
        this.render();
        this.updateResetButton();
      },
      onAutoFitChange: (state) => settings.autoFit("memory").set(JSON.stringify(state)),
    });
    this.renderer.setViewport({ autoFit: storedAutoFit(settings.autoFit("memory")) });
    this.resetButton = this.renderer.addControl("Reset layout", "Put every box back in its automatic position", () => {
      this.renderer.resetLayout();
      this.render();
      this.updateResetButton();
    });
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
    this.updateResetButton();
    this.renderer.setViewport({ refit: true });
  }

  private updateResetButton(): void {
    this.resetButton.hidden = !this.renderer.hasMovedBoxes;
  }

  /** Nothing to show yet. */
  showEmpty(): void {
    this.drawn = null;
    this.renderer.showMessage("Write some code and press Run. Variables, objects and scopes appear here.");
    this.updateTotal();
  }

  /** Draw the step on screen. */
  render(): void {
    const { trace, stepIndex } = this.options.app.get();
    if (!trace?.steps.length) return;
    const diff = diffSteps(trace.steps[stepIndex - 1], trace.steps[stepIndex]);
    const scene = memoryScene(trace, stepIndex, diff, {
      mode: this.mode,
      sizes: this.sizes(),
      output: this.outputOn,
      dimForOutput: this.dimForOutput,
    });
    this.renderer.setAppearance({ step: this.options.animation() });
    this.renderer.render(scene, this.drawn);
    this.drawn = scene;
    this.updateTotal();
  }

  /** "Program: 1.4 KB" in the memory header, for the step on screen. */
  private updateTotal(): void {
    const { memoryTotal } = this.options.els;
    const { trace, stepIndex } = this.options.app.get();
    const model = this.sizes();
    const step = trace?.steps[stepIndex];
    memoryTotal.hidden = !model || !step;
    if (!model || !step) return;
    const sizes = stepSizes(step, model);
    memoryTotal.textContent = `Program: ${formatBytes(sizes.program, sizes.approximate)}`;
    memoryTotal.title = "Everything the program holds at this step, each object counted once";
  }
}
