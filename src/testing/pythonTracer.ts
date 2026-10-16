/**
 * The Python tracer in Pyodide, for tests running in Node: set up as
 * src/worker/pyodide.worker.ts does in the browser (the same Python build,
 * a fixed hash seed, then tracer.py). Loaded once per test file.
 */
import { readFileSync } from "node:fs";
import { loadPyodide } from "pyodide";
import type { Trace } from "../trace/types";

export type TracePython = (source: string, maxSteps: number, maxSeconds: number) => Trace;

let loading: Promise<TracePython> | null = null;

export function pythonTracer(): Promise<TracePython> {
  loading ??= (async () => {
    const pyodide = await loadPyodide({ env: { PYTHONHASHSEED: "0" } });
    pyodide.runPython(readFileSync(new URL("../worker/tracer.py", import.meta.url), "utf8"));
    const runTrace = pyodide.globals.get("run_trace") as (source: string, steps: number, seconds: number) => string;
    return (source, maxSteps, maxSeconds) => JSON.parse(runTrace(source, maxSteps, maxSeconds)) as Trace;
  })();
  return loading;
}
