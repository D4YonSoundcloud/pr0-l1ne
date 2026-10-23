/**
 * Drawing the step on screen: the step label under the timeline, the memory
 * view and loop history, the output printed so far, and the editor's line
 * marks (yellow for the line that ran, blue for the next one, red for the
 * error at the end; for SQL, yellow is the clause the step shows). Called after every move and every run.
 */
import type { LineMarks } from "../editor";
import { compact } from "../trace/measurement";
import type { Step } from "../trace/types";
import type { AppStore } from "./state";

/** What a step did, in words, for the step label. */
export function describe(step: Step, prev: Step | undefined): string {
  const frame = step.stack[step.stack.length - 1];
  const func = frame?.func ?? "Global";
  switch (step.event) {
    case "call":
      return func === "Global" ? "Program starts" : `Called ${func}()`;
    case "line":
      // Matches the editor: yellow is the line that ran, blue is next.
      return prev && prev.line >= 1 && prev.event === "line"
        ? `Ran line ${prev.line}, next is line ${step.line}`
        : `Next is line ${step.line}`;
    case "return": {
      if (func === "Global") return "Program finished";
      const value = step.returnValue;
      const shown = value?.kind === "prim" ? value.repr : "an object";
      return `${func}() returns ${shown}`;
    }
    case "exception":
      return `${step.exception?.type ?? "Error"} raised on line ${step.line}`;
    case "yield": {
      const value = step.returnValue;
      if (!value) return `${func}() hands over to another generator`;
      return `${func}() yields ${value.kind === "prim" ? value.repr : "an object"} and pauses`;
    }
    case "await":
      return `${func}() waits at line ${step.line} and pauses`;
    case "resume":
      return `${func}() resumes at line ${step.line}`;
  }
}

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
}

export class StepView {
  constructor(private readonly options: StepViewOptions) {}

  /** Draw the step on screen. `updateMarks` false leaves the editor's marks alone (they're already right). */
  render(updateMarks = true): void {
    const { app, els, memory, loop, editor } = this.options;
    const { trace, stale, stepIndex } = app.get();
    els.canvas.classList.toggle("is-stale", stale);
    const total = trace?.steps.length ?? 0;
    this.options.updateControls();

    if (!trace || !total) {
      memory.showEmpty();
      loop.showEmpty();
      els.stepLabel.textContent = "";
      els.stepLabel.title = "";
      els.output.textContent = "";
      if (updateMarks) editor.setMarks({ next: null, prev: null, error: null });
      return;
    }

    const step = trace.steps[stepIndex];
    const prev = trace.steps[stepIndex - 1];
    // The label has a fixed width (so the scrubber never resizes); the full
    // text is in its tooltip when it doesn't fit.
    // SQL: the stage's clause (its step shows what the clause did).
    const stage = trace.sql?.stages[stepIndex];
    els.stepLabel.textContent = `Step ${stepIndex + 1} of ${total}: ${stage ? stage.clause : describe(step, prev)}`;
    els.stepLabel.title = els.stepLabel.textContent;
    const skipped = (step.skipped ?? 0) + (stepIndex === trace.steps.length - 1 ? (step.skippedAfter ?? 0) : 0);
    if (skipped) {
      // Passes in the middle of a long loop ran here without being recorded.
      els.stepLabel.textContent += ` (${compact(skipped)} steps skipped)`;
      els.stepLabel.title += `\n${skipped.toLocaleString()} steps ran ${step.skipped ? "just before this one" : "after this one"} without being recorded: the middle of a long, sampled loop.`;
    }

    memory.render();
    loop.render();

    // Output printed so far, plus the error once we reach the end.
    els.output.textContent = trace.stdout.slice(0, step.stdoutLength);
    const atEnd = stepIndex === total - 1;
    if (atEnd && trace.error) {
      const span = document.createElement("span");
      span.className = "error";
      span.textContent = `${trace.error.type}: ${trace.error.message}\n`;
      els.output.append(span);
    }

    if (updateMarks && stage) {
      // A SQL step shows what its clause did: that line is the one that ran.
      editor.setMarks({
        next: null,
        prev: stage.line,
        error:
          atEnd && trace.error
            ? { line: trace.error.line, message: `${trace.error.type}: ${trace.error.message}` }
            : null,
      });
    } else if (updateMarks) {
      const nextLine = step.event === "call" && step.line < 1 ? null : step.line;
      editor.setMarks({
        next: nextLine,
        prev: prev && prev.line >= 1 ? prev.line : null,
        error:
          atEnd && trace.error
            ? { line: trace.error.line, message: `${trace.error.type}: ${trace.error.message}` }
            : null,
      });
    }
  }
}
