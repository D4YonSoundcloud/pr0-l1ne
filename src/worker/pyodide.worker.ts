/// <reference lib="webworker" />
/**
 * Runs in a Web Worker so user code can never freeze the page.
 *
 * Loads Pyodide (CPython compiled to WebAssembly) from the jsDelivr CDN,
 * loads tracer.py into it, then answers "run" messages with a Trace.
 */
import tracerSource from "./tracer.py?raw";
import type { FromWorker, ToWorker } from "./protocol";
import type { Trace } from "../trace/types";

// Pyodide 0.27.x ships CPython 3.12. The npm package on jsDelivr contains the
// core interpreter and standard library, which is all the tracer needs.
export const PYODIDE_VERSION = "0.27.8";
const INDEX_URL = `https://cdn.jsdelivr.net/npm/pyodide@${PYODIDE_VERSION}/`;

/** The small part of the Pyodide API we use. */
interface Pyodide {
  version: string;
  runPython(code: string): unknown;
  globals: { get(name: string): unknown };
}

type RunTrace = (source: string, maxSteps: number) => string;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker) => ctx.postMessage(message);

let runTrace: RunTrace | null = null;
const queue: ToWorker[] = [];

async function boot(): Promise<void> {
  try {
    const module = await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`);
    const pyodide: Pyodide = await module.loadPyodide({ indexURL: INDEX_URL });
    pyodide.runPython(tracerSource);
    runTrace = pyodide.globals.get("run_trace") as RunTrace;
    const pythonVersion = String(pyodide.runPython("import sys; sys.version.split()[0]"));
    post({ type: "ready", label: `Python ${pythonVersion}` });
    while (queue.length) handle(queue.shift()!);
  } catch (error) {
    post({ type: "loadError", message: error instanceof Error ? error.message : String(error) });
  }
}

function handle(message: ToWorker): void {
  if (!runTrace) {
    queue.length = 0; // only the latest run matters
    queue.push(message);
    return;
  }
  const started = performance.now();
  try {
    const json = runTrace(message.source, message.maxSteps);
    const trace = JSON.parse(json) as Trace;
    post({ type: "result", runId: message.runId, trace, elapsedMs: performance.now() - started });
  } catch (error) {
    post({
      type: "crash",
      runId: message.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

ctx.onmessage = (event: MessageEvent<ToWorker>) => handle(event.data);
boot();
