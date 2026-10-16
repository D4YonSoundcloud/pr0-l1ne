/**
 * Tracer conformance: each program in conformance.cases.ts, written in both
 * Python and JavaScript, must give traces of the same shape (shape.ts).
 * A failure means the tracers disagree about something they both record:
 * read the diff, then fix the tracer that's wrong (or the case, if the two
 * programs don't really do the same thing).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { pythonTracer, type TracePython } from "../testing/pythonTracer";
import { CASES } from "./conformance.cases";
import { shapeOf, type TraceShape } from "./shape";
import { traceProblems } from "./validate";

const MAX_STEPS = 20_000; // as src/main.ts
const MAX_SECONDS = 600; // never the reason a trace stops, unless a case sets its own

describe("tracer conformance: Python and JavaScript agree", () => {
  let tracePython: TracePython;

  beforeAll(async () => {
    tracePython = await pythonTracer();
  }, 120_000);

  for (const c of CASES) {
    it(c.name, async () => {
      const seconds = c.maxSeconds ?? MAX_SECONDS;
      const py = tracePython(c.python, MAX_STEPS, seconds);
      const js = await traceJavaScript(c.javascript, MAX_STEPS, seconds);
      expect(traceProblems(py), "the Python trace matches the schema").toEqual([]);
      expect(traceProblems(js), "the JavaScript trace matches the schema").toEqual([]);
      const shape = (trace: typeof py): Partial<TraceShape> => {
        const s: Partial<TraceShape> = shapeOf(trace, { ignore: c.ignore });
        for (const part of c.skip ?? []) delete s[part];
        return s;
      };
      expect(shape(js), "JavaScript compared with Python").toEqual(shape(py));
    });
  }

  it("has about 30 cases, each with a distinct name", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });
});
