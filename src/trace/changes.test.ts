/**
 * What changed at a step, in words (changes.ts): variables, list slots,
 * dict entries and fields, named as code would reach them; values shown
 * briefly; things that appear or go; a long list's window moving along
 * isn't a change; and no more than the most it lists.
 */
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { stepChanges } from "./changes";
import { applyHints } from "./hints";
import type { HeapObject, Step, Trace, Value } from "./types";

/** Each step's changes, as "name: before → after" (— for new, "gone" for gone), by the line about to run. */
function said(trace: Trace): string[][] {
  const out: string[][] = [];
  for (let i = 1; i < trace.steps.length; i++)
    out.push(
      stepChanges(trace.steps[i - 1], trace.steps[i]).changes.map(
        (c) => `${c.frame ? `${c.frame}: ` : ""}${c.name}: ${c.before ?? "—"} → ${c.after ?? "gone"}`,
      ),
    );
  return out;
}

const prim = (repr: string, type = "int"): Value => ({ kind: "prim", type, repr });
const ref = (id: string): Value => ({ kind: "ref", id });
const step = (locals: [string, Value][], heap: Record<string, HeapObject>, extra: Partial<Step> = {}): Step => ({
  event: "line",
  line: 1,
  stack: [{ id: "g", func: "Global", line: 1, locals }],
  heap,
  stdoutLength: 0,
  loops: [],
  ...extra,
});
const list = (items: Value[], extra: Partial<HeapObject> = {}): HeapObject =>
  ({ kind: "list", typeName: "list", items, length: items.length, ...extra }) as HeapObject;

describe("what changed at a step", () => {
  it("says each variable, slot, key and field that changed, named as the code reaches it", async () => {
    const trace = applyHints(
      await traceJavaScript(`const nums = [5, 3, 8];
const counts = { a: 1 };
class Node { constructor(v) { this.val = v; this.next = null; } }
const head = new Node(1);
function swap(xs, i, j) {
  const t = xs[i];
  xs[i] = xs[j];
  xs[j] = t;
}
swap(nums, 0, 2);
counts.a += 1;
counts["two words"] = 7;
head.next = new Node(2);
nums.push(4);
nums.pop();
`),
    );
    const all = said(trace).flat();
    expect(all).toContain("nums: — → [5, 3, 8]");
    expect(all).toContain("counts: — → {a: 1}");
    expect(all).toContain("xs: — → [5, 3, 8]"); // a new call's arguments
    expect(all).toContain("xs[0]: 5 → 8"); // by the running frame's name for it
    expect(all).toContain("xs[2]: 8 → 5");
    expect(all).toContain("counts.a: 1 → 2"); // a JavaScript object's key
    expect(all).toContain('counts["two words"]: — → 7');
    expect(all).toContain("head.next: null → Node(val=2, next=null)");
    expect(all).toContain("nums[3]: — → 4");
    expect(all).toContain("nums[3]: 4 → gone");
  });

  it("names the function a variable's in when it's not the one running, and says what went", () => {
    const before: Step = {
      ...step([["n", prim("3")]], {}),
      stack: [
        { id: "g", func: "Global", line: 1, locals: [["n", prim("3")]] },
        {
          id: "f1",
          func: "fact",
          line: 2,
          locals: [
            ["k", prim("3")],
            ["tmp", prim("1")],
          ],
        },
      ],
    };
    const after: Step = {
      ...before,
      stack: [
        { id: "g", func: "Global", line: 1, locals: [["n", prim("4")]] },
        { id: "f1", func: "fact", line: 2, locals: [["k", prim("2")]] },
      ],
    };
    expect(stepChanges(before, after).changes).toEqual([
      { name: "k", before: "3", after: "2", target: { kind: "var", frame: "f1", name: "k" } },
      { name: "tmp", before: "1", after: null, target: { kind: "var", frame: "f1", name: "tmp" } },
      { name: "n", before: "3", after: "4", frame: "Global", target: { kind: "var", frame: "g", name: "n" } },
    ]);
  });

  it("quotes a Python dict's keys as they're written, and goes into nested lists by index", () => {
    const key = prim("'a'", "str");
    const dict = (v: string): HeapObject =>
      ({ kind: "dict", typeName: "dict", entries: [[key, prim(v)]], length: 1 }) as HeapObject;
    const grid = (v: string) => ({
      o1: list([ref("o2"), ref("o3")]),
      o2: list([prim("0"), prim("0")]),
      o3: list([prim("0"), prim(v)]),
      o4: dict(v),
    });
    const locals: [string, Value][] = [
      ["grid", ref("o1")],
      ["counts", ref("o4")],
    ];
    const { changes } = stepChanges(step(locals, grid("0")), step(locals, grid("1")));
    expect(changes.map((c) => c.name)).toEqual(["grid[1][1]", "counts['a']"]);
  });

  it("compares a long list's windows only where they meet: the window moving along isn't a change", () => {
    const window = (offset: number, values: number[]) =>
      list(
        values.map((v) => prim(String(v))),
        { length: 1000, offset } as Partial<HeapObject>,
      );
    const locals: [string, Value][] = [["big", ref("o1")]];
    const before = step(locals, { o1: window(100, [100, 101, 102, 103]) });
    const after = step(locals, { o1: window(102, [102, 7, 104, 105]) });
    expect(stepChanges(before, after).changes).toEqual([
      { name: "big[103]", before: "103", after: "7", target: { kind: "slot", object: "o1", slot: "103" } },
    ]);
  });

  it("says what a set gained and lost", () => {
    const set = (items: string[]): HeapObject =>
      ({ kind: "set", typeName: "set", items: items.map((v) => prim(v)), length: items.length }) as HeapObject;
    const locals: [string, Value][] = [["seen", ref("o1")]];
    const { changes } = stepChanges(step(locals, { o1: set(["1", "2"]) }), step(locals, { o1: set(["2", "3"]) }));
    expect(changes).toEqual([
      { name: "seen +", before: null, after: "3" },
      { name: "seen −", before: "1", after: null },
    ]);
  });

  it("shows values briefly: a long list by its start and length", () => {
    const long = list(
      Array.from({ length: 60 }, (_, i) => prim(String(i))),
      { length: 5000 } as Partial<HeapObject>,
    );
    const { changes } = stepChanges(step([], {}), step([["xs", ref("o1")]], { o1: long }));
    expect(changes[0].after).toBe("[0, 1, 2, 3, 4, 5, …] (5,000 items)");
  });

  it("lists at most so many, and says how many more", () => {
    const many = (v: string) => Array.from({ length: 10 }, (_, i) => [`v${i}`, prim(v)] as [string, Value]);
    const out = stepChanges(step(many("0"), {}), step(many("1"), {}), 4);
    expect(out.changes).toHaveLength(4);
    expect(out.more).toBe(6);
  });

  it("the first step has nothing to compare with", () => {
    expect(stepChanges(undefined, step([["a", prim("1")]], {}))).toEqual({ changes: [], more: 0 });
  });
});
