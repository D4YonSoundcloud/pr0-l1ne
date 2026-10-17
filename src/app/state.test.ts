import { describe, expect, it } from "vitest";
import type { Trace } from "../trace/types";
import { makeApp } from "./testHelpers";

const trace = { steps: [{}, {}, {}] } as unknown as Trace;

describe("AppStore", () => {
  it("shows a run's trace at a step, and keeps the old one dimmed when a run fails", () => {
    const { app } = makeApp();
    app.showTrace(trace, "code", 2);
    expect(app.get()).toMatchObject({ trace, tracedCode: "code", stale: false, stepIndex: 2 });
    app.markStale();
    expect(app.get()).toMatchObject({ trace, stale: true });
  });

  it("switching language forgets the trace, and remembers the language", () => {
    const { app, storage } = makeApp();
    app.showTrace(trace, "code", 2);
    app.setLanguage("python");
    expect(app.get()).toMatchObject({ language: "python", trace: null, tracedCode: null, stale: false, stepIndex: 0 });
    expect(makeApp(storage).app.get().language).toBe("python");
  });

  it("measuring is part of the state, so runs can wait for it", () => {
    const { app } = makeApp();
    const seen: boolean[] = [];
    app.watch(
      (s) => s.measuring,
      (on) => seen.push(on),
    );
    app.setMeasuring(true);
    app.setMeasuring(true);
    app.setMeasuring(false);
    expect(seen).toEqual([true, false]);
  });
});
