/**
 * The JavaScript runtime recorder: the counterpart of tracer.py.
 *
 * Instrumented code (see instrument.ts) calls these methods as it runs. The
 * runtime keeps a shadow call stack, tracks loop iterations, and at every
 * event serializes all frames and everything they reach into a Step, in
 * exactly the format the Python tracer produces.
 */
import type { HeapObject, LoopContext, PrimValue, SequenceObject, Step, Value } from "../trace/types";
import { sameData } from "../trace/delta";

/** [name, () => value] for each visible variable, produced by the instrumenter. */
export type Getter = () => [string, () => unknown][];

const MAX_ITEMS = 60;
const MAX_REPR = 48;
const MAX_OBJECTS = 400;
const MAX_DEPTH = 250;

// Sampling long loops: the same rules as the Python tracer (see tracer.py).
const SAMPLE_FIRST = 5;
const SAMPLE_LAST = 5;
export const TRACE_SECONDS = 6;

/** 10, 20 ... 90, 100, 200 ... 900, 1000 ...: a pass worth keeping in a long loop. */
export function roundPass(n: number): boolean {
  if (n < 10) return false;
  const scale = 10 ** (String(n).length - 1);
  return n % scale === 0;
}

interface LoopState {
  instance: number;
  iteration: number;
  /** How many passes it will make, when known as it starts. */
  total: number | null;
  /** Decided after its first passes: recorded in full, or sampled. */
  mode: "full" | "watch" | "sampled" | null;
  /** Steps recorded or buffered when it started. */
  start: number;
  /** Not a loop statement: one function called again and again from one line (no last passes kept). */
  pseudo?: boolean;
  /** Is the current pass recorded (decided as it starts), and how many have been. */
  keep?: boolean;
  kept?: number;
}

/** A pass in the buffer of a long loop's last passes. Pinned: a round-numbered pass, always kept. */
interface TailPass {
  it: number;
  steps: Step[];
  pinned: boolean;
}

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

