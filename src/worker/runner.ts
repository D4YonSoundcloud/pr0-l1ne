/**
 * Main-thread side of a language worker: starts it, sends code, and enforces
 * a time limit. One Runner exists per language.
 *
 * The tracer already stops runaway loops with a step budget, but code that
 * spends a long time inside a single C call (sum(range(10**12))) never hits a
 * trace event. For that, the watchdog terminates the worker and starts a
 * fresh one. Restarting is slower than an interrupt, but needs no special
 * server headers. See the README's "Limitations" section.
 */

import type { Measurement, MeasureProgress } from "../trace/measurement";
import type { Trace } from "../trace/types";
import type { FromWorker, ToWorker } from "./protocol";

export type RunOutcome =
  | { kind: "trace"; trace: Trace; elapsedMs: number }
  | { kind: "timeout"; seconds: number }
  | { kind: "crash"; message: string };

export type MeasureOutcome =
  | { kind: "measured"; result: Measurement }
  /** Stopped by the person, or past the time limit without stopping itself (stuck inside one call). */
  | { kind: "stopped"; reason: "person" | "unresponsive" }
  | { kind: "crash"; message: string };

/** Extra time a Measure run gets past its own limit, for the untouched timing run and reporting. */
const MEASURE_GRACE_MS = 15_000;

export type RunnerStatus =
  | { kind: "loading" }
  | { kind: "ready"; label: string }
  | { kind: "running" }
  | { kind: "failed"; message: string };

interface Pending {
  runId: number;
  resolve: (outcome: RunOutcome) => void;
  timer: number;
}

interface PendingMeasure {
  runId: number;
  resolve: (outcome: MeasureOutcome) => void;
  progress: (progress: MeasureProgress) => void;
  timer: number;
}

export class Runner {
  private worker!: Worker;
  private nextRunId = 1;
  private pending: Pending | null = null;
  private measuring: PendingMeasure | null = null;
  private isReady = false;
  private label = "";
  /** The latest status, so the UI can show it when switching languages. */
  status: RunnerStatus = { kind: "loading" };

  constructor(
    private readonly createWorker: () => Worker,
    private readonly onStatus: (status: RunnerStatus) => void,
    private readonly timeoutMs = 10_000,
  ) {
    this.start();
  }

  private setStatus(status: RunnerStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  private start(): void {
    this.isReady = false;
    this.setStatus({ kind: "loading" });
    this.worker = this.createWorker();
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      this.setStatus({ kind: "failed", message: event.message || "The worker failed to start." });
    };
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case "ready":
        this.isReady = true;
        this.label = message.label;
        this.setStatus(this.pending || this.measuring ? { kind: "running" } : { kind: "ready", label: message.label });
        break;
      case "loadError":
        this.setStatus({ kind: "failed", message: `Couldn't load the language runtime: ${message.message}` });
        break;
      case "result":
        this.settle(message.runId, { kind: "trace", trace: message.trace, elapsedMs: message.elapsedMs });
        break;
      case "crash":
        if (this.measuring?.runId === message.runId) this.settleMeasure({ kind: "crash", message: message.message });
        else this.settle(message.runId, { kind: "crash", message: message.message });
        break;
      case "measureProgress":
        if (this.measuring?.runId === message.runId) this.measuring.progress(message.progress);
        break;
      case "measured":
        if (this.measuring?.runId === message.runId) this.settleMeasure({ kind: "measured", result: message.result });
        break;
    }
  }

  private settle(runId: number, outcome: RunOutcome): void {
    if (!this.pending || this.pending.runId !== runId) return;
    clearTimeout(this.pending.timer);
    const { resolve } = this.pending;
    this.pending = null;
    if (this.isReady) this.setStatus({ kind: "ready", label: this.label });
    resolve(outcome);
  }

  private settleMeasure(outcome: MeasureOutcome): void {
    if (!this.measuring) return;
    clearTimeout(this.measuring.timer);
    const { resolve } = this.measuring;
    this.measuring = null;
    if (this.isReady) this.setStatus({ kind: "ready", label: this.label });
    resolve(outcome);
  }

  get busy(): boolean {
    return !!this.pending || !!this.measuring;
  }

  /**
   * Run code at full size with counters. The program stops itself at
   * `limitMs`; the runner only steps in (restarting the worker) if it
   * doesn't, or when the person presses Stop.
   */
  measure(
    source: string,
    limitMs: number,
    progress: (p: MeasureProgress) => void,
    overrides?: Record<string, number>,
  ): Promise<MeasureOutcome> {
    if (this.busy) throw new Error("A run is already in progress");
    const runId = this.nextRunId++;
    return new Promise((resolve) => {
      const hard = limitMs + MEASURE_GRACE_MS + (this.isReady ? 0 : 60_000);
      const timer = window.setTimeout(() => this.stopMeasure("unresponsive"), hard);
      this.measuring = { runId, resolve, progress, timer };
      if (this.isReady) this.setStatus({ kind: "running" });
      const message: ToWorker = { type: "measure", runId, source, limitMs, ...(overrides ? { overrides } : {}) };
      this.worker.postMessage(message);
    });
  }

  /** Stop a Measure run now: the worker is busy running the program, so it's restarted. */
  stopMeasure(reason: "person" | "unresponsive" = "person"): void {
    if (!this.measuring) return;
    this.worker.terminate();
    this.settleMeasure({ kind: "stopped", reason });
    this.start();
  }

  /** Run code. Only one run is in flight at a time; callers should await. */
  run(source: string, maxSteps: number, maxSeconds: number): Promise<RunOutcome> {
    if (this.busy) throw new Error("A run is already in progress");
    const runId = this.nextRunId++;
    return new Promise((resolve) => {
      // The timer starts when we send, but the first run also waits for
      // Pyodide to load, so give it extra time while not ready.
      const limit = this.isReady ? this.timeoutMs : this.timeoutMs + 60_000;
      const timer = window.setTimeout(() => {
        this.worker.terminate();
        this.pending = null;
        resolve({ kind: "timeout", seconds: Math.round(this.timeoutMs / 1000) });
        this.start();
      }, limit);
      this.pending = { runId, resolve, timer };
      if (this.isReady) this.setStatus({ kind: "running" });
      const message: ToWorker = { type: "run", runId, source, maxSteps, maxSeconds };
      this.worker.postMessage(message);
    });
  }
}
