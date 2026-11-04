/**
 * A trace that arrives while it runs. The tracers (worker/tracer.py,
 * js/serve.ts) report every quarter second how far they've got, with the
 * steps recorded since the last report (a piece), as deltas
 * (trace/delta.ts), with what the program printed since and its counts.
 * The first piece also carries the trace's header: everything worked out
 * before the program ran (its loops, index names, hints, cost).
 *
 * Pieces are rebuilt into full steps as they arrive, while the page waits,
 * so the end of a long run costs little; and when the person presses Stop,
 * the worker is ended and the trace is what had arrived (`partial`), its
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

/** What a tracer reports, as JSON: how far it's got, and now and then the steps since the last piece. */
export interface ProgressReport {
  progress: RunProgress;
  chunk?: {
    /** The trace without its steps, stdout or counts: sent once, in the first piece. */
    header?: Omit<Trace, "steps" | "stdout" | "counts">;
    /** Steps recorded since the last piece, as deltas. */
    steps: Step[];
    /** What the program printed since the last piece. */
    stdout: string;
    counts?: Trace["counts"];
  };
}

/** Text a run's pieces may add up to, at most (as much as a whole trace may be: checkTrace.ts's message limit). */
const MAX_CHARS = 50_000_000;

/** A trace (or piece of one) that doesn't match the trace format: a crash, saying why. */
export class TraceFormatError extends Error {}

const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** A report's progress, if it's of the right shape. */
function progressOf(value: unknown): RunProgress | null {
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

  /**
   * Take a report (JSON from the worker): its piece's steps rebuilt and
   * kept, and how far the run has got. Throws on one that isn't a report.
   */
  add(json: string): RunProgress {
    this.chars += json.length;
    if (this.chars > MAX_CHARS) throw new Error("the trace is too big");
    const report = JSON.parse(json) as ProgressReport;
    const progress = progressOf(report?.progress);
    if (!progress) throw new Error("a progress report isn't one");
    const chunk = report.chunk;
    if (chunk !== undefined) {
      if (
        typeof chunk !== "object" ||
        chunk === null ||
        !Array.isArray(chunk.steps) ||
        typeof chunk.stdout !== "string"
      )
        throw new Error("a piece of the trace isn't one");
      if (chunk.header !== undefined) {
        if (typeof chunk.header !== "object" || chunk.header === null) throw new Error("the trace's header isn't one");
        this.header = chunk.header;
      }
      for (const step of chunk.steps) this.keep(step);
      this.stdout += chunk.stdout;
      if (chunk.counts !== undefined) this.counts = chunk.counts;
    }
    return progress;
  }

  /**
   * The finished trace: what arrived, then the rest, JSON of `{ trace,
   * skippedAfter? }`: the trace, its steps the ones not sent yet (as
   * deltas) and its stdout whole, and the events after the last recorded step when that step
   * had already been sent.
   */
  finish(json: string): Trace {
    this.chars += json.length;
    if (this.chars > MAX_CHARS) throw new Error("the trace is too big");
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
