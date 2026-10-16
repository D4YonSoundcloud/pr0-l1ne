/**
 * Golden traces: every example, in every language, traced and compared with
 * the trace saved in fixtures/traces/. Any change in what a tracer records
 * shows up here as a diff of the steps it touched.
 *
 * When a change is intended, accept it with
 *   npm run test:golden -- -u
 * and commit the updated fixtures with the change, so the pull request
 * shows exactly what moved.
 *
 * Traces use the app's step budget (20,000) and a generous time budget, so
 * they stop on steps, never on the clock, and come out the same on any
 * machine. Python runs in Pyodide, the same Python the browser runs.
 */
import { readFileSync } from "node:fs";
import { loadPyodide } from "pyodide";
import { beforeAll, describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { goldenText, slug } from "../trace/golden";
import type { Trace } from "../trace/types";
import { type Example, JAVASCRIPT_EXAMPLES, PYTHON_EXAMPLES, TYPESCRIPT_EXAMPLES } from "./index";

const MAX_STEPS = 20_000; // as src/main.ts
const MAX_SECONDS = 600; // never the reason a trace stops

const fixture = (language: string, example: Example) => `../../fixtures/traces/${language}/${slug(example.name)}.json`;

describe("golden traces: JavaScript", () => {
  for (const example of JAVASCRIPT_EXAMPLES) {
    it(example.name, async () => {
      const trace = await traceJavaScript(example.code, MAX_STEPS, MAX_SECONDS);
      await expect(goldenText(trace)).toMatchFileSnapshot(fixture("javascript", example));
    });
  }
});

describe("golden traces: TypeScript", () => {
  for (const example of TYPESCRIPT_EXAMPLES) {
    it(example.name, async () => {
      const trace = await traceTypeScript(example.code, MAX_STEPS, MAX_SECONDS);
      await expect(goldenText(trace)).toMatchFileSnapshot(fixture("typescript", example));
    });
  }
});

describe("golden traces: Python (in Pyodide)", () => {
  let runTrace: (source: string, maxSteps: number, maxSeconds: number) => string;

  beforeAll(async () => {
    // Set up as src/worker/pyodide.worker.ts does: a fixed hash seed, then the tracer.
    const pyodide = await loadPyodide({ env: { PYTHONHASHSEED: "0" } });
    pyodide.runPython(readFileSync(new URL("../worker/tracer.py", import.meta.url), "utf8"));
    runTrace = pyodide.globals.get("run_trace");
  }, 120_000);

  for (const example of PYTHON_EXAMPLES) {
    it(example.name, async () => {
      const trace = JSON.parse(runTrace(example.code, MAX_STEPS, MAX_SECONDS)) as Trace;
      await expect(goldenText(trace)).toMatchFileSnapshot(fixture("python", example));
    });
  }
});

describe("golden traces: the examples", () => {
  it("have distinct file names in each language", () => {
    for (const list of [PYTHON_EXAMPLES, JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES]) {
      const names = list.map((e) => slug(e.name));
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
