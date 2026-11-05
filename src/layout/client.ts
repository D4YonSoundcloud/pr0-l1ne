/**
 * The layout worker, from the page (layout/service.ts LayoutService): the
 * run's pieces passed on as they arrive, the trace prepared there with its
 * progress reported here, and each window's step drawn there and made into
 * marks here (render/wire.ts), the marks kept from the step before being
 * the page's own from then.
 */
import { perf, timed } from "../perf";
import type { Mark } from "../render/drawing";
import { MarkMirror, type WireDrawing, WireError } from "../render/wire";
import type { Estimate } from "../trace/complexity";
import type { Measurement } from "../trace/measurement";
import type { Trace } from "../trace/types";
import type { Progress } from "../trace/work";
import type { TracePart } from "../worker/runner";
import type { FromLayout, ToLayout } from "./protocol";
import type { LoopLaidOut, LoopShow, LoopView, MemoryLaidOut, MemoryShow, MemoryView } from "./requests";
import { type Ahead, LatestWins, type LayoutService, type Loaded, requestKey } from "./service";

/** What the client needs of a worker (tests pass a fake). */
export interface LayoutWorkerLike {
  postMessage(message: ToLayout): void;
  onmessage: ((event: MessageEvent<FromLayout>) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

/** The layout worker, a module worker of the app's own. */
export const startLayoutWorker = (): LayoutWorkerLike =>
  new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module", name: "layout" }) as LayoutWorkerLike;

interface Window {
  mirror: MarkMirror;
  /** The last drawing made from what it sent: held, so the marks the next one keeps are still here. */
  last: Mark | null;
  lane: LatestWins<unknown>;
  /** A request laid out ahead (LayoutService.ahead), by what it asks for: answered or on its way. */
  ahead: { key: string; answer: Promise<unknown> } | null;
}

type Reply = Extract<FromLayout, { type: "memory" | "loop" }>;

export class WorkerLayout implements LayoutService {
  private readonly worker: LayoutWorkerLike;
  private nextChannel = 1;
  private nextId = 1;
  private loads = 0;
  private readonly windows = new Map<number, Window>();
  private readonly replies = new Map<number, (reply: Reply) => void>();
  private loading: {
    load: number;
    report: (progress: Progress) => void;
    resolve: (loaded: Loaded) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(
    start: () => LayoutWorkerLike = startLayoutWorker,
    /** Told when the worker fails (it's a bug): the run controller reports it as a crash. */
    private readonly onError: (message: string) => void = (message) => console.error("Layout worker:", message),
  ) {
    this.worker = start();
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = (event) => {
      const message = event.message || "the layout worker stopped";
      this.onError(message);
      this.loading?.reject(new Error(message));
      this.loading = null;
      for (const resolve of this.replies.values()) resolve({ type: "memory", id: 0, laidOut: null, error: message });
      this.replies.clear();
      for (const resolve of this.estimates.values()) resolve(null);
      this.estimates.clear();
    };
  }

  channel(): number {
    return this.nextChannel++;
  }

  release(channel: number): void {
    this.windows.delete(channel);
    this.worker.postMessage({ type: "release", channel });
  }

  begin(): void {
    this.worker.postMessage({ type: "begin" });
  }

  feed(part: TracePart): void {
    this.worker.postMessage({ type: "feed", part });
  }

  load(
    how: "whole" | "streamed" | "stopped",
    trace: Trace | null,
    report: (progress: Progress) => void,
  ): Promise<Loaded> {
    const load = ++this.loads;
    this.loading?.resolve({ kind: "replaced" });
    // Laid out ahead from the trace before: not what will be asked for.
    for (const w of this.windows.values()) w.ahead = null;
    return new Promise((resolve, reject) => {
      this.loading = { load, report, resolve, reject };
      this.worker.postMessage(
        how === "whole" && trace ? { type: "load", load, how, trace } : { type: "load", load, how },
      );
    });
  }

  /** Estimates asked for, by request. */
  private readonly estimates = new Map<number, (estimate: Estimate | null) => void>();

  estimate(measurement: Measurement | null): Promise<Estimate | null> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.estimates.set(id, resolve);
      this.worker.postMessage({ type: "estimate", id, measurement });
    });
  }

  memory(channel: number, show: MemoryShow, view: MemoryView): Promise<MemoryLaidOut<Mark> | null> {
    return this.ask(channel, view.full, requestKey("memory", show, view), (id) => ({
      type: "memory",
      id,
      channel,
      show,
      view,
      perf: perf.on,
    })) as Promise<MemoryLaidOut<Mark> | null>;
  }