const prim = (type: string, repr: string): PrimValue => ({
  kind: "prim",
  type,
  repr: repr.length > MAX_REPR ? `${repr.slice(0, MAX_REPR - 1)}…` : repr,
});

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
  private closures = new WeakMap<Function, { name: string; captured: Getter }>();
  private errorLines = new WeakMap<object, number>();
  private lastErrorLine: number | null = null;

  /** Everything that happens is counted, recorded or not. */
  readonly counts = { steps: 0, calls: {} as Record<string, number>, depth: {} as Record<string, number> };
  sampled = false;
  stoppedBy: "steps" | "time" | null = null;
  /** Events not recorded since the last recorded step. */
  private skipped = 0;
  /** Steps recorded or buffered (a loop's share of the budget). */
  private considered = 0;
  private tick = 1000;
  private readonly deadline: number;
  /** The last passes of a long loop whose length wasn't known, kept until it ends. */
  private tailBuffer: { state: LoopState; passes: TailPass[]; loose: number } | null = null;
  /** The function being called again and again from one line (a callback given to map, Array.from...). */
  private callbacks: { caller: FrameState; line: number; func: string; defLine: number; state: LoopState } | null = null;
  /** A callback call's place in its run. */
  private callbackOf = new Map<FrameState, LoopState>();

  constructor(private readonly maxSteps: number, maxSeconds = TRACE_SECONDS) {
    this.deadline = (typeof performance !== "undefined" ? performance.now() : Date.now()) + maxSeconds * 1000;
  }

  /** Steps not recorded after the last one (a sampled loop at the very end). */
  get skippedAtEnd(): number {
    return this.skipped;
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
        run = this.callbacks = { caller, line: caller.line, func, defLine: line, state: this.pseudoState() };
      }
      run.state.iteration++;
      this.newPass(run.state);
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
    frame.loops.set(id, { instance, iteration: 0, total: null, mode: null, start: this.considered });
    this.line(frame, line, getter);
  }

  loopIter(frame: FrameState, id: string): void {
    this.ensure(frame);
    const state = frame.loops.get(id);
    if (!state) return;
    state.iteration++;
    this.newPass(state);
  }

  private pseudoState(): LoopState {
    return { instance: 0, iteration: 0, total: null, mode: null, start: this.considered, pseudo: true };
  }

  /** After a loop's first passes, decide whether to record all of it. */
  private newPass(state: LoopState): void {
    const room = this.maxSteps - state.start;
    if (state.mode === null && state.iteration === SAMPLE_FIRST + 1) {
      const perPass = (this.considered - state.start) / SAMPLE_FIRST;
      state.mode = state.total !== null ? (perPass * state.total > room * 0.5 ? "sampled" : "full") : "watch";
    }
    if (state.mode === "watch" && this.considered - state.start > room * 0.25) state.mode = "sampled";
    if (state.mode === "sampled") {
      this.sampled = true;
      state.keep = this.decideKeep(state, room);
    } else {
      state.keep = true;
    }
    if (state.keep) state.kept = (state.kept ?? 0) + 1;
  }

  /**
   * In a sampled loop: record this pass? The first and last few, and
   * round-numbered ones while the loop's share of the budget allows
   * (leaving room for its last passes).
   */
  private decideKeep(state: LoopState, room: number): boolean {
    const it = state.iteration;
    if (it <= SAMPLE_FIRST || (state.total !== null && it > state.total - SAMPLE_LAST)) return true;
    if (!roundPass(it)) return false;
    const spent = this.considered - state.start;
    const perPass = spent / Math.max(1, state.kept ?? 0);
    return spent + perPass * (SAMPLE_LAST + 1) <= room * 0.6;
  }

  /** for (x of xs): note the loop's length as it starts. */
  loopLength<T>(frame: FrameState, id: string, iterable: T): T {
    const state = frame.loops.get(id);
    const n = Array.isArray(iterable) || typeof iterable === "string" ? iterable.length
      : iterable instanceof Map || iterable instanceof Set ? iterable.size : null;
    if (state && state.iteration === 0 && n !== null) state.total = n;
    return iterable;
  }

  /** for (let i = A; i < B; i++): B - A passes. */
  loopTotal(frame: FrameState, id: string, total: unknown): void {
    const state = frame.loops.get(id);
    if (state && state.iteration === 0 && typeof total === "number" && Number.isFinite(total)) state.total = Math.max(0, total);
  }

  /** End of an iteration: a snapshot at the loop header, like Python's re-check. */
  tail(frame: FrameState, id: string, line: number, getter: Getter): void {
    if (frame.loops.has(id)) this.line(frame, line, getter);
  }

  loopExit(frame: FrameState, id: string): void {
    frame.loops.delete(id);
  }

  /** Remember which variables a closure captured, for the heap view. */
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
    const source = iterable as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown>; [Symbol.iterator]?: () => Iterator<unknown> };
    const isAsync = typeof source?.[Symbol.asyncIterator] === "function";
    const it: AsyncIterator<unknown> | Iterator<unknown> = isAsync ? source[Symbol.asyncIterator]!() : source[Symbol.iterator]!();
    const runtime = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(value?: unknown) {
            runtime.awaiting(frame, undefined);
            return Promise.resolve(it.next(value)).then((result) =>
              result.done || isAsync ? result : Promise.resolve(result.value).then((v) => ({ value: v, done: false })));
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
    const clear = (id: unknown) => { this.timers = this.timers.filter((t) => t.id !== id); };
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
      this.stdout += args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" ") + "\n";
      const pending = this.pendingOutput ?? { line: this.frames[this.frames.length - 1]?.line ?? 0, objects: [] };
      for (const arg of args) if ((typeof arg === "object" && arg !== null) || typeof arg === "function") pending.objects.push(arg as object);
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

  private static keepPass(state: LoopState): boolean {
    return state.mode !== "sampled" || state.keep !== false;
  }

  /** The last committed step's heap, to share unchanged objects with. */
  private prevHeap: Record<string, HeapObject> = {};

  private commit(step: Step): void {
    if (this.skipped) {
      step.skipped = this.skipped;
      this.skipped = 0;
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

  /** The buffered last passes of a long loop: saved once the loop ends. */
  private settleTail(states: LoopState[]): void {
    const tail = this.tailBuffer;
    if (!tail || states.includes(tail.state)) return;
    for (const pass of tail.passes) for (const step of pass.steps) this.commit(step);
    this.tailBuffer = null;
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

  /**
   * Where this step goes in a long loop of unknown length: a buffer of its
   * last passes, in case they're the last. Round-numbered passes are pinned
   * there so they stay in order. Null: one enormous pass, not kept.
   */
  private bufferFor(state: LoopState, pinned: boolean): Step[] | null {
    if (this.tailBuffer && this.tailBuffer.state !== state) this.settleTail([]);
    const tail = (this.tailBuffer ??= { state, passes: [], loose: 0 });
    const passes = tail.passes;
    if (!passes.length || passes[passes.length - 1].it !== state.iteration) {
      passes.push({ it: state.iteration, steps: [], pinned });
      if (!pinned) tail.loose++;
      while (tail.loose > SAMPLE_LAST) {
        const first = passes.shift()!;
        if (first.pinned) {
          for (const step of first.steps) this.commit(step); // earlier than everything still buffered
        } else {
          tail.loose--;
          this.skipped += first.steps.length;
        }
      }
    }
    const steps = passes[passes.length - 1].steps;
    if (steps.length > this.maxSteps / 4) return null;
    return steps;
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
    let into: Step[] | null = null;
    if (this.sampled) {
      const states = this.activeStates();
      this.settleTail(states);
      const outside = states.find((s) => !Runtime.keepPass(s));
      if (outside && (outside.total !== null || outside.pseudo)) {
        this.skipped++; // the middle of a loop whose last passes are known: not recorded
        return;
      }
      if (outside || this.tailBuffer) {
        // Unknown length: keep this pass in case it's one of the last.
        into = this.bufferFor(outside ?? this.tailBuffer!.state, !outside);
        if (!into) {
          this.skipped++; // one enormous pass: keep its start
          return;
        }
      }
    }
    this.recording = true;
    try {
      const serializer = new Serializer(this.objectIds, () => `o${++this.objectCounter}`, this.closures, this.focusOf());
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
        [...frame.loops].map(([loop, state]) => ({ frame: frame.id, loop, instance: state.instance, iteration: state.iteration })));
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
      this.considered++;
      if (into) into.push(step);
      else this.commit(step);
    } finally {
      this.recording = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Reads a property without running user code (getters show as "(getter)"). */
function readOwn(obj: object, key: PropertyKey): { value: unknown } | { getter: true } {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) return { value: undefined };
  return "value" in desc ? { value: desc.value } : { getter: true };
}

function constructorName(obj: object): string {
  const proto = Object.getPrototypeOf(obj);
  if (!proto) return "Object";
  const ctor = Object.getOwnPropertyDescriptor(proto, "constructor")?.value;
  return typeof ctor === "function" && ctor.name ? ctor.name : "Object";
}

function isPlainObject(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  return proto === null || proto === Object.prototype;
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error === "object" && error !== null ? constructorName(error) : typeof error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return typeof error === "string" ? error : inspect(error);
  } catch {
    return String(error);
  }
}

/** Parameter names from a function's source text. */
export function parseParams(source: string): string[] {
  const single = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(source);
  if (single) return [single[1]];
  const open = source.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let current = "";
  const params: string[] = [];
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) {
      params.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  params.push(current);
  return params.map((p) => p.split("=")[0].trim()).filter(Boolean);
}

const OPAQUE_TYPES: [Function, (v: any) => string][] = [
  [Date, (v: Date) => (Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString())],
  [RegExp, (v: RegExp) => String(v)],
  [Error, (v: Error) => `${v.name}: ${v.message}`],
  [Promise, () => "Promise"],
  [WeakMap, () => "WeakMap"],
  [WeakSet, () => "WeakSet"],
  [ArrayBuffer, (v: ArrayBuffer) => `ArrayBuffer(${v.byteLength})`],
];

// Long lists: the cells shown follow the index variables (a window of
// MAX_ITEMS), and a strip of evenly spaced samples shows the whole list.
const STRIP_SAMPLES = 256;
/** Names that conventionally hold an index (as render/draw.ts's pointersFor). */
const CONVENTIONAL_POINTERS = ["lo", "hi", "low", "high", "left", "right", "l", "r", "start", "end", "mid", "slow", "fast"];

/** Where the window of MAX_ITEMS cells starts, to show these indices. Moves in steps of 10. */
export function windowStart(indices: number[], length: number): number {
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  const center = hi - lo < MAX_ITEMS - 4 ? Math.floor((lo + hi) / 2) : lo;
  const start = Math.floor(Math.max(0, center - MAX_ITEMS / 2) / 10) * 10;
  return Math.max(0, Math.min(start, length - MAX_ITEMS));
}

/** Evenly spaced samples of a long list of numbers, or null if it holds anything else. */
function stripOf(read: (i: number) => unknown, n: number): { values: number[]; min: number; max: number } | null {
  const count = Math.min(STRIP_SAMPLES, n);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    let x = read(Math.floor((i * n) / count));
    if (typeof x === "boolean") x = Number(x);
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    values.push(x);
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { values, min, max };
}

const isListLike = (v: unknown): v is ArrayLike<unknown> =>
  Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));

