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
import type { FromWorker, ToWorker } from "./protocol";
import type { Trace } from "../trace/types";

export type RunOutcome =
  | { kind: "trace"; trace: Trace; elapsedMs: number }
  | { kind: "timeout"; seconds: number }
  | { kind: "crash"; message: string };

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

export class Runner {
  private worker!: Worker;
  private nextRunId = 1;
  private pending: Pending | null = null;
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
        this.setStatus(this.pending ? { kind: "running" } : { kind: "ready", label: message.label });
        break;
      case "loadError":
        this.setStatus({ kind: "failed", message: `Couldn't load the language runtime: ${message.message}` });
        break;
      case "result":
        this.settle(message.runId, { kind: "trace", trace: message.trace, elapsedMs: message.elapsedMs });
        break;
      case "crash":
        this.settle(message.runId, { kind: "crash", message: message.message });
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

  /** Run code. Only one run is in flight at a time; callers should await. */
  run(source: string, maxSteps: number): Promise<RunOutcome> {
    if (this.pending) throw new Error("A run is already in progress");
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
      const message: ToWorker = { type: "run", runId, source, maxSteps };
      this.worker.postMessage(message);
    });
  }
}
