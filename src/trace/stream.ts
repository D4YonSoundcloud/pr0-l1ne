/**
 * A trace that arrives while it runs. The tracers (worker/tracer.py,
 * js/serve.ts) report every quarter second how far they've got
 * (RunProgress, which the page reads), with the steps recorded since the
 * last report (a piece, JSON the page passes on to the layout worker
 * unread), as deltas (trace/delta.ts), with what the program printed since
 * and its counts. The first piece also carries the trace's header:
 * everything worked out before the program ran (its loops, index names,
 * hints, cost).
 *
 * The layout worker rebuilds the pieces into full steps as they arrive, so
 * the end of a long run costs little; and when the person presses Stop,
 * the runner is ended and the trace is what had arrived (`partial`), its
 * last quarter second or so of steps lost.
 *
 * Everything here comes from the program's side, so it's checked: each
 * piece parses as JSON of the right shape, within limits, and each step is
 * checked as it's rebuilt (checkTrace.ts TraceCheck), while the program
 * still runs; at the end, only the last steps and the trace around them
 * are left to check.
 */
import { TraceCheck } from "./checkTrace";
import { HeapExpander } from "./delta";
import type { Step, Trace } from "./types";

/** How far a run has got. */
export interface RunProgress {
  /** Steps recorded so far. */
  steps: number;
  /** Seconds the program has been running. */
  seconds: number;
  /** The line running now. */
  line: number;
}

/** A piece of the trace, as a tracer sends it (as JSON): the steps since the last piece. */
export interface TracePiece {
  /** The trace without its steps, stdout or counts: sent once, in the first piece. */
  header?: Omit<Trace, "steps" | "stdout" | "counts">;
  /** Steps recorded since the last piece, as deltas. */
  steps: Step[];
  /** What the program printed since the last piece. */
  stdout: string;
  counts?: Trace["counts"];
}

/** Text a run's pieces may add up to, at most (as much as a whole trace may be: checkTrace.ts's message limit). */
export const MAX_TRACE_CHARS = 50_000_000;

/** A trace (or piece of one) that doesn't match the trace format: a crash, saying why. */
export class TraceFormatError extends Error {}

const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** A report's progress, if it's of the right shape. */
export function progressOf(value: unknown): RunProgress | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  return isNumber(p.steps) && isNumber(p.seconds) && isNumber(p.line)
    ? { steps: p.steps as number, seconds: p.seconds as number, line: p.line as number }
    : null;
}

export class TraceStream {
  private header: Omit<Trace, "steps" | "stdout" | "counts"> | null = null;
  private readonly steps: Step[] = [];
  private stdout = "";
  private counts: Trace["counts"] | undefined;
  private chars = 0;
  private readonly expander = new HeapExpander();
  private readonly check = new TraceCheck();

  /** Rebuild a step as sent, check it, and keep it. */
  private keep(sent: Step): void {
    const step = this.expander.add(sent);
    const problem = this.check.step(step, this.steps.length);
    if (problem) throw new TraceFormatError(problem);
    this.steps.push(step);
  }

  /** The trace, checked whole (its steps were as they came). */
  private checked(trace: Trace): Trace {
    const problem = this.check.whole(trace);
    if (problem) throw new TraceFormatError(problem);
    return trace;
  }

  /** Steps that have arrived. */
  get received(): number {
    return this.steps.length;
  }

  /** Take a piece (JSON from the tracer, TracePiece): its steps rebuilt, checked and kept. Throws on one that isn't a piece. */
  add(json: string): void {
    this.chars += json.length;
    if (this.chars > MAX_TRACE_CHARS) throw new Error("the trace is too big");
    const piece = JSON.parse(json) as TracePiece;
    if (typeof piece !== "object" || piece === null || !Array.isArray(piece.steps) || typeof piece.stdout !== "string")
      throw new Error("a piece of the trace isn't one");
    if (piece.header !== undefined) {
      if (typeof piece.header !== "object" || piece.header === null) throw new Error("the trace's header isn't one");
      this.header = piece.header;
    }
    for (const step of piece.steps) this.keep(step);
    this.stdout += piece.stdout;
    if (piece.counts !== undefined) this.counts = piece.counts;
  }

  /**
   * The finished trace: what arrived, then the rest, JSON of `{ trace,
   * skippedAfter? }`: the trace, its steps the ones not sent yet (as
   * deltas) and its stdout whole, and the events after the last recorded step when that step
   * had already been sent.
   */
  finish(json: string): Trace {
    this.chars += json.length;
    if (this.chars > MAX_TRACE_CHARS) throw new Error("the trace is too big");
    const end = JSON.parse(json) as { trace: Trace; skippedAfter?: number };
    const rest = end?.trace;
    const skippedAfter = end?.skippedAfter;
    if (typeof rest !== "object" || rest === null || !Array.isArray(rest.steps)) throw new Error("the trace isn't one");
    const steps = this.steps;
    for (const step of rest.steps) this.keep(step);
    const trace: Trace = { ...rest, steps };
    delete trace.heapDelta;
    if (skippedAfter && steps.length && isNumber(skippedAfter)) steps[steps.length - 1].skippedAfter = skippedAfter;
    return this.checked(trace);
  }

  /** What had arrived when the person stopped the run, as a trace (checked); null when nothing had. */
  partial(): Trace | null {
    if (!this.header || !this.steps.length) return null;
    const trace: Trace = {
      ...this.header,
      steps: this.steps,
      stdout: this.stdout,
      error: null,
      truncated: true,
      stoppedBy: "person",
    };
    if (this.counts) trace.counts = this.counts;
    delete trace.heapDelta;
    return this.checked(trace);
  }
}
