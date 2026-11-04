/** Work over a run, done at once or a slice at a time (trace/work.ts). */
import { describe, expect, it } from "vitest";
import { finishInSlices, finishNow, type Progress, stepOf, type Work, within } from "./work";

function* count(n: number, label = "Counting"): Work<string> {
  for (let i = 1; i <= n; i++) yield stepOf(label, i, n);
  return `counted ${n}`;
}

describe("work", () => {
  it("finishes at once", () => {
    expect(finishNow(count(1000))).toBe("counted 1000");
  });

  it("in slices: pauses when a slice's time is up, reporting how far it's got at each pause", async () => {
    let clock = 0;
    const pauses: number[] = [];
    const seen: Progress[] = [];
    const result = await finishInSlices(
      (function* () {
        for (let i = 1; i <= 10; i++) {
          clock += 10; // each step takes 10 ms
          yield stepOf("Ten", i, 10);
        }
        return "done";
      })(),
      (p) => seen.push(p),
      {
        sliceMs: 25,
        now: () => clock,
        pause: async () => {
          pauses.push(clock);
        },
      },
    );
    expect(result).toBe("done");
    expect(seen.map((p) => p.done)).toEqual([3, 6, 9]);
    expect(pauses).toEqual([30, 60, 90]);
  });

  it("work done within the first slice never pauses or reports", async () => {
    const seen: Progress[] = [];
    let pauses = 0;
    const result = await finishInSlices(count(50), (p) => seen.push(p), {
      now: () => 0,
      pause: async () => {
        pauses++;
      },
    });
    expect(result).toBe("counted 50");
    expect(seen).toEqual([]);
    expect(pauses).toBe(0);
  });

  it("scales a part's progress into its share of the whole", () => {
    function* both(): Work<string[]> {
      const a = yield* within(count(2, "A"), 0, 0.25);
      const b = yield* within(count(4, "B"), 0.25, 1);
      return [a, b];
    }
    const shares: [string, number][] = [];
    const work = both();
    for (let next = work.next(); ; next = work.next()) {
      if (next.done) {
        expect(next.value).toEqual(["counted 2", "counted 4"]);
        break;
      }
      shares.push([next.value.label, next.value.share]);
    }
    expect(shares).toEqual([
      ["A", 0.125],
      ["A", 0.25],
      ["B", 0.4375],
      ["B", 0.625],
      ["B", 0.8125],
      ["B", 1],
    ]);
  });
});
