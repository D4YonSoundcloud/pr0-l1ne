import type { Trace } from "../trace/types";

/** Messages the main thread sends to the worker. */
export type ToWorker = { type: "run"; runId: number; source: string; maxSteps: number };

/** Messages the worker sends back. */
export type FromWorker =
  /** `label` is shown in the status bar, e.g. "Python 3.12.7". */
  | { type: "ready"; label: string }
  | { type: "loadError"; message: string }
  | { type: "result"; runId: number; trace: Trace; elapsedMs: number }
  | { type: "crash"; runId: number; message: string };
