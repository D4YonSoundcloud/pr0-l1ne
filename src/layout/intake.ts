/**
 * A run's trace as it reaches the layout (the layout worker, or the page
 * when there's none): its pieces as they arrive, rebuilt and checked
 * (trace/stream.ts), then the whole of it, what had arrived when the person
 * stopped the run, or a trace sent whole (SQL's).
 *
 * The pieces came from the program's side and were passed on unread, so
 * this is where they're checked: a piece that isn't one ends that trace,
 * and taking it says why, in the words the run controller shows as a crash.
 */
import { TraceFormatError, TraceStream } from "../trace/stream";
import type { Trace } from "../trace/types";
import type { TracePart } from "../worker/runner";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What went wrong with a trace, as the crash banner says it. */
function problem(error: unknown): string {
  return error instanceof TraceFormatError
    ? `the trace doesn't match the trace format: ${error.message}`
    : `the trace isn't one the app can use: ${errorText(error)}`;
}

export class TraceIntake {
  private stream: TraceStream | null = null;
  /** The streamed trace, once all of it has arrived. */
  private finished: Trace | null = null;
  /** Why the trace arriving can't be used (a piece that isn't one). */
  private failed: string | null = null;

  /** A run starts: its pieces come next. */
  begin(): void {
    this.stream = new TraceStream();
    this.finished = null;
    this.failed = null;
  }

  feed(part: TracePart): void {
    if (!this.stream || this.failed) return;
    try {
      if (part.kind === "piece") this.stream.add(part.json);
      else this.finished = this.stream.finish(part.json);
    } catch (error) {
      this.failed = problem(error);
      if (import.meta.env?.DEV && error instanceof TraceFormatError)
        console.error("Trace doesn't match the trace format (schema/trace.schema.json):", error.message);
    }
  }

  /**
   * The trace to draw: the whole of what was fed, what had arrived when the
   * run was stopped (null if nothing had), or `whole`. Throws, saying why,
   * when it can't be used.
   */
  take(how: "whole" | "streamed" | "stopped", whole: Trace | null): Trace | null {
    const failed = this.failed;
    const stream = this.stream;
    const finished = this.finished;
    this.stream = null;
    this.finished = null;
    this.failed = null;
    if (how === "whole") {
      if (!whole) throw new Error("the trace didn't arrive");
      return whole;
    }
    if (failed) throw new Error(failed);
    if (how === "stopped") {
      try {
        return stream?.partial() ?? null;
      } catch (error) {
        throw new Error(problem(error));
      }
    }
    if (!finished) throw new Error("the trace didn't arrive");
    return finished;
  }
}
