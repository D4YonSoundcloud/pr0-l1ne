// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LanguageId } from "../languages";
import type { MeasureLabel } from "../measurePanel";
import { ProgramStore } from "../programs";
import { createSettings, type KeyValueStorage } from "../settings";
import type { Measurement, MeasureProgress } from "../trace/measurement";
import type { MeasureOutcome } from "../worker/runner";
import { MeasureController, sizeSuggestion } from "./measureController";
import { AppStore } from "./state";

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

function measurement(extra: Partial<Measurement> = {}): Measurement {
  return {
    status: "done",
    error: null,
    lines: { "1": 1, "2": 100 },
    passes: { "2": 100 },
    calls: {},
    work: {},
    workKind: {},
    totals: {},
    ms: 12,
    plainMs: 3,
    peakBytes: null,
    heldBytes: null,
    stdout: "",
    droppedOutput: 0,
    ...extra,
  };
}

interface MeasureCall {
  code: string;
  limit: number;
  sizes?: Record<string, number>;
  progress(p: MeasureProgress): void;
  finish(outcome: MeasureOutcome): void;
}

/** Runners whose Measure runs finish when the test says so. */
function fakeRuns() {
  const calls: MeasureCall[] = [];
  const stopped: LanguageId[] = [];
  const log: string[] = [];
  let idle: Promise<void> = Promise.resolve();
  const runs = {
    runnerFor: (language: LanguageId) =>
      ({
        measure: (
          code: string,
          limit: number,
          progress: (p: MeasureProgress) => void,
          sizes?: Record<string, number>,
        ) => new Promise<MeasureOutcome>((finish) => calls.push({ code, limit, sizes, progress, finish })),
        stopMeasure: () => void stopped.push(language),
      }) as never,
    whenIdle: () => idle,
    resumeQueued: () => void log.push("resumeQueued"),
    refreshStatus: () => void log.push("refreshStatus"),
  };
  return {
    runs,
    calls,
    stopped,
    log,
    holdUntil: (p: Promise<void>) => {
      idle = p;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(code = "let a = 1;\nfor (let i = 0; i < 100; i++) a++;", storage = memoryStorage()) {
  document.body.innerHTML = `
    <button id="measure">Measure</button><button id="results" hidden></button>
    <span id="status"></span><div id="host"></div>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const settings = createSettings(storage);
  const app = new AppStore(settings, new ProgramStore(null));
  const fake = fakeRuns();
  let editorCode = code;
  const labels: MeasureLabel[][] = [];
  const banners: (string | null)[] = [];
  const events: string[] = [];
  const intervals = new Map<number, () => void>();
  let nextTimer = 1;
  const measure = new MeasureController({
    app,
    settings,
    runs: fake.runs,
    els: { measure: $("measure"), measureResults: $("results"), status: $("status"), editorPane: $("host") },
    editor: {
      getCode: () => editorCode,
      setCode: (c) => {
        editorCode = c;
      },
      revealLine: () => {},
      setMeasureLabels: (l) => labels.push(l),
    },
    setBanner: (html) => banners.push(html),
    pause: () => events.push("pause"),
    onMeasured: () => events.push("measured"),
    onOpen: () => events.push("open"),
    now: () => 0,
    setInterval: (callback) => {
      intervals.set(nextTimer, callback);
      return nextTimer++;
    },
    clearInterval: (id) => void intervals.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  return {
    app,
    measure,
    ...fake,
    $,
    labels,
    banners,
    events,
    intervals,
    settings,
    setCode: (c: string) => {
      editorCode = c;
      measure.codeChanged(c);
    },
  };
}

describe("MeasureController", () => {
  it("measures the code in the editor, holding traced runs until it's done", async () => {
    const { app, measure, calls, $, events, log } = setup();
    const done = measure.measure();
    expect(app.get().measuring).toBe(true);
    expect($("measure").textContent).toBe("Stop");
    expect($("measure").classList.contains("is-measuring")).toBe(true);
    expect(events).toEqual(["pause"]);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toContain("for (let i");
    expect($("status").textContent).toBe("Measuring…");
    calls[0].progress({ elapsedMs: 1500, loop: { line: 2, done: 50, total: 100 } });
    expect($("status").textContent).toMatch(/^Measuring… .* · 50% of line 2's loop$/);

    calls[0].finish({ kind: "measured", result: measurement() });
    await done;
    expect(app.get().measuring).toBe(false);
    expect($("measure").textContent).toBe("Measure");
    expect(log).toEqual(["refreshStatus", "resumeQueued"]); // queued edits run after
    expect(events).toEqual(["pause", "measured", "open"]); // the results open the panel, closing the others
    expect($("results").hidden).toBe(false);
    expect(measure.panel.isOpen).toBe(true);
    expect(measure.current()).not.toBeNull();
  });

  it("waits for a traced run that's finishing", async () => {
    const { measure, calls, holdUntil } = setup();
    let release!: () => void;
    holdUntil(new Promise((resolve) => (release = resolve)));
    void measure.measure();
    await flush();
    expect(calls).toHaveLength(0);
    release();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("labels the lines with their counts, until the code changes", async () => {
    const { measure, calls, labels, setCode } = setup();
    const done = measure.measure();
    await flush();
    calls[0].finish({ kind: "measured", result: measurement() });
    await done;
    expect(labels.at(-1)?.map((l) => l.line)).toEqual(expect.arrayContaining([2]));
    setCode("let a = 2;");
    expect(measure.current()).toBeNull();
    expect(labels.at(-1)).toEqual([]);
  });

  it("Measure again while measuring stops it, and says nothing was counted", async () => {
    const { measure, calls, stopped, banners, app } = setup();
    const done = measure.measure();
    await flush();
    void measure.measure();
    expect(stopped).toEqual(["javascript"]);
    calls[0].finish({ kind: "stopped", reason: "person" });
    await done;
    expect(banners.at(-1)).toMatch(/^Measuring stopped/);
    expect(app.get().measuring).toBe(false);
  });

  it("explains a run stopped from outside, at the chosen limit, and a crash", async () => {
    const storage = memoryStorage();
    storage.setItem("pr0l1ne:measure-limit", "5000");
    const { measure, calls, banners } = setup(undefined, storage);
    let done = measure.measure();
    await flush();
    expect(calls[0].limit).toBe(5000);
    calls[0].finish({ kind: "stopped", reason: "unresponsive" });
    await done;
    expect(banners.at(-1)).toMatch(/didn't stop at the 5(\.0+)? s limit/);
    done = measure.measure();
    await flush();
    calls[1].finish({ kind: "crash", message: "<oops>" });
    await done;
    expect(banners.at(-1)).toBe("Measuring failed: <code>&lt;oops&gt;</code>");
  });

  it("uses the default limit when the saved one isn't offered", async () => {
    const storage = memoryStorage();
    storage.setItem("pr0l1ne:measure-limit", "1234");
    const { measure, calls } = setup(undefined, storage);
    void measure.measure();
    await flush();
    expect(calls[0].limit).toBe(20_000);
  });

  it("drops a result for a language the person has left, and stops measuring it", async () => {
    const { app, measure, calls, stopped, events, $ } = setup();
    const done = measure.measure();
    await flush();
    app.setLanguage("python");
    expect(stopped).toEqual(["javascript"]);
    calls[0].finish({ kind: "measured", result: measurement() });
    await done;
    expect(events).not.toContain("measured");
    expect($("results").hidden).toBe(true);
    expect(measure.current()).toBeNull();
  });

  it("keeps a language's results for when the person comes back", async () => {
    const { app, measure, calls, $ } = setup();
    const done = measure.measure();
    await flush();
    calls[0].finish({ kind: "measured", result: measurement() });
    await done;
    app.setLanguage("python");
    expect($("results").hidden).toBe(true);
    app.setLanguage("javascript");
    expect($("results").hidden).toBe(false);
    expect(measure.current()).not.toBeNull();
  });

  it("growth runs measure each size in turn, then stop for an error", async () => {
    const code = "// viz: size n\nconst n = 6400;\nfor (let i = 0; i < n; i++) {}";
    const { app, measure, calls, log, $ } = setup(code);
    const done = measure.measureGrowth();
    expect(measure.panel.isOpen).toBe(true);
    expect(app.get().measuring).toBe(true);
    await flush();
    expect(calls[0].sizes).toEqual({ n: 100 });
    calls[0].finish({ kind: "measured", result: measurement() });
    await flush();
    expect(calls[1].sizes).toEqual({ n: 400 });
    calls[1].finish({
      kind: "measured",
      result: measurement({ status: "error", error: { type: "RangeError", message: "too deep", line: 3 } }),
    });
    await done;
    expect(calls).toHaveLength(2);
    expect(app.get().measuring).toBe(false);
    expect(log).toEqual(["refreshStatus", "resumeQueued"]);
    expect($("host").textContent).toContain("At n = 400 the program stopped with RangeError: too deep");
  });

  it("a growth run needs a size to grow", async () => {
    const { app, measure, calls } = setup("let a = 1;");
    await measure.measureGrowth();
    expect(measure.panel.isOpen).toBe(true);
    expect(app.get().measuring).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("closes when another panel opens, and closes the others when it opens", () => {
    const { measure, events, $ } = setup();
    measure.panel.toggle(true);
    expect(events).toEqual(["open"]);
    expect($("results").getAttribute("aria-expanded")).toBe("true");
    measure.close();
    expect(measure.panel.isOpen).toBe(false);
  });
});

describe("sizeSuggestion", () => {
  it("suggests the biggest top-level number", () => {
    expect(sizeSuggestion("n = 1000\nk = 10\n  m = 99999")).toEqual({ name: "n", line: 1 });
    expect(sizeSuggestion("const size: number = 40_000; // big\nlet x = 3;")).toEqual({ name: "size", line: 1 });
  });

  it("ignores small numbers and anything that isn't a plain assignment", () => {
    expect(sizeSuggestion("let a = 4;\nlet b = a * 1000;")).toBeNull();
  });
});
