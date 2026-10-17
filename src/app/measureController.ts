/**
 * Measure: run the whole program at full size with counters instead of a
 * trace (see trace/measurement.ts), and growth runs, which Measure the same
 * code at several sizes to see how the work grows. Both run only when
 * asked, never on every edit, since a big run can take a while. Traced runs
 * wait until they're done (the app state's `measuring`).
 *
 * This controller owns the Measure button, the results button, the Measure
 * panel (measurePanel.ts) with its growth section (growthView.ts), the time
 * limit and labels settings, the editor's count labels, and the last
 * measurement.
 */

import { type GrowthSeries, GrowthView } from "../growthView";
import type { LanguageId } from "../languages";
import type { MeasureLabel } from "../measurePanel";
import { MEASURE_LIMITS, MeasurePanel, measureLabels } from "../measurePanel";
import type { Settings } from "../settings";
import { estimateComplexity } from "../trace/complexity";
import { findSizes, type GrowthPoint, ladder, pointFrom, staticGrowth } from "../trace/growth";
import { duration, type Measurement } from "../trace/measurement";
import { POLICY } from "../trace/policy";
import type { MeasureOutcome } from "../worker/runner";
import type { BannerTone } from "./banner";
import { failureBanner, type RunController, type TracerCrash } from "./runController";
import type { AppStore } from "./state";

const DEFAULT_LIMIT_MS = POLICY.measureMs;

export interface MeasureElements {
  /** Measure (Stop while measuring). */
  measure: HTMLButtonElement;
  /** Opens the last results; hidden until there are some. */
  measureResults: HTMLButtonElement;
  /** The status text in the toolbar, which shows progress. */
  status: HTMLElement;
  /** Where the Measure panel goes. */
  editorPane: HTMLElement;
}

export interface MeasureEditor {
  getCode(): string;
  setCode(code: string): void;
  revealLine(line: number): void;
  setMeasureLabels(labels: MeasureLabel[]): void;
}

export interface MeasureOptions {
  app: AppStore;
  settings: Pick<Settings, "measureLimit" | "measureLabels" | "growthKept">;
  runs: Pick<RunController, "runnerFor" | "whenIdle" | "resumeQueued" | "refreshStatus">;
  els: MeasureElements;
  editor: MeasureEditor;
  setBanner(html: string | null, tone?: BannerTone): void;
  /** The tracer crashed while measuring: a bug in PR0L1NE (see RunOptions.reportCrash). */
  reportCrash?(crash: TracerCrash): void;
  /** Stop playback (measuring starts from a still picture). */
  pause(): void;
  /** A new measurement for the code on screen: the complexity estimate can use its counts. */
  onMeasured(): void;
  /** The Measure panel opened: close the other panels. */
  onOpen(): void;
  /** Timers and the clock, replaceable in tests. */
  now?(): number;
  setInterval?(callback: () => void, ms: number): number;
  clearInterval?(id: number): void;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

/** A top-level `name = number` to suggest a `viz: size` hint for: the biggest number. */
export function sizeSuggestion(code: string): { name: string; line: number } | null {
  let best: { name: string; line: number; value: number } | null = null;
  code.split("\n").forEach((text, i) => {
    const m =
      /^(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]|. ]+?\s*)?=\s*([0-9][0-9_]*)\s*;?\s*(?:(?:#|\/\/).*)?$/.exec(
        text,
      );
    const value = m ? Number(m[2].replace(/_/g, "")) : 0;
    if (m && value >= 8 && (!best || value > best.value)) best = { name: m[1], line: i + 1, value };
  });
  return best ? { name: (best as { name: string }).name, line: (best as { line: number }).line } : null;
}

