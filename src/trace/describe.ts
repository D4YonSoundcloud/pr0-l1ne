/**
 * What a step did, in words: the step label under the timeline ("Ran line
 * 5, next is line 6"). Worked out where the trace is (trace/summary.ts).
 */
import type { Step } from "./types";

/** What a step did, in words, for the step label. */
export function describe(step: Step, prev: Step | undefined): string {
  const frame = step.stack[step.stack.length - 1];
  const func = frame?.func ?? "Global";
  switch (step.event) {
    case "call":
      return func === "Global" ? "Program starts" : `Called ${func}()`;
    case "line":
      // Matches the editor: yellow is the line that ran, blue is next.
      return prev && prev.line >= 1 && prev.event === "line"
        ? `Ran line ${prev.line}, next is line ${step.line}`
        : `Next is line ${step.line}`;
    case "return": {
      if (func === "Global") return "Program finished";
      const value = step.returnValue;
      const shown = value?.kind === "prim" ? value.repr : "an object";
      return `${func}() returns ${shown}`;
    }
    case "exception":
      return `${step.exception?.type ?? "Error"} raised on line ${step.line}`;
    case "yield": {
      const value = step.returnValue;
      if (!value) return `${func}() hands over to another generator`;
      return `${func}() yields ${value.kind === "prim" ? value.repr : "an object"} and pauses`;
    }
    case "await":
      return `${func}() waits at line ${step.line} and pauses`;
    case "resume":
      return `${func}() resumes at line ${step.line}`;
  }
}
