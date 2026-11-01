/**
 * Builds the "stacked iterations" view of a loop from the trace.
 *
 * A loop instance is one entry into a loop (an inner loop gets a new instance
 * on every pass of the outer loop). Its rows are the state at the end of each
 * iteration, plus a "before" row for the state when the loop was entered.
 */
import {
  type Frame,
  type HeapObject,
  type LoopContext,
  type LoopInfo,
  liveFrames,
  type Step,
  type Trace,
} from "./types";

export interface LoopRow {
  /** 0 is the "before" row. */
  iteration: number;
  stepIndex: number;
  frame: Frame;
  heap: Record<string, HeapObject>;
  /** All loops together: which loop and which run of it this row is a pass of, and how deeply it's nested (0 outermost). */
  loop?: string;
  instance?: number;
  depth?: number;
}

/** "L4#2": one run of a loop. */
export const runKey = (loop: string, instance: number) => `${loop}#${instance}`;

/** The loop tab that draws every loop of a frame together. */
export const ALL_LOOPS = "*";

export interface LoopHistory {
  info: LoopInfo;
  context: LoopContext;
  rows: LoopRow[];
  /** False when the current step is past the end of this loop. */
  running: boolean;
  /** Every loop running in the frame, drawn together: rows of all of them, in the order they ran. */
  nested?: boolean;
  /** Each run's header with its values (LoopContext.call), by runKey. */
  calls: Map<string, string>;
}

const sameInstance = (a: LoopContext, b: LoopContext) =>
  a.frame === b.frame && a.loop === b.loop && a.instance === b.instance;

function contextIn(step: Step, target: LoopContext): LoopContext | undefined {
  return step.loops.find((ctx) => sameInstance(ctx, target));
}

/*
 * Building a history at every step from the trace alone meant scanning its
 * loop's whole run each time: thousands of steps, every step. But a run's
 * shape is fixed for the whole trace: where it starts and ends, and which
 * steps are which pass. So it's worked out once per trace, in one pass over
 * every step (`indexOf`), and a step's history is then found with a binary
 * search and one row per pass. A row is the same object every time it's
 * the same pass at the same step (`rowAt`), so the loop's scene can keep
 * what it works out about a row (scene/loopScene.ts).
 */

/** A contiguous run of steps inside one run of a loop (its context on the stack). */
interface Block {
  ctx: LoopContext;
  start: number;
  end: number;
  /** Stretches of steps on the same pass, in order. */
  passes: { iteration: number; start: number; end: number }[];
  /** The first step in it with the run's header values, and those values. */
  callAt: number;
  call: string | undefined;
  /** The first step in it where another loop of the same frame runs (nested loops), or Infinity. */
  otherLoopAt: number;
  /** Every loop of its frame together (buildNestedHistory), worked out the first time it's asked. */
  nested?: NestedPasses;
}

/** What's known about a trace's loops, worked out once. */
interface TraceIndex {
  /** By step: the latest step at or before it with a loop running, or -1. */
  lastWithLoops: Int32Array;
  /** Each context's blocks, in order, by "frame|loop|instance". */
  blocks: Map<string, Block[]>;
  /** Rows made so far, by block, pass and step: the same row object each time. */
  rows: Map<string, LoopRow>;
}

const ctxKey = (c: { frame: string; loop: string; instance: number }) => `${c.frame}|${c.loop}|${c.instance}`;

const indexes = new WeakMap<Trace, TraceIndex>();

function indexOf(trace: Trace): TraceIndex {
  let index = indexes.get(trace);
  if (index) return index;
  const steps = trace.steps;
  const lastWithLoops = new Int32Array(steps.length);
  const blocks = new Map<string, Block[]>();
  let last = -1;
  for (let i = 0; i < steps.length; i++) {
    const loops = steps[i].loops;
    if (loops.length) last = i;
    lastWithLoops[i] = last;
    for (const ctx of loops) {
      const key = ctxKey(ctx);
      let list = blocks.get(key);
      if (!list) {
        list = [];
        blocks.set(key, list);
      }
      let block = list[list.length - 1];
      if (!block || block.end !== i - 1) {
        block = {
          ctx,
          start: i,
          end: i,
          passes: [],
          callAt: Number.POSITIVE_INFINITY,
          call: undefined,
          otherLoopAt: Number.POSITIVE_INFINITY,
        };
        list.push(block);
      }
      block.end = i;
      const pass = block.passes[block.passes.length - 1];
      if (pass && pass.iteration === ctx.iteration && pass.end === i - 1) pass.end = i;
      else block.passes.push({ iteration: ctx.iteration, start: i, end: i });
      if (ctx.call && block.callAt === Number.POSITIVE_INFINITY) {
        block.callAt = i;
        block.call = ctx.call;
      }
      if (
        block.otherLoopAt === Number.POSITIVE_INFINITY &&
        loops.some((c) => c.frame === ctx.frame && c.loop !== ctx.loop)
      )
        block.otherLoopAt = i;
    }
  }
  index = { lastWithLoops, blocks, rows: new Map() };
  indexes.set(trace, index);
  return index;
}