export class MeasureController {
  readonly growth: GrowthView;
  readonly panel: MeasurePanel;
  /** The language being measured (the runner to stop, if the person switches away). */
  private measuringLanguage: LanguageId;
  private limit: number;
  private labelsOn: boolean;
  /** The last measurement and the code it was for (labels are hidden once the code changes). */
  private measured: { result: Measurement; code: string; language: LanguageId } | null = null;
  private growthTimer = 0;
  private readonly now: () => number;
  private readonly setInterval: (callback: () => void, ms: number) => number;
  private readonly clearInterval: (id: number) => void;
  private readonly setTimer: (callback: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  constructor(private readonly options: MeasureOptions) {
    const { app, settings, editor, els } = options;
    this.now = options.now ?? (() => performance.now());
    this.setInterval = options.setInterval ?? ((callback, ms) => window.setInterval(callback, ms));
    this.clearInterval = options.clearInterval ?? ((id) => window.clearInterval(id));
    this.setTimer = options.setTimeout ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => window.clearTimeout(id));

    this.measuringLanguage = app.get().language;
    const limit = settings.measureLimit.get() || DEFAULT_LIMIT_MS;
    this.limit = MEASURE_LIMITS.some((l) => l.ms === limit) ? limit : DEFAULT_LIMIT_MS;
    this.labelsOn = settings.measureLabels.get();

    this.growth = new GrowthView({
      sizes: () => findSizes(editor.getCode()),
      suggestion: () => sizeSuggestion(editor.getCode()),
      addHint: (name, line) => {
        const lines = editor.getCode().split("\n");
        const comment = this.language === "python" ? "#" : "//";
        lines.splice(line - 1, 0, `${comment} viz: size ${name}`);
        editor.setCode(lines.join("\n"));
        this.growth.render();
      },
      start: (scaled) => void this.measureGrowth(scaled),
      stop: () => this.stop(),
      kept: () => settings.growthKept(this.language),
    });

    this.panel = new MeasurePanel({
      growth: this.growth.el,
      renderGrowth: () => this.growth.render(),
      host: els.editorPane,
      reveal: (line) => editor.revealLine(line),
      labelsShown: () => this.labelsOn,
      setLabelsShown: (on) => {
        this.labelsOn = on;
        settings.measureLabels.set(on);
        this.updateLabels();
      },
      limit: () => this.limit,
      setLimit: (ms) => {
        this.limit = ms;
        settings.measureLimit.set(ms);
      },
      measureAgain: () => void this.measure(),
      estimate: () => {
        try {
          const { trace, stale } = app.get();
          return trace ? (estimateComplexity(trace, stale ? null : this.current())?.time ?? null) : null;
        } catch {
          return null;
        }
      },
      onOpen: () => {
        options.onOpen();
        els.measureResults.setAttribute("aria-expanded", "true");
      },
    });
    new MutationObserver(() => els.measureResults.setAttribute("aria-expanded", String(this.panel.isOpen))).observe(
      this.panel.el,
      { attributes: true, attributeFilter: ["hidden"] },
    );

    els.measure.addEventListener("click", () => void this.measure());
    els.measureResults.addEventListener("click", () => this.panel.toggle());
    app.watch(
      (s) => s.measuring,
      (on) => this.setButton(on),
    );
    app.watch(
      (s) => s.language,
      () => this.languageChanged(),
    );
  }

  private get language(): LanguageId {
    return this.options.app.get().language;
  }

  private get measuring(): boolean {
    return this.options.app.get().measuring;
  }

  /** Measure's result, when it's for the code in the editor now. */
  current(): Measurement | null {
    const { measured } = this;
    return measured && measured.language === this.language && measured.code === this.options.editor.getCode()
      ? measured.result
      : null;
  }

  /** Close the Measure panel (another panel opened). */
  close(): void {
    this.panel.toggle(false);
  }

  /** Stop the measurement in progress. */
  stop(): void {
    this.options.runs.runnerFor(this.measuringLanguage).stopMeasure();
  }

  /** The code in the editor changed. */
  codeChanged(code: string): void {
    // The growth section reads the code's `viz: size` hints.
    this.clearTimer(this.growthTimer);
    if (this.panel.isOpen && !this.growth.running) this.growthTimer = this.setTimer(() => this.growth.render(), 250);
    // A measurement is for the code it ran: once that changes, its counts would sit on the wrong lines.
    if (this.measured) {
      this.updateLabels();
      if (this.measured.code !== code) this.panel.markStale();
    }
  }

  /** The person switched language: stop measuring the old one, and show what's kept for the new one. */
  private languageChanged(): void {
    this.growth.reload();
    if (this.measuring) this.stop();
    this.options.els.measureResults.hidden = !this.measured || this.measured.language !== this.language;
    this.panel.toggle(false);
    this.updateLabels();
  }

  private updateLabels(): void {
    this.options.editor.setMeasureLabels(this.labelsOn ? measureLabels(this.current()) : []);
  }

  private setButton(on: boolean): void {
    const { measure: button } = this.options.els;
    button.textContent = on ? "Stop" : "Measure";
    button.classList.toggle("is-measuring", on);
    button.title = on
      ? "Stop measuring"
      : "Run the whole program at full size, counting how many times each line runs (Ctrl + Shift + ')";
  }

  /** Measuring starts: pause playback, and hold traced runs until it's done. */
  private begin(language: LanguageId): void {
    this.options.pause();
    this.measuringLanguage = language;
    this.options.app.setMeasuring(true);
  }

  private end(): void {
    this.options.app.setMeasuring(false);
    this.options.runs.refreshStatus();
  }

