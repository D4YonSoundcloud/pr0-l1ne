// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LanguageId } from "../languages";
import { ProgramStore } from "../programs";
import { createSettings } from "../settings";
import type { Trace } from "../trace/types";
import type { RunnerStatus, RunOutcome } from "../worker/runner";
import { LIVE_DELAY_MS, LIVE_SECONDS, RUN_SECONDS, RunController, type RunnerLike } from "./runController";
import { AppStore } from "./state";

/** A trace of `steps` empty steps (enough for the controller). */
function makeTrace(steps: number, extra: Partial<Trace> = {}): Trace {
  return {
    version: 1,
    language: "javascript",
    steps: Array.from({ length: steps }, (_, i) => ({
      event: "line" as const,
      line: i + 1,
      stack: [],
      heap: {},
      stdoutLength: 0,
      loops: [],
    })),
    loops: [],
    indexNames: {},
    stdout: "",
    error: null,
    truncated: false,
    ...extra,
  } as Trace;
}

/** A runner whose runs finish when the test says so. */
class FakeRunner implements RunnerLike {
  status: RunnerStatus = { kind: "ready", label: "JavaScript" };
  calls: { code: string; seconds: number; finish(outcome: RunOutcome): void }[] = [];
  constructor(readonly onStatus: (status: RunnerStatus) => void) {}
  run(code: string, _steps: number, seconds: number): Promise<RunOutcome> {
    return new Promise((resolve) => this.calls.push({ code, seconds, finish: resolve }));
  }
  measure(): never {
    throw new Error("not used");
  }
  stopMeasure(): void {}
  setStatus(status: RunnerStatus) {
    this.status = status;
    this.onStatus(status);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  document.body.innerHTML = `<span id="status"></span>`;
  const settings = createSettings(null);
  const app = new AppStore(settings, new ProgramStore(null));
  const runners = new Map<LanguageId, FakeRunner>();
  const banners: (string | null)[] = [];
  const marks: unknown[] = [];
  const results: boolean[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let busy = false;
  const runs = new RunController({
    app,
    status: document.getElementById("status")!,
    editor: { setMarks: (m) => marks.push(m), setHintWarnings: () => {} },
    setBanner: (html) => banners.push(html),
    onResult: (updateMarks) => results.push(updateMarks),
    busy: () => busy,
    createRunner: (language, onStatus) => {
      const runner = new FakeRunner(onStatus);
      runners.set(language, runner);
      return runner;
    },
    setTimeout: (callback) => {
      timers.set(nextTimer, callback);
      return nextTimer++;
    },
    clearTimeout: (id) => void timers.delete(id),
  });
  const fireTimers = () => {
    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      callback();
    }
  };
  return {
    app,
    runs,
    runners,
    banners,
    marks,
    results,
    fireTimers,
    timers,
    status: document.getElementById("status")!,
    setBusy: (on: boolean) => {
      busy = on;
    },
  };
}

describe("RunController", () => {
  it("runs with Run's budget and shows the trace at its last step", async () => {
    const { runs, runners, app, results, banners } = setup();
    runs.runNow("let a = 1;");
    const call = runners.get("javascript")!.calls[0];
    expect(call.seconds).toBe(RUN_SECONDS);
    call.finish({ kind: "trace", trace: makeTrace(5), elapsedMs: 1 });
    await flush();
    expect(app.get().trace?.steps).toHaveLength(5);
    expect(app.get().stepIndex).toBe(4);
    expect(app.get().tracedCode).toBe("let a = 1;");
    expect(app.get().stale).toBe(false);
    expect(results).toEqual([true]);
    expect(banners).toEqual([null]);
  });

  it("waits for typing to pause, then runs with Live's shorter budget", () => {
    const { runs, runners, fireTimers, timers } = setup();
    runs.scheduleLive("let a = 1");
    runs.scheduleLive("let a = 12"); // replaces the first
    expect(timers.size).toBe(1);
    expect(LIVE_DELAY_MS).toBeGreaterThan(0);
    fireTimers();
    const calls = runners.get("javascript")!.calls;
    expect(calls.map((c) => [c.code, c.seconds])).toEqual([["let a = 12", LIVE_SECONDS]]);
  });

  it("Run cancels a pending Live run", () => {
    const { runs, runners, fireTimers } = setup();
    runs.scheduleLive("x");
    runs.runNow("x");
    fireTimers();
    expect(runners.get("javascript")!.calls).toHaveLength(1);
  });

  it("queues only the newest run while one is going", async () => {
    const { runs, runners } = setup();
    runs.runNow("first");
    runs.runNow("second");
    runs.runNow("third");
    const runner = runners.get("javascript")!;
    expect(runner.calls.map((c) => c.code)).toEqual(["first"]);
    runner.calls[0].finish({ kind: "trace", trace: makeTrace(3), elapsedMs: 1 });
    await flush();
    expect(runner.calls.map((c) => c.code)).toEqual(["first", "third"]);
  });

  it("waits while Measure is using the runner, then runs what was queued", async () => {
    const { runs, runners, setBusy } = setup();
    setBusy(true);
    runs.runNow("edited while measuring");
    expect(runners.get("javascript")?.calls ?? []).toHaveLength(0);
    setBusy(false);
    runs.resumeQueued();
    expect(runners.get("javascript")!.calls.map((c) => c.code)).toEqual(["edited while measuring"]);
  });

  it("drops results for a language the person has left", async () => {
    const { runs, runners, app, results } = setup();
    runs.runNow("let a = 1;");
    app.setLanguage("python");
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: makeTrace(5), elapsedMs: 1 });
    await flush();
    expect(app.get().trace).toBeNull();
    expect(results).toEqual([]);
  });

