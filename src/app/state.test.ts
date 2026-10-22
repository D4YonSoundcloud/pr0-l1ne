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

  it("a shared program clears the picture and the open program, without forgetting which one was open", () => {
    const { app, settings, storage } = makeApp();
    settings.openProgram("javascript").set("p1");
    app.showTrace(trace, "code", 2);
    app.openShared();
    expect(app.get()).toMatchObject({ shared: true, program: null, trace: null, tracedCode: null, stepIndex: 0 });
    expect(makeApp(storage).settings.openProgram("javascript").get()).toBe("p1");
    app.keepShared();
    expect(app.get().shared).toBe(false);
    // Saving it, or opening something else, or switching language, ends it too.
    app.openShared();
    app.setProgram(null);
    expect(app.get().shared).toBe(false);
    app.openShared();
    app.setLanguage("python");
    expect(app.get().shared).toBe(false);
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