  loop(channel: number, show: LoopShow, view: LoopView): Promise<LoopLaidOut<Mark> | null> {
    return this.ask(channel, view.full, requestKey("loop", show, view), (id) => ({
      type: "loop",
      id,
      channel,
      show,
      view,
      perf: perf.on,
    })) as Promise<LoopLaidOut<Mark> | null>;
  }

  ahead(channel: number, ask: Ahead): void {
    const w = this.window(channel);
    const key = requestKey(ask.kind, ask.show, ask.view);
    // Only when the window has nothing else to do: never in the way of a step asked for.
    if (ask.view.full || w.ahead?.key === key || !w.lane.idle) return;
    const message = (id: number): Extract<ToLayout, { type: "memory" | "loop" }> =>
      ask.kind === "memory"
        ? { type: "memory", id, channel, show: ask.show, view: ask.view, perf: perf.on }
        : { type: "loop", id, channel, show: ask.show, view: ask.view, perf: perf.on };
    w.ahead = { key, answer: w.lane.ask(() => this.send(channel, w, false, message, true)) };
    if (perf.on) perf.record("layout.ahead", 1);
  }

  private window(channel: number): Window {
    let w = this.windows.get(channel);
    if (!w) {
      w = { mirror: new MarkMirror(), last: null, lane: new LatestWins(), ahead: null };
      this.windows.set(channel, w);
    }
    return w;
  }

  private ask(
    channel: number,
    full: boolean | undefined,
    key: string,
    message: (id: number) => Extract<ToLayout, { type: "memory" | "loop" }>,
  ): Promise<unknown> {
    const w = this.window(channel);
    // Saving lays out on the side: not in the window's line of draws.
    if (full) return this.send(channel, w, true, message, true);
    // Laid out ahead: that's the answer (already here, or on its way). Anything else: not needed now.
    const ahead = w.ahead;
    w.ahead = null;
    if (ahead?.key === key) {
      if (perf.on) perf.record("layout.ahead.used", 1);
      return ahead.answer;
    }
    return w.lane.ask(() => this.send(channel, w, false, message, true));
  }

  /** Send a request, and make what comes back into marks (every drawing sent is read, in order, so the numbers stay in step). */
  private send(
    channel: number,
    w: Window,
    full: boolean,
    message: (id: number) => Extract<ToLayout, { type: "memory" | "loop" }>,
    retry: boolean,
  ): Promise<unknown> {
    return new Promise<Reply>((resolve) => {
      const id = this.nextId++;
      const sent = perf.on ? performance.now() : 0;
      this.replies.set(id, (reply) => {
        if (perf.on) perf.record("layout.roundtrip", performance.now() - sent);
        resolve(reply);
      });
      this.worker.postMessage(message(id));
    }).then((reply) => {
      // The worker's times, with the page's own (the benchmarks read them together).
      for (const [stage, list] of reply.perf ?? []) for (const ms of list) perf.record(stage, ms);
      if (reply.error) {
        this.onError(reply.error);
        return null;
      }
      const laidOut = reply.laidOut;
      if (!laidOut?.drawing) return laidOut;
      try {
        // Saved ones on their own.
        const drawing = timed("wire.decode", () =>
          full
            ? new MarkMirror().decode(laidOut.drawing as WireDrawing)
            : w.mirror.decode(laidOut.drawing as WireDrawing),
        );
        if (!full) w.last = drawing;
        return { ...laidOut, drawing };
      } catch (error) {
        if (!(error instanceof WireError) || !retry) throw error;
        // Out of step (a bug, or a copy of a mark changed on the page): start the window afresh, and ask again.
        if (perf.on) perf.record("wire.reset", 1);
        w.mirror = new MarkMirror();
        w.last = null;
        this.worker.postMessage({ type: "reset", channel });
        return this.send(channel, w, full, message, false);
      }
    });
  }

  private receive(message: FromLayout): void {
    switch (message.type) {
      case "progress":
        if (this.loading?.load === message.load) this.loading.report(message.progress);
        return;
      case "loaded": {
        const loading = this.loading;
        if (loading?.load !== message.load) return;
        this.loading = null;
        if (message.error) loading.reject(new Error(message.error));
        else loading.resolve(message.info ? { kind: "ready", info: message.info } : { kind: "empty" });
        return;
      }
      case "estimate": {
        const resolve = this.estimates.get(message.id);
        this.estimates.delete(message.id);
        resolve?.(message.estimate);
        return;
      }
      case "memory":
      case "loop": {
        const resolve = this.replies.get(message.id);
        this.replies.delete(message.id);
        resolve?.(message);
        return;
      }
    }
  }

  dispose(): void {
    this.worker.terminate();
  }
}
