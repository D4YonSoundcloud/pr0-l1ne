/**
 * What a step printed: the text that print() / console.log() added to the
 * output since the step before, the line that printed it, and the printed
 * objects that are drawn at this step.
 */
import type { Trace } from "./types";

export interface Printed {
  text: string;
  /** The line that printed (or, for output the tracer didn't see printed, the line that just ran). */
  line: number;
  /** Heap ids of printed objects (print(nums), console.log(node)). */
  refs: string[];
}

export function printedAt(trace: Trace, stepIndex: number): Printed | null {
  const step = trace.steps[stepIndex];
  if (!step) return null;
  const before = trace.steps[stepIndex - 1]?.stdoutLength ?? 0;
  if (step.stdoutLength <= before) return null;
  const text = trace.stdout.slice(before, step.stdoutLength).replace(/\n$/, "");
  const line = step.output?.line ?? trace.steps[stepIndex - 1]?.line ?? step.line;
  return { text, line, refs: step.output?.refs ?? [] };
}
