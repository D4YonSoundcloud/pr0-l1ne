/**
 * Runs the Python tracer's and measure's tests inside Pyodide, the same CPython build
 * (3.12, 32-bit WebAssembly) the app runs in the browser, using the pyodide
 * npm package. It catches what testing on a desktop Python can't, like
 * bytecode differences between Python versions, and checks that sizes
 * converted from 32-bit match a 64-bit Python.
 *
 *   npm run test:pyodide
 */

import { readFileSync } from "node:fs";
import { loadPyodide } from "pyodide";

const dir = new URL("../src/worker/", import.meta.url);
const pyodide = await loadPyodide({ env: { PYTHONHASHSEED: "0" } }); // as the app does
for (const file of [
  "tracer.py",
  "test_tracer.py",
  "test_serializer.py",
  "test_analysis.py",
  "measure.py",
  "test_measure.py",
]) {
  pyodide.FS.writeFile(`/home/pyodide/${file}`, readFileSync(new URL(file, dir), "utf8"));
}
const [ok, report] = pyodide
  .runPython(`
import sys, io, unittest
sys.path.insert(0, "/home/pyodide")
import test_tracer, test_serializer, test_analysis, test_measure
stream = io.StringIO()
suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromModule(m) for m in (test_tracer, test_serializer, test_analysis, test_measure)])
result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
(result.wasSuccessful(), f"Python {sys.version.split()[0]} in Pyodide\\n" + stream.getvalue())
`)
  .toJs();
console.log(report);
process.exit(ok ? 0 : 1);
