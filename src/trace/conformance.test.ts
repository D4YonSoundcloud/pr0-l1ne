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
import { POLICY, type SamplingPolicy } from "../trace/policy";
import { traceProblem } from "./checkTrace";
import { CASES } from "./conformance.cases";
import { shapeOf, type TraceShape } from "./shape";
import { traceProblems } from "./validate";

const MAX_STEPS = POLICY.maxSteps; // as the app
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
      // ...and passes the app's own check of what the runner sends.
      expect(traceProblem(py), "the app accepts the Python trace").toBeNull();
      expect(traceProblem(js), "the app accepts the JavaScript trace").toBeNull();
      const shape = (trace: typeof py): Partial<TraceShape> => {
        const s: Partial<TraceShape> = shapeOf(trace, { ignore: c.ignore });
        for (const part of c.skip ?? []) delete s[part];
        return s;
      };
      expect(shape(js), "JavaScript compared with Python").toEqual(shape(py));
    });
  }

  describe("both tracers follow the policy they're sent", () => {
    // Not the app's numbers: different enough that every rule shows.
    const other: SamplingPolicy = {
      first: 3,
      last: 8,
      roundFrom: 100,
      sampleShare: 0.2,
      watchShare: 0.1,
      roundShare: 0.9,
      passShare: 0.5,
    };
    const tenThousand = CASES.filter((c) => c.name.startsWith("a 10,000-pass loop"));

    for (const c of tenThousand) {
      it(c.name, async () => {
        const kept = (trace: Parameters<typeof shapeOf>[0]) =>
          shapeOf(trace, { ignore: c.ignore }).loops[0].recorded![0];
        const py = tracePython(c.python, MAX_STEPS, MAX_SECONDS, other);
        const js = await traceJavaScript(c.javascript, MAX_STEPS, MAX_SECONDS, other);
        expect(shapeOf(js, { ignore: c.ignore }), "JavaScript compared with Python").toEqual(
          shapeOf(py, { ignore: c.ignore }),
        );
        const passes = kept(js);
        if (c.name.includes("unknown length")) {
          // Every pass while it's watched (until a tenth of the room is used), then round
          // passes while they fit in 90% of it (buffered passes count too), then the last 8.
          expect(passes.slice(0, 1001)).toEqual(Array.from({ length: 1001 }, (_, i) => i));
          expect(passes.slice(1001, -8)).toEqual([2000, 3000, 4000, 5000, 6000, 7000, 8000]);
        } else {
          // The header, the first 3, round passes from 100, the last 8.
          const round = [
            100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000,
          ];
          expect(passes).toEqual([0, 1, 2, 3, ...round, 9993, 9994, 9995, 9996, 9997, 9998, 9999, 10000]);
        }
        expect(passes.slice(-8)).toEqual([9993, 9994, 9995, 9996, 9997, 9998, 9999, 10000]); // the last 8
        // ...and not what the app's own policy keeps.
        expect(kept(await traceJavaScript(c.javascript, MAX_STEPS, MAX_SECONDS))).not.toEqual(passes);
      });
    }

    it("covers both kinds of long loop", () => expect(tenThousand).toHaveLength(2));
  });

  it("has about 30 cases, each with a distinct name", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });
});
