/**
 * Runs JavaScript (or, via typescript.ts, TypeScript) source and returns a
 * Trace, the same format tracer.py produces. Pure functions only, so it works in the worker and in tests.
 */
import { POLICY, type SamplingPolicy } from "../trace/policy";
import type { Trace } from "../trace/types";
import { InstrumentError, type Instrumented, instrument, RUNTIME } from "./instrument";
import { Runtime } from "./runtime";

/** The app passes the budget and the sampling policy with each run; tests and the CLI can leave them to POLICY. */
export function traceJavaScript(
  source: string,
  maxSteps = 2000,
  maxSeconds = POLICY.runSeconds,
  sampling: SamplingPolicy = POLICY.sampling,
): Promise<Trace> {
  return traceProgram(source, maxSteps, "javascript", instrument, maxSeconds, sampling);
}

/** Most turns of the event loop to run before giving up (setInterval forever). */
const MAX_TURNS = 10_000;

/**
 * Wait for a macrotask: every pending microtask (promise callbacks, so every
 * async function that can continue) runs first. MessageChannel is used
 * because nested setTimeout(0) is slowed to 4 ms by browsers.
 */
export function macrotask(): Promise<void> {
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
export function onUnhandledRejection(handler: (reason: unknown) => void): () => void {
  // biome-ignore lint/complexity/noBannedTypes: Node's process.on/off, only looked up to detach its handlers
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
  maxSeconds: number,
  sampling: SamplingPolicy,
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
  if (program.gridAccesses.length) trace.gridAccesses = program.gridAccesses;
  if (program.hints.length) trace.hints = program.hints;
  if (program.cost) trace.cost = program.cost;

  const runtime = new Runtime(maxSteps, maxSeconds, sampling);
  runtime.indexNames = withPointerHints(program.indexNames, program.hints);
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
    const run = new Function(
      RUNTIME,
      "console",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      program.code,
    );
    try {
      run(runtime, runtime.console, setTimeout, setInterval, clearTimeout, clearInterval);
    } catch (error) {
      fail(error);
    }
    // The event loop: let async functions continue, then run timers in
    // order, until nothing is left (or something went wrong).
    for (let turn = 0; !stopped; turn++) {
      await macrotask();
      if (stopped || runtime.isAborted) break;
      const timer = runtime.nextTimer();
      if (!timer) break;
      if (turn >= MAX_TURNS) {
        fail(runtime.ABORT); // timers that never stop (sampled, so not out of steps)
        break;
      }
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
  trace.counts = runtime.counts;
  if (runtime.sampled) trace.sampled = true;
  if (trace.truncated) trace.stoppedBy = runtime.stoppedBy ?? "steps";
  if (runtime.skippedAtEnd && trace.steps.length)
    trace.steps[trace.steps.length - 1].skippedAfter = runtime.skippedAtEnd;
  return trace;
}

/** Index names from the code, plus `viz: pointers nums: lo, hi` hints. */
function withPointerHints(indexNames: Record<string, string[]>, hints: { text: string }[]): Record<string, string[]> {
  const out = { ...indexNames };
  for (const hint of hints) {
    const m = /^pointers\s+([\w.]+(?:\[\])?)\s*:\s*(.+)$/.exec(hint.text);
    if (!m) continue;
    const extra = m[2]
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    out[m[1]] = [...new Set([...(out[m[1]] ?? []), ...extra])].sort();
  }
  return out;
}