/**
 * The step range of the run holding `ctx` up to `stepIndex`: its latest step
 * at or before `stepIndex` (last), and where its contiguous steps start
 * (first). As the scan from stepIndex back, then from there back, found it.
 */
function runRange(
  trace: Trace,
  index: TraceIndex,
  stepIndex: number,
  ctx: LoopContext,
): { first: number; last: number; block?: Block } {
  const at = Math.min(stepIndex, trace.steps.length - 1);
  const list = index.blocks.get(ctxKey(ctx)) ?? [];
  // The latest block starting at or before `at`; then its last step at or before `at`.
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Step 0 always counts as the last step when nothing earlier has the context (as the scan stopped at 0).
  if (found < 0) return { first: 0, last: 0, block: list[0]?.start === 0 ? list[0] : undefined };
  const block = list[found];
  const last = Math.min(block.end, at);
  return { first: block.start, last, block };
}

/** The row for a pass at a step: made once, then the same object. */
function rowAt(
  trace: Trace,
  index: TraceIndex,
  key: string,
  stepIndex: number,
  frameId: string,
  make: (frame: LoopRow["frame"]) => LoopRow,
): LoopRow | null {
  const id = `${key}@${stepIndex}`;
  const known = index.rows.get(id);
  if (known) return known;
  const frame = liveFrames(trace.steps[stepIndex]).find((f) => f.id === frameId);
  if (!frame) return null;
  const row = make(frame);
  index.rows.set(id, row);
  return row;
}

/**
 * The loops a person can pick from at this step. If no loop is running, use
 * the most recent step that was inside one, so a finished loop's full history
 * stays visible.
 */
export function availableLoops(trace: Trace, stepIndex: number): { contexts: LoopContext[]; running: boolean } {
  const current = trace.steps[stepIndex];
  if (current?.loops.length) return { contexts: current.loops, running: true };
  if (!current) {
    // Past the end (or before the start): as the scan back did.
    for (let i = Math.min(stepIndex, trace.steps.length) - 1; i >= 0; i--) {
      const loops = trace.steps[i].loops;
      if (loops.length) return { contexts: loops, running: false };
    }
    return { contexts: [], running: false };
  }
  const at = stepIndex > 0 ? indexOf(trace).lastWithLoops[stepIndex - 1] : -1;
  return at >= 0 ? { contexts: trace.steps[at].loops, running: false } : { contexts: [], running: false };
}

export function buildLoopHistory(trace: Trace, stepIndex: number, preferredLoopId: string | null): LoopHistory | null {
  const { contexts, running } = availableLoops(trace, stepIndex);
  if (!contexts.length) return null;

  // Prefer the loop the person picked; otherwise the innermost one if it's
  // running, or the outermost one once everything has finished.
  const picked =
    contexts.find((ctx) => ctx.loop === preferredLoopId) ?? (running ? contexts[contexts.length - 1] : contexts[0]);
  const info = trace.loops.find((loop) => loop.id === picked.loop);
  if (!info) return null;

  const index = indexOf(trace);
  // The step range for this run: its steps are contiguous (calls made from
  // inside the loop keep the caller's loop context on the stack).
  const { first, last, block } = runRange(trace, index, stepIndex, picked);

  // The last step of each pass (up to `last`) is that pass's row.
  const lastStepOfIteration = new Map<number, number>();
  if (block && contextIn(trace.steps[last], picked)) {
    for (const pass of block.passes) {
      if (pass.start > last) break;
      lastStepOfIteration.set(pass.iteration, Math.min(pass.end, last));
    }
  }

  const rows: LoopRow[] = [];
  const key = `${ctxKey(picked)}#${first}`;
  for (const [iteration, at] of [...lastStepOfIteration].sort((a, b) => a[0] - b[0])) {
    const row = rowAt(trace, index, `${key}:${iteration}`, at, picked.frame, (frame) => ({
      iteration,
      stepIndex: at,
      frame,
      heap: trace.steps[at].heap,
    }));
    if (row) rows.push(row);
  }

  const latest = contextIn(trace.steps[last], picked) ?? picked;
  const calls = new Map<string, string>();
  if (block && block.callAt <= last && block.call) calls.set(runKey(picked.loop, picked.instance), block.call);
  return { info, context: latest, rows, running: running && last === stepIndex, calls };
}

/**
 * The loops that can be drawn together at this step: those running in the
 * same frame as the innermost one, when a loop inside the outermost one has
 * run. Empty otherwise (one loop at a time).
 */
export function nestedLoopsAt(trace: Trace, stepIndex: number): LoopContext[] {
  const { contexts, running } = availableLoops(trace, stepIndex);
  if (!contexts.length) return [];
  const frame = (running ? contexts[contexts.length - 1] : contexts[0]).frame;
  const inFrame = contexts.filter((c) => c.frame === frame);
  const root = inFrame[0];
  const { first, last, block } = runRange(trace, indexOf(trace), stepIndex, root);
  if (block && contextIn(trace.steps[last], root)) return block.otherLoopAt <= last ? inFrame : [];
  // Not inside the root's run at `last` (only possible at step 0): as the scan did.
  for (let i = first; i <= last; i++) {
    if (trace.steps[i].loops.some((c) => c.frame === frame && c.loop !== root.loop)) return inFrame;
  }
  return [];
}

