/**
 * Drawing the step on screen: the step label under the timeline, the memory
 * view and loop history, the output printed so far, and the editor's line
 * marks (yellow for the line that ran, blue for the next one, red for the
 * error at the end; for SQL, yellow is the clause the step shows). Called after every move and every run.
 */
import type { LineMarks } from "../editor";
import { compact } from "../trace/measurement";
import type { AppStore } from "./state";

// The step label's words are worked out with the trace (trace/summary.ts); here for its tests.
export { describe } from "../trace/describe";

/** A window on the canvas (MemoryController, LoopController). */
export interface CanvasPane {
  render(): void;
  showEmpty(): void;
}

export interface StepViewOptions {
  app: AppStore;
  els: { canvas: HTMLElement; stepLabel: HTMLElement; output: HTMLElement };
  memory: CanvasPane;
  loop: CanvasPane;
  /** Update the timeline's buttons and scrubber (PlaybackController.updateControls). */
  updateControls(): void;
  editor: { setMarks(marks: LineMarks): void };
  /** What changed at the step, under the code (changesView.ts). */
  changes?: { render(): void };
}

export class StepView {
  constructor(private readonly options: StepViewOptions) {}

  /** Draw the step on screen. `updateMarks` false leaves the editor's marks alone (they're already right). */
  render(updateMarks = true): void {
    const { app, els, memory, loop, editor } = this.options;
    const { trace, stale, stepIndex } = app.get();
    els.canvas.classList.toggle("is-stale", stale);
    const total = trace?.steps ?? 0;
    this.options.updateControls();

    if (!trace || !total) {
      memory.showEmpty();
      loop.showEmpty();
      els.stepLabel.textContent = "";
      els.stepLabel.title = "";
      els.output.textContent = "";
      if (updateMarks) editor.setMarks({ next: null, prev: null, error: null });
      this.options.changes?.render();
      return;
    }

    const line = trace.lines[stepIndex];
    const prevLine = stepIndex > 0 ? trace.lines[stepIndex - 1] : undefined;
    // The label has a fixed width (so the scrubber never resizes); the full
    // text is in its tooltip when it doesn't fit.
    // SQL: the stage's clause (its step shows what the clause did).
    const stage = trace.stages?.[stepIndex];
    els.stepLabel.textContent = `Step ${stepIndex + 1} of ${total}: ${stage ? stage.clause : trace.labels[stepIndex]}`;
    els.stepLabel.title = els.stepLabel.textContent;
    const before = trace.skipped[stepIndex];
    const skipped = before + (stepIndex === total - 1 ? trace.skippedAfter : 0);
    if (skipped) {
      // Passes in the middle of a long loop ran here without being recorded.
      els.stepLabel.textContent += ` (${compact(skipped)} steps skipped)`;
      els.stepLabel.title += `\n${skipped.toLocaleString()} steps ran ${before ? "just before this one" : "after this one"} without being recorded: the middle of a long, sampled loop.`;
    }

    memory.render();
    loop.render();
    this.options.changes?.render();

    // Output printed so far, plus the error once we reach the end.
    els.output.textContent = trace.stdout.slice(0, trace.stdoutLengths[stepIndex]);
    const atEnd = stepIndex === total - 1;
    if (atEnd && trace.error) {
      const span = document.createElement("span");
      span.className = "error";
      span.textContent = `${trace.error.type}: ${trace.error.message}\n`;
      els.output.append(span);
    }
    const error =
      atEnd && trace.error ? { line: trace.error.line, message: `${trace.error.type}: ${trace.error.message}` } : null;

    if (updateMarks && stage) {
      // A SQL step shows what its clause did: that line is the one that ran.
      editor.setMarks({ next: null, prev: stage.line, error });
    } else if (updateMarks) {
      const nextLine = trace.events[stepIndex] === "call" && line < 1 ? null : line;
      editor.setMarks({ next: nextLine, prev: prevLine !== undefined && prevLine >= 1 ? prevLine : null, error });
    }
  }
}
