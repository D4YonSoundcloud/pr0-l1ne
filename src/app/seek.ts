/**
 * Finding a step by the line it's at: "run to a line", forward or back, as
 * a debugger's breakpoint stops there, but both ways through the recorded
 * run. A step is at a line when that line is the one about to run (the
 * editor's blue mark); for SQL, when its clause is the one the step shows.
 * Worked out from what the page knows of the trace (trace/summary.ts).
 */
import type { TraceInfo } from "../trace/summary";

/** Steps that happen once a line has run (a return, an error, a yield, an await): not stopped at again. */
const AFTER_A_LINE = new Set(["return", "exception", "yield", "await"]);

/**
 * The line a step is at, or null when it's at none: the line about to run
 * (the editor's blue mark, stepView.ts), or a call's `def`. Not a step that
 * happens once its line has run ("sum() returns 6", "Program finished"):
 * a line is stopped at once each time it runs, as at a breakpoint.
 */
export function lineAt(trace: TraceInfo, step: number): number | null {
  const stage = trace.stages?.[step];
  if (stage) return stage.line;
  const line = trace.lines[step];
  // A call into the program from outside it ("called Global") isn't at a line.
  if (line === undefined || line < 1 || AFTER_A_LINE.has(trace.events[step])) return null;
  return line;
}

/**
 * The next step after `from` at `line` (`back`: the step before it that's
 * at it), no earlier than `first` (the timeline's first step), or null when
 * there's none that way.
 */
export function stepAtLine(trace: TraceInfo, line: number, from: number, back: boolean, first = 0): number | null {
  if (back) {
    for (let i = Math.min(from - 1, trace.steps - 1); i >= first; i--) if (lineAt(trace, i) === line) return i;
  } else {
    for (let i = Math.max(from + 1, first); i < trace.steps; i++) if (lineAt(trace, i) === line) return i;
  }
  return null;
}

/** The steps at a line: the first, the last, and how many. */
export interface LineSpan {
  first: number;
  last: number;
  steps: number;
}

/** Each line's steps, from `first` on (the lines a step can be run to). */
export function lineSpans(trace: TraceInfo, first = 0): Map<number, LineSpan> {
  const spans = new Map<number, LineSpan>();
  for (let i = first; i < trace.steps; i++) {
    const line = lineAt(trace, i);
    if (line === null) continue;
    const span = spans.get(line);
    if (span) {
      span.last = i;
      span.steps++;
    } else spans.set(line, { first: i, last: i, steps: 1 });
  }
  return spans;
}

/** How many recorded steps are at each line, from `first` on (the lines a step can be run to). */
export function stepsPerLine(trace: TraceInfo, first = 0): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = first; i < trace.steps; i++) {
    const line = lineAt(trace, i);
    if (line !== null) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}
