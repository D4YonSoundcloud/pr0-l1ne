import { describe, expect, it } from "vitest";
import { isTracerModule, loadPythonTracer, PYTHON_DIR, type PyodideFiles } from "./pythonModules";

/** Records what's written and run, and imports from what was written. */
function fakePyodide() {
  const files = new Map<string, string>();
  const ran: string[] = [];
  const pyodide: PyodideFiles = {
    FS: {
      mkdirTree: (path) => void ran.push(`mkdir ${path}`),
      writeFile: (path, data) => void files.set(path, data),
    },
    runPython: (code) => void ran.push(code),
    pyimport: (name) => {
      if (!files.has(`${PYTHON_DIR}/${name}.py`)) throw new Error(`No module named '${name}'`);
      return { run_trace: () => `trace from ${name}`, run_measure: () => `measure from ${name}` };
    },
  };
  return { pyodide, files, ran };
}

describe("loading the Python tracer", () => {
  it("writes the modules as files, not the tests, and imports them", () => {
    const { pyodide, files, ran } = fakePyodide();
    const tracer = loadPythonTracer(pyodide, {
      "./tracer.py": "# tracer",
      "./measure.py": "# measure",
      "./sizes.py": "# sizes",
      "./test_tracer.py": "# a test",
    });
    expect([...files.keys()].sort()).toEqual([
      `${PYTHON_DIR}/measure.py`,
      `${PYTHON_DIR}/sizes.py`,
      `${PYTHON_DIR}/tracer.py`,
    ]);
    expect(files.get(`${PYTHON_DIR}/sizes.py`)).toBe("# sizes");
    expect(ran[0]).toBe(`mkdir ${PYTHON_DIR}`);
    expect(ran[1]).toContain(`sys.path.append("${PYTHON_DIR}")`); // after the standard library
    expect(tracer.runTrace("", 1, 1, "{}")).toBe("trace from tracer");
    expect(tracer.runMeasure("", 1, () => {})).toBe("measure from measure");
  });

  it("fails clearly when a module is missing", () => {
    const { pyodide } = fakePyodide();
    expect(() => loadPythonTracer(pyodide, { "./tracer.py": "" })).toThrow("No module named 'measure'");
  });

  it("knows the tests by their names", () => {
    expect(isTracerModule("./tracer.py")).toBe(true);
    expect(isTracerModule("/a/b/analysis.py")).toBe(true);
    expect(isTracerModule("./test_tracer.py")).toBe(false);
    expect(isTracerModule("./protocol.ts")).toBe(false);
  });
});
