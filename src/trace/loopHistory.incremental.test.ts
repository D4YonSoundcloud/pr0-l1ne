/**
 * The loop history from the trace's index (loopHistory.ts) must be exactly
 * what scanning the run gives (testing/loopHistoryReference.ts): at every
 * step of every example and benchmark program, for every loop that can be
 * picked, together and one at a time, visited in any order. And a pass's
 * row must be the same object each time it's the same pass at the same step.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import * as reference from "../testing/loopHistoryReference";
import { availableLoops, buildLoopHistory, buildNestedHistory, type LoopHistory, nestedLoopsAt } from "./loopHistory";
import type { Trace } from "./types";

/** A history as plain data: rows by what they're made of (frame and heap by identity). */
function plain(history: LoopHistory | null, ids: Map<object, number>) {
  if (!history) return null;
  const id = (o: object) => {
    if (!ids.has(o)) ids.set(o, ids.size);
    return ids.get(o);
  };
  return {
    info: history.info.id,
    context: history.context,
    running: history.running,
    nested: history.nested ?? false,
    calls: [...history.calls],
    rows: history.rows.map((r) => ({
      iteration: r.iteration,
      stepIndex: r.stepIndex,
      frame: id(r.frame),
      heap: id(r.heap),
      loop: r.loop,
      instance: r.instance,
      depth: r.depth,
    })),
  };
}

function check(trace: Trace): number {
  const ids = new Map<object, number>();
  const n = trace.steps.length;
  // Forward, then backward, then jumping: the index answers any step.
  const order = [...Array(n).keys(), ...[...Array(n).keys()].reverse().filter((i) => i % 3 === 0)];
  let checked = 0;
  for (const i of order) {
    expect(availableLoops(trace, i)).toEqual(reference.availableLoops(trace, i));
    expect(nestedLoopsAt(trace, i)).toEqual(reference.nestedLoopsAt(trace, i));
    expect(plain(buildNestedHistory(trace, i), ids), `nested, step ${i}`).toEqual(
      plain(reference.buildNestedHistory(trace, i), ids),
    );
    const loops = [null, ...new Set(availableLoops(trace, i).contexts.map((c) => c.loop))];
    for (const loop of loops) {
      expect(plain(buildLoopHistory(trace, i, loop), ids), `loop ${loop}, step ${i}`).toEqual(
        plain(reference.buildLoopHistory(trace, i, loop), ids),
      );
      checked++;
    }
  }
  return checked;
}

describe("the loop history from the trace's index is the one scanning gives", () => {
  const programs = [
    ...JAVASCRIPT_EXAMPLES.map((e) => [e.name, () => traceJavaScript(e.code, 2000)] as const),
    ...TYPESCRIPT_EXAMPLES.map((e) => [`${e.name} (TypeScript)`, () => traceTypeScript(e.code, 2000)] as const),
    ...readdirSync(join(__dirname, "../../bench/programs"))
      .filter((f) => f.endsWith(".js"))
      .map(
        (f) =>
          [
            `bench: ${f}`,
            () => traceJavaScript(readFileSync(join(__dirname, "../../bench/programs", f), "utf8"), 1500),
          ] as const,
      ),
  ];
  it.each(programs)(
    "%s",
    async (_name, run) => {
      expect(check(await run())).toBeGreaterThan(0);
    },
    120_000,
  );

  it("gives a pass's row as the same object each time it's the same pass at the same step", async () => {
    const trace = await traceJavaScript(JAVASCRIPT_EXAMPLES[0].code, 2000);
    const at = trace.steps.findIndex((s) => s.loops.length > 0) + 8;
    const a = buildLoopHistory(trace, at, null)!;
    const b = buildLoopHistory(trace, at + 3, null)!;
    expect(b.rows.length).toBeGreaterThan(1);
    // The passes finished by `at` are the very same rows three steps later.
    const done = a.rows.slice(0, -1);
    expect(done.length).toBeGreaterThan(0);
    done.forEach((row, i) => {
      expect(b.rows[i]).toBe(row);
    });
    expect(buildLoopHistory(trace, at, null)!.rows).toEqual(a.rows);
    expect(buildLoopHistory(trace, at, null)!.rows.at(-1)).toBe(a.rows.at(-1));
  });
});