  it("keeps the step when you weren't at the end, within the new trace", async () => {
    const { runs, runners, app } = setup();
    runs.runNow("a");
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: makeTrace(10), elapsedMs: 1 });
    await flush();
    app.setStep(5);
    runs.runNow("b");
    runners.get("javascript")!.calls[1].finish({ kind: "trace", trace: makeTrace(8), elapsedMs: 1 });
    await flush();
    expect(app.get().stepIndex).toBe(5);
    app.setStep(6);
    runs.runNow("c");
    runners.get("javascript")!.calls[2].finish({ kind: "trace", trace: makeTrace(4), elapsedMs: 1 });
    await flush();
    expect(app.get().stepIndex).toBe(3); // clamped to the new last step
  });

  it("keeps the last picture, dimmed, when the code can't start", async () => {
    const { runs, runners, app, banners, marks, results } = setup();
    runs.runNow("good");
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: makeTrace(4), elapsedMs: 1 });
    await flush();
    runs.runNow("bad(");
    const error = { type: "SyntaxError", message: "Unexpected end of input", line: 1 };
    runners.get("javascript")!.calls[1].finish({ kind: "trace", trace: makeTrace(0, { error }), elapsedMs: 1 });
    await flush();
    expect(app.get().stale).toBe(true);
    expect(app.get().trace?.steps).toHaveLength(4); // the old one
    expect(app.get().tracedCode).toBe("good");
    expect(banners.at(-1)).toContain("Showing the last version that ran");
    expect(marks.at(-1)).toMatchObject({ error: { line: 1, message: "SyntaxError: Unexpected end of input" } });
    expect(results.at(-1)).toBe(false); // the error mark is already set
  });

  it("explains timeouts and tracer crashes, escaping what it quotes", async () => {
    const { runs, runners, app, banners } = setup();
    runs.runNow("a");
    runners.get("javascript")!.calls[0].finish({ kind: "timeout", seconds: 10 });
    await flush();
    expect(app.get().stale).toBe(true);
    expect(banners.at(-1)).toMatch(/ran for more than 10 seconds/);
    runs.runNow("b");
    runners.get("javascript")!.calls[1].finish({ kind: "crash", message: "<boom>" });
    await flush();
    expect(banners.at(-1)).toBe("The tracer failed: <code>&lt;boom&gt;</code>");
  });

  it("explains a trace cut short, offering Run after a Live run", async () => {
    const { runs, runners, banners, fireTimers } = setup();
    runs.scheduleLive("loop");
    fireTimers();
    runners.get("javascript")!.calls[0].finish({
      kind: "trace",
      trace: makeTrace(5, { truncated: true, stoppedBy: "time" }),
      elapsedMs: 1,
    });
    await flush();
    expect(banners.at(-1)).toContain(`Traced for ${LIVE_SECONDS} seconds`);
    expect(banners.at(-1)).toContain('data-action="run"');
    expect(banners.at(-1)).toContain('data-action="measure"');
  });

  it("shows the program's error at the end, and the status of the current language's runner", async () => {
    const { runs, runners, banners, status, app } = setup();
    runs.runNow("throw");
    const error = { type: "Error", message: "bad <input>", line: 3 };
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: makeTrace(4, { error }), elapsedMs: 1 });
    await flush();
    expect(banners.at(-1)).toBe("<strong>Error</strong> on line 3: bad &lt;input&gt;");

    runners.get("javascript")!.setStatus({ kind: "running" });
    expect(status.textContent).toBe("Running…");
    app.setLanguage("python");
    runs.runnerFor("python");
    runners.get("python")!.setStatus({ kind: "loading" });
    expect(status.textContent).toBe("Downloading Python (6 MB)…");
    runners.get("javascript")!.setStatus({ kind: "ready", label: "JavaScript" }); // not the current language
    expect(status.textContent).toBe("Downloading Python (6 MB)…");
  });

  it("whenIdle resolves once the run in progress finishes", async () => {
    const { runs, runners, fireTimers } = setup();
    runs.runNow("a");
    let idle = false;
    void runs.whenIdle().then(() => {
      idle = true;
    });
    fireTimers();
    await flush();
    expect(idle).toBe(false);
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: makeTrace(3), elapsedMs: 1 });
    await flush();
    fireTimers();
    await flush();
    expect(idle).toBe(true);
  });
});
