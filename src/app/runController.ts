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

import type { HintContext } from "../hintAssist";
import { LANGUAGES, type LanguageId } from "../languages";
import type { LayoutService, Loaded } from "../layout/service";
import { perf, timed } from "../perf";
import { POLICY } from "../trace/policy";
import type { TraceInfo } from "../trace/summary";
import { Runner, type RunnerStatus, type RunOutcome } from "../worker/runner";
import type { BannerTone } from "./banner";
import { escapeHtml } from "./html";
import { firstStepFor } from "./playbackController";
import type { ProgressView } from "./runProgress";
import type { AppStore } from "./state";

// The step budget, how long tracing may take (Live or Run) and how long
// loops are sampled are the tracing policy, trace/policy.ts.

export interface Download {
  name: string;
  size: string;
}

/** Languages whose runtime is a download worth mentioning while it loads (gzipped, roughly). */
const DOWNLOADS: Partial<Record<LanguageId, Download>> = {
  python: { name: "Python", size: "6 MB" },
  sql: { name: "PostgreSQL", size: "8 MB" },
};

/** What a language downloads the first time it runs, or null when it's ready at once. */
export const downloadFor = (language: LanguageId): Download | null => DOWNLOADS[language] ?? null;

/** How long typing must pause before a Live run. */
export const LIVE_DELAY_MS = 600;

export type Budget = "live" | "run";

/** The part of a Runner this controller uses (tests pass a fake). */
export type RunnerLike = Pick<Runner, "run" | "status" | "measure" | "stopMeasure" | "stop">;

export interface RunEditor {
  /** Show an error under a line (null clears the marks). */
  setMarks(marks: {
    next: number | null;
    prev: number | null;
    error: { line: number | null; message: string } | null;
  }): void;
  setHintWarnings(warnings: { line: number; message: string }[]): void;
  /** What the program has, for help writing hints (hintAssist.ts). Optional: tests leave it out. */
  setHintContext?(ctx: HintContext): void;
}

