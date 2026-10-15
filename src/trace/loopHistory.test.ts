import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { evaluatedHeader, linkedChains, loopVariable } from "../render/loopView";
import { buildLoopHistory, buildNestedHistory, nestedLoopsAt } from "./loopHistory";
import type { LoopInfo } from "./types";

const BUBBLE = `const nums = [5, 2, 4, 1];
for (let i = 0; i < nums.length; i++) {
  for (let j = 0; j < nums.length - 1 - i; j++) {
    if (nums[j] > nums[j + 1]) [nums[j], nums[j + 1]] = [nums[j + 1], nums[j]];
  }
}
const done = true;`;

describe("all loops together", () => {
  it("puts every pass of the inner loop before the end of the outer pass it's in", async () => {
    const t = await traceJavaScript(BUBBLE);
    const end = t.steps.length - 1;
    expect(nestedLoopsAt(t, end).length).toBe(1); // only the outer loop was last running
    const h = buildNestedHistory(t, end)!;
    expect(h.nested).toBe(true);
    const order = h.rows.map((r) => `${r.loop === "L2" ? "i" : "j"}${r.iteration}`).join(" ");
    expect(order).toBe("i0 j1 j2 j3 i1 j1 j2 i2 j1 i3 i4");
    expect(h.rows.filter((r) => r.loop === "L3").every((r) => r.depth === 1)).toBe(true);
  });

  it("keeps each run's header with its values", async () => {
    const t = await traceJavaScript(BUBBLE);
    const h = buildNestedHistory(t, t.steps.length - 1)!;
    expect([...h.calls.values()]).toEqual(["i = 0; i < 4; i++", "j = 0; j < 3; j++", "j = 0; j < 2; j++", "j = 0; j < 1; j++"]);
    const single = buildLoopHistory(t, t.steps.length - 1, "L2")!;
    expect([...single.calls.values()]).toEqual(["i = 0; i < 4; i++"]);
  });

  it("has nothing to draw together for a single loop", async () => {
    const t = await traceJavaScript(`let s = 0;\nfor (let i = 0; i < 3; i++) s += i;`);
    expect(buildNestedHistory(t, t.steps.length - 1)).toBeNull();
  });
});

describe("loop headers", () => {
  const info = (header: string, kind: "for" | "while" = "for"): LoopInfo => ({ id: "L1", kind, line: 1, bodyStart: 2, bodyEnd: 2, header });
  it("finds the loop variable", () => {
    expect(loopVariable(info("for j in range(n - 1 - i)"))).toBe("j");
    expect(loopVariable(info("for (let j = 0; j < n; j++)"))).toBe("j");
    expect(loopVariable(info("for (const x of xs)"))).toBe("x");
    expect(loopVariable(info("for i, x in enumerate(xs)"))).toBe("i");
    expect(loopVariable(info("while lo <= hi", "while"))).toBeNull();
  });
  it("writes the header with its values", () => {
    expect(evaluatedHeader(info("for j in range(n - 1 - i)"), "range(0, 3)")).toBe("for j in range(0, 3)");
    expect(evaluatedHeader(info("for (let j = 0; j < n - 1 - i; j++)"), "j = 0; j < 3; j++")).toBe("for (j = 0; j < 3; j++)");
  });
});

describe("separate linked lists", () => {
  const node = (links: (string | null)[]) => ({ value: null, links }) as unknown as import("./linked").NodeState;
  it("groups nodes linked in any row, in the track's order", () => {
    const rows = [
      { nodes: new Map([["a", node(["b"])], ["b", node([null])], ["c", node(["d"])], ["d", node([null])], ["e", node([null])]]), pointers: [] },
      { nodes: new Map([["e", node(["f"])], ["f", node([null])]]), pointers: [] },
    ];
    expect(linkedChains(["a", "c", "b", "e", "d", "f"], rows)).toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
  });
});
