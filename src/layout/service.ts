/**
 * What the page asks of the layout: take a trace (built from the run's
 * pieces, and prepared), say what the page should know of it (TraceInfo),
 * and draw a window's step. The trace is the layout's: the page never holds
 * it. Two kinds do it: the layout worker (layout/client.ts), which the app
 * uses, so building, preparing and laying out never hold up the page; and
 * the page itself (LocalLayout here), for the tests, and if the worker
 * can't start.
 *
 * Draws are latest-wins, a window at a time: while one is being laid out,
 * a newer request for the same window replaces any waiting one, and a
 * request that's replaced resolves with null (scrubbing fast draws the
 * steps it can keep up with, and always the last).
 *
 * While playing, a window asks for the next step ahead (`ahead`), so it's
 * laid out while the step before is on screen: when playback gets to it,
 * it's ready, or on its way.
 */
import type { Mark } from "../render/drawing";
import type { StepChanges } from "../trace/changes";
import type { Estimate } from "../trace/complexity";
import type { Found, ValueHistory, ValueTarget } from "../trace/history";
import type { Measurement } from "../trace/measurement";
import type { TraceInfo } from "../trace/summary";
import type { Trace } from "../trace/types";
import { finishInSlices, type Progress, type SliceOptions, type Work } from "../trace/work";
import type { TracePart } from "../worker/runner";
import { TraceIntake } from "./intake";
import type { LoopLaidOut, LoopShow, LoopView, MemoryLaidOut, MemoryShow, MemoryView } from "./requests";
import { LayoutSession } from "./session";

export interface LayoutService {
  /** A window to draw in (each renderer has its own: its kept boxes or rows). */
  channel(): number;
  /** The window's renderer is gone. */
  release(channel: number): void;
  /** A run starts: what it streams comes next (feed). */
  begin(): void;
  /** A piece of the running trace, as the tracer sent it (worker/runner.ts feed): read and checked here. */
  feed(part: TracePart): void;
  /**
   * The trace to draw from now: what was fed (`how` "streamed": the run's
   * pieces, or what had arrived when it was stopped: "stopped"), or `trace`
   * (`how` "whole"). Built, checked and prepared with its progress
   * reported. Rejects, saying why, when the trace can't be used.
   */
  load(
    how: "whole" | "streamed" | "stopped",
    trace: Trace | null,
    report: (progress: Progress) => void,
  ): Promise<Loaded>;
  /** The complexity estimate for the trace drawn, with Measure's counts for the same code. */
  estimate(measurement: Measurement | null): Promise<Estimate | null>;
  /** What changed at a step of the trace drawn, in words (trace/changes.ts). */
  changes(step: number): Promise<StepChanges>;
  /** A value's history over the run (trace/history.ts), named at step `at`. */
  history(target: ValueTarget, at: number): Promise<ValueHistory>;
  /** The next step after `from` (`back`: the one before) where a condition is true (trace/history.ts findWhere). */
  find(text: string, from: number, back: boolean, first: number): Promise<Found>;
  memory(channel: number, show: MemoryShow, view: MemoryView): Promise<MemoryLaidOut<Mark> | null>;
  loop(channel: number, show: LoopShow, view: LoopView): Promise<LoopLaidOut<Mark> | null>;
  /**
   * The step a window will most likely ask for next (playing: the next
   * step), laid out now if the window has nothing else waiting; asked for
   * the same (memory or loop, with the same show and view), it's the answer.
   */
  ahead(channel: number, ask: Ahead): void;
}

/** A request laid out ahead (LayoutService.ahead). */
export type Ahead =
  | { kind: "memory"; show: MemoryShow; view: MemoryView }
  | { kind: "loop"; show: LoopShow; view: LoopView };

/** What a request asks for, as one string: two the same are answered the same. */
export const requestKey = (kind: "memory" | "loop", show: object, view: object): string =>
  `${kind}:${JSON.stringify(show)}:${JSON.stringify(view)}`;

/** A trace taken: ready (what the page knows of it), replaced by a newer one while it was prepared, or nothing had arrived. */
export type Loaded = { kind: "ready"; info: TraceInfo } | { kind: "replaced" } | { kind: "empty" };