class Serializer {
  readonly heap: Record<string, HeapObject> = {};
  private count = 0;

  constructor(
    private readonly ids: WeakMap<object, string>,
    private readonly newId: () => string,
    private readonly closures: WeakMap<Function, { name: string; captured: Getter }>,
    /** Long lists' index variables' values (see windowStart). */
    private readonly focus: Map<object, number[]> = new Map(),
  ) {}

  locals(getter: Getter): [string, Value][] {
    const out: [string, Value][] = [];
    for (const [name, read] of getter()) {
      let value: unknown;
      try {
        value = read();
      } catch {
        continue; // let/const before its declaration (temporal dead zone)
      }
      out.push([name, this.value(value)]);
    }
    return out;
  }

  value(v: unknown): Value {
    switch (typeof v) {
      case "number": return prim("number", Object.is(v, -0) ? "-0" : String(v));
      case "string": {
        // A shortened string still knows its real length, for memory sizes.
        const value = prim("string", JSON.stringify(v));
        if (value.repr.endsWith("…")) value.length = v.length;
        return value;
      }
      case "boolean": return prim("boolean", String(v));
      case "undefined": return prim("undefined", "undefined");
      case "bigint": return prim("bigint", `${v}n`);
      case "symbol": return prim("symbol", v.toString());
    }
    if (v === null) return prim("null", "null");
    return { kind: "ref", id: this.ref(v as object) };
  }