  /** Measure (the button, Ctrl + Shift + '), or Stop while measuring. */
  async measure(): Promise<void> {
    if (this.measuring) {
      this.stop();
      return;
    }
    const { runs, els, editor } = this.options;
    const code = editor.getCode();
    const lang = this.language;
    this.begin(lang);
    // A traced run may be finishing: measure right after it.
    await runs.whenIdle();
    const started = this.now();
    const showProgress = (text: string) => {
      if (lang === this.language) els.status.textContent = text;
    };
    showProgress("Measuring…");
    const tick = this.setInterval(() => showProgress(`Measuring… ${duration(this.now() - started)}`), 500);
    const outcome = await runs.runnerFor(lang).measure(code, this.limit, (p) => {
      const share = p.loop
        ? ` · ${Math.min(99, Math.floor((100 * p.loop.done) / p.loop.total))}% of line ${p.loop.line}'s loop`
        : "";
      showProgress(`Measuring… ${duration(p.elapsedMs)}${share}`);
    });
    this.clearInterval(tick);
    this.end();
    if (lang === this.language) {
      if (outcome.kind === "measured") {
        this.measured = { result: outcome.result, code, language: lang };
        this.options.onMeasured();
        els.measureResults.hidden = false;
        this.panel.show(outcome.result, code);
        this.updateLabels();
      } else if (outcome.kind === "stopped") {
        this.options.setBanner(
          outcome.reason === "person"
            ? "Measuring stopped. Nothing was counted, since the run was cut off from outside."
            : `The program didn't stop at the ${duration(this.limit)} limit (probably stuck inside one long built-in call), so it was stopped from outside.`,
          "budget",
        );
      } else {
        this.options.setBanner(...failureBanner(outcome, lang));
      }
    }
    if (outcome.kind === "crash") this.options.reportCrash?.({ language: lang, message: outcome.message });
    // Edits made while measuring were waiting.
    runs.resumeQueued();
  }

  /** Why a growth run ended before its last size, when it ended without a measurement. */
  private cutShort(outcome: Exclude<MeasureOutcome, { kind: "measured" }>, at: string, lang: LanguageId): string {
    switch (outcome.kind) {
      case "stopped":
        return outcome.reason === "person" ? `Stopped at ${at}.` : `At ${at} the run didn't stop at the time limit.`;
      case "crash":
        this.options.reportCrash?.({ language: lang, message: outcome.message });
        return `At ${at} PR0L1NE's tracer failed (a bug in PR0L1NE, not your code): ${outcome.message}`;
      case "unavailable":
        return `At ${at} the language couldn't run: ${outcome.message}`;
    }
  }

  /**
   * Growth runs: Measure at n/64, n/16, n/4 and n (the `viz: size` variables
   * in `scaled` grow; others stay at their full size), then fit the counts
   * and compare with the code's estimate.
   */
  async measureGrowth(scaled?: string[]): Promise<void> {
    if (this.measuring) return;
    const { runs, editor, app } = this.options;
    const code = editor.getCode();
    const lang = this.language;
    const { vars } = findSizes(code);
    const grow = scaled ?? vars.map((v) => v.name);
    const rungs = ladder(vars, grow);
    this.panel.toggle(true);
    if (rungs.length < 2) {
      this.growth.render();
      return;
    }
    this.begin(lang);
    await runs.whenIdle();
    const x = grow[0];
    const points: GrowthPoint[] = [];
    let stopped: GrowthSeries["stopped"];
    for (const [i, rung] of rungs.entries()) {
      const label = `Measuring ${x} = ${rung.x.toLocaleString()} (${i + 1} of ${rungs.length})…`;
      this.growth.setProgress(label);
      const outcome = await runs
        .runnerFor(lang)
        .measure(code, this.limit, (p) => this.growth.setProgress(`${label} ${duration(p.elapsedMs)}`), rung.sizes);
      const full = rungs[rungs.length - 1].x;
      const at = `At ${x} = ${rung.x.toLocaleString()}`;
      if (outcome.kind !== "measured") {
        stopped = { x: full, why: this.cutShort(outcome, `${x} = ${rung.x.toLocaleString()}`, lang) };
        break;
      }
      const m = outcome.result;
      if (m.status === "error") {
        stopped = {
          x: full,
          why: `${at} the program stopped with ${m.error?.type ?? "an error"}: ${m.error?.message ?? ""}`,
        };
        break;
      }
      if (m.status === "limit") {
        stopped = { x: full, why: `${at} it reached the ${duration(this.limit)} time limit.` };
        break;
      }
      points.push(pointFrom(rung, m));
    }
    this.end();
    // The code's estimate, from the trace of this same code.
    let expected = null;
    try {
      const { trace, stale, tracedCode } = app.get();
      const estimate = trace && !stale && tracedCode === code ? estimateComplexity(trace) : null;
      expected = estimate ? staticGrowth(estimate, vars, grow) : null;
    } catch {
      expected = null;
    }
    if (lang === this.language)
      this.growth.setResult({ label: "This version", x, scaled: grow, points, stopped, expected });
    else this.growth.setProgress(null);
    runs.resumeQueued();
  }
}
