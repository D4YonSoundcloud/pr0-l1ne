// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LanguageId } from "../languages";
import { type LayoutService, LocalLayout } from "../layout/service";
import { ProgramStore } from "../programs";
import { createSettings } from "../settings";
import { HeapEncoder } from "../trace/delta";
import { POLICY } from "../trace/policy";
import type { RunProgress } from "../trace/stream";
import type { Trace } from "../trace/types";
import type { Progress } from "../trace/work";
import type { RunnerStatus, RunOutcome, TracePart } from "../worker/runner";
import type { BannerTone } from "./banner";
import { LIVE_DELAY_MS, RunController, type RunnerLike, reportLink, type TracerCrash } from "./runController";
import type { ProgressView } from "./runProgress";
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
  calls: {
    code: string;
    steps: number;
    seconds: number;
    sampling: unknown;
    finish(outcome: RunOutcome): void;
    progress?: (p: RunProgress) => void;
    feed?: (part: TracePart) => void;
  }[] = [];
  stops = 0;
  constructor(readonly onStatus: (status: RunnerStatus) => void) {}
  run(
    code: string,
    steps: number,
    seconds: number,
    sampling: unknown,
    progress?: (p: RunProgress) => void,
    feed?: (part: TracePart) => void,
  ): Promise<RunOutcome> {
    return new Promise((resolve) =>
      this.calls.push({
        code,
        steps,
        seconds,
        sampling,
        finish: resolve,
        ...(progress ? { progress } : {}),
        ...(feed ? { feed } : {}),
      }),
    );
  }
  stop(): void {
    this.stops++;
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

/** A trace's parts as a tracer streams them: pieces of `per` steps (as deltas), then the end. */
function parts(whole: Trace, per = 2): TracePart[] {
  const encoder = new HeapEncoder();
  const { steps, stdout, counts, ...header } = whole;
  const out: TracePart[] = [];
  let sent = 0;
  for (; sent + per < steps.length; sent += per) {
    const chunk = {
      ...(sent === 0 ? { header } : {}),
      steps: steps.slice(sent, sent + per).map((s) => encoder.encode(s)),
      stdout: "",
      counts,
    };
    out.push({ kind: "piece", json: JSON.stringify(chunk) });
  }
  const rest = { ...header, steps: steps.slice(sent).map((s) => encoder.encode(s)), stdout, counts, heapDelta: true };
  out.push({ kind: "end", json: JSON.stringify({ trace: rest }) });
  return out;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A progress view that says what it was told. */
class FakeProgress implements ProgressView {
  told: string[] = [];
  showing = false;
  start(run: { budget: string; maxSteps: number; maxSeconds: number }) {
    this.told.push(`start ${run.budget} ${run.maxSeconds}`);
  }
  update(p: RunProgress) {
    this.showing = true;
    this.told.push(`update ${p.steps}`);
  }
  preparing() {
    this.told.push("preparing");
    return this.showing;
  }
  prepare(p: Progress) {
    this.showing = true;
    this.told.push(`prepare ${p.label} ${p.done}/${p.total}`);
  }
  drawing() {
    this.told.push("drawing");
    return this.showing;
  }
  done() {
    this.showing = false;
    this.told.push("done");
  }
}

function setup(options: { layout?: LayoutService } = {}) {
  document.body.innerHTML = `<span id="status"></span>`;
  const settings = createSettings(null);
  const app = new AppStore(settings, new ProgramStore(null));
  const runners = new Map<LanguageId, FakeRunner>();
  const banners: (string | null)[] = [];
  const marks: unknown[] = [];
  const results: boolean[] = [];
  const tones: (BannerTone | undefined)[] = [];
  const crashes: TracerCrash[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const progress = new FakeProgress();
  let frames = 0;
  const runs = new RunController({
    app,
    progress,
    layout: options.layout ?? new LocalLayout(),
    nextFrame: () => {
      frames++;
      return Promise.resolve();
    },
    status: document.getElementById("status")!,
    editor: { setMarks: (m) => marks.push(m), setHintWarnings: () => {} },
    setBanner: (html, tone) => {
      banners.push(html);
      tones.push(tone);
    },
    reportCrash: (crash) => crashes.push(crash),
    onResult: (updateMarks) => results.push(updateMarks),
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
    tones,
    crashes,
    marks,
    results,
    fireTimers,
    timers,
    status: document.getElementById("status")!,
    setBusy: (on: boolean) => app.setMeasuring(on),
    progress,
    frames: () => frames,
  };
}

describe("RunController", () => {
  it("shows how a run is going, lets it paint 'preparing' before drawing, and Stop stops the runner", async () => {
    const { runs, runners, progress, frames, app } = setup();
    runs.runNow("let a = 1;");
    const call = runners.get("javascript")!.calls[0];
    expect(progress.told).toEqual([`start run ${POLICY.runSeconds}`]);
    call.progress!({ steps: 120, seconds: 0.5, line: 3 });
    runs.stop();
    expect(runners.get("javascript")!.stops).toBe(1);
    const stopped = { ...makeTrace(4), truncated: true, stoppedBy: "person" as const };
    call.finish({ kind: "trace", trace: stopped, elapsedMs: 1 });
    await flush();
    expect(progress.told).toEqual([`start run ${POLICY.runSeconds}`, "update 120", "preparing", "drawing", "done"]);
    expect(frames()).toBe(1); // "preparing" painted before the work (the drawing is laid out off the page)

    expect(app.get().trace?.steps).toBe(4);
    runs.stop(); // nothing running: nothing to stop
    expect(runners.get("javascript")!.stops).toBe(1);
  });

  it("draws at once when the progress never showed (a quick run)", async () => {
    const { runs, runners, progress, frames } = setup();
    runs.runNow("let a = 1;");
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: makeTrace(2), elapsedMs: 1 });
    await flush();
    expect(progress.told).toEqual([`start run ${POLICY.runSeconds}`, "preparing", "drawing", "done"]);
    expect(frames()).toBe(0);
  });

  it("prepares a trace a slice at a time, showing how far it's got, then draws it", async () => {
    const layout = new LocalLayout({ sliceMs: 0, pause: flush });
    const { runs, runners, progress, frames, app } = setup({ layout });
    runs.runNow("let a = 1;");
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: makeTrace(3), elapsedMs: 1 });
    for (let i = 0; i < 10; i++) await flush();
    expect(progress.told).toEqual([
      `start run ${POLICY.runSeconds}`,
      "preparing",
      "prepare Finding graphs 1/3",
      "prepare Finding graphs 2/3",
      "drawing",
      "done",
    ]);
    expect(frames()).toBe(0); // nothing showed before preparing took a while
    expect(app.get().trace?.steps).toBe(3);
  });

  it("drops a prepared trace if the language changed meanwhile", async () => {
    const { runs, runners, app, results } = setup({ layout: new LocalLayout({ sliceMs: 0, pause: flush }) });
    runs.runNow("let a = 1;");
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: makeTrace(3), elapsedMs: 1 });
    await flush();
    app.setLanguage("python"); // part way through preparing it
    for (let i = 0; i < 10; i++) await flush();
    expect(app.get().trace).toBeNull();
    expect(results).toEqual([]);
  });

  it("says what the person stopped: the steps recorded, or that nothing was", async () => {
    const { runs, runners, banners } = setup();
    runs.runNow("let a = 1;");
    const stopped = { ...makeTrace(4), truncated: true, stoppedBy: "person" as const };
    runners.get("javascript")!.calls[0].finish({ kind: "trace", trace: stopped, elapsedMs: 1 });
    await flush();
    expect(banners.at(-1)).toContain("You stopped the run: here are the 4 steps recorded");
    runs.runNow("let a = 2;");
    runners.get("javascript")!.calls[1].finish({ kind: "stopped", arrived: false });
    await flush();
    expect(banners.at(-1)).toContain("before anything was recorded");
  });

  it("passes a streamed trace to the layout as it arrives, and draws what had arrived when stopped", async () => {
    const { runs, runners, app, banners } = setup();
    runs.runNow("let a = 1;");
    const first = runners.get("javascript")!.calls[0];
    for (const part of parts(makeTrace(5))) first.feed!(part);
    first.finish({ kind: "streamed", elapsedMs: 1 });
    await flush();
    expect(app.get().trace?.steps).toBe(5);
    runs.runNow("let a = 2;");
    const second = runners.get("javascript")!.calls[1];
    // Two pieces (four steps) arrived, then the person stopped it.
    for (const part of parts(makeTrace(9)).slice(0, 2)) second.feed!(part);
    second.finish({ kind: "stopped", arrived: true });
    await flush();
    expect(app.get().trace?.steps).toBe(4);
    expect(banners.at(-1)).toContain("You stopped the run: here are the 4 steps recorded");
  });

  it("a piece that isn't one is said as a crash, and reported", async () => {
    const { runs, runners, app, banners, crashes } = setup();
    runs.runNow("let a = 1;");
    const call = runners.get("javascript")!.calls[0];
    call.feed!({ kind: "piece", json: JSON.stringify({ steps: "nope" }) });
    call.finish({ kind: "streamed", elapsedMs: 1 });
    await flush();
    expect(app.get().trace).toBeNull();
    expect(crashes).toEqual([{ language: "javascript", message: expect.stringMatching(/isn't one the app can use/) }]);
    expect(banners.at(-1)).toContain("a bug in PR0L1NE");
  });

  it("runs with Run's budget and shows the trace at its last step", async () => {
    const { runs, runners, app, results, banners } = setup();
    runs.runNow("let a = 1;");
    const call = runners.get("javascript")!.calls[0];
    expect(call.seconds).toBe(POLICY.runSeconds);
    expect(call.steps).toBe(POLICY.maxSteps);
    expect(call.sampling).toBe(POLICY.sampling); // sent with every run, so both tracers sample alike
    call.finish({ kind: "trace", trace: makeTrace(5), elapsedMs: 1 });
    await flush();
    expect(app.get().trace?.steps).toBe(5);
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
    expect(calls.map((c) => [c.code, c.seconds])).toEqual([["let a = 12", POLICY.liveSeconds]]);
  });

  it("Run cancels a pending Live run", () => {
    const { runs, runners, fireTimers } = setup();
    runs.scheduleLive("x");
    runs.runNow("x");
    fireTimers();
    expect(runners.get("javascript")!.calls).toHaveLength(1);
  });

  it("switching language drops a pending Live run and shows the new language's status", () => {
    const { runs, runners, fireTimers, app, status } = setup();
    runs.scheduleLive("let a = 1");
    app.setLanguage("python");
    fireTimers();
    expect(runners.get("javascript")?.calls ?? []).toHaveLength(0);
    runners.get("python")!.setStatus({ kind: "loading" });
    expect(status.textContent).toBe("Downloading Python (6 MB)…");
    // Once the worker counts the bytes: how much, then starting up.
    runners.get("python")!.setStatus({ kind: "loading", download: { loaded: 4_200_000, total: 10_000_000 } });
    expect(status.textContent).toBe("Downloading Python… 42%");
    runners.get("python")!.setStatus({ kind: "loading", download: { loaded: 10_000_000, total: 10_000_000 } });
    expect(status.textContent).toBe("Starting Python…");
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
    expect(app.get().trace?.steps).toBe(4); // the old one
    expect(app.get().tracedCode).toBe("good");
    expect(banners.at(-1)).toContain("Showing the last version that ran");
    expect(marks.at(-1)).toMatchObject({ error: { line: 1, message: "SyntaxError: Unexpected end of input" } });
    expect(results.at(-1)).toBe(false); // the error mark is already set
  });

  describe("every way a run can fail has its own message and tone, and only a tracer crash is reported", () => {
    /** Run once, finish with `outcome`, and say what the banner showed. */
    async function failWith(outcome: RunOutcome, language: LanguageId = "javascript") {
      const t = setup();
      t.app.setLanguage(language);
      t.runs.runNow("code");
      t.runners.get(language)!.calls[0].finish(outcome);
      await flush();
      return { html: t.banners.at(-1)!, tone: t.tones.at(-1), crashes: t.crashes, stale: t.app.get().stale };
    }

    it("the program raised an error: its own output", async () => {
      const r = await failWith({
        kind: "trace",
        trace: makeTrace(3, { error: { type: "ValueError", message: "<bad>", line: 2 } }),
        elapsedMs: 1,
      });
      expect(r).toMatchObject({ html: "<strong>ValueError</strong> on line 2: &lt;bad&gt;", tone: "program" });
      expect(r.crashes).toEqual([]);
    });

    it("it used up its steps, or its time: stopped, and labelled so", async () => {
      const steps = await failWith({ kind: "trace", trace: makeTrace(3, { truncated: true }), elapsedMs: 1 });
      expect(steps).toMatchObject({ tone: "budget", stale: false });
      expect(steps.html).toContain(`Stopped after ${POLICY.maxSteps.toLocaleString()} recorded steps`);
      const stuck = await failWith({ kind: "timeout", seconds: 10 });
      expect(stuck).toMatchObject({ tone: "budget", stale: true });
      expect(stuck.html).toMatch(/ran for more than 10 seconds/);
      expect([...steps.crashes, ...stuck.crashes]).toEqual([]);
    });

    it("the tracer crashed: a PR0L1NE bug, with a way to report it", async () => {
      const r = await failWith({ kind: "crash", message: "<boom>" }, "python");
      expect(r).toMatchObject({ tone: "tracer", stale: true });
      expect(r.html).toContain("a bug in PR0L1NE, not in your code: <code>&lt;boom&gt;</code>");
      expect(r.html).toContain('target="_blank"');
      expect(r.crashes).toEqual([{ language: "python", message: "<boom>" }]);
      const link = new URL(reportLink({ language: "python", message: "<boom>" }));
      expect(link.searchParams.get("title")).toBe("Tracer crash (Python): <boom>");
      expect(link.searchParams.get("body")).toContain("**Error:** <boom>");
    });

    it("the runtime couldn't load: nothing ran, try again", async () => {
      const r = await failWith(
        {
          kind: "unavailable",
          reason: "load",
          message: "Couldn't load the language runtime: offline",
          detail: "offline",
        },
        "python",
      );
      expect(r).toMatchObject({ tone: "runtime", stale: true });
      expect(r.html).toContain("<strong>Python couldn't load</strong>, so nothing ran (<code>offline</code>).");
      expect(r.html).toContain('data-action="run"');
      expect(r.crashes).toEqual([]);
    });

    it("the worker is from another version: reload", async () => {
      const r = await failWith({ kind: "unavailable", reason: "version", message: "PR0L1NE was updated." });
      expect(r).toMatchObject({ tone: "runtime" });
      expect(r.html).toContain('data-action="reload"');
      expect(r.crashes).toEqual([]);
    });

    it("a crash is reported even after switching language, but not shown", async () => {
      const t = setup();
      t.runs.runNow("code");
      t.app.setLanguage("python");
      const shown = t.banners.length;
      t.runners.get("javascript")!.calls[0].finish({ kind: "crash", message: "late" });
      await flush();
      expect(t.crashes).toEqual([{ language: "javascript", message: "late" }]);
      expect(t.banners.length).toBe(shown);
    });
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
    expect(banners.at(-1)).toContain(`Traced for ${POLICY.liveSeconds} seconds`);
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
