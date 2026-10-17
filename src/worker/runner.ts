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
import type { SamplingPolicy } from "../trace/policy";
import type { Trace } from "../trace/types";
import { type FromWorker, PROTOCOL_VERSION, type ToWorker } from "./protocol";

/*
 * How a run can end. Each kind means something different to the person, and
 * the app shows each its own way (app/runController.ts):
 *
 * - trace        The program ran. It may have raised an error (trace.error)
 *                or used up its steps or time (trace.truncated): those are
 *                the program's own story, shown as normal output.
 * - timeout      It ran out of time without the tracer noticing (stuck in
 *                one long built-in call), so the worker was restarted.
 * - crash        The tracer itself failed: a bug in PR0L1NE, not in the
 *                program. The only kind worth reporting.
 * - unavailable  The language runtime couldn't load (usually the network),
 *                or the worker speaks another protocol version than the page
 *                (one cached from before a deploy). Nothing ran.
 */

/** The runtime couldn't run anything. "load": it didn't load (try again); "version": reload the page. */
export type Unavailable = {
  kind: "unavailable";
  reason: "load" | "version";
  /** For the status bar: says what failed. */
  message: string;
  /** Why, as the browser or the worker put it ("Failed to fetch…"). */
  detail?: string;
};

export type RunOutcome =
  | { kind: "trace"; trace: Trace; elapsedMs: number }
  | { kind: "timeout"; seconds: number }
  | { kind: "crash"; message: string }
  | Unavailable;

export type MeasureOutcome =
  | { kind: "measured"; result: Measurement }
  /** Stopped by the person, or past the time limit without stopping itself (stuck inside one call). */
  | { kind: "stopped"; reason: "person" | "unresponsive" }
  | { kind: "crash"; message: string }
  | Unavailable;

/** Shown when a worker speaks another protocol version than the page. */
export const OUTDATED_MESSAGE = "PR0L1NE was updated since this page loaded. Reload the page to use the new version.";

/**
 * Development builds only: what's wrong with a trace, per the trace schema.
 * `null` in production builds, where the bundler drops it together with the
 * validator and the schema.
 */
const checkTrace = import.meta.env.DEV
  ? async (trace: Trace) => (await import("../trace/validate")).traceProblems(trace)
  : null;

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
  /** Why the runtime can't run anything, until a fresh worker is started. */
  private failure: Unavailable | null = null;
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
    this.failure = null;
    this.setStatus({ kind: "loading" });
    this.worker = this.createWorker();
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      if (this.isReady) {
        // It loaded, then died: an error the worker's own code didn't catch.
        this.crashed(event.message || "the worker stopped unexpectedly");
      } else {
        const detail = event.message || "the worker failed to start";
        this.fail("load", `Couldn't start the language runtime: ${detail}.`, detail);
      }
    };
  }

  /** Nothing can run: say why, and end whatever was waiting. */
  private fail(reason: Unavailable["reason"], message: string, detail?: string): void {
    const failure: Unavailable = { kind: "unavailable", reason, message, ...(detail ? { detail } : {}) };
    this.failure = failure;
    this.isReady = false;
    this.setStatus({ kind: "failed", message });
    if (this.pending) this.settle(this.pending.runId, failure);
    this.settleMeasure(failure);
  }

  /** The worker died after loading: whatever was running crashed with it. Start a fresh one. */
  private crashed(message: string): void {
    const outcome = { kind: "crash" as const, message };
    this.worker.terminate();
    if (this.pending) this.settle(this.pending.runId, outcome);
    this.settleMeasure(outcome);
    this.start();
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case "ready":
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.worker.terminate();
          this.fail("version", OUTDATED_MESSAGE);
          break;
        }
        this.isReady = true;
        this.label = message.label;
        this.setStatus(this.pending || this.measuring ? { kind: "running" } : { kind: "ready", label: message.label });
        break;
      case "loadError":
        this.fail("load", `Couldn't load the language runtime: ${message.message}`, message.message);
        break;
      case "result":
        if (checkTrace) void this.settleChecked(message.runId, message.trace, message.elapsedMs);
        else this.settle(message.runId, { kind: "trace", trace: message.trace, elapsedMs: message.elapsedMs });
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

  /**
   * Development builds only: check the trace against the trace schema
   * before using it, so a tracer that sends the wrong shape fails here,
   * naming the field, rather than somewhere deep in the renderer.
   * Production builds leave this out entirely (with the validator and the
   * schema), so it costs them nothing.
   */
  private async settleChecked(runId: number, trace: Trace, elapsedMs: number): Promise<void> {
    const problems = (await checkTrace?.(trace)) ?? [];
    if (!problems.length) {
      this.settle(runId, { kind: "trace", trace, elapsedMs });
      return;
    }
    console.error("Trace doesn't match the trace format (schema/trace.schema.json):", problems, trace);
    this.settle(runId, {
      kind: "crash",
      message: `the trace doesn't match the trace format (checked in development builds): ${problems.join(" · ")}`,
    });
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
    const failure = this.unavailable();
    if (failure) return Promise.resolve(failure);
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

  /**
   * Before a run: if the runtime failed to load, try a fresh worker (the
   * network may be back). A worker of another version can't be helped
   * without reloading the page.
   */
  private unavailable(): Unavailable | null {
    if (this.failure?.reason === "version") return this.failure;
    if (this.failure) this.start();
    return null;
  }

  /** Run code. Only one run is in flight at a time; callers should await. */
  run(source: string, maxSteps: number, maxSeconds: number, sampling: SamplingPolicy): Promise<RunOutcome> {
    if (this.busy) throw new Error("A run is already in progress");
    const failure = this.unavailable();
    if (failure) return Promise.resolve(failure);
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
      const message: ToWorker = { type: "run", runId, source, maxSteps, maxSeconds, sampling };
      this.worker.postMessage(message);
    });
  }
}
