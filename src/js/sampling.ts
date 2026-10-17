/**
 * The sampling policy for long loops: which passes are recorded, the same
 * rules as the Python tracer's sampling.py. After a loop's first passes it is
 * recorded in full, sampled (its first and last passes and round-numbered
 * ones in between) or, when its length isn't known, watched until it has
 * spent a quarter of its room. The last passes of a loop of unknown length
 * wait in a buffer until it ends, since any pass could be one of the last.
 */

import type { Step } from "../trace/types";

export const SAMPLE_FIRST = 5;
export const SAMPLE_LAST = 5;

/** 10, 20 ... 90, 100, 200 ... 900, 1000 ...: a pass worth keeping in a long loop. */
export function roundPass(n: number): boolean {
  if (n < 10) return false;
  const scale = 10 ** (String(n).length - 1);
  return n % scale === 0;
}

export interface LoopState {
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
  /** The header with its values as it started: "j = 0; j < 4; j++". */
  call?: string;
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

/** place(): the step is recorded now. */
export const RECORD = "record";

export class Sampler {
  /** Has any loop been sampled? Until then every step is recorded. */
  sampled = false;
  /** Events not recorded since the last recorded step. */
  skipped = 0;
  /** Steps recorded or buffered (a loop's share of the budget). */
  considered = 0;
  /** The last passes of a long loop whose length wasn't known, kept until it ends. */
  tail: { state: LoopState; passes: TailPass[]; loose: number } | null = null;

  constructor(
    private readonly maxSteps: number,
    /** Save a step to the trace. */
    private readonly commit: (step: Step) => void,
  ) {}

  /** A loop statement starting. */
  loop(instance: number): LoopState {
    return { instance, iteration: 0, total: null, mode: null, start: this.considered };
  }

  /** A run of calls from one line, sampled like a loop. */
  pseudo(): LoopState {
    return { instance: 0, iteration: 0, total: null, mode: null, start: this.considered, pseudo: true };
  }

  /** A pass starting. After a loop's first passes, decide whether to record all of it. */
  newPass(state: LoopState): void {
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
  decideKeep(state: LoopState, room: number): boolean {
    const it = state.iteration;
    if (it <= SAMPLE_FIRST || (state.total !== null && it > state.total - SAMPLE_LAST)) return true;
    if (!roundPass(it)) return false;
    const spent = this.considered - state.start;
    const perPass = spent / Math.max(1, state.kept ?? 0);
    return spent + perPass * (SAMPLE_LAST + 1) <= room * 0.6;
  }

  static keepPass(state: LoopState): boolean {
    return state.mode !== "sampled" || state.keep !== false;
  }

  /**
   * Where the next step goes, given the loops running (outermost first):
   * RECORD, a buffer of a loop's last passes, or null (counted, not
   * recorded).
   */
  place(states: LoopState[]): Step[] | typeof RECORD | null {
    if (!this.sampled) return RECORD;
    this.settle(states);
    const outside = states.find((s) => !Sampler.keepPass(s));
    if (outside && (outside.total !== null || outside.pseudo)) {
      this.skipped++; // the middle of a loop whose last passes are known: not recorded
      return null;
    }
    if (!outside && !this.tail) return RECORD;
    // Unknown length: keep this pass in case it's one of the last.
    const into = this.buffer(outside ?? this.tail!.state, !outside);
    if (!into) this.skipped++; // one enormous pass: keep its start
    return into;
  }

  /** The buffered last passes of a long loop: saved once the loop ends. */
  settle(states: LoopState[]): void {
    const tail = this.tail;
    if (!tail || states.includes(tail.state)) return;
    for (const pass of tail.passes) for (const step of pass.steps) this.commit(step);
    this.tail = null;
  }

  /**
   * Where this step goes in a long loop of unknown length: a buffer of its
   * last passes, in case they're the last. Round-numbered passes are pinned
   * there so they stay in order. Null: one enormous pass, not kept.
   */
  buffer(state: LoopState, pinned: boolean): Step[] | null {
    if (this.tail && this.tail.state !== state) this.settle([]);
    this.tail ??= { state, passes: [], loose: 0 };
    const tail = this.tail;
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
}