  private ref(obj: object): string {
    let id = this.ids.get(obj);
    if (!id) {
      id = this.newId();
      this.ids.set(obj, id);
    }
    if (id in this.heap) return id;
    if (this.count >= MAX_OBJECTS) {
      this.heap[id] = { kind: "opaque", id, typeName: constructorName(obj), repr: "…" };
      return id;
    }
    this.count++;
    this.heap[id] = { kind: "opaque", id, typeName: "", repr: "" }; // placeholder for cycles
    this.heap[id] = this.describe(obj, id);
    return id;
  }

  private items(values: Iterable<unknown>): Value[] {
    const out: Value[] = [];
    for (const value of values) {
      if (out.length >= MAX_ITEMS) break;
      out.push(this.value(value));
    }
    return out;
  }

  private slot(obj: object, key: PropertyKey): Value {
    const read = readOwn(obj, key);
    return "getter" in read ? prim("getter", "(getter)") : this.value(read.value);
  }

  private describe(obj: object, id: string): HeapObject {
    if (Array.isArray(obj)) {
      const n = obj.length;
      const indices = n > MAX_ITEMS ? this.focus.get(obj) : undefined;
      const start = indices ? windowStart(indices, n) : 0;
      const items: Value[] = [];
      for (let i = start; i < Math.min(n, start + MAX_ITEMS); i++) items.push(this.slot(obj, i));
      const out: SequenceObject = { kind: "list", id, typeName: "Array", items, length: n };
      if (start) out.offset = start;
      if (n > MAX_ITEMS) {
        const strip = stripOf((i) => { const r = readOwn(obj, i); return "getter" in r ? undefined : r.value; }, n);
        if (strip) out.strip = strip;
      }
      return out;
    }
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      const view = obj as unknown as ArrayLike<number>;
      const n = view.length;
      const indices = n > MAX_ITEMS ? this.focus.get(obj) : undefined;
      const start = indices ? windowStart(indices, n) : 0;
      const items: Value[] = [];
      for (let i = start; i < Math.min(n, start + MAX_ITEMS); i++) items.push(this.value(view[i]));
      const out: SequenceObject = { kind: "list", id, typeName: constructorName(obj), items, length: n };
      if (start) out.offset = start;
      if (n > MAX_ITEMS) {
        const strip = stripOf((i) => view[i], n);
        if (strip) out.strip = strip;
      }
      return out;
    }
    if (obj instanceof Map) {
      const entries: [Value, Value][] = [];
      for (const [key, value] of Map.prototype.entries.call(obj)) {
        if (entries.length >= MAX_ITEMS) break;
        entries.push([this.value(key), this.value(value)]);
      }
      return { kind: "dict", id, typeName: "Map", entries, length: obj.size };
    }
    if (obj instanceof Set) {
      return { kind: "set", id, typeName: "Set", items: this.items(Set.prototype.values.call(obj)), length: obj.size };
    }
    if (typeof obj === "function") {
      const source = Function.prototype.toString.call(obj);
      if (/^class[\s{]/.test(source)) return { kind: "class", id, typeName: "class", name: obj.name || "anonymous" };
      const builtin = source.includes("[native code]");
      const closure = this.closures.get(obj);
      return {
        kind: "function",
        id,
        typeName: "function",
        name: closure?.name ?? (obj.name || "anonymous"),
        params: builtin ? [] : parseParams(source),
        fields: closure ? this.locals(closure.captured) : [],
        builtin,
      };
    }
    // Generators and promises have no visible state in JavaScript; name them.
    const tag = Object.prototype.toString.call(obj).slice(8, -1);
    if (tag === "Generator" || tag === "AsyncGenerator") {
      return { kind: "opaque", id, typeName: tag, repr: tag === "Generator" ? "generator object" : "async generator object" };
    }
    for (const [type, show] of OPAQUE_TYPES) {
      if (obj instanceof type) return { kind: "opaque", id, typeName: constructorName(obj), repr: show(obj) };
    }

    const keys = Object.keys(obj);
    if (isPlainObject(obj)) {
      // Plain objects are JavaScript's everyday dictionary, so draw them as
      // one. Keys are shown unquoted.
      const entries: [Value, Value][] = keys.slice(0, MAX_ITEMS).map((key) => [prim("key", key), this.slot(obj, key)]);
      return { kind: "dict", id, typeName: "Object", entries, length: keys.length };
    }
    return {
      kind: "object",
      id,
      typeName: constructorName(obj),
      fields: keys.slice(0, MAX_ITEMS).map((key) => [key, this.slot(obj, key)]),
    };
  }
}

