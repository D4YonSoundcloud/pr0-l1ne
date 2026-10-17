import type { Measurement, MeasureProgress } from "../trace/measurement";
import type { SamplingPolicy } from "../trace/policy";
import type { Trace } from "../trace/types";

/** Messages the main thread sends to the worker. */
export type ToWorker =
  /** Trace: the budget for this run, and how to sample long loops (trace/policy.ts), so both tracers follow the same rules. */
  | { type: "run"; runId: number; source: string; maxSteps: number; maxSeconds: number; sampling: SamplingPolicy }
  /** Run at full size with counters (see trace/measurement.ts). */
  | { type: "measure"; runId: number; source: string; limitMs: number; overrides?: Record<string, number> };

/** Messages the worker sends back. */
export type FromWorker =
  /** `label` is shown in the status bar, e.g. "Python 3.12.7". */
  | { type: "ready"; label: string }
  | { type: "loadError"; message: string }
  | { type: "result"; runId: number; trace: Trace; elapsedMs: number }
  | { type: "crash"; runId: number; message: string }
  | { type: "measureProgress"; runId: number; progress: MeasureProgress }
  | { type: "measured"; runId: number; result: Measurement };
