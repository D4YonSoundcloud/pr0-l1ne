/**
 * Runs the Python tracer's and measure's tests inside Pyodide, the same CPython build
 * (3.12, 32-bit WebAssembly) the app runs in the browser, using the pyodide
 * npm package. It catches what testing on a desktop Python can't, like
 * bytecode differences between Python versions, and checks that sizes
 * converted from 32-bit match a 64-bit Python.
 *
 *   npm run test:pyodide
 */

import { readdirSync, readFileSync } from "node:fs";
import { loadPyodide } from "pyodide";

const dir = new URL("../src/worker/", import.meta.url);
const pyodide = await loadPyodide({ env: { PYTHONHASHSEED: "0" } }); // as the app does
// Every Python file, as the app loads them (src/worker/pythonModules.ts), plus the tests.
const files = readdirSync(dir).filter((f) => f.endsWith(".py"));
pyodide.FS.mkdirTree("/pr0l1ne");
for (const file of files) pyodide.FS.writeFile(`/pr0l1ne/${file}`, readFileSync(new URL(file, dir), "utf8"));
// The shape corpus (see test_shape.py), found from the tests by its folder.
pyodide.FS.mkdirTree("/fixtures/shapes");
pyodide.FS.writeFile(
  "/fixtures/shapes/python.json",
  readFileSync(new URL("../fixtures/shapes/python.json", import.meta.url), "utf8"),
);
const tests = files.filter((f) => f.startsWith("test_")).map((f) => f.slice(0, -3));
const [ok, report] = pyodide
  .runPython(`
import sys, io, importlib, unittest
sys.path.append("/pr0l1ne")
modules = [importlib.import_module(name) for name in ${JSON.stringify(tests)}]
stream = io.StringIO()
suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromModule(m) for m in modules])
result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
(result.wasSuccessful(), f"Python {sys.version.split()[0]} in Pyodide\\n" + stream.getvalue())
`)
  .toJs();
console.log(report);
process.exit(ok ? 0 : 1);
