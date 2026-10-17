/// <reference lib="webworker" />
/**
 * Runs in a Web Worker so user code can never freeze the page.
 *
 * Loads Pyodide (CPython compiled to WebAssembly) from the jsDelivr CDN,
 * loads the tracer's modules into it (pythonModules.ts), then answers "run"
 * messages with a Trace and "measure" messages with a Measurement.
 */
import { expandHeaps } from "../trace/delta";
import type { Trace } from "../trace/types";
import type { FromWorker, ToWorker } from "./protocol";
import { loadPythonTracer, type PyodideFiles } from "./pythonModules";

/** The tracer's Python files, bundled as text (every .py here; loadPythonTracer skips the tests). */
const PYTHON_FILES = import.meta.glob<string>(["./*.py", "!./test_*.py"], {
  query: "?raw",
  import: "default",
  eager: true,
});

// Pyodide 0.27.x ships CPython 3.12. The npm package on jsDelivr contains the
// core interpreter and standard library, which is all the tracer needs.
export const PYODIDE_VERSION = "0.27.8";
const INDEX_URL = `https://cdn.jsdelivr.net/npm/pyodide@${PYODIDE_VERSION}/`;

/** The small part of the Pyodide API we use. */
interface Pyodide extends PyodideFiles {
  version: string;
}

type RunTrace = (source: string, maxSteps: number, maxSeconds: number) => string;
type RunMeasure = (source: string, limitMs: number, report: (json: string) => void, overridesJson?: string) => string;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker) => ctx.postMessage(message);

let runTrace: RunTrace | null = null;
let runMeasure: RunMeasure | null = null;
const queue: ToWorker[] = [];

async function boot(): Promise<void> {
  try {
    const module = await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`);
    // A fixed hash seed: sets of strings come out in the same order on every
    // run and every page load (Python randomizes it by default), so a
    // program's output and drawing are repeatable.
    const pyodide: Pyodide = await module.loadPyodide({ indexURL: INDEX_URL, env: { PYTHONHASHSEED: "0" } });
    ({ runTrace, runMeasure } = loadPythonTracer(pyodide, PYTHON_FILES));
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
  if (message.type === "measure") {
    try {
      const runId = message.runId;
      const report = (json: string) => post({ type: "measureProgress", runId, progress: JSON.parse(json) });
      const json = runMeasure!(
        message.source,
        message.limitMs,
        report,
        message.overrides ? JSON.stringify(message.overrides) : undefined,
      );
      post({ type: "measured", runId, result: JSON.parse(json) });
    } catch (error) {
      post({ type: "crash", runId: message.runId, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const started = performance.now();
  try {
    const json = runTrace(message.source, message.maxSteps, message.maxSeconds);
    // Rebuilt here, so the page gets heaps that share unchanged objects.
    const trace = expandHeaps(JSON.parse(json) as Trace);
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
