/**
 * Run to a line: with Run to line on (the code window's header), the
 * gutter beside a line that ran has ◀ and ▶ on the line the pointer's
 * over: the step before this one at that line, and the next one (each
 * dimmed when there's none that way). Ctrl + F10 does the same at the
 * cursor, Ctrl + Shift + F10 back. Like a debugger's breakpoint, but both
 * ways through the recorded run (seek.ts).
 */
import type { RunnableLine } from "../editor";
import type { Settings } from "../settings";
import { type LineSpan, lineSpans, stepAtLine } from "./seek";
import type { AppStore } from "./state";

export interface SeekEditor {
  setRunToLine(on: boolean): void;
  setRunnable(lines: Map<number, RunnableLine> | null): void;
  onGutterClick(handler: (line: number, back: boolean) => void): void;
  showMessage(line: number, text: string): void;
  /** The line the cursor is on. */
  cursorLine(): number | null;
}

export interface SeekOptions {
  app: AppStore;
  settings: Pick<Settings, "runToLine">;
  editor: SeekEditor;
  /** The Run to line switch in the code window's header. */
  toggle: HTMLButtonElement;
  /** Go to a step (PlaybackController.goTo: it pauses playback, and a single step animates). */
  goTo(step: number): void;
  /** The timeline's first step (PlaybackController.firstStep). */
  firstStep(): number;
}

export class SeekController {
  /** Each line's steps, for the trace on screen (null when there's none, or the code changed since it ran). */
  private spans: Map<number, LineSpan> | null = null;

  constructor(private readonly options: SeekOptions) {
    const { app, editor, settings, toggle } = options;
    editor.onGutterClick((line, back) => this.runTo(line, back));
    toggle.addEventListener("click", () => {
      settings.runToLine.set(!settings.runToLine.get());
      this.showOption();
    });
    this.showOption();
    // A new trace, the picture going stale (the code changed), another language: the lines that run change.
    app.watch(
      (s) => s.trace,
      () => this.update(),
    );
    app.watch(
      (s) => s.stale,
      () => this.update(),
    );
    app.watch(
      (s) => s.language,
      () => this.update(),
    );
    // Another step: which lines have a step before it and after it.
    app.watch(
      (s) => s.stepIndex,
      () => this.showArrows(),
    );
  }

  private showOption(): void {
    const on = this.options.settings.runToLine.get();
    this.options.toggle.setAttribute("aria-pressed", String(on));
    this.options.editor.setRunToLine(on);
  }

  /** The lines a step can be run to, for the trace on screen (none when there's no trace, or the code changed since it ran). */
  update(): void {
    const { trace, stale } = this.options.app.get();
    this.spans = trace && !stale ? lineSpans(trace, this.options.firstStep()) : null;
    this.showArrows();
  }

  /** Each line's ◀ and ▶: whether a step at it comes before this one, and after. */
  private showArrows(): void {
    if (!this.spans) {
      this.options.editor.setRunnable(null);
      return;
    }
    const at = this.options.app.get().stepIndex;
    const lines = new Map<number, RunnableLine>();
    for (const [line, span] of this.spans)
      lines.set(line, { back: span.first < at, next: span.last > at, steps: span.steps });
    this.options.editor.setRunnable(lines);
  }

  /** Ctrl + F10 (`back`: with Shift): run to the cursor's line. */
  runToCursor(back: boolean): void {
    const line = this.options.editor.cursorLine();
    if (line === null) return;
    // From the keyboard, a line with no step at it says why (the arrows aren't there to say it).
    const { trace, stale } = this.options.app.get();
    if (!trace?.steps)
      this.options.editor.showMessage(line, "Run the code first: then Ctrl + F10 goes to the step at this line.");
    else if (stale)
      this.options.editor.showMessage(line, "The code changed since it ran: run it again to step to a line.");
    else if (!this.spans?.has(line))
      this.options.editor.showMessage(line, `No recorded step is at line ${line}: it never ran.`);
    else this.runTo(line, back);
  }

  /** Go to the next step at `line` (`back`: the one before this step); nothing when there's none that way. */
  runTo(line: number, back: boolean): void {
    const { trace, stale, stepIndex } = this.options.app.get();
    if (!trace?.steps || stale) return;
    const step = stepAtLine(trace, line, stepIndex, back, this.options.firstStep());
    if (step !== null) this.options.goTo(step);
  }
}