// ---------------------------------------------------------------------------
// console.log formatting, close to what Node and browsers print
// ---------------------------------------------------------------------------

export function inspect(value: unknown, depth = 0, seen = new Set<object>()): string {
  switch (typeof value) {
    case "string": return depth === 0 ? value : `'${value}'`;
    case "bigint": return `${value}n`;
    case "symbol": return value.toString();
    case "function": {
      const source = Function.prototype.toString.call(value);
      if (/^class[\s{]/.test(source)) return `[class ${value.name || "(anonymous)"}]`;
      return value.name ? `[Function: ${value.name}]` : "[Function (anonymous)]";
    }
    case "object": break;
    default: return String(value);
  }
  if (value === null) return "null";
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof RegExp) return String(obj);
  if (obj instanceof Error) return `${obj.name}: ${obj.message}`;
  if (depth > 2) return Array.isArray(obj) ? "[Array]" : "[Object]";

  seen.add(obj);
  const show = (v: unknown) => inspect(v, depth + 1, seen);
  const read = (o: object, k: PropertyKey) => {
    const r = readOwn(o, k);
    return "getter" in r ? "[Getter]" : show(r.value);
  };
  let text: string;
  if (Array.isArray(obj)) {
    const parts = obj.slice(0, 100).map((_, i) => read(obj, i));
    if (obj.length > 100) parts.push(`... ${obj.length - 100} more items`);
    text = parts.length ? `[ ${parts.join(", ")} ]` : "[]";
  } else if (obj instanceof Map) {
    const parts = [...obj].map(([k, v]) => `${show(k)} => ${show(v)}`);
    text = `Map(${obj.size}) ${parts.length ? `{ ${parts.join(", ")} }` : "{}"}`;
  } else if (obj instanceof Set) {
    const parts = [...obj].map(show);
    text = `Set(${obj.size}) ${parts.length ? `{ ${parts.join(", ")} }` : "{}"}`;
  } else {
    const parts = Object.keys(obj).map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${read(obj, k)}`);
    const name = constructorName(obj);
    const body = parts.length ? `{ ${parts.join(", ")} }` : "{}";
    text = name === "Object" ? body : `${name} ${body}`;
  }
  seen.delete(obj);
  return text;
}
