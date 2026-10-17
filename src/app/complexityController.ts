/**
 * The complexity estimate (trace/complexity.ts): the chip and panel
 * (complexityPanel.ts), and the cost labels beside loops and functions in
 * the editor. The estimate is worked out once per run (it's cached on the
 * trace), after the step is drawn so it never delays the canvas.
 */
import { ComplexityPanel, type CostLabel, costLabels } from "../complexityPanel";
import type { Settings } from "../settings";
import { estimateComplexity } from "../trace/complexity";
import type { Measurement } from "../trace/measurement";
import type { AppStore } from "./state";

export interface ComplexityOptions {
  app: AppStore;
  settings: Pick<Settings, "complexityLabels">;
  /** The panel goes in the editor pane; the chip opens it. */
  els: { editorPane: HTMLElement; complexity: HTMLButtonElement };
  editor: { revealLine(line: number): void; setCostLabels(labels: CostLabel[]): void };
  /** Measure's counts for the code on screen, if any: a trace cut short uses them. */
  measurement(): Measurement | null;
  /** The panel opened: close the other panels. */
  onOpen(): void;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export class ComplexityController {
  readonly panel: ComplexityPanel;
  private labelsOn: boolean;
  private timer = 0;
  private readonly setTimer: (callback: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  constructor(private readonly options: ComplexityOptions) {
    this.setTimer = options.setTimeout ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => window.clearTimeout(id));
    this.labelsOn = options.settings.complexityLabels.get();
    this.panel = new ComplexityPanel({
      host: options.els.editorPane,
      button: options.els.complexity,
      reveal: (line) => options.editor.revealLine(line),
      labelsShown: () => this.labelsOn,
      setLabelsShown: (on) => {
        this.labelsOn = on;
        options.settings.complexityLabels.set(on);
        this.update();
      },
      onOpen: () => options.onOpen(),
    });
    // A new trace (or none), or the picture going stale: a new estimate.
    options.app.watch(
      (s) => s.trace,
      () => this.update(),
    );
    options.app.watch(
      (s) => s.stale,
      () => this.update(),
    );
  }

  close(): void {
    this.panel.toggle(false);
  }

  /** Work out the estimate for the trace on screen, once the current step has been drawn (Measure calls this with new counts). */
  update(): void {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      const { trace, stale } = this.options.app.get();
      let estimate = null;
      try {
        // A trace cut short uses Measure's full counts for the same code, if there are any.
        estimate = trace ? estimateComplexity(trace, stale ? null : this.options.measurement()) : null;
      } catch (error) {
        console.warn("Complexity estimate failed", error);
      }
      this.panel.show(estimate, stale);
      // Labels sit on lines; once the code has changed under an error, they'd be on the wrong ones.
      this.options.editor.setCostLabels(this.labelsOn && !stale ? costLabels(estimate) : []);
    }, 0);
  }
}
