/**
 * Main-thread side of a language worker: starts it, sends code, and enforces
 * a time limit. One Runner exists per language.
 *
 * The tracer already stops runaway loops with a step budget, but code that
 * spends a long time inside a single C call (sum(range(10**12))) never hits a
 * trace event. For that, the watchdog terminates the worker and starts a
 * fresh one. Restarting is slower than an interrupt, but needs no special
 * server headers. See the README's "Limitations" section.
 *
 * The worker is a SandboxWorker (sandbox/sandboxWorker.ts): it runs on the
 * runner's site, not the app's, behind the same interface as a Worker.
 */

import type { WorkerLike } from "../sandbox/sandboxWorker";
import { dataLimitProblem, MESSAGE_LIMITS, traceProblem } from "../trace/checkTrace";
import type { Measurement, MeasureProgress } from "../trace/measurement";
import type { SamplingPolicy } from "../trace/policy";
import { MAX_TRACE_CHARS, progressOf, type RunProgress } from "../trace/stream";
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
  /** The whole trace (SQL's, whose queries are quick). */
  | { kind: "trace"; trace: Trace; elapsedMs: number }
  /** The trace arrived a piece at a time, all of it: what `feed` was given is the trace. */
  | { kind: "streamed"; elapsedMs: number }
  /**
   * The person stopped it: `arrived` says whether any piece had (then what
   * `feed` was given, so far, is the trace: stoppedBy "person").
   */
  | { kind: "stopped"; arrived: boolean }
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

/** Labels and error messages are shown in the page: a sane length. */
const MAX_TEXT = 10_000;

/**
 * Is a message one the protocol has, with the fields it needs? The worker
 * runs the program being traced, on another site, and the program can send
 * anything (see trace/checkTrace.ts): what doesn't fit is ignored, and a
 * trace or measurement is checked in full before it's used.
 */
function wellFormed(message: unknown): message is FromWorker {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" && v.length <= MAX_TEXT;
  const id = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  switch (m.type) {
    case "ready":
      // Any version, or none: receive() turns away one that isn't this page's.
      return text(m.label);
    case "loadError":
      return text(m.message);
    case "loadProgress": {
      const bytes = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
      return bytes(m.loaded) && bytes(m.total);
    }
    case "result":
      return id(m.runId) && id(m.elapsedMs) && typeof m.trace === "object" && m.trace !== null;
    case "progress":
      return id(m.runId) && progressOf(m.progress) !== null && (m.piece === undefined || typeof m.piece === "string");
    case "streamed":
      return id(m.runId) && id(m.elapsedMs) && typeof m.json === "string";
    case "crash":
      return id(m.runId) && text(m.message);
    case "measureProgress":
      return id(m.runId) && typeof m.progress === "object" && m.progress !== null;
    case "measured":
      return id(m.runId) && typeof m.result === "object" && m.result !== null;
    default:
      return false;
  }
}

/** Extra time a Measure run gets past its own limit, for the untouched timing run and reporting. */
const MEASURE_GRACE_MS = 15_000;

export type RunnerStatus =
  /** `download`: how much of the runtime has downloaded, in bytes, once the worker says. */
  | { kind: "loading"; download?: { loaded: number; total: number } }
  | { kind: "ready"; label: string }
  | { kind: "running" }
  | { kind: "failed"; message: string };

interface Pending {
  runId: number;
  resolve: (outcome: RunOutcome) => void;
  timer: number;
  /** Pieces passed on, and their text so far. */
  pieces: number;
  chars: number;
  progress?: (progress: RunProgress) => void;
  feed?: (part: TracePart) => void;
}

/** A piece of a streamed trace as it was sent (a piece's JSON, or the end's), for the layout worker to read and check. */
export interface TracePart {
  kind: "piece" | "end";
  json: string;
}

interface PendingMeasure {
  runId: number;
  resolve: (outcome: MeasureOutcome) => void;
  progress: (progress: MeasureProgress) => void;
  timer: number;
}