/**
 * Latest-wins requests for one window: at most one being answered, and the
 * newest one waiting; one replaced while it waited resolves null.
 */
export class LatestWins<R> {
  private busy = false;
  private waiting: { run: () => Promise<R | null>; resolve: (r: R | null) => void } | null = null;

  /** Nothing being answered, nothing waiting. */
  get idle(): boolean {
    return !this.busy && !this.waiting;
  }

  ask(run: () => Promise<R | null>): Promise<R | null> {
    return new Promise((resolve) => {
      if (!this.busy) {
        this.start(run, resolve);
        return;
      }
      this.waiting?.resolve(null);
      this.waiting = { run, resolve };
    });
  }

  private start(run: () => Promise<R | null>, resolve: (r: R | null) => void): void {
    this.busy = true;
    run()
      .catch(() => null)
      .then((result) => {
        this.busy = false;
        // Shown even with a newer one waiting: it's newer than what's on screen, and
        // scrubbing fast keeps drawing the steps it can keep up with.
        resolve(result);
        const next = this.waiting;
        this.waiting = null;
        if (next) this.start(next.run, next.resolve);
      });
  }
}

/** The layout on the page: the same session (layout/session.ts), its preparing done a slice at a time. */
export class LocalLayout implements LayoutService {
  private readonly session = new LayoutSession();
  private nextChannel = 1;
  private loading = 0;
  private readonly lanes = new Map<number, LatestWins<unknown>>();
  private readonly intake = new TraceIntake();

  constructor(private readonly slices: SliceOptions = {}) {}

  channel(): number {
    return this.nextChannel++;
  }

  release(channel: number): void {
    this.session.release(channel);
    this.lanes.delete(channel);
  }

  begin(): void {
    this.intake.begin();
  }

  feed(part: TracePart): void {
    this.intake.feed(part);
  }

  async load(
    how: "whole" | "streamed" | "stopped",
    trace: Trace | null,
    report: (progress: Progress) => void,
  ): Promise<Loaded> {
    const mine = ++this.loading;
    const raw = this.intake.take(how, trace);
    if (!raw) return { kind: "empty" };
    const work = this.session.load(raw);
    // A newer trace while this one is prepared: stop preparing it.
    const sliced = function* (this: LocalLayout): Work<TraceInfo | null> {
      for (;;) {
        if (this.loading !== mine) return null;
        const next = work.next();
        if (next.done) return next.value;
        yield next.value;
      }
    }.call(this);
    const info = await finishInSlices(sliced, report, this.slices);
    return info && this.loading === mine ? { kind: "ready", info } : { kind: "replaced" };
  }

  async estimate(measurement: Measurement | null): Promise<Estimate | null> {
    return this.session.estimate(measurement);
  }

  async changes(step: number): Promise<StepChanges> {
    return this.session.changes(step);
  }

  async history(target: ValueTarget, at: number): Promise<ValueHistory> {
    return this.session.history(target, at);
  }

  async find(text: string, from: number, back: boolean, first: number): Promise<Found> {
    return this.session.find(text, from, back, first);
  }

  private lane<R>(channel: number): LatestWins<R> {
    let lane = this.lanes.get(channel);
    if (!lane) {
      lane = new LatestWins<unknown>();
      this.lanes.set(channel, lane);
    }
    return lane as LatestWins<R>;
  }

  memory(channel: number, show: MemoryShow, view: MemoryView): Promise<MemoryLaidOut<Mark> | null> {
    return this.lane<MemoryLaidOut<Mark>>(channel).ask(async () => this.session.memory(channel, show, view));
  }

  loop(channel: number, show: LoopShow, view: LoopView): Promise<LoopLaidOut<Mark> | null> {
    return this.lane<LoopLaidOut<Mark>>(channel).ask(async () => this.session.loop(channel, show, view));
  }

  /** On the page, laying out ahead would only take the page's time sooner: nothing's done until it's asked for. */
  ahead(_channel: number, _ask: Ahead): void {}
}
