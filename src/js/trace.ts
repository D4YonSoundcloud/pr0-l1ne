/**
 * Runs JavaScript (or, via typescript.ts, TypeScript) source and returns a
 * Trace, the same format tracer.py produces. Pure functions only, so it works in the worker and in tests.
 */
import type { Trace } from "../trace/types";
import { RUNTIME, InstrumentError, instrument, type Instrumented } from "./instrument";
import { Runtime } from "./runtime";

export function traceJavaScript(source: string, maxSteps = 2000): Trace {
  return traceProgram(source, maxSteps, "javascript", instrument);
}

/** Instrument with the given function (JavaScript or TypeScript), run, and trace. */
export function traceProgram(
  source: string,
  maxSteps: number,
  language: "javascript" | "typescript",
  instrumenter: (source: string) => Instrumented,
): Trace {
  const trace: Trace = {
    version: 1,
    language,
    steps: [],
    loops: [],
    indexNames: {},
    stdout: "",
    error: null,
    truncated: false,
  };

  let program: Instrumented;
  try {
    program = instrumenter(source);
  } catch (error) {
    const line = error instanceof InstrumentError ? error.line : null;
    trace.error = { type: "SyntaxError", message: error instanceof Error ? error.message : String(error), line };
    return trace;
  }
  trace.loops = program.loops;
  trace.indexNames = program.indexNames;

  const runtime = new Runtime(maxSteps);
  try {
    // The program sees our runtime and a console that prints into the trace.
    const run = new Function(RUNTIME, "console", program.code);
    run(runtime, runtime.console);
  } catch (error) {
    if (error === runtime.ABORT) {
      trace.truncated = true;
    } else {
      trace.error = {
        type: error instanceof Error ? error.name : "Uncaught",
        message: error instanceof Error ? error.message : String(error),
        line: runtime.errorLine(error),
      };
    }
  }
  trace.steps = runtime.steps;
  trace.stdout = runtime.stdout;
  return trace;
}