export class Runner {
  private worker: WorkerLike | null = null;
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
    private readonly createWorker: () => WorkerLike,
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
    // One that failed to load is still there: end it before starting another.
    this.worker?.terminate();
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      if (worker === this.worker && wellFormed(event.data)) this.receive(event.data);
    };
    worker.onerror = (event) => {
      if (worker !== this.worker) return;
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
    this.worker?.terminate();
    if (this.pending) this.settle(this.pending.runId, outcome);
    this.settleMeasure(outcome);
    this.start();
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case "ready":
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.worker?.terminate();
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
      case "loadProgress":
        // Only while it's loading: a late one never turns a ready runner back.
        if (!this.isReady && this.status.kind === "loading")
          this.setStatus({
            kind: "loading",
            download: { loaded: Math.min(message.loaded, message.total), total: message.total },
          });
        break;
      case "result":
        this.settleChecked(message.runId, message.trace, message.elapsedMs);
        break;
      case "progress": {
        const pending = this.pending;
        if (pending?.runId !== message.runId) break;
        // The piece goes on to the layout worker unread, which builds and checks the trace
        // (trace/stream.ts). Here, only how much has come: no more than a whole trace may be.
        if (message.piece !== undefined && !this.passOn(pending, { kind: "piece", json: message.piece })) break;
        // A word from the tracer: the watchdog waits again from now.
        clearTimeout(pending.timer);
        pending.timer = window.setTimeout(() => this.silent(message.runId), this.timeoutMs);
        pending.progress?.(progressOf(message.progress)!);
        break;
      }
      case "streamed": {
        const pending = this.pending;
        if (pending?.runId !== message.runId) break;
        if (!this.passOn(pending, { kind: "end", json: message.json })) break;
        this.settle(message.runId, { kind: "streamed", elapsedMs: message.elapsedMs });
        break;
      }
      case "crash":
        if (this.measuring?.runId === message.runId) this.settleMeasure({ kind: "crash", message: message.message });
        else this.settle(message.runId, { kind: "crash", message: message.message });
        break;
      case "measureProgress":
        if (this.measuring?.runId === message.runId && !dataLimitProblem(message.progress, MESSAGE_LIMITS)) {
          this.measuring.progress(message.progress);
        }
        break;
      case "measured": {
        if (this.measuring?.runId !== message.runId) break;
        const problem = dataLimitProblem(message.result, MESSAGE_LIMITS);
        this.settleMeasure(
          problem
            ? { kind: "crash", message: `the measurement isn't one the app can use: ${problem}` }
            : { kind: "measured", result: message.result },
        );
        break;
      }
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
   * Check the trace before anything uses it (trace/checkTrace.ts): its
   * limits, and the trace schema. A tracer that sends the wrong shape, or a
   * program that tampers with its trace, then fails here, naming the field,
   * rather than somewhere deep in the renderer.
   */
  private settleChecked(runId: number, trace: Trace, elapsedMs: number): void {
    if (!this.pending || this.pending.runId !== runId) return;
    const problem = traceProblem(trace);
    if (!problem) {
      this.settle(runId, { kind: "trace", trace, elapsedMs });
      return;
    }
    if (import.meta.env.DEV)
      console.error("Trace doesn't match the trace format (schema/trace.schema.json):", problem, trace);
    this.settle(runId, { kind: "crash", message: `the trace doesn't match the trace format: ${problem}` });
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
      this.worker?.postMessage(message);
    });
  }

  /** Stop a Measure run now: the worker is busy running the program, so it's restarted. */
  stopMeasure(reason: "person" | "unresponsive" = "person"): void {
    if (!this.measuring) return;
    this.worker?.terminate();
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

  /**
   * Stop the run going now (the person pressed Stop). The worker is busy
   * running the program, so it's ended and a fresh one started; the run
   * ends with what had arrived (a trace stopped by the person), or
   * "stopped" when nothing had yet.
   */
  /** The tracer has said nothing for too long (see run): the worker is stopped, and a fresh one started. */
  private silent(runId: number): void {
    const pending = this.pending;
    if (pending?.runId !== runId) return;
    this.worker?.terminate();
    this.pending = null;
    pending.resolve({ kind: "timeout", seconds: Math.round(this.timeoutMs / 1000) });
    this.start();
  }

  stop(): void {
    const pending = this.pending;
    if (!pending) return;
    this.worker?.terminate();
    this.settle(pending.runId, { kind: "stopped", arrived: pending.pieces > 0 });
    this.start();
  }

  /** Pass a piece of the trace on (feed); false (the run ended as a crash) once the pieces are more than a trace may be. */
  private passOn(pending: Pending, part: TracePart): boolean {
    pending.chars += part.json.length;
    if (pending.chars > MAX_TRACE_CHARS) {
      this.settle(pending.runId, {
        kind: "crash",
        message: "the trace isn't one the app can use: the trace is too big",
      });
      return false;
    }
    if (part.kind === "piece") pending.pieces++;
    pending.feed?.(part);
    return true;
  }

  /**
   * Run code. Only one run is in flight at a time; callers should await.
   * `progress`: how far it's got, every quarter second or so (Python,
   * JavaScript, TypeScript). `feed`: each piece of the trace, as sent and unread, for
   * the layout worker (layout/), which builds the trace and checks it.
   */
  run(
    source: string,
    maxSteps: number,
    maxSeconds: number,
    sampling: SamplingPolicy,
    progress?: (progress: RunProgress) => void,
    feed?: (part: TracePart) => void,
  ): Promise<RunOutcome> {
    if (this.busy) throw new Error("A run is already in progress");
    const failure = this.unavailable();
    if (failure) return Promise.resolve(failure);
    const runId = this.nextRunId++;
    return new Promise((resolve) => {
      // The watchdog: the tracer says how it's getting on every quarter second, so this long without a
      // word means the program is stuck where the tracer can't stop it (one long built-in call). Each
      // word puts it off again (silence, not the run's length: a long run stops on its own time limit).
      // The first run also waits for Pyodide to load, so it gets extra time while not ready.
      const limit = this.isReady ? this.timeoutMs : this.timeoutMs + 60_000;
      const timer = window.setTimeout(() => this.silent(runId), limit);
      this.pending = {
        runId,
        resolve,
        timer,
        pieces: 0,
        chars: 0,
        ...(progress ? { progress } : {}),
        ...(feed ? { feed } : {}),
      };
      if (this.isReady) this.setStatus({ kind: "running" });
      const message: ToWorker = { type: "run", runId, source, maxSteps, maxSeconds, sampling };
      this.worker?.postMessage(message);
    });
  }
}