export interface RunOptions {
  app: AppStore;
  /** The status text in the toolbar. */
  status: HTMLElement;
  editor: RunEditor;
  setBanner(html: string | null, tone?: BannerTone): void;
  /**
   * The tracer crashed: a bug in PR0L1NE. The one failure worth reporting
   * (the others are the program's own, or the network's); nothing is sent
   * anywhere yet, this is where error reporting will plug in.
   */
  reportCrash?(crash: TracerCrash): void;
  /** A run produced something to show: draw it. `updateMarks` is false when the editor's marks are already set. */
  onResult(updateMarks: boolean): void;
  /**
   * The current language's runner status changed (or the language did):
   * `download` is what it's downloading, if it's a download worth showing
   * (the loading card, app/loadingCard.ts).
   */
  onStatus?(status: RunnerStatus, download: Download | null): void;
  /** Make a language's runner. */
  createRunner?(language: LanguageId, onStatus: (status: RunnerStatus) => void): RunnerLike;
  /** How a run is going, while it goes (app/runProgress.ts). */
  progress?: ProgressView;
  /** Resolves once the page has painted (so "Preparing the drawing" shows before the work that blocks it). */
  nextFrame?(): Promise<void>;
  /**
   * The layout (layout/service.ts): it's given each run's trace as it
   * arrives, builds it, prepares it and draws the windows from it. The page
   * keeps only what it says of the trace (trace/summary.ts).
   */
  layout: LayoutService;
  /** Resolves once the windows have drawn the step a new trace opened on (the card says "Drawing" until then). */
  drawn?(): Promise<void>;
  /**
   * The code that's run for the code in the editor (app/inputController.ts
   * swaps in the inputs chosen, on the same lines), and problems with hints
   * the page reads itself, shown with the trace's own.
   */
  prepare?(code: string, language: LanguageId): { code: string; warnings: { line: number; message: string }[] };
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export interface TracerCrash {
  language: LanguageId;
  message: string;
}

/** Where people report a PR0L1NE bug. */
export const ISSUES_URL = "https://github.com/D4YonSoundcloud/pr0-l1ne/issues/new";

/** A link that opens a bug report about this crash, filled in. */
export function reportLink(crash: TracerCrash): string {
  const title = `Tracer crash (${LANGUAGES[crash.language].label}): ${crash.message.slice(0, 80)}`;
  const body = `**Language:** ${LANGUAGES[crash.language].label}\n**Error:** ${crash.message}\n\n**The program** (or a smaller one that fails the same way):\n\n\`\`\`\n\n\`\`\`\n`;
  return `${ISSUES_URL}?${new URLSearchParams({ title, body })}`;
}

/** A run that produced nothing to draw. */
export type Failure = Exclude<RunOutcome, { kind: "trace" } | { kind: "streamed" }>;

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
    const download = DOWNLOADS[this.language];
    el.classList.toggle("is-error", status.kind === "failed");
    // A spinner beside the text while the language loads (styles.css).
    el.classList.toggle("is-loading", status.kind === "loading");
    this.options.onStatus?.(status, download ?? null);
    el.title =
      status.kind === "loading" && download
        ? `${download.name} runs right here in your browser. It downloads once (about ${download.size}); after that your browser keeps a copy.`
        : status.kind === "failed"
          ? status.message // a long error may be cut short on screen
          : "";
    switch (status.kind) {
      case "loading": {
        const bytes = status.download;
        const share = bytes && bytes.total > 0 ? Math.min(1, bytes.loaded / bytes.total) : null;
        el.textContent = !download
          ? `Loading ${LANGUAGES[this.language].label}…`
          : share === null
            ? `Downloading ${download.name} (${download.size})…`
            : share < 1
              ? `Downloading ${download.name}… ${Math.floor(share * 100)}%`
              : `Starting ${download.name}…`;
        break;
      }
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
    this.running = language;
    const seconds = budget === "live" ? POLICY.liveSeconds : POLICY.runSeconds;
    const started = perf.on ? performance.now() : 0;
    const view = this.options.progress;
    view?.start({ budget, maxSteps: POLICY.maxSteps, maxSeconds: seconds });
    // The trace goes to the layout as it arrives (its pieces unread here): it builds it, checks it,
    // prepares it and draws from it, and says what the page should know of it.
    const layout = this.options.layout;
    layout.begin();
    const prepared = this.options.prepare?.(code, language) ?? { code, warnings: [] };
    const outcome = await this.runnerFor(language).run(
      prepared.code,
      POLICY.maxSteps,
      seconds,
      POLICY.sampling,
      (progress) => view?.update(progress),
      (part) => layout.feed(part),
    );
    if (perf.on) perf.record("run.trace", performance.now() - started);
    this.lastBudget = budget;
    this.running = null;
    // Report a crash whatever the language now; show results only for the language on screen.
    if (outcome.kind === "crash") this.options.reportCrash?.({ language, message: outcome.message });
    // What reaches the layout: the whole trace (SQL's), all its pieces, or what had arrived when stopped.
    const how =
      outcome.kind === "trace"
        ? "whole"
        : outcome.kind === "streamed"
          ? "streamed"
          : outcome.kind === "stopped" && outcome.arrived
            ? "stopped"
            : null;
    if (language === this.language && !how) this.applyFailure(outcome as Failure, language);
    else if (language === this.language && how) {
      // The progress showing: say the drawing's being prepared, and let that paint.
      if (view?.preparing()) await this.nextFrame();
      const started = perf.on ? performance.now() : 0;
      let loaded: Loaded;
      try {
        loaded = await layout.load(how, outcome.kind === "trace" ? outcome.trace : null, (p) => view?.prepare(p));
      } catch (error) {
        // The trace couldn't be used (a tracer bug, or a program tampering with its trace).
        const message = error instanceof Error ? error.message : String(error);
        this.options.reportCrash?.({ language, message });
        loaded = { kind: "replaced" };
        if (language === this.language) this.applyFailure({ kind: "crash", message }, language);
      }
      if (perf.on) perf.record("run.prepare", performance.now() - started);
      // Still the language on screen (it can change while a big trace is prepared)?
      if (language === this.language) {
        if (loaded.kind === "empty") this.applyFailure({ kind: "stopped", arrived: false }, language);
        else if (loaded.kind === "ready" && this.applyTrace(loaded.info, code, prepared.warnings)) {
          // The card says "Drawing" until the windows have drawn it.
          view?.drawing();
          await this.options.drawn?.();
        }
      }
    }
    view?.done();
    this.inFlight = false;
    this.resumeQueued();
  }

  /** The language of the run going now, if any. */
  private running: LanguageId | null = null;

  /**
   * Stop the run going now (the toolbar's or the card's Stop): it ends with
   * what had been recorded, drawn like any trace that stopped early.
   */
  stop(): void {
    if (this.running) this.runnerFor(this.running).stop();
  }

