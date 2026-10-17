import type { Measurement, MeasureProgress } from "../trace/measurement";
import type { SamplingPolicy } from "../trace/policy";
import type { Trace } from "../trace/types";

/**
 * The version of these messages. A worker says which it speaks in "ready";
 * the page refuses one that differs (a worker cached from before a deploy,
 * talking to a newer page), rather than misreading its messages. Raise it
 * whenever a message changes shape.
 */
export const PROTOCOL_VERSION = 1;

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
  | { type: "result"; runId: number; trace: Trace; elapsedMs: number }
  /** The tracer itself failed: a bug in PR0L1NE, not in the program. */
  | { type: "crash"; runId: number; message: string }
  | { type: "measureProgress"; runId: number; progress: MeasureProgress }
  | { type: "measured"; runId: number; result: Measurement };
