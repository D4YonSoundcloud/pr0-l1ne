/**
 * The complexity estimate (trace/complexity.ts): the chip and panel
 * (complexityPanel.ts), and the cost labels beside loops and functions in
 * the editor. The layout works out the estimate with each trace
 * (trace/summary.ts); with Measure's counts for the same code, it's asked
 * again (the layout holds the trace).
 */
import { ComplexityPanel, type CostLabel, costLabels } from "../complexityPanel";
import type { Settings } from "../settings";
import type { Estimate } from "../trace/complexity";
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
  /** The estimate for the trace on screen with Measure's counts (LayoutService.estimate). */
  estimate(measurement: Measurement): Promise<Estimate | null>;
  /** The panel opened: close the other panels. */
  onOpen(): void;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export class ComplexityController {
  readonly panel: ComplexityPanel;
  private labelsOn: boolean;
  private timer = 0;
  /** The estimate shown now (Measure's panel shows it too). */
  latest: Estimate | null = null;
  /** Updates asked for, to drop an answer a newer one replaced. */
  private asked = 0;
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

  /**
   * Show the estimate for the trace on screen (Measure calls this with new
   * counts); resolves once it's shown.
   */
  update(): Promise<void> {
    this.clearTimer(this.timer);
    const asked = ++this.asked;
    return new Promise((resolve) => {
      this.timer = this.setTimer(() => void this.show(asked).finally(resolve), 0);
    });
  }

  private async show(asked: number): Promise<void> {
    const { trace, stale } = this.options.app.get();
    // A trace cut short uses Measure's full counts for the same code, if there are any.
    const measurement = trace && !stale ? this.options.measurement() : null;
    let estimate: Estimate | null = trace?.estimate ?? null;
    if (trace && measurement) {
      try {
        estimate = await this.options.estimate(measurement);
      } catch (error) {
        console.warn("Complexity estimate failed", error);
      }
    }
    if (asked !== this.asked) return;
    this.latest = estimate;
    this.panel.show(estimate, stale);
    // Labels sit on lines; once the code has changed under an error, they'd be on the wrong ones.
    this.options.editor.setCostLabels(this.labelsOn && !stale ? costLabels(estimate) : []);
  }
}
