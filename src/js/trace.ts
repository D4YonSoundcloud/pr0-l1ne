/**
 * Runs JavaScript (or, via typescript.ts, TypeScript) source and returns a
 * Trace, the same format tracer.py produces. Pure functions only, so it works in the worker and in tests.
 */
import type { Trace } from "../trace/types";
import { RUNTIME, InstrumentError, instrument, type Instrumented } from "./instrument";
import { Runtime } from "./runtime";

export function traceJavaScript(source: string, maxSteps = 2000): Promise<Trace> {
  return traceProgram(source, maxSteps, "javascript", instrument);
}

/** Most turns of the event loop to run before giving up (setInterval forever). */
const MAX_TURNS = 10_000;

/**
 * Wait for a macrotask: every pending microtask (promise callbacks, so every
 * async function that can continue) runs first. MessageChannel is used
 * because nested setTimeout(0) is slowed to 4 ms by browsers.
 */
function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "function") {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Catch promise rejections nobody handled (an async function that threw,
 * with no await or .catch on it): the browser worker reports them as an
 * event, Node through its process object.
 */
function onUnhandledRejection(handler: (reason: unknown) => void): () => void {
  const proc = (globalThis as { process?: { on?: Function; off?: Function } }).process;
  if (proc?.on && proc.off) {
    const listener = (reason: unknown) => handler(reason);
    proc.on("unhandledRejection", listener);
    return () => proc.off!("unhandledRejection", listener);
  }
  const target = globalThis as unknown as EventTarget;
  if (typeof target.addEventListener === "function") {
    const listener = (event: Event) => {
      event.preventDefault();
      handler((event as PromiseRejectionEvent).reason);
    };
    target.addEventListener("unhandledrejection", listener);
    return () => target.removeEventListener("unhandledrejection", listener);
  }
  return () => {};
}

/**
 * Instrument with the given function (JavaScript or TypeScript), run, and
 * trace. Runs the program's script, then its async work and timers, the way
 * a browser would, until there's nothing left to do.
 */
export async function traceProgram(
  source: string,
  maxSteps: number,
  language: "javascript" | "typescript",
  instrumenter: (source: string) => Instrumented,
): Promise<Trace> {
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
  if (program.hints.length) trace.hints = program.hints;
  if (program.cost) trace.cost = program.cost;

  const runtime = new Runtime(maxSteps);
  let stopped = false;
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    if (error === runtime.ABORT || runtime.isAborted) {
      trace.truncated = true;
    } else {
      trace.error = {
        type: error instanceof Error ? error.name : "Uncaught",
        message: error instanceof Error ? error.message : String(error),
        line: runtime.errorLine(error),
      };
    }
  };
  const stopListening = onUnhandledRejection(fail);

  try {
    // The program sees our runtime, a console that prints into the trace,
    // and virtual timers.
    const { setTimeout, setInterval, clearTimeout, clearInterval } = runtime.timerApi;
    const run = new Function(RUNTIME, "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval", program.code);
    try {
      run(runtime, runtime.console, setTimeout, setInterval, clearTimeout, clearInterval);
    } catch (error) {
      fail(error);
    }
    // The event loop: let async functions continue, then run timers in
    // order, until nothing is left (or something went wrong).
    for (let turn = 0; turn < MAX_TURNS && !stopped; turn++) {
      await macrotask();
      if (stopped || runtime.isAborted) break;
      const timer = runtime.nextTimer();
      if (!timer) break;
      try {
        timer();
      } catch (error) {
        fail(error);
      }
    }
    await macrotask(); // let a last rejection be reported
    if (runtime.isAborted) fail(runtime.ABORT);
    if (!stopped) runtime.finish();
  } finally {
    stopListening();
    runtime.close();
  }
  trace.steps = runtime.steps;
  trace.stdout = runtime.stdout;
  return trace;
}
