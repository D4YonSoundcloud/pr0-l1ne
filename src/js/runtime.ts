/**
 * The JavaScript runtime recorder: the counterpart of tracer.py.
 *
 * Instrumented code (see instrument.ts) calls these methods as it runs. The
 * runtime keeps a shadow call stack, tracks loop iterations, and at every
 * event serializes all frames and everything they reach into a Step, in
 * exactly the format the Python tracer produces. Which steps are recorded is
 * sampling.ts's decision; how values look is inspector.ts's.
 */

import { sameData } from "../trace/delta";
import type { SamplingPolicy } from "../trace/policy";
import type { HeapObject, LoopContext, Step } from "../trace/types";
import {
  CONVENTIONAL_POINTERS,
  errorMessage,
  errorName,
  type Getter,
  inspect,
  isListLike,
  MAX_ITEMS,
  Serializer,
} from "./inspector";
import { type LoopState, RECORD, Sampler } from "./sampling";

export type { Getter } from "./inspector";

const MAX_DEPTH = 250;

/** Thrown to stop the program when the step budget runs out. */
export class StepLimit {
  readonly reason = "step limit";
}

interface FrameState {
  id: string;
  func: string;
  line: number;
  getter: Getter;
  loops: Map<string, LoopState>;
}

interface Timer {
  id: number;
  at: number;
  seq: number;
  run: () => void;
  every?: number;
}

export class Runtime {
  readonly steps: Step[] = [];
  readonly ABORT = new StepLimit();
  stdout = "";

  private frames: FrameState[] = [];
  /** Generators and async functions paused at a yield or await, oldest first. */
  private suspended = new Set<FrameState>();
  private frameCounter = 0;
  private aborted = false;
  private recording = false;
  /** Set by finish(): nothing is recorded after "Program finished". */
  private closed = false;
  private loopInstances = new Map<string, number>();
  private objectIds = new WeakMap<object, string>();
  private objectCounter = 0;
  // biome-ignore lint/complexity/noBannedTypes: keys are the user's own functions and classes, of any shape
  private closures = new WeakMap<Function, { name: string; captured: Getter }>();
  private errorLines = new WeakMap<object, number>();
  private lastErrorLine: number | null = null;

  /** Everything that happens is counted, recorded or not. */
  readonly counts = { steps: 0, calls: {} as Record<string, number>, depth: {} as Record<string, number> };
  stoppedBy: "steps" | "time" | null = null;
  private tick = 1000;
  private readonly deadline: number;
  /** The function being called again and again from one line (a callback given to map, Array.from...). */
  private callbacks: { caller: FrameState; line: number; func: string; defLine: number; state: LoopState } | null =
    null;
  /** A callback call's place in its run. */
  private callbackOf = new Map<FrameState, LoopState>();

  private readonly sampler: Sampler;

  constructor(
    private readonly maxSteps: number,
    maxSeconds: number,
    sampling: SamplingPolicy,
  ) {
    this.sampler = new Sampler(maxSteps, sampling, (step) => this.commit(step));
    this.deadline = (typeof performance !== "undefined" ? performance.now() : Date.now()) + maxSeconds * 1000;
  }

  /** Steps not recorded after the last one (a sampled loop at the very end). */
  get skippedAtEnd(): number {
    return this.sampler.skipped;
  }