  private nextFrame(): Promise<void> {
    if (this.options.nextFrame) return this.options.nextFrame();
    if (typeof requestAnimationFrame !== "function") return Promise.resolve();
    // Two frames: the first runs before the paint, the second after it.
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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

  /** Show a run that produced no trace: keep the last picture, dimmed, and say why. */
  private applyFailure(outcome: Failure, language: LanguageId): void {
    const { app, setBanner, onResult } = this.options;
    app.markStale();
    const [html, tone] = failureBanner(outcome, language);
    setBanner(html, tone);
    onResult(true);
  }

  /** Show a run's trace (what the page knows of it); false when there's nothing to draw (it never started). */
  private applyTrace(trace: TraceInfo, code: string, pageWarnings: { line: number; message: string }[] = []): boolean {
    const { app, setBanner, editor, onResult } = this.options;
    if (trace.error && trace.steps === 0) {
      // Couldn't even start (usually a syntax error mid-typing). Keep the last
      // good picture on screen, dimmed, and point at the problem.
      app.markStale();
      const error = trace.error;
      const where = error.line ? ` on line ${error.line}` : "";
      setBanner(
        `<strong>${escapeHtml(error.type)}</strong>${where}: ${escapeHtml(error.message)}. Showing the last version that ran.`,
        "program",
      );
      editor.setMarks({
        next: null,
        prev: null,
        error: { line: error.line, message: `${error.type}: ${error.message}` },
      });
      onResult(false);
      return false;
    }

    // Stay on the last step if we were there, so live edits show the result.
    const { trace: before, stepIndex } = app.get();
    const wasAtEnd = !before || stepIndex >= before.steps - 1;
    if (perf.on) perf.lastTrace = trace.stats;
    const warnings = [...trace.warnings, ...pageWarnings].sort((a, b) => a.line - b.line);
    editor.setHintWarnings(warnings);
    // From the trace before its hints, so hidden variables still count as the program's.
    if (!trace.sql) editor.setHintContext?.(trace.hintContext);
    const last = trace.steps - 1;
    const first = trace.sql ? 0 : firstStepFor(trace.steps);
    timed("run.show", () => app.showTrace(trace, code, wasAtEnd ? last : Math.max(first, Math.min(stepIndex, last))));

    if (trace.truncated) {
      setBanner(this.truncationBanner(trace), "budget");
    } else if (trace.error) {
      const where = trace.error.line ? ` on line ${trace.error.line}` : "";
      setBanner(
        `<strong>${escapeHtml(trace.error.type)}</strong>${where}: ${escapeHtml(trace.error.message)}`,
        "program",
      );
    } else if (warnings.length) {
      const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more, underlined in the editor)` : "";
      setBanner(`<strong>Hint on line ${warnings[0].line}</strong>: ${escapeHtml(warnings[0].message)}${more}`, "hint");
    } else {
      setBanner(null);
    }
    onResult(true);
    return true;
  }

  /** Why a trace stopped early, and what to do about it. */
  private truncationBanner(t: TraceInfo): string {
    const ran = t.counts ? ` (${t.counts.steps.toLocaleString()} steps ran)` : "";
    const measure = `<button type="button" class="banner-link" data-action="measure">Measure</button> runs it all at full size, counting instead of tracing.`;
    if (t.stoppedBy === "person") {
      const steps = t.steps.toLocaleString();
      return `You stopped the run: here are the ${steps} steps recorded up to then${ran}, with long loops sampled. <button type="button" class="banner-link" data-action="run">Run</button> to trace it again. ${measure}`;
    }
    if (t.stoppedBy === "time") {
      const seconds = this.lastBudget === "live" ? POLICY.liveSeconds : POLICY.runSeconds;
      const runLonger =
        this.lastBudget === "live"
          ? ` <button type="button" class="banner-link" data-action="run">Run</button> traces for up to ${POLICY.runSeconds} seconds.`
          : "";
      return `Traced for ${seconds} seconds and stopped${ran}: this is the start of the run, with long loops sampled.${runLonger} If that's unexpected, look for a loop that never ends. ${measure}`;
    }
    return `Stopped after ${POLICY.maxSteps.toLocaleString()} recorded steps${ran}. If that's unexpected, look for a loop that never ends. ${measure}`;
  }
}

/** The banner for a run that produced no trace, and its tone: each kind of failure says something different. */
export function failureBanner(outcome: Failure, language: LanguageId): [string, BannerTone] {
  const name = LANGUAGES[language].label;
  switch (outcome.kind) {
    case "stopped":
      return [
        `You stopped the run before anything was recorded. <button type="button" class="banner-link" data-action="run">Run</button> to start it again.`,
        "budget",
      ];
    case "timeout":
      // The program's doing, like any other limit.
      return [
        `Your code ran for more than ${outcome.seconds} seconds without the tracer getting a word in (probably one long built-in call), so it was stopped. Check for a loop that never ends.`,
        "budget",
      ];
    case "crash":
      // Ours: say so plainly, and how to tell us.
      return [
        `<strong>PR0L1NE's tracer failed.</strong> That's a bug in PR0L1NE, not in your code: <code>${escapeHtml(outcome.message)}</code>. <a href="${escapeHtml(reportLink({ language, message: outcome.message }))}" target="_blank" rel="noopener">Report it</a> so it can be fixed.`,
        "tracer",
      ];
    case "unavailable":
      if (outcome.reason === "version")
        return [
          `${escapeHtml(outcome.message)} <button type="button" class="banner-link" data-action="reload">Reload</button>`,
          "runtime",
        ];
      return [
        `<strong>${escapeHtml(name)} couldn't load</strong>, so nothing ran (<code>${escapeHtml(outcome.detail ?? outcome.message)}</code>). Check your connection, then <button type="button" class="banner-link" data-action="run">Run</button> to try again.`,
        "runtime",
      ];
  }
}