/** Every pass of every loop in a root block's frame: where each pass's row can be, worked out once. */
interface NestedPasses {
  /** Each pass, in the order its first row step comes: the steps its row can be at, ascending. */
  passes: { key: string; ctx: LoopContext; depth: number; at: number[] }[];
  /** Each run's header values, with the step they first appear at, in order. */
  calls: { key: string; call: string; at: number }[];
}

function nestedPasses(trace: Trace, block: Block): NestedPasses {
  if (block.nested) return block.nested;
  const root = block.ctx;
  const byKey = new Map<string, NestedPasses["passes"][number]>();
  const passes: NestedPasses["passes"] = [];
  const calls: NestedPasses["calls"] = [];
  const called = new Set<string>();
  for (let i = block.start; i <= block.end; i++) {
    const here = trace.steps[i].loops.filter((c) => c.frame === root.frame);
    here.forEach((ctx, depth) => {
      const run = runKey(ctx.loop, ctx.instance);
      if (ctx.call && !called.has(run)) {
        called.add(run);
        calls.push({ key: run, call: ctx.call, at: i });
      }
      // Inner runs start without a "before" row; the outermost has one.
      if (ctx.iteration === 0 && depth > 0) return;
      // A step belongs to the innermost loop running: an outer pass's row is
      // its state once its inner loops are done, not a copy of theirs.
      if (depth < here.length - 1 && !(ctx.iteration === 0 && here[depth + 1]?.iteration === 0)) return;
      const key = `${run}|${ctx.iteration}`;
      let pass = byKey.get(key);
      if (!pass) {
        pass = { key, ctx, depth, at: [] };
        byKey.set(key, pass);
        passes.push(pass);
      }
      // The row takes the context and depth of its latest step.
      pass.at.push(i);
    });
  }
  block.nested = { passes, calls };
  return block.nested;
}

/** The steps (ctx and depth) a pass's row step had, by step: kept to give each row its latest context. */
const passContexts = new WeakMap<NestedPasses["passes"][number], Map<number, { ctx: LoopContext; depth: number }>>();

/**
 * Every loop in a frame, together: the outermost loop's run, with a row for
 * each pass of it and of every loop inside it (each at the last step of
 * that pass), in the order they happened. An inner loop's passes come
 * before the end of the outer pass they're in. Null when there's nothing
 * nested to draw together.
 */
export function buildNestedHistory(trace: Trace, stepIndex: number): LoopHistory | null {
  const inFrame = nestedLoopsAt(trace, stepIndex);
  if (!inFrame.length) return null;
  const { running } = availableLoops(trace, stepIndex);
  const root = inFrame[0];
  const info = trace.loops.find((loop) => loop.id === root.loop);
  if (!info) return null;
  const index = indexOf(trace);
  const { first, last, block } = runRange(trace, index, stepIndex, root);
  if (!block || !contextIn(trace.steps[last], root)) return null;
  const { passes, calls: allCalls } = nestedPasses(trace, block);

  // Each pass that has a row step by `last`: its latest one.
  const entries: { at: number; ctx: LoopContext; depth: number; key: string }[] = [];
  for (const pass of passes) {
    if (pass.at[0] > last) break;
    let lo = 0;
    let hi = pass.at.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pass.at[mid] <= last) lo = mid;
      else hi = mid - 1;
    }
    const at = pass.at[lo];
    let contexts = passContexts.get(pass);
    if (!contexts) {
      contexts = new Map();
      passContexts.set(pass, contexts);
    }
    let here = contexts.get(at);
    if (!here) {
      const loops = trace.steps[at].loops.filter((c) => c.frame === root.frame);
      const depth = loops.findIndex((c) => c.loop === pass.ctx.loop && c.instance === pass.ctx.instance);
      here = { ctx: loops[depth], depth };
      contexts.set(at, here);
    }
    entries.push({ at, ctx: here.ctx, depth: here.depth, key: pass.key });
  }
  entries.sort((a, b) => a.at - b.at || b.depth - a.depth);
  const rows: LoopRow[] = [];
  const blockKey = `${ctxKey(root)}#${first}*`;
  for (const { at, ctx, depth, key } of entries) {
    const row = rowAt(trace, index, `${blockKey}${key}:${depth}`, at, root.frame, (frame) => ({
      iteration: ctx.iteration,
      stepIndex: at,
      frame,
      heap: trace.steps[at].heap,
      loop: ctx.loop,
      instance: ctx.instance,
      depth,
    }));
    if (row) rows.push(row);
  }
  const calls = new Map<string, string>();
  for (const c of allCalls) {
    if (c.at > last) break;
    calls.set(c.key, c.call);
  }
  const latest = contextIn(trace.steps[last], root) ?? root;
  return { info, context: latest, rows, running: running && last === stepIndex, nested: true, calls };
}
