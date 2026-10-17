/**
 * The Python tracer in Pyodide, for tests running in Node: set up as
 * src/worker/pyodide.worker.ts does in the browser (the same Python build,
 * a fixed hash seed, the same modules loaded the same way). Loaded once per
 * test file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { loadPyodide } from "pyodide";
import type { Trace } from "../trace/types";
import { loadPythonTracer, type PyodideFiles } from "../worker/pythonModules";

export type TracePython = (source: string, maxSteps: number, maxSeconds: number) => Trace;

const WORKER_DIR = new URL("../worker/", import.meta.url);

/** The worker folder's Python files, as the worker bundles them. */
export function pythonFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(WORKER_DIR).filter((f) => f.endsWith(".py"))) {
    files[`./${name}`] = readFileSync(new URL(name, WORKER_DIR), "utf8");
  }
  return files;
}

let loading: Promise<TracePython> | null = null;

export function pythonTracer(): Promise<TracePython> {
  loading ??= (async () => {
    const pyodide = (await loadPyodide({ env: { PYTHONHASHSEED: "0" } })) as unknown as PyodideFiles;
    const { runTrace } = loadPythonTracer(pyodide, pythonFiles());
    return (source, maxSteps, maxSeconds) => JSON.parse(runTrace(source, maxSteps, maxSeconds)) as Trace;
  })();
  return loading;
}
