// @vitest-environment jsdom
/**
 * The runner, with a fake worker standing in for the real one: every way the
 * boundary between the page and a language worker can go wrong.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { traceJavaScript } from "../js/trace";
import { POLICY } from "../trace/policy";
import type { Trace } from "../trace/types";
import { type FromWorker, PROTOCOL_VERSION, type ToWorker } from "./protocol";
import { OUTDATED_MESSAGE, Runner, type RunnerStatus } from "./runner";

/** A worker the test drives: it records what it's sent and says what the test tells it to. */
class FakeWorker {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: ToWorker[] = [];
  terminated = false;
  postMessage(message: ToWorker) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** The worker sends a message (even after being terminated: a late one). */
  say(message: FromWorker) {
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }
  ready(label = "JavaScript", protocolVersion = PROTOCOL_VERSION) {
    this.say({ type: "ready", label, protocolVersion });
  }
  /** An error the worker's own code didn't catch (or its script failing to load). */
  fail(message = "") {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
  get lastRunId(): number {
    return this.sent[this.sent.length - 1].runId;
  }
}

let trace: Trace;
beforeAll(async () => {
  trace = await traceJavaScript("let a = 1;\n");
});

function setup(timeoutMs = 10_000) {
  const workers: FakeWorker[] = [];
  const statuses: RunnerStatus[] = [];
  const runner = new Runner(
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    (status) => statuses.push(status),
    timeoutMs,
  );
  const run = () => runner.run("code", 100, 1, POLICY.sampling);
  return { runner, workers, statuses, run, worker: () => workers[workers.length - 1] };
}

/** Let promise callbacks (and the development-build trace check) finish. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a run", () => {
  it("sends the code, the budget and the sampling policy, and resolves with the trace", async () => {
    const { runner, worker, statuses, run } = setup();
    expect(statuses).toEqual([{ kind: "loading" }]);
    worker().ready();
    expect(runner.status).toEqual({ kind: "ready", label: "JavaScript" });
    const done = run();
    expect(worker().sent[0]).toEqual({
      type: "run",
      runId: 1,
      source: "code",
      maxSteps: 100,
      maxSeconds: 1,
      sampling: POLICY.sampling,
    });
    expect(runner.status).toEqual({ kind: "running" });
    expect(runner.busy).toBe(true);
    expect(() => run()).toThrow(/already in progress/);
    worker().say({ type: "result", runId: 1, trace, elapsedMs: 12 });
    await settle();
    await expect(done).resolves.toEqual({ kind: "trace", trace, elapsedMs: 12 });
    expect(runner.status).toEqual({ kind: "ready", label: "JavaScript" });
    expect(runner.busy).toBe(false);
  });

  it("can be sent before the runtime has loaded, and says it's running once it has", async () => {
    const { runner, worker, run } = setup();
    const done = run();
    expect(runner.status).toEqual({ kind: "loading" }); // still downloading
    worker().ready("Python 3.12");
    expect(runner.status).toEqual({ kind: "running" });
    worker().say({ type: "result", runId: 1, trace, elapsedMs: 1 });
    await settle();
    expect((await done).kind).toBe("trace");
    expect(runner.status).toEqual({ kind: "ready", label: "Python 3.12" });
  });

  it("ignores results that arrive out of order: only the run waiting is answered", async () => {
    const { worker, run } = setup();
    worker().ready();
    const first = run();
    worker().say({ type: "result", runId: 99, trace, elapsedMs: 1 }); // not a run of ours
    worker().say({ type: "crash", runId: 0, message: "stale" });
    worker().say({ type: "result", runId: 1, trace, elapsedMs: 5 });
    await settle();
    expect(await first).toMatchObject({ kind: "trace", elapsedMs: 5 });
    const second = run();
    worker().say({ type: "result", runId: 1, trace, elapsedMs: 1 }); // the first run's, again
    await settle();
    let answered = false;
    void second.then(() => (answered = true));
    await settle();
    expect(answered).toBe(false);
    worker().say({ type: "result", runId: 2, trace, elapsedMs: 7 });
    await settle();
    expect(await second).toMatchObject({ kind: "trace", elapsedMs: 7 });
  });

  it("a crash in the tracer mid-run ends the run as a crash, and the next run is fine", async () => {
    const { runner, worker, run } = setup();
    worker().ready();
    const done = run();
    worker().say({ type: "crash", runId: 1, message: "KeyError: 'o3'" });
    expect(await done).toEqual({ kind: "crash", message: "KeyError: 'o3'" });
    expect(runner.status).toEqual({ kind: "ready", label: "JavaScript" });
    const next = run();
    worker().say({ type: "result", runId: 2, trace, elapsedMs: 1 });
    await settle();
    expect((await next).kind).toBe("trace");
  });

  it("a worker that dies after loading is a crash too, and a fresh one is started", async () => {
    const { workers, worker, run } = setup();
    worker().ready();
    const done = run();
    worker().fail("out of memory");
    expect(await done).toEqual({ kind: "crash", message: "out of memory" });
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    worker().ready();
    worker().fail(); // with nothing running, and no message
    expect(workers).toHaveLength(3);
  });

  it("a run that never answers is stopped by the watchdog, and the worker restarted", async () => {
    const { runner, workers, worker, statuses, run } = setup(4_000);
    worker().ready();
    const done = run();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(runner.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toEqual({ kind: "timeout", seconds: 4 });
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(statuses.at(-1)).toEqual({ kind: "loading" });
    // The old worker's late answer goes nowhere.
    workers[0].say({ type: "result", runId: 1, trace, elapsedMs: 1 });
    expect(runner.busy).toBe(false);
  });

  it("the first run waits longer while the runtime is still loading", async () => {
    const { run } = setup(4_000);
    let outcome: unknown = null;
    void run().then((o) => (outcome = o));
    await vi.advanceTimersByTimeAsync(4_000 + 59_999);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual({ kind: "timeout", seconds: 4 });
  });

  it("a trace that doesn't match the trace format is a crash (checked in development builds)", async () => {
    const { worker, run } = setup();
    worker().ready();
    const done = run();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    worker().say({ type: "result", runId: 1, trace: { ...trace, steps: "no" } as unknown as Trace, elapsedMs: 1 });
    await settle();
    const outcome = await done;
    expect(outcome.kind).toBe("crash");
    expect(outcome.kind === "crash" && outcome.message).toMatch(/doesn't match the trace format/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("a runtime that can't load", () => {
  it("ends the waiting run at once, as unavailable, instead of letting it time out", async () => {
    const { runner, worker, run } = setup();
    const done = run();
    worker().say({ type: "loadError", message: "NetworkError when fetching pyodide.asm.wasm" });
    expect(await done).toEqual({
      kind: "unavailable",
      reason: "load",
      message: "Couldn't load the language runtime: NetworkError when fetching pyodide.asm.wasm",
      detail: "NetworkError when fetching pyodide.asm.wasm",
    });
    expect(runner.status.kind).toBe("failed");
  });

  it("tries a fresh worker on the next run (the network may be back)", async () => {
    const { workers, worker, run } = setup();
    worker().say({ type: "loadError", message: "offline" });
    const retry = run();
    expect(workers).toHaveLength(2);
    worker().ready();
    worker().say({ type: "result", runId: 1, trace, elapsedMs: 1 });
    await settle();
    expect((await retry).kind).toBe("trace");
  });

  it("a worker script that fails to start is a load failure, not a crash", async () => {
    const { runner, worker, run } = setup();
    const done = run();
    worker().fail();
    expect(await done).toMatchObject({ kind: "unavailable", reason: "load" });
    expect(runner.status).toEqual({
      kind: "failed",
      message: "Couldn't start the language runtime: the worker failed to start.",
    });
  });
});

describe("the protocol version", () => {
  it("a worker that speaks another version is refused: reload the page", async () => {
    const { runner, workers, worker, run } = setup();
    const waiting = run();
    worker().ready("JavaScript", PROTOCOL_VERSION + 1);
    expect(await waiting).toEqual({ kind: "unavailable", reason: "version", message: OUTDATED_MESSAGE });
    expect(worker().terminated).toBe(true);
    expect(runner.status).toEqual({ kind: "failed", message: OUTDATED_MESSAGE });
    // Every later run says the same at once; a new worker wouldn't help.
    expect(await run()).toMatchObject({ kind: "unavailable", reason: "version" });
    expect(workers).toHaveLength(1);
  });

  it("a worker from before versions existed is refused too", async () => {
    const { runner, worker } = setup();
    worker().say({ type: "ready", label: "JavaScript" } as FromWorker);
    expect(runner.status).toEqual({ kind: "failed", message: OUTDATED_MESSAGE });
  });
});

describe("Measure", () => {
  const measure = (runner: Runner, progress = vi.fn()) => runner.measure("code", 2_000, progress, { n: 5 });

  it("sends the limit and sizes, passes its progress on, and resolves with the result", async () => {
    const { runner, worker } = setup();
    worker().ready();
    const progress = vi.fn();
    const done = measure(runner, progress);
    expect(worker().sent[0]).toEqual({
      type: "measure",
      runId: 1,
      source: "code",
      limitMs: 2_000,
      overrides: { n: 5 },
    });
    expect(runner.status).toEqual({ kind: "running" });
    expect(() => runner.run("x", 1, 1, POLICY.sampling)).toThrow(/already in progress/);
    worker().say({ type: "measureProgress", runId: 1, progress: { elapsedMs: 250 } });
    worker().say({ type: "measureProgress", runId: 7, progress: { elapsedMs: 1 } }); // not ours
    worker().say({ type: "measured", runId: 7, result: {} as never });
    const result = { status: "done" } as never;
    worker().say({ type: "measured", runId: 1, result });
    expect(await done).toEqual({ kind: "measured", result });
    expect(progress.mock.calls).toEqual([[{ elapsedMs: 250 }]]);
    expect(runner.status).toEqual({ kind: "ready", label: "JavaScript" });
  });

  it("without sizes, sends none", () => {
    const { runner, worker } = setup();
    void runner.measure("code", 2_000, () => {});
    expect(worker().sent[0]).not.toHaveProperty("overrides");
  });

  it("a crash while measuring is the measurement's", async () => {
    const { runner, worker } = setup();
    worker().ready();
    const done = measure(runner);
    worker().say({ type: "crash", runId: 1, message: "boom" });
    expect(await done).toEqual({ kind: "crash", message: "boom" });
  });

  it("stopping restarts the worker", async () => {
    const { runner, workers } = setup();
    workers[0].ready();
    const done = measure(runner);
    runner.stopMeasure();
    expect(await done).toEqual({ kind: "stopped", reason: "person" });
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    runner.stopMeasure(); // nothing to stop
    expect(workers).toHaveLength(2);
  });

  it("a program that doesn't stop at its limit is stopped from outside", async () => {
    const { runner, worker } = setup();
    worker().ready();
    const done = measure(runner);
    await vi.advanceTimersByTimeAsync(2_000 + 15_000);
    expect(await done).toEqual({ kind: "stopped", reason: "unresponsive" });
  });

  it("can't run on a runtime that failed to load, and the worker dying mid-measure is a crash", async () => {
    const { runner, worker } = setup();
    const done = measure(runner);
    worker().say({ type: "loadError", message: "offline" });
    expect(await done).toMatchObject({ kind: "unavailable", reason: "load" });
    const again = measure(runner); // a fresh worker is tried
    worker().ready();
    worker().fail("gone");
    expect(await again).toEqual({ kind: "crash", message: "gone" });
  });

  it("on an outdated worker, resolves at once", async () => {
    const { runner, worker } = setup();
    worker().ready("JavaScript", 0);
    expect(await measure(runner)).toMatchObject({ kind: "unavailable", reason: "version" });
  });
});

describe("switching language mid-run", () => {
  it("each language's runner is its own: one waiting doesn't hold up the other", async () => {
    const python = setup();
    const javascript = setup();
    python.worker().ready("Python");
    javascript.worker().ready("JavaScript");
    const slow = python.run();
    const quick = javascript.run();
    javascript.worker().say({ type: "result", runId: 1, trace, elapsedMs: 1 });
    await settle();
    expect((await quick).kind).toBe("trace");
    expect(python.runner.busy).toBe(true);
    python.worker().say({ type: "result", runId: 1, trace, elapsedMs: 2 });
    await settle();
    expect(await slow).toMatchObject({ kind: "trace", elapsedMs: 2 });
  });
});
