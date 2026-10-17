/**
 * Loads the Python tracer's modules (src/worker/*.py, not the tests) into
 * Pyodide as files, and imports them the normal way, so each module can
 * import the others (`from sizes import size64`). Used by the worker in the
 * browser and by the Node tests (src/testing/pythonTracer.ts), so both run
 * the tracer the same way.
 */

/** Where the modules go in Pyodide's virtual file system. */
export const PYTHON_DIR = "/pr0l1ne";

/** The small part of the Pyodide API this needs. */
export interface PyodideFiles {
  FS: { mkdirTree(path: string): void; writeFile(path: string, data: string): void };
  runPython(code: string): unknown;
  pyimport(name: string): unknown;
}

/** The tracer's entry points, called from JavaScript. */
export interface PythonTracer {
  /** samplingJson: the run's SamplingPolicy (trace/policy.ts), as JSON. */
  runTrace(source: string, maxSteps: number, maxSeconds: number, samplingJson: string): string;
  runMeasure(source: string, limitMs: number, report: (json: string) => void, overridesJson?: string): string;
}

/** A module's file name (`tracer.py`) from a path (`./tracer.py`, `/x/y/tracer.py`). */
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The tracer's own modules: Python files that aren't tests. */
export const isTracerModule = (path: string) => path.endsWith(".py") && !fileName(path).startsWith("test_");

/**
 * Write the modules (`{ "./tracer.py": source }`) into Pyodide and import
 * the tracer and Measure. The directory goes at the end of the import path,
 * so the standard library always wins over a module of ours.
 */
export function loadPythonTracer(pyodide: PyodideFiles, files: Record<string, string>): PythonTracer {
  pyodide.FS.mkdirTree(PYTHON_DIR);
  for (const [path, source] of Object.entries(files)) {
    if (isTracerModule(path)) pyodide.FS.writeFile(`${PYTHON_DIR}/${fileName(path)}`, source);
  }
  pyodide.runPython(
    `import sys\nif ${JSON.stringify(PYTHON_DIR)} not in sys.path: sys.path.append(${JSON.stringify(PYTHON_DIR)})`,
  );
  const tracer = pyodide.pyimport("tracer") as { run_trace: PythonTracer["runTrace"] };
  const measure = pyodide.pyimport("measure") as { run_measure: PythonTracer["runMeasure"] };
  return { runTrace: tracer.run_trace, runMeasure: measure.run_measure };
}
