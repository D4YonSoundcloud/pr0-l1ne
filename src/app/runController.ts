/**
 * Running code: one runner (web worker) per language, started the first time
 * it's needed; the time budgets for Live runs and Run; queuing edits that
 * arrive while a run is going; dropping results for a language the person
 * has left; the status text; and turning each outcome into the app state,
 * the banner and the editor's error marks.
 *
 * Measure uses the same runners (`runnerFor`), waits for a run to finish
 * before starting (`whenIdle`), and hands back queued edits when it's done
 * (`resumeQueued`).
 */
import { LANGUAGES, type LanguageId } from "../languages";
import { applyHints } from "../trace/hints";
import type { Trace } from "../trace/types";
import { Runner, type RunnerStatus, type RunOutcome } from "../worker/runner";
import { escapeHtml } from "./html";
import { firstStepFor } from "./playbackController";
import type { AppStore } from "./state";

/** Steps recorded at most per trace. */
export const MAX_STEPS = 20_000;
/**
 * How long tracing may take: short while typing (Live), so the page keeps
 * up; longer for Run. Long loops are sampled, so a big input runs until
 * one of these instead of the step budget.
 */
export const LIVE_SECONDS = 1.5;
export const RUN_SECONDS = 6;
/** How long typing must pause before a Live run. */
export const LIVE_DELAY_MS = 600;

export type Budget = "live" | "run";

/** The part of a Runner this controller uses (tests pass a fake). */
export type RunnerLike = Pick<Runner, "run" | "status" | "measure" | "stopMeasure">;

export interface RunEditor {
  /** Show an error under a line (null clears the marks). */
  setMarks(marks: {
    next: number | null;
    prev: number | null;
    error: { line: number | null; message: string } | null;
  }): void;
  setHintWarnings(warnings: { line: number; message: string }[]): void;
}

export interface RunOptions {
  app: AppStore;
  /** The status text in the toolbar. */
  status: HTMLElement;
  editor: RunEditor;
  setBanner(html: string | null): void;
  /** A run produced something to show: draw it. `updateMarks` is false when the editor's marks are already set. */
  onResult(updateMarks: boolean): void;
  /** Make a language's runner. */
  createRunner?(language: LanguageId, onStatus: (status: RunnerStatus) => void): RunnerLike;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

interface Queued {
  code: string;
  language: LanguageId;
  budget: Budget;
}

export class RunController {
  private readonly runners = new Map<LanguageId, RunnerLike>();
  private inFlight = false;
  private queued: Queued | null = null;
  private lastBudget: Budget = "run";
  private liveTimer = 0;
  private readonly createRunner: NonNullable<RunOptions["createRunner"]>;
  private readonly setTimer: (callback: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  constructor(private readonly options: RunOptions) {
    this.createRunner =
      options.createRunner ?? ((language, onStatus) => new Runner(LANGUAGES[language].createWorker, onStatus));
    this.setTimer = options.setTimeout ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => window.clearTimeout(id));
    // A Live run waiting for the old language's code shouldn't run; the status is the new language's runner's.
    options.app.watch(
      (s) => s.language,
      () => {
        this.cancelLive();
        this.refreshStatus();
      },
    );
  }

  private get language(): LanguageId {
    return this.options.app.get().language;
  }

  /** Measure is using the runner: runs wait until it's done. */
  private get busy(): boolean {
    return this.options.app.get().measuring;
  }

  /** A language's runner, started the first time it's needed (so people writing JavaScript never download Python). */
  runnerFor(language: LanguageId): RunnerLike {
    let runner = this.runners.get(language);
    if (!runner) {
      runner = this.createRunner(language, (status) => {
        if (language === this.language) this.showStatus(status);
      });
      this.runners.set(language, runner);
    }
    return runner;
  }

  /** Show the current language's runner status (after switching language, or after Measure). */
  refreshStatus(): void {
    this.showStatus(this.runnerFor(this.language).status);
  }

  showStatus(status: RunnerStatus): void {
    const el = this.options.status;
    const python = this.language === "python";
    el.classList.toggle("is-error", status.kind === "failed");
    el.title =
      status.kind === "loading" && python
        ? "Python runs right here in your browser. It downloads once (about 6 MB); after that your browser keeps a copy."
        : status.kind === "failed"
          ? status.message // a long error may be cut short on screen
          : "";
    switch (status.kind) {
      case "loading":
        el.textContent = python ? "Downloading Python (6 MB)…" : `Loading ${LANGUAGES[this.language].label}…`;
        break;
      case "running":
        el.textContent = "Running…";
        break;
      case "ready":
        el.textContent = status.label;
        break;
      case "failed":
        el.textContent = status.message;
        break;
    }
  }

  /** Run now (the Run button, Ctrl + '), with Run's longer time budget. */
  runNow(code: string): void {
    this.cancelLive(); // don't run the same code twice
    void this.run(code, this.language, "run");
  }

