/** The sampling policy, driven by hand: which passes of long loops are recorded. */
import { describe, expect, it } from "vitest";
import { POLICY } from "../trace/policy";
import type { Step } from "../trace/types";
import { type LoopState, RECORD, roundPass, Sampler } from "./sampling";

const SAMPLING = POLICY.sampling;
const { first: SAMPLE_FIRST, last: SAMPLE_LAST } = SAMPLING;

const step = () => ({ event: "line" }) as Step;

function sampler(maxSteps = 1000) {
  const committed: Step[] = [];
  return { s: new Sampler(maxSteps, SAMPLING, (x: Step) => committed.push(x)), committed };
}

/** A loop after its first passes, each `perPass` steps long. */
function started(s: Sampler, total: number | null, perPass: number): LoopState {
  const loop = s.loop(1);
  loop.total = total;
  s.considered = perPass * SAMPLE_FIRST;
  loop.iteration = SAMPLE_FIRST + 1;
  s.newPass(loop);
  return loop;
}

describe("sampling", () => {
  it("keeps round-numbered passes", () => {
    expect([5, 9, 10, 13, 20, 99, 100, 150, 200, 1000].filter((n) => roundPass(n, SAMPLING))).toEqual([
      10, 20, 100, 200, 1000,
    ]);
  });

  it("records a short loop in full, and samples a long one", () => {
    const short = sampler();
    expect(started(short.s, 10, 6)).toMatchObject({ mode: "full", keep: true });
    expect(short.s.sampled).toBe(false);
    const long = sampler();
    expect(started(long.s, 1000, 6)).toMatchObject({ mode: "sampled", keep: false });
    expect(long.s.sampled).toBe(true);
  });

  it("watches a loop of unknown length until it has spent a quarter of its room", () => {
    const { s } = sampler();
    const loop = started(s, null, 6);
    expect(loop.mode).toBe("watch");
    s.considered = 251;
    loop.iteration++;
    s.newPass(loop);
    expect(loop.mode).toBe("sampled");
  });

  it("keeps a sampled loop's ends, and round passes while they fit", () => {
    const { s } = sampler();
    const loop: LoopState = { ...s.loop(1), mode: "sampled", total: 1000, kept: 6 };
    s.considered = 60;
    const keep = (it: number) => {
      loop.iteration = it;
      return s.decideKeep(loop, 1000);
    };
    expect([3, 996, 13, 20].map(keep)).toEqual([true, true, false, true]);
    s.considered = 700; // past its share
    expect(keep(30)).toBe(false);
  });

  it("records everything until a loop is sampled", () => {
    expect(sampler().s.place([])).toBe(RECORD);
  });

  it("counts the middle of a sampled loop of known length, or a run of calls", () => {
    const { s } = sampler();
    s.sampled = true;
    expect(s.place([{ ...s.loop(1), mode: "sampled", keep: false, total: 500 }])).toBeNull();
    expect(s.place([{ ...s.pseudo(), mode: "sampled", keep: false }])).toBeNull();
    expect(s.skipped).toBe(2);
  });

  it("buffers the passes of a loop of unknown length, and saves them when it ends", () => {
    const { s, committed } = sampler();
    s.sampled = true;
    const loop: LoopState = { ...s.loop(1), mode: "sampled", keep: false, iteration: 40 };
    const into = s.place([loop]);
    expect(Array.isArray(into)).toBe(true);
    (into as Step[]).push(step());
    loop.keep = true; // a round pass while buffering: pinned into the buffer, in order
    expect(s.place([loop])).toBe(into);
    expect(s.place([])).toBe(RECORD); // the loop ended
    expect(committed).toHaveLength(1);
    expect(s.tail).toBeNull();
  });

  it("keeps a loop's last passes and counts the rest", () => {
    const { s, committed } = sampler();
    const loop: LoopState = { ...s.loop(1), mode: "sampled", keep: false };
    for (let it = 1; it < SAMPLE_LAST + 4; it++) {
      loop.iteration = it;
      s.buffer(loop, it === 2)!.push(step(), step());
    }
    // Pass 1 fell out (2 steps counted); pass 2 was pinned, so saved; then pass 3 fell out.
    expect(committed).toHaveLength(2);
    expect(s.skipped).toBe(4);
    expect(s.tail!.passes.map((p) => p.it)).toEqual([4, 5, 6, 7, 8]);
  });

  it("saves one loop's buffer before buffering another's", () => {
    const { s, committed } = sampler();
    const first = { ...s.loop(1), iteration: 1 };
    s.buffer(first, false)!.push(step());
    s.buffer({ ...s.loop(2), iteration: 1 }, false);
    expect(committed).toHaveLength(1);
  });

  it("keeps only the start of one enormous pass", () => {
    const { s } = sampler(8);
    s.sampled = true;
    const loop: LoopState = { ...s.loop(1), mode: "watch", iteration: 1 };
    const into = s.buffer(loop, false)!;
    into.push(step(), step(), step()); // more than a quarter of the budget
    Object.assign(loop, { mode: "sampled", keep: false });
    expect(s.place([loop])).toBeNull();
    expect(s.skipped).toBe(1);
  });
});
