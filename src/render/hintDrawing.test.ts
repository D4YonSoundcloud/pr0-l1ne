// @vitest-environment jsdom
/**
 * The hints that change what's drawn, drawn: regions and compares on a
 * list, rows labeled by a variable, watches and checks in loop rows, bits,
 * characters, formats and labels in the memory view, and arrows marked by
 * the kind of link they are.
 */
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { loopScene } from "../scene/loopScene";
import { memoryScene } from "../scene/memoryScene";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { renderLoopHistory } from "./loopView";
import { renderMemory } from "./memory";

const example = (start: string) => JAVASCRIPT_EXAMPLES.find((e) => e.name.startsWith(start))!.code;
const memoryAt = (t: Trace, i: number, mode: "arrows" | "nested" = "nested") =>
  renderMemory(memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { mode }));
const loopAt = (t: Trace, i: number) => {
  const history = buildNestedHistory(t, i) ?? buildLoopHistory(t, i, null)!;
  return renderLoopHistory(loopScene(t, history, { hideQuiet: false }));
};
const texts = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map((el) => el.textContent);

describe("region, compare and rows by", () => {
  it("draws labeled regions in their own colors, the compared cells, and rows labeled by i", async () => {
    const t = applyHints(await traceJavaScript(example("13 ·")));
    expect(t.viz?.warnings).toEqual([]);
    // Inside the inner loop, partway through.
    const at = t.steps.findIndex((s, i) => i > 30 && s.line === 15);
    const memory = memoryAt(t, at);
    expect(memory.querySelectorAll(".region-band").length).toBe(2);
    expect(memory.querySelector(".region-band.region-0")).not.toBeNull();
    expect(memory.querySelector(".region-band.region-1")).not.toBeNull();
    expect(texts(memory, ".region-label").join(" ")).toMatch(/sorted|sor…/);
    expect(memory.querySelectorAll(".compare-mark").length).toBe(2);

    const loop = loopAt(t, at);
    expect(texts(loop, ".iteration-label").some((l) => /^i = \d$/.test(l ?? ""))).toBe(true);
    // The inner loop's rows keep their own labels.
    expect(texts(loop, ".iteration-label").some((l) => /^#\d$/.test(l ?? ""))).toBe(true);
    expect(loop.querySelectorAll(".compare-mark").length).toBeGreaterThan(0);
  });
});

describe("watch and check", () => {
  it("shows a watch's value in each row, and turns a row red where a check is false", async () => {
    const good = applyHints(await traceJavaScript(example("14 ·")));
    const last = good.steps.length - 2;
    const loop = loopAt(good, last);
    expect(texts(loop, ".scalars .watch").some((w) => /^total - seen = -?\d+$/.test(w ?? ""))).toBe(true);
    expect(loop.querySelectorAll(".loop-row.is-failing").length).toBe(0);

    const broken = applyHints(
      await traceJavaScript(example("14 ·").replace("if (i > 0) total += nums[i - 1]", "if (i > 0) total += 1")),
    );
    const failing = loopAt(broken, broken.steps.length - 2);
    expect(failing.querySelectorAll(".loop-row.is-failing").length).toBeGreaterThan(0);
    expect(texts(failing, ".check-failed")[0]).toBe("✗ total == sum(nums[0:i])");
    expect(failing.querySelector(".loop-row.is-failing .failing-band")).not.toBeNull();
  });
});

describe("chars, bits, format and label", () => {
  it("draws a string as letters, a number as bits counted from the right, and names boxes by a field", async () => {
    const t = applyHints(await traceJavaScript(example("15 ·")));
    expect(t.viz?.warnings).toEqual([]);
    const svg = memoryAt(t, t.steps.length - 1);
    const seqs = [...svg.querySelectorAll(".seq")];
    const word = seqs.find((g) => texts(g, ".value").join("") === '"l""e""v""e""l"');
    expect(word).toBeDefined();
    const bits = seqs.find((g) => texts(g, ".index").join(",") === "4,3,2,1,0");
    expect(bits).toBeDefined();
    expect(texts(bits!, ".value").join("")).toBe("00011");
    expect(texts(svg, ".value")).toContain("40.0%");
    expect(texts(svg, ".box-title")).toEqual(expect.arrayContaining(["Node 1", "Node 2", "Node 3"]));
  });
});

describe("arrows by kind", () => {
  it("marks each arrow with the kind of link it is, and gives it that kind's arrowhead", async () => {
    const t = applyHints(
      await traceJavaScript(`class Node { constructor(v) { this.v = v; this.next = null; } }
const a = new Node(1);
a.next = new Node(2);
a.next.next = new Node(3);
a.next.next.next = a.next;
const list = [a];`),
    );
    const svg = memoryAt(t, t.steps.length - 1, "arrows");
    const kinds = [...svg.querySelectorAll(".ref-arrow")].map((p) => p.getAttribute("class")!.match(/kind-(\w+)/)?.[1]);
    expect(kinds).toEqual(expect.arrayContaining(["ref", "next", "cycle"]));
    const cycleHead = svg.querySelector(".ref-arrow-part.arrow-head.kind-cycle");
    expect(cycleHead?.getAttribute("marker-end")).toBe("url(#arrow-kind-cycle)");
    expect(svg.querySelector("marker#arrow-kind-cycle")).not.toBeNull();
  });
});

describe("links by kind in the loop history", () => {
  it("calls a reversed list's links next, and only a real loop of links a cycle", async () => {
    const reversed = applyHints(await traceJavaScript(example("Reverse a linked list")));
    const loop = loopAt(reversed, reversed.steps.length - 2);
    expect(loop.querySelectorAll(".link-arrow.kind-next").length).toBeGreaterThan(0);
    expect(loop.querySelectorAll(".link-arrow.kind-cycle").length).toBe(0);

    const cycle = applyHints(await traceJavaScript(example("Find a cycle")));
    const withCycle = loopAt(cycle, cycle.steps.length - 2);
    expect(withCycle.querySelectorAll(".link-arrow.kind-cycle").length).toBeGreaterThan(0);
  });
});
