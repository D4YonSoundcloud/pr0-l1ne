/**
 * What the page asks of the layout: take a trace (and prepare it), and draw
 * a window's step. Two kinds do it: the layout worker (layout/client.ts),
 * which the app uses, so preparing and laying out never hold up the page;
 * and the page itself (LocalLayout here), for the tests, and if the worker
 * can't start.
 *
 * Draws are latest-wins, a window at a time: while one is being laid out,
 * a newer request for the same window replaces any waiting one, and a
 * request that's replaced resolves with null (scrubbing fast draws the
 * steps it can keep up with, and always the last).
 */
import type { Mark } from "../render/drawing";
import type { Trace } from "../trace/types";
import { finishInSlices, type Progress, type SliceOptions } from "../trace/work";
import type { TracePart } from "../worker/runner";
import type { LoopLaidOut, LoopShow, LoopView, MemoryLaidOut, MemoryShow, MemoryView } from "./requests";
import { LayoutSession } from "./session";

export interface LayoutService {
  /** A window to draw in (each renderer has its own: its kept boxes or rows). */
  channel(): number;
  /** The window's renderer is gone. */
  release(channel: number): void;
  /** A run starts: what it streams comes next (feed). */
  begin(): void;
  /** A piece of the running trace, as the runner checked it (worker/runner.ts feed). */
  feed(part: TracePart): void;
  /**
   * The trace to draw from now: what was fed (`how` "streamed": the run's
   * pieces, or what had arrived when it was stopped: "stopped"), or this
   * one (`how` "whole"). Prepared with its progress reported; resolves true
   * once it's ready to draw, false if another came along meanwhile.
   */
  load(trace: Trace, how: "whole" | "streamed" | "stopped", report: (progress: Progress) => void): Promise<boolean>;
  memory(channel: number, show: MemoryShow, view: MemoryView): Promise<MemoryLaidOut<Mark> | null>;
  loop(channel: number, show: LoopShow, view: LoopView): Promise<LoopLaidOut<Mark> | null>;
}

/**
 * Latest-wins requests for one window: at most one being answered, and the
 * newest one waiting; one replaced while it waited resolves null.
 */
export class LatestWins<R> {
  private busy = false;
  private waiting: { run: () => Promise<R | null>; resolve: (r: R | null) => void } | null = null;

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

  /**
   * `follow`: draw from the page's own trace (prepared on the page) rather
   * than one loaded here, as the controllers do when they're given no
   * layout (their tests).
   */
  constructor(
    private readonly slices: SliceOptions = {},
    private readonly follow?: () => Trace | null,
  ) {}

  /** The page's trace, when following it. */
  private followed(): void {
    if (!this.follow) return;
    const trace = this.follow();
    if (trace && trace !== this.session.current) this.session.use(trace);
  }

  channel(): number {
    return this.nextChannel++;
  }

  release(channel: number): void {
    this.session.release(channel);
    this.lanes.delete(channel);
  }

  begin(): void {}
  feed(): void {}

  async load(trace: Trace, _how: string, report: (progress: Progress) => void): Promise<boolean> {
    const mine = ++this.loading;
    const work = this.session.load(trace);
    // A newer trace while this one is prepared: stop preparing it.
    const sliced = function* (this: LocalLayout) {
      for (;;) {
        if (this.loading !== mine) return false;
        const next = work.next();
        if (next.done) return true;
        yield next.value;
      }
    }.call(this);
    return (await finishInSlices(sliced, report, this.slices)) && this.loading === mine;
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
    return this.lane<MemoryLaidOut<Mark>>(channel).ask(async () => {
      this.followed();
      return this.session.memory(channel, show, view);
    });
  }

  loop(channel: number, show: LoopShow, view: LoopView): Promise<LoopLaidOut<Mark> | null> {
    return this.lane<LoopLaidOut<Mark>>(channel).ask(async () => {
      this.followed();
      return this.session.loop(channel, show, view);
    });
  }
}
