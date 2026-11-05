/**
 * Messages between the page (layout/client.ts) and the layout worker
 * (layout/layout.worker.ts). Both are the app's own code, on the app's own
 * site; what the trace says came from the program, and the page passes
 * its pieces on unread: they're checked here as they arrive
 * (layout/intake.ts, trace/stream.ts).
 */
import type { WireDrawing } from "../render/wire";
import type { Estimate } from "../trace/complexity";
import type { Measurement } from "../trace/measurement";
import type { TraceInfo } from "../trace/summary";
import type { Trace } from "../trace/types";
import type { Progress } from "../trace/work";
import type { TracePart } from "../worker/runner";
import type { LoopLaidOut, LoopShow, LoopView, MemoryLaidOut, MemoryShow, MemoryView } from "./requests";

export type ToLayout =
  /** A run starts: its pieces come next. */
  | { type: "begin" }
  | { type: "feed"; part: TracePart }
  /** Draw from this trace now (its pieces, what had arrived when stopped, or this one), once prepared. */
  | { type: "load"; load: number; how: "whole" | "streamed" | "stopped"; trace?: Trace }
  /** `perf`: time each stage (src/perf.ts), and send the times back with the drawing (the page opened with ?perf). */
  | { type: "memory"; id: number; channel: number; show: MemoryShow; view: MemoryView; perf?: boolean }
  | { type: "loop"; id: number; channel: number; show: LoopShow; view: LoopView; perf?: boolean }
  /** The page lost track of a window's marks (render/wire.ts): send them all afresh. */
  | { type: "reset"; channel: number }
  /** The complexity estimate, with Measure's counts for the same code. */
  | { type: "estimate"; id: number; measurement: Measurement | null }
  | { type: "release"; channel: number };

export type FromLayout =
  | { type: "progress"; load: number; progress: Progress }
  /**
   * Prepared: what the page knows of it (`info`); or nothing had arrived
   * when the run was stopped (`info` null); or it couldn't be used
   * (`error`: said as a crash).
   */
  | { type: "loaded"; load: number; info: TraceInfo | null; error?: string }
  | { type: "estimate"; id: number; estimate: Estimate | null }
  | { type: "memory"; id: number; laidOut: MemoryLaidOut<WireDrawing> | null; error?: string; perf?: PerfTimes }
  | { type: "loop"; id: number; laidOut: LoopLaidOut<WireDrawing> | null; error?: string; perf?: PerfTimes };

/** Times recorded in the worker, by stage (src/perf.ts), for the page's own record. */
export type PerfTimes = [stage: string, ms: number[]][];