  /** Was any loop sampled (some of its passes not recorded)? */
  get sampled(): boolean {
    return this.sampler.sampled;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  // -- called by instrumented code ------------------------------------------

  enter(func: string, line: number, getter: Getter): FrameState {
    if (this.frames.length >= MAX_DEPTH) {
      throw new RangeError(`More than ${MAX_DEPTH} nested calls. Is a recursive function missing its base case?`);
    }
    const frame: FrameState = { id: `f${++this.frameCounter}`, func, line, getter, loops: new Map() };
    this.frames.push(frame);
    this.counts.calls[func] = (this.counts.calls[func] ?? 0) + 1;
    let depth = 0;
    for (const f of this.frames) if (f.func === func) depth++;
    if (depth > (this.counts.depth[func] ?? 0)) this.counts.depth[func] = depth;
    const caller = this.frames[this.frames.length - 2];
    if (caller) {
      let run = this.callbacks;
      if (!run || run.caller !== caller || run.line !== caller.line || run.func !== func || run.defLine !== line) {
        run = this.callbacks = { caller, line: caller.line, func, defLine: line, state: this.sampler.pseudo() };
      }
      run.state.iteration++;
      this.sampler.newPass(run.state);
      this.callbackOf.set(frame, run.state);
    }
    this.record("call");
    return frame;
  }

  exit(frame: FrameState): void {
    const index = this.frames.lastIndexOf(frame);
    if (index >= 0) this.frames.splice(index, 1);
    this.suspended.delete(frame);
    this.callbackOf.delete(frame);
  }

  line(frame: FrameState, line: number, getter: Getter): void {
    this.ensure(frame);
    if (this.callbacks?.caller === frame && this.callbacks.line !== line) this.callbacks = null; // the caller moved on
    frame.line = line;
    frame.getter = getter;
    this.record("line");
  }

  ret<T>(frame: FrameState, value: T, getter?: Getter): T {
    this.ensure(frame);
    if (getter) frame.getter = getter;
    this.record("return", { returnValue: value });
    return value;
  }

  raise(frame: FrameState, error: unknown): void {
    if (error === this.ABORT) return;
    this.ensure(frame);
    if (typeof error === "object" && error !== null && !this.errorLines.has(error)) {
      this.errorLines.set(error, frame.line);
    }
    this.lastErrorLine ??= frame.line;
    this.record("exception", { exception: { type: errorName(error), message: errorMessage(error) } });
  }

  loopEnter(frame: FrameState, id: string, line: number, getter: Getter): void {
    this.ensure(frame);
    const key = `${frame.id}/${id}`;
    const instance = (this.loopInstances.get(key) ?? 0) + 1;
    this.loopInstances.set(key, instance);
    frame.loops.set(id, this.sampler.loop(instance));
    this.line(frame, line, getter);
  }

  loopIter(frame: FrameState, id: string): void {
    this.ensure(frame);
    const state = frame.loops.get(id);
    if (!state) return;
    state.iteration++;
    this.sampler.newPass(state);
  }

  /** for (x of xs): note the loop's length as it starts. */
  loopLength<T>(frame: FrameState, id: string, iterable: T): T {
    const state = frame.loops.get(id);
    const n =
      Array.isArray(iterable) || typeof iterable === "string"
        ? iterable.length
        : iterable instanceof Map || iterable instanceof Set
          ? iterable.size
          : null;
    if (state && state.iteration === 0 && n !== null) state.total = n;
    return iterable;
  }

  /** for (let j = A; j < B; j++): the header with A and B's values, shown on the loop's rows. */
  loopCall(
    frame: FrameState,
    id: string,
    name: string,
    op: string,
    update: string,
    start: unknown,
    bound: unknown,
  ): void {
    const state = frame.loops.get(id);
    if (state?.iteration !== 0) return;
    const show = (v: unknown) => (typeof v === "number" || typeof v === "bigint" ? String(v) : null);
    const a = show(start);
    const b = show(bound);
    if (a !== null && b !== null) state.call = `${name} = ${a}; ${name} ${op} ${b}; ${update}`;
  }

  /** for (let i = A; i < B; i++): B - A passes. */
  loopTotal(frame: FrameState, id: string, total: unknown): void {
    const state = frame.loops.get(id);
    if (state && state.iteration === 0 && typeof total === "number" && Number.isFinite(total))
      state.total = Math.max(0, total);
  }

  /** End of an iteration: a snapshot at the loop header, like Python's re-check. */
  tail(frame: FrameState, id: string, line: number, getter: Getter): void {
    if (frame.loops.has(id)) this.line(frame, line, getter);
  }

  loopExit(frame: FrameState, id: string): void {
    frame.loops.delete(id);
  }

  /** Remember which variables a closure captured, for the heap view. */
  // biome-ignore lint/complexity/noBannedTypes: wraps any user function or class and returns it unchanged
  fn<F extends Function>(fn: F, name: string, captured: Getter): F {
    this.closures.set(fn, { name, captured });
    return fn;
  }

  // -- pausing: generators and async functions --------------------------------

  /** `yield value`: record it, then the frame leaves the stack until resumed. */
  yielding<T>(frame: FrameState, value: T): T {
    this.ensure(frame);
    this.record("yield", { returnValue: value });
    this.suspend(frame);
    return value;
  }

  /** `yield* inner`: the frame pauses while `inner` produces values. */
  delegating<T>(frame: FrameState, inner: T): T {
    this.ensure(frame);
    this.record("yield");
    this.suspend(frame);
    return inner;
  }

  /** `await value`: record it, then the frame leaves the stack until resumed. */
  awaiting<T>(frame: FrameState, value: T): T {
    this.ensure(frame);
    this.record("await");
    this.suspend(frame);
    return value;
  }

  /** The value a paused frame resumed with (sent in, or awaited). */
  resumed<T>(frame: FrameState, value: T): T {
    this.ensure(frame);
    this.record("resume");
    return value;
  }

  /**
   * `for await (x of items)` pauses before each item. Wrap the iterable so
   * each of those pauses is an await, like an explicit one. Plain iterables
   * work too, with each item awaited, as `for await` does.
   */
  asyncIter(frame: FrameState, iterable: unknown): AsyncIterable<unknown> {
    const source = iterable as {
      [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
      [Symbol.iterator]?: () => Iterator<unknown>;
    };
    const isAsync = typeof source?.[Symbol.asyncIterator] === "function";
    const it: AsyncIterator<unknown> | Iterator<unknown> = isAsync
      ? source[Symbol.asyncIterator]!()
      : source[Symbol.iterator]!();
    const runtime = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(value?: unknown) {
            runtime.awaiting(frame, undefined);
            return Promise.resolve(it.next(value)).then((result) =>
              result.done || isAsync ? result : Promise.resolve(result.value).then((v) => ({ value: v, done: false })),
            );
          },
          return(value?: unknown) {
            return Promise.resolve(it.return ? it.return(value) : { value, done: true as const });
          },
        } as AsyncIterator<unknown>;
      },
    };
  }

  /** The script reached its end. Global stays on the stack until finish(). */
  mainDone(frame: FrameState, getter: Getter): void {
    frame.getter = getter;
  }

  // -- the event loop ----------------------------------------------------------

  private timers: Timer[] = [];
  private timerSeq = 0;
  private clock = 0;

  /**
   * Virtual timers for the program: setTimeout and friends run in order of
   * their deadlines, as fast as possible, once the program and every
   * promise it's waiting on have settled.
   */
  readonly timerApi = (() => {
    const add = (fn: unknown, ms: unknown, args: unknown[], every?: number) => {
      const id = ++this.timerSeq;
      if (typeof fn !== "function") return id;
      const delay = Math.max(0, Number(ms) || 0);
      this.timers.push({ id, at: this.clock + delay, seq: id, run: () => fn(...args), every });
      return id;
    };
    const clear = (id: unknown) => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
    return {
      setTimeout: (fn: unknown, ms?: unknown, ...args: unknown[]) => add(fn, ms, args),
      setInterval: (fn: unknown, ms?: unknown, ...args: unknown[]) => add(fn, ms, args, Math.max(1, Number(ms) || 0)),
      clearTimeout: clear,
      clearInterval: clear,
    };
  })();

  /** Take the next due timer, advancing the virtual clock to it. */
  nextTimer(): (() => void) | null {
    if (!this.timers.length) return null;
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const timer = this.timers.shift()!;
    this.clock = timer.at;
    if (timer.every !== undefined) this.timers.push({ ...timer, at: timer.at + timer.every, seq: ++this.timerSeq });
    return timer.run;
  }

  /** Stop recording (code that runs after the trace is done is ignored). */
  close(): void {
    this.closed = true;
  }

  /** Everything has run: record "Program finished" and stop recording. */
  finish(): void {
    const global = this.frames[0];
    if (global && global.func === "Global" && !this.aborted) {
      this.frames.length = 1; // anything else left on the stack is stale
      this.record("return", { returnValue: undefined });
      this.frames.length = 0;
    }
    this.closed = true;
  }

  /**
   * Make `frame` the running frame. If it isn't on top of the stack, it's a
   * paused generator or async function continuing: put it back. Frames
   * above it are ones that paused without us seeing it, so move them to
   * the suspended list.
   */
  private ensure(frame: FrameState): void {
    if (this.frames[this.frames.length - 1] === frame) return;
    const index = this.frames.lastIndexOf(frame);
    if (index >= 0) {
      for (const stale of this.frames.splice(index + 1)) this.suspended.add(stale);
      return;
    }
    this.suspended.delete(frame);
    this.frames.push(frame);
  }

  private suspend(frame: FrameState): void {
    const index = this.frames.lastIndexOf(frame);
    if (index >= 0) this.frames.splice(index, 1);
    this.suspended.add(frame);
  }

  // -- results ----------------------------------------------------------------

  errorLine(error: unknown): number | null {
    if (typeof error === "object" && error !== null) return this.errorLines.get(error) ?? this.lastErrorLine;
    return this.lastErrorLine;
  }

  /** What console.log() was given since the last step, so the canvas can point at printed objects. */
  private pendingOutput: { line: number; objects: object[] } | null = null;

  /** A console that prints into the trace's stdout. */
  readonly console = (() => {
    const print = (...args: unknown[]) => {
      this.stdout += `${args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" ")}\n`;
      const pending = this.pendingOutput ?? { line: this.frames[this.frames.length - 1]?.line ?? 0, objects: [] };
      for (const arg of args)
        if ((typeof arg === "object" && arg !== null) || typeof arg === "function") pending.objects.push(arg as object);
      this.pendingOutput = pending;
    };
    return { log: print, info: print, warn: print, error: print, debug: print, table: print };
  })();

  // -- internals --------------------------------------------------------------

  /** Index names, from the code and `viz: pointers` hints (set by trace.ts). */
  indexNames: Record<string, string[]> = {};

  /** Long lists' index variables: list -> their values, innermost frame first. */
  private focusOf(): Map<object, number[]> {
    const focus = new Map<object, number[]>();
    if (!Object.keys(this.indexNames).length) return focus;
    for (let f = this.frames.length - 1; f >= 0; f--) {
      const locals = new Map<string, unknown>();
      for (const [name, read] of this.frames[f].getter()) {
        try {
          locals.set(name, read());
        } catch {
          // not declared yet
        }
      }
      for (const [name, value] of locals) {
        if (!isListLike(value) || value.length <= MAX_ITEMS || focus.has(value as object)) continue;
        const subs = this.indexNames[name];
        if (!subs) continue;
        const indices: number[] = [];
        for (const sub of new Set([...subs, ...CONVENTIONAL_POINTERS.filter((c) => locals.has(c))])) {
          const x = locals.get(sub);
          if (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= value.length) indices.push(x);
        }
        if (indices.length) focus.set(value as object, indices);
      }
    }
    return focus;
  }

  /** The last committed step's heap, to share unchanged objects with. */
  private prevHeap: Record<string, HeapObject> = {};

  private commit(step: Step): void {
    if (this.sampler.skipped) {
      step.skipped = this.sampler.skipped;
      this.sampler.skipped = 0;
    }
    // An object that didn't change since the step before is the same
    // object: steps share it, here and (structured clone keeps sharing)
    // on the page. See trace/delta.ts.
    const prev = this.prevHeap;
    for (const id in step.heap) {
      const before = prev[id];
      if (before && before !== step.heap[id] && sameData(before, step.heap[id])) step.heap[id] = before;
    }
    this.prevHeap = step.heap;
    this.steps.push(step);
  }

  /** Loop states on the stack, outermost first: callback runs, then loop statements. */
  private activeStates(): LoopState[] {
    const states: LoopState[] = [];
    for (const frame of this.frames) {
      const run = this.callbackOf.get(frame);
      if (run && run.iteration > 0) states.push(run);
      for (const state of frame.loops.values()) states.push(state);
    }
    return states;
  }

  private record(event: Step["event"], extra: { returnValue?: unknown; exception?: Step["exception"] } = {}): void {
    if (this.recording || this.closed) return; // never record while reading user values
    // Once the budget is spent, every event throws. User code can catch the
    // first throw, but the first statement in any catch block is itself an
    // event, so the program can never make progress past the limit.
    if (this.aborted || this.steps.length >= this.maxSteps) {
      this.aborted = true;
      this.stoppedBy ??= "steps";
      throw this.ABORT;
    }
    this.counts.steps++;
    if (--this.tick <= 0) {
      this.tick = 1000;
      if ((typeof performance !== "undefined" ? performance.now() : Date.now()) > this.deadline) {
        this.aborted = true;
        this.stoppedBy = "time";
        throw this.ABORT;
      }
    }
    // Sampling: is this step in a pass of a long loop that isn't recorded?
    const into = this.sampler.sampled ? this.sampler.place(this.activeStates()) : RECORD;
    if (into === null) return;
    this.recording = true;
    try {
      const serializer = new Serializer(
        this.objectIds,
        () => `o${++this.objectCounter}`,
        this.closures,
        this.focusOf(),
      );
      const describe = (frame: FrameState) => ({
        id: frame.id,
        func: frame.func,
        line: frame.line,
        locals: serializer.locals(frame.getter),
      });
      const stack = this.frames.map(describe);
      const paused = [...this.suspended].filter((frame) => !this.frames.includes(frame));
      // Loops in paused frames stay active, so their history isn't cut short.
      const loops: LoopContext[] = [...this.frames, ...paused].flatMap((frame) =>
        [...frame.loops].map(([loop, state]) => ({
          frame: frame.id,
          loop,
          instance: state.instance,
          iteration: state.iteration,
          ...(state.call ? { call: state.call } : {}),
        })),
      );
      const step: Step = {
        event,
        line: this.frames[this.frames.length - 1]?.line ?? 0,
        stack,
        heap: serializer.heap,
        stdoutLength: this.stdout.length,
        loops,
      };
      if (paused.length) step.suspended = paused.map((frame) => ({ ...describe(frame), state: "suspended" as const }));
      if (this.pendingOutput) {
        const refs: string[] = [];
        for (const obj of this.pendingOutput.objects) {
          const id = this.objectIds.get(obj);
          if (id && serializer.heap[id] && !refs.includes(id)) refs.push(id);
        }
        step.output = { line: this.pendingOutput.line, refs };
        this.pendingOutput = null;
      }
      if ("returnValue" in extra) step.returnValue = serializer.value(extra.returnValue);
      if (extra.exception) step.exception = extra.exception;
      this.sampler.considered++;
      if (into !== RECORD) into.push(step);
      else this.commit(step);
    } finally {
      this.recording = false;
    }
  }
}
