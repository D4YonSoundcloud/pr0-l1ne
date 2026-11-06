/**
 * What changed at a step, in words (changes.ts), on Python's own traces
 * (the tracer in Pyodide): its dicts' keys as Python writes them, an
 * object's fields, a list grown and shrunk. Type-checked with Node's types
 * (tsconfig.node.json), as the tracer is loaded from files.
 */
import { describe, expect, it } from "vitest";
import { pythonTracer } from "../testing/pythonTracer";
import { stepChanges } from "./changes";
import { applyHints } from "./hints";
import { POLICY } from "./policy";
import type { Trace } from "./types";

/** Every step's changes, as "name: before → after" (— for new, "gone" for gone). */
const said = (trace: Trace): string[] =>
  trace.steps
    .slice(1)
    .flatMap((step, i) =>
      stepChanges(trace.steps[i], step).changes.map((c) => `${c.name}: ${c.before ?? "—"} → ${c.after ?? "gone"}`),
    );

describe("what changed at a step, in Python", () => {
  it("Python: its dicts' keys as written, an object's fields, a list grown and shrunk", async () => {
    const trace = (await pythonTracer())(
      `counts = {"a": 1}
class Node:
    def __init__(self, val):
        self.val = val
        self.next = None
head = Node(1)
counts["a"] += 1
counts[2] = "two"
head.next = Node(2)
xs = [1, 2]
xs.append(3)
xs.pop(0)
`,
      POLICY.maxSteps,
      5,
    );
    const all = said(applyHints(trace));
    expect(all).toContain("counts: — → {'a': 1}");
    expect(all).toContain("counts['a']: 1 → 2");
    expect(all).toContain("counts[2]: — → 'two'");
    expect(all).toContain("head.next: None → Node(val=2, next=None)");
    expect(all).toContain("xs[2]: — → 3");
    // pop(0): every item moves up one, and the last place goes.
    expect(all).toEqual(expect.arrayContaining(["xs[0]: 1 → 2", "xs[1]: 2 → 3", "xs[2]: 3 → gone"]));
  }, 120_000);
});
