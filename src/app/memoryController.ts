/**
 * The memory view: the step's variables, objects and scopes (render/memory.ts)
 * in a pannable, zoomable window (render/viewport.ts). Boxes can be dragged
 * (Reset layout puts them back); hovering one highlights its arrows. Its
 * toolbar picks arrows or nested objects, memory sizes and their model, and
 * whether output is shown on the canvas.
 */
import type { LanguageId } from "../languages";
import { applyFocus, type MemoryMode, type Point, renderMemory } from "../render/memory";
import { Viewport } from "../render/viewport";
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
}

/** Python has its own real sizes; JavaScript and TypeScript share theirs. */
const sizeFamily = (id: LanguageId) => (id === "python" ? "python" : "javascript");

export class MemoryController {
  readonly view: Viewport;
  /** Where the person has dragged boxes, by node key. */
  private readonly positions = new Map<string, Point>();
  private dragging: string | null = null;
  private hovered: string | null = null;
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

    this.view = new Viewport(els.memory, {
      label: "Memory diagram",
      onNodeMove: (key, position, done) => {
        this.positions.set(key, position);
        this.dragging = done ? null : key;
        this.render();
        this.updateResetButton();
      },
      onAutoFitChange: (state) => settings.autoFit("memory").set(JSON.stringify(state)),
    });
    this.view.setAutoFit(storedAutoFit(settings.autoFit("memory")), false);
    this.resetButton = this.view.addControl("Reset layout", "Put every box back in its automatic position", () => {
      this.positions.clear();
      this.render();
      this.updateResetButton();
    });
    this.updateResetButton();

    // Hovering a box (or dragging it) highlights its arrows and the boxes they
    // connect to. The SVG is redrawn on every step, so the focus is re-applied.
    els.memory.addEventListener("pointerover", (event) => {
      const key = (event.target as Element).closest<SVGGElement>(".node")?.dataset.nodeKey ?? null;
      if (key === this.hovered) return;
      this.hovered = key;
      this.refreshFocus();
    });
    els.memory.addEventListener("pointerleave", () => {
      this.hovered = null;
      this.refreshFocus();
    });

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
    this.positions.clear();
    this.updateResetButton();
    this.view.restartAutoFit();
  }

  private updateResetButton(): void {
    this.resetButton.hidden = this.positions.size === 0;
  }

  private refreshFocus(): void {
    applyFocus(this.options.els.memory.querySelector<SVGSVGElement>(".memory-svg"), this.dragging ?? this.hovered);
  }

  /** Nothing to show yet. */
  showEmpty(): void {
    this.view.setContent(null, "Write some code and press Run. Variables, objects and scopes appear here.");
    this.updateTotal();
  }

  /** Draw the step on screen. */
  render(): void {
    const { trace, stepIndex } = this.options.app.get();
    if (!trace?.steps.length) return;
    const diff = diffSteps(trace.steps[stepIndex - 1], trace.steps[stepIndex]);
    const animation = this.options.animation();
    this.view.setContent(
      renderMemory(trace, stepIndex, diff, {
        positions: this.positions,
        raise: this.dragging,
        mode: this.mode,
        sizes: this.sizes(),
        output: this.outputOn,
        dimForOutput: this.dimForOutput,
      }),
      "",
      animation.duration,
      animation.easing,
      animation.enter,
    );
    this.updateTotal();
    this.refreshFocus();
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
