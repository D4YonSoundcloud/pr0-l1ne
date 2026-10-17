/**
 * Golden traces: every example, in every language, traced, checked against
 * the trace schema, and compared with the trace saved in fixtures/traces/. Any change in what a tracer records
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
import { beforeAll, describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { pythonTracer, type TracePython } from "../testing/pythonTracer";
import { goldenText, slug } from "../trace/golden";
import { POLICY } from "../trace/policy";
import { traceProblems } from "../trace/validate";
import { type Example, JAVASCRIPT_EXAMPLES, PYTHON_EXAMPLES, TYPESCRIPT_EXAMPLES } from "./index";

const MAX_STEPS = POLICY.maxSteps; // as the app
const MAX_SECONDS = 600; // never the reason a trace stops

const fixture = (language: string, example: Example) => `../../fixtures/traces/${language}/${slug(example.name)}.json`;

describe("golden traces: JavaScript", () => {
  for (const example of JAVASCRIPT_EXAMPLES) {
    it(example.name, async () => {
      const trace = await traceJavaScript(example.code, MAX_STEPS, MAX_SECONDS);
      expect(traceProblems(trace), "matches the trace schema").toEqual([]);
      await expect(goldenText(trace)).toMatchFileSnapshot(fixture("javascript", example));
    });
  }
});

describe("golden traces: TypeScript", () => {
  for (const example of TYPESCRIPT_EXAMPLES) {
    it(example.name, async () => {
      const trace = await traceTypeScript(example.code, MAX_STEPS, MAX_SECONDS);
      expect(traceProblems(trace), "matches the trace schema").toEqual([]);
      await expect(goldenText(trace)).toMatchFileSnapshot(fixture("typescript", example));
    });
  }
});

describe("golden traces: Python (in Pyodide)", () => {
  let tracePython: TracePython;

  beforeAll(async () => {
    tracePython = await pythonTracer();
  }, 120_000);

  for (const example of PYTHON_EXAMPLES) {
    it(example.name, async () => {
      const trace = tracePython(example.code, MAX_STEPS, MAX_SECONDS);
      expect(traceProblems(trace), "matches the trace schema").toEqual([]);
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
