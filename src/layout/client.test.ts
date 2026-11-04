// @vitest-environment jsdom
/**
 * The layout worker from the page (client.ts), with the worker's own code
 * (host.ts) behind a fake worker that clones every message as postMessage
 * does: a trace sent in pieces or whole, prepared with its progress, each
 * window's steps drawn the same as on the page, kept marks the same
 * objects from step to step, newer requests replacing waiting ones, and
 * failures said, not hidden.
 */
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { Mark } from "../render/drawing";
import { HeapEncoder } from "../trace/delta";
import { applyHints } from "../trace/hints";
import type { Trace } from "../trace/types";
import type { Progress } from "../trace/work";
import { type LayoutWorkerLike, WorkerLayout } from "./client";
import { layoutHost } from "./host";
import type { FromLayout, ToLayout } from "./protocol";
import { currentLook, type LoopShow, type LoopView, type MemoryShow, type MemoryView } from "./requests";
import { LayoutSession } from "./session";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Let messages go back and forth until nothing's left to do. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick();
}

/** The worker's code, behind messages cloned as postMessage clones them. */
class FakeWorker implements LayoutWorkerLike {
  onmessage: ((event: MessageEvent<FromLayout>) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  sent: ToLayout[] = [];
  terminated = false;
  private readonly host = layoutHost((message) =>
    setTimeout(() => this.onmessage?.({ data: structuredClone(message) } as MessageEvent<FromLayout>), 0),
  );
  postMessage(message: ToLayout): void {
    this.sent.push(message);
    const copy = structuredClone(message);
    setTimeout(() => this.host(copy), 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const CODE = `const nums = [5, 3, 8, 1];
const graph = { a: ["b"], b: ["c"], c: [] };
for (let i = 0; i < nums.length; i++) {
  nums[i] = nums[i] * 2;
}
console.log(nums);
`;

const show = (step: number): MemoryShow => ({
  look: currentLook(),
  step,
  mode: "arrows",
  sizes: null,
  output: true,
  dimForOutput: false,
  tall: false,
  expanded: [],
});
const VIEW: MemoryView = { positions: [], raise: null, simpleArrows: false, level: 0, budget: 64 };
const loopShow = (step: number): LoopShow => ({
  look: currentLook(),
  step,
  selected: null,
  mode: "stacked",
  hideQuiet: true,
  sizes: null,
  tall: false,
  expanded: [],
});
const LOOP_VIEW: LoopView = {
  vertical: false,
  fit: { level: 0, fitting: false, keep: false, fitW: 0, fitH: 0, viewW: 800, viewH: 600 },
  budget: 40_000,
};

/** A trace's pieces as the tracers send them: progress reports carrying steps (as deltas), then the end. */
function pieces(whole: Trace, per = 3): { kind: "piece" | "end"; json: string }[] {
  const encoder = new HeapEncoder();
  const { steps, stdout, counts, ...header } = whole;
  const out: { kind: "piece" | "end"; json: string }[] = [];
  let sent = 0;
  for (; sent + per < steps.length; sent += per) {
    const chunk = {
      ...(sent === 0 ? { header } : {}),
      steps: steps.slice(sent, sent + per).map((s) => encoder.encode(s)),
      stdout: "",
      counts,
    };
    out.push({ kind: "piece", json: JSON.stringify({ progress: { steps: sent + per, seconds: 0, line: 1 }, chunk }) });
  }
  const rest = { ...header, steps: steps.slice(sent).map((s) => encoder.encode(s)), stdout, counts, heapDelta: true };
  out.push({ kind: "end", json: JSON.stringify({ trace: rest }) });
  return out;
}

function setup() {
  const workers: FakeWorker[] = [];
  const errors: string[] = [];
  const layout = new WorkerLayout(
    () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    (message) => errors.push(message),
  );
  return { layout, worker: () => workers[0], errors };
}

/** The same steps drawn on the page, for comparing. */
function onThePage(trace: Trace): LayoutSession {
  const session = new LayoutSession();
  const work = session.load(trace);
  while (!work.next().done);
  return session;
}

describe("the layout worker, from the page", () => {
  it("builds the trace from the run's pieces, prepares it with its progress, and draws each step as the page would", async () => {
    const raw = await traceJavaScript(CODE);
    const { layout } = setup();
    layout.begin();
    for (const part of pieces(raw)) layout.feed(part);
    const seen: Progress[] = [];
    const ready = layout.load(raw, "streamed", (p) => seen.push(p));
    await settle();
    expect(await ready).toBe(true);
    const page = onThePage(raw);
    const channel = layout.channel();
    for (const step of [0, 3, 4, 5, raw.steps.length - 1]) {
      const drawn = layout.memory(channel, show(step), VIEW);
      await settle();
      const laidOut = await drawn;
      const expected = page.memory(99, show(step), VIEW)!;
      expect(laidOut!.drawing.signature(), `step ${step + 1}`).toBe(expected.drawing.signature());
      expect(laidOut!.summaryKeys).toEqual(expected.summaryKeys);
    }
  });

  it("keeps a window's kept marks the same objects on the page, from step to step", async () => {
    const raw = await traceJavaScript(CODE);
    const { layout } = setup();
    const ready = layout.load(raw, "whole", () => {});
    await settle();
    await ready;
    const channel = layout.channel();
    const drawings: Mark[] = [];
    for (let step = 4; step < 10; step++) {
      const drawn = layout.memory(channel, show(step), VIEW);
      await settle();
      drawings.push((await drawn)!.drawing);
    }
    const marksOf = (root: Mark) => {
      const out = new Set<Mark>();
      const walk = (m: Mark) => {
        out.add(m);
        for (const c of m.childNodes) if (c instanceof Mark) walk(c);
      };
      walk(root);
      return out;
    };
    let shared = 0;
    for (let i = 1; i < drawings.length; i++) {
      const before = marksOf(drawings[i - 1]);
      shared += [...marksOf(drawings[i])].filter((m) => before.has(m)).length;
    }
    expect(shared).toBeGreaterThan(0);
  });

  it("draws the loop history and its tabs; laid out in full to save, the window's drawing goes on as before", async () => {
    const raw = await traceJavaScript(CODE);
    const { layout } = setup();
    const ready = layout.load(raw, "whole", () => {});
    await settle();
    await ready;
    const channel = layout.channel();
    const page = onThePage(raw);
    const step = 8;
    const first = layout.loop(channel, loopShow(step), LOOP_VIEW);
    await settle();
    const laidOut = (await first)!;
    expect(laidOut.drawing!.signature()).toBe(page.loop(99, loopShow(step), LOOP_VIEW)!.drawing!.signature());
    expect(laidOut.tabs.map((t) => t.text)).toEqual([expect.stringMatching(/^for \(let i = 0/)]);
    const full = layout.loop(channel, loopShow(step), { ...LOOP_VIEW, full: true });
    await settle();
    expect((await full)!.drawing).toBeInstanceOf(Mark);
    const next = layout.loop(channel, loopShow(step + 1), LOOP_VIEW);
    await settle();
    expect((await next)!.drawing!.signature()).toBe(page.loop(99, loopShow(step + 1), LOOP_VIEW)!.drawing!.signature());
  });

  it("asked for steps faster than it draws: each finished one, and the last", async () => {
    const raw = await traceJavaScript(CODE);
    const { layout, worker } = setup();
    const ready = layout.load(raw, "whole", () => {});
    await settle();
    await ready;
    const channel = layout.channel();
    const asked = [3, 4, 5, 6].map((step) => layout.memory(channel, show(step), VIEW));
    await settle();
    const answers = await Promise.all(asked);
    // The first was being drawn; the second and third waited and were replaced; the last was drawn.
    expect(answers.map((a) => a !== null)).toEqual([true, false, false, true]);
    expect(
      worker()
        .sent.filter((m) => m.type === "memory")
        .map((m) => (m as { show: MemoryShow }).show.step),
    ).toEqual([3, 6]);
  });

  it("stopped: draws what had arrived", async () => {
    const raw = applyHints(await traceJavaScript(CODE));
    const { layout } = setup();
    layout.begin();
    const parts = pieces(raw);
    for (const part of parts.slice(0, 2)) layout.feed(part);
    const ready = layout.load(raw, "stopped", () => {});
    await settle();
    expect(await ready).toBe(true);
    const channel = layout.channel();
    const past = layout.memory(channel, show(5), VIEW); // the pieces sent had 6 steps
    const beyond = layout.memory(channel, show(20), VIEW);
    await settle();
    expect(await past).not.toBeNull();
    expect(await beyond).toBeNull();
  });

  it("a newer trace while one is prepared: the first says it isn't shown", async () => {
    const raw = await traceJavaScript(CODE);
    const { layout } = setup();
    const first = layout.load(raw, "whole", () => {});
    const second = layout.load(raw, "whole", () => {});
    await settle();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
  });

  it("a trace that never arrived, or a worker that fails, is an error, not a blank window", async () => {
    const raw = await traceJavaScript(CODE);
    const { layout, worker, errors } = setup();
    const nothing = expect(layout.load(raw, "streamed", () => {})).rejects.toThrow(/didn't arrive/); // no pieces were sent
    await settle();
    await nothing;
    const ready = layout.load(raw, "whole", () => {});
    worker().onerror?.({ message: "out of memory" });
    await expect(ready).rejects.toThrow(/out of memory/);
    expect(errors).toEqual(["out of memory"]);
  });
});
