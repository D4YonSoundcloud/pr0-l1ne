import type { Measurement, MeasureProgress } from "../trace/measurement";
import type { SamplingPolicy } from "../trace/policy";
import type { Trace } from "../trace/types";

/**
 * The version of these messages. A worker says which it speaks in "ready";
 * the page refuses one that differs (a worker cached from before a deploy,
 * talking to a newer page), rather than misreading its messages. Raise it
 * whenever a message changes shape.
 */
export const PROTOCOL_VERSION = 2;

/** Messages the main thread sends to the worker. */
export type ToWorker =
  /** Trace: the budget for this run, and how to sample long loops (trace/policy.ts), so both tracers follow the same rules. */
  | { type: "run"; runId: number; source: string; maxSteps: number; maxSeconds: number; sampling: SamplingPolicy }
  /** Run at full size with counters (see trace/measurement.ts). */
  | { type: "measure"; runId: number; source: string; limitMs: number; overrides?: Record<string, number> };

/** Messages the worker sends back. */
export type FromWorker =
  /** `label` is shown in the status bar, e.g. "Python 3.12.7". */
  | { type: "ready"; label: string; protocolVersion: number }
  /** The language runtime couldn't load (usually the network). */
  | { type: "loadError"; message: string }
  /**
   * While the runtime downloads (Python, PostgreSQL): bytes so far, of its
   * files' sizes all together (worker/downloads.ts). A page that doesn't
   * know it ignores it.
   */
  | { type: "loadProgress"; loaded: number; total: number }
  | { type: "result"; runId: number; trace: Trace; elapsedMs: number }
  /**
   * While a run goes (Python, JavaScript, TypeScript): how far it's got,
   * and now and then the steps since the last report, as JSON (a
   * ProgressReport, trace/stream.ts), read and rebuilt on the page.
   */
  | { type: "progress"; runId: number; json: string }
  /**
   * A run that sent progress is done: JSON of `{ trace, skippedAfter? }`,
   * the trace's steps the ones no report sent yet (as deltas), and
   * `skippedAfter` the events after the last recorded step when a report
   * had already sent that step (trace/stream.ts TraceStream.finish).
   */
  | { type: "streamed"; runId: number; json: string; elapsedMs: number }
  /** The tracer itself failed: a bug in PR0L1NE, not in the program. */
  | { type: "crash"; runId: number; message: string }
  | { type: "measureProgress"; runId: number; progress: MeasureProgress }
  | { type: "measured"; runId: number; result: Measurement };
