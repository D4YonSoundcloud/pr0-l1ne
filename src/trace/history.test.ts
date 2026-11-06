/**
 * A value over the whole run (history.ts): a variable of one call, a
 * list's slot, a dict's key, an object's field; where it appears, changes
 * and goes; a long list's window not knowing what's outside it; and
 * finding a step by a condition, forward and back, with what it reads from.
 */
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { applyHints } from "./hints";
import { findWhere, targetOf, type ValueTarget, valueHistory } from "./history";
import type { HeapObject, Step, Trace, Value } from "./types";

const CODE = `let best = 0;
const nums = [3, 12, 5, 20];
const counts = { seen: 0 };
for (let i = 0; i < nums.length; i++) {
  if (nums[i] > best) best = nums[i];
  counts.seen += 1;
  nums[i] = 0;
}
function f(n) {
  const twice = n * 2;
  return twice;
}
f(1);
f(2);
`;

async function trace(): Promise<Trace> {
  return applyHints(await traceJavaScript(CODE));
}

/** A global's id, and an object's id by the global holding it. */
const globalFrame = (t: Trace) => t.steps.at(-1)!.stack[0].id;
const objectOf = (t: Trace, name: string) =>
  (t.steps.at(-1)!.stack[0].locals.find(([n]) => n === name)![1] as { id: string }).id;
const values = (t: Trace, target: ValueTarget) =>
  valueHistory(t, target, t.steps.length - 1).points.map((p) => p.value);

describe("a value's history", () => {
  it("lists a variable's values as it changes, with numbers for a sparkline", async () => {
    const t = await trace();
    const history = valueHistory(t, { kind: "var", frame: globalFrame(t), name: "best" }, 5);
    expect(history.name).toBe("best");
    expect(history.points.map((p) => [p.value, p.num])).toEqual([
      ["0", 0],
      ["3", 3],
      ["12", 12],
      ["20", 20],
    ]);
    expect(history.points.every((p, i) => i === 0 || p.step > history.points[i - 1].step)).toBe(true);
  });

  it("follows a list's slot and an object's field", async () => {
    const t = await trace();
    expect(values(t, { kind: "slot", object: objectOf(t, "nums"), slot: "1" })).toEqual(["12", "0"]);
    const seen = valueHistory(
      t,
      { kind: "slot", object: objectOf(t, "counts"), slot: "p:key:seen" },
      t.steps.length - 1,
    );
    expect(seen.name).toBe("counts.seen");
    expect(seen.points.map((p) => p.value)).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("a variable of one call: it appears when the call starts and goes when it returns", async () => {
    const t = await trace();
    const calls = [...new Set(t.steps.flatMap((s) => s.stack.filter((f) => f.func === "f").map((f) => f.id)))];
    expect(calls).toHaveLength(2);
    const second = valueHistory(t, { kind: "var", frame: calls[1], name: "n" }, t.steps.length - 1);
    expect(second.points.map((p) => (p.gone ? "gone" : p.value))).toEqual(["2", "gone"]);
  });

  it("doesn't count a long list's window moving: what's outside it isn't known", () => {
    const prim = (v: string): Value => ({ kind: "prim", type: "int", repr: v });
    const window = (offset: number, items: string[]): HeapObject =>
      ({ kind: "list", typeName: "list", items: items.map(prim), length: 100, offset }) as HeapObject;
    const step = (obj: HeapObject): Step => ({
      event: "line",
      line: 1,
      stack: [{ id: "g", func: "Global", line: 1, locals: [["xs", { kind: "ref", id: "o1" }]] }],
      heap: { o1: obj },
      stdoutLength: 0,
      loops: [],
    });
    const t = {
      steps: [step(window(0, ["7", "8"])), step(window(50, ["1", "2"])), step(window(0, ["9", "8"]))],
    } as unknown as Trace;
    expect(values(t, { kind: "slot", object: "o1", slot: "0" })).toEqual(["7", "9"]);
  });

  it("reads which value a drawing's element stands for", () => {
    expect(targetOf("o3|2", null)).toEqual({ kind: "slot", object: "o3", slot: "2" });
    expect(targetOf("o3|p:str:'a|b'", null)).toEqual({ kind: "slot", object: "o3", slot: "p:str:'a|b'" });
    expect(targetOf(null, "f2|count")).toEqual({ kind: "var", frame: "f2", name: "count" });
    expect(targetOf(null, null)).toBeNull();
    expect(targetOf("nonsense", null)).toBeNull();
  });
});

describe("finding a step where something's true", () => {
  it("finds the next step where it's true, and the one before, with the running function's variables then the globals", async () => {
    const t = await trace();
    const first = findWhere(t, "best > 10", 0, false).step!;
    expect(first).not.toBeNull();
    const step = t.steps[first];
    expect(step.stack[0].locals.find(([n]) => n === "best")![1]).toMatchObject({ repr: "12" });
    expect(findWhere(t, "best > 10", first, true).step).toBeNull();
    expect(findWhere(t, "best > 10", t.steps.length, true).step).not.toBeNull();
    // Inside f, its own n, and a global, together.
    const inF = findWhere(t, "n == 2 && best == 20", 0, false).step!;
    expect(t.steps[inF].stack.at(-1)!.func).toBe("f");
    expect(findWhere(t, "best > 100", 0, false)).toEqual({ step: null });
  });

  it("says when a condition doesn't read, and skips steps where it can't be worked out", async () => {
    const t = await trace();
    expect(findWhere(t, "best >", 0, false).error).toBeTruthy();
    expect(findWhere(t, "twice == 4", 0, false).step).not.toBeNull(); // only set inside f
    expect(findWhere(t, "nope == 1", 0, false)).toEqual({ step: null });
  });
});