  /** Run after typing pauses (Live), with Live's short time budget. */
  scheduleLive(code: string): void {
    this.cancelLive();
    const language = this.language;
    this.liveTimer = this.setTimer(() => void this.run(code, language, "live"), LIVE_DELAY_MS);
  }

  cancelLive(): void {
    this.clearTimer(this.liveTimer);
  }

  /** Trace `code`. While another run (or Measure) is going, only the newest request waits. */
  async run(code: string, language: LanguageId, budget: Budget): Promise<void> {
    if (this.inFlight || this.busy) {
      this.queued = { code, language, budget };
      return;
    }
    this.inFlight = true;
    const outcome = await this.runnerFor(language).run(code, MAX_STEPS, budget === "live" ? LIVE_SECONDS : RUN_SECONDS);
    this.lastBudget = budget;
    this.inFlight = false;
    // Ignore results for a language the person has switched away from.
    if (language === this.language) this.apply(outcome, code);
    this.resumeQueued();
  }

  /** Start the run that was waiting, if any (Measure calls this when it finishes). */
  resumeQueued(): void {
    if (this.queued === null || this.busy) return;
    const next = this.queued;
    this.queued = null;
    void this.run(next.code, next.language, next.budget);
  }

  /** Resolves once no run is going (Measure starts right after a run finishing). */
  async whenIdle(): Promise<void> {
    while (this.inFlight) await new Promise((resolve) => this.setTimer(() => resolve(undefined), 30));
  }

  private apply(outcome: RunOutcome, code: string): void {
    const { app, setBanner, editor, onResult } = this.options;
    if (outcome.kind === "timeout") {
      app.markStale();
      setBanner(
        `Your code ran for more than ${outcome.seconds} seconds and was stopped. Check for a loop that never ends.`,
      );
      onResult(true);
      return;
    }
    if (outcome.kind === "crash") {
      app.markStale();
      setBanner(`The tracer failed: <code>${escapeHtml(outcome.message)}</code>`);
      onResult(true);
      return;
    }

    const next = outcome.trace;
    if (next.error && next.steps.length === 0) {
      // Couldn't even start (usually a syntax error mid-typing). Keep the last
      // good picture on screen, dimmed, and point at the problem.
      app.markStale();
      const where = next.error.line ? ` on line ${next.error.line}` : "";
      setBanner(
        `<strong>${escapeHtml(next.error.type)}</strong>${where}: ${escapeHtml(next.error.message)}. Showing the last version that ran.`,
      );
      editor.setMarks({
        next: null,
        prev: null,
        error: { line: next.error.line, message: `${next.error.type}: ${next.error.message}` },
      });
      onResult(false);
      return;
    }

    // Stay on the last step if we were there, so live edits show the result.
    const { trace: before, stepIndex } = app.get();
    const wasAtEnd = !before || stepIndex >= before.steps.length - 1;
    const trace = applyHints(next);
    const warnings = trace.viz?.warnings ?? [];
    editor.setHintWarnings(warnings);
    const last = trace.steps.length - 1;
    app.showTrace(trace, code, wasAtEnd ? last : Math.max(firstStepFor(trace.steps.length), Math.min(stepIndex, last)));

    if (trace.truncated) {
      setBanner(this.truncationBanner(trace));
    } else if (trace.error) {
      const where = trace.error.line ? ` on line ${trace.error.line}` : "";
      setBanner(`<strong>${escapeHtml(trace.error.type)}</strong>${where}: ${escapeHtml(trace.error.message)}`);
    } else if (warnings.length) {
      const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more, underlined in the editor)` : "";
      setBanner(`<strong>Hint on line ${warnings[0].line}</strong>: ${escapeHtml(warnings[0].message)}${more}`);
    } else {
      setBanner(null);
    }
    onResult(true);
  }

  /** Why a trace stopped early, and what to do about it. */
  private truncationBanner(t: Trace): string {
    const ran = t.counts ? ` (${t.counts.steps.toLocaleString()} steps ran)` : "";
    const measure = `<button type="button" class="banner-link" data-action="measure">Measure</button> runs it all at full size, counting instead of tracing.`;
    if (t.stoppedBy === "time") {
      const seconds = this.lastBudget === "live" ? LIVE_SECONDS : RUN_SECONDS;
      const runLonger =
        this.lastBudget === "live"
          ? ` <button type="button" class="banner-link" data-action="run">Run</button> traces for up to ${RUN_SECONDS} seconds.`
          : "";
      return `Traced for ${seconds} seconds and stopped${ran}: this is the start of the run, with long loops sampled.${runLonger} If that's unexpected, look for a loop that never ends. ${measure}`;
    }
    return `Stopped after ${MAX_STEPS.toLocaleString()} recorded steps${ran}. If that's unexpected, look for a loop that never ends. ${measure}`;
  }
}
